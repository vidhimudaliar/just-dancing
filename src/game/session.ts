/**
 * Orchestrates a single play-through: two pose detectors, the checkpoint
 * detector, the pose buffer and the scoring engine, driven off one clock.
 *
 * The loop is deliberately single-threaded and sequential. MoveNet inference on
 * the WebGL backend serializes on the GPU anyway, so issuing both detectors
 * concurrently would add latency without adding throughput. Instead the webcam
 * runs every frame and the reference is throttled (spec §8's own mitigation),
 * which keeps the user's own pose — the one being scored — at full rate.
 */

import { createDetector, type PoseDetectorHandle } from '../pose/detector';
import { FramingTracker, type FramingAssessment } from '../calibration/framing';
import { PoseBuffer } from '../scoring/poseBuffer';
import { ScoringEngine, type ScoreTotals } from '../scoring/engine';
import { angleVelocity } from '../calibration/lag';
import { CALIBRATION, CONFIDENCE, DETECTION } from '../tuning';
import type { CheckpointDetector } from '../checkpoints/types';
import type { Orientation } from '../pose/mirror';
import type { ReferenceSource } from '../sources/types';
import type { WebcamHandle } from '../sources/webcam';
import type { Checkpoint, PoseFrame, ScoredCheckpoint, ScoringMode } from '../pose/types';

/**
 * `waiting` covers the stretch before the routine has actually begun — menu
 * navigation, title cards, whatever the uploader put in front of the song.
 * Calibrating through that would measure the timing of a static screen.
 */
export type SessionPhase = 'idle' | 'waiting' | 'calibrating' | 'scoring' | 'finished';

export interface RoutineStartInfo {
  /** Video time the warm-up window was anchored to. */
  startedAt: number;
  /**
   * True when the routine was never detected starting and calibration was
   * forced by the timeout — the estimates that follow are correspondingly
   * unreliable, and the user should be told rather than shown a confident
   * number.
   */
  timedOut: boolean;
}

export interface SessionCallbacks {
  onScored?(scored: ScoredCheckpoint, totals: ScoreTotals): void;
  onWebcamFrame?(frame: PoseFrame | null, framing: FramingAssessment): void;
  onReferenceFrame?(frame: PoseFrame | null): void;
  onPhaseChange?(phase: SessionPhase): void;
  /** Fires once the warm-up window closes, carrying the frames gathered during it. */
  onCalibrationComplete?(
    referenceFrames: PoseFrame[],
    userFrames: PoseFrame[],
    info: RoutineStartInfo,
  ): void;
  onFinished?(totals: ScoreTotals, checkpoints: Checkpoint[]): void;
}

export interface SessionOptions {
  webcam: WebcamHandle;
  reference: ReferenceSource;
  checkpointDetector: CheckpointDetector;
  /** Pre-extracted checkpoints from cache; when given, the reference detector is skipped. */
  cachedCheckpoints?: Checkpoint[];
  mode: ScoringMode;
  lagMs: number;
  orientation: Orientation;
  /** Skip the warm-up window — used when lag and mirror are already known. */
  skipCalibration?: boolean;
  callbacks?: SessionCallbacks;
}

export interface SessionDebugInfo {
  webcamInferenceMs: number;
  referenceInferenceMs: number;
  loopFps: number;
  bufferSize: number;
  pendingCheckpoints: number;
  videoTimeMs: number;
}

export class Session {
  private webcamDetector: PoseDetectorHandle | null = null;
  private referenceDetector: PoseDetectorHandle | null = null;
  private readonly buffer = new PoseBuffer();
  private readonly engine: ScoringEngine;
  private readonly framing = new FramingTracker();

  private phase: SessionPhase = 'idle';
  private rafHandle: number | null = null;
  private running = false;
  private lastReferenceAt = -Infinity;
  private lastFrameWall = 0;
  private loopFpsEma = 0;

  /** Video time at which the routine was judged to have started. */
  private routineStartedAt: number | null = null;
  /** True when that judgement was the timeout rather than detected movement. */
  private routineStartTimedOut = false;
  /** Running total of time the reference has been moving, for start detection. */
  private movingMs = 0;
  /** Previous reference frame, kept separately from the checkpoint detector's. */
  private lastReferenceFrame: PoseFrame | null = null;
  /** Cached checkpoints rendered as pose frames, for calibration on cached runs. */
  private readonly cachedFrames: PoseFrame[] = [];
  private cachedFrameCursor = 0;

  /** Every checkpoint seen this run, for persisting to cache on a clean finish. */
  private readonly collected: Checkpoint[] = [];
  /** Reference poses during the warm-up window, for lag and mirror estimation. */
  readonly calibrationReference: PoseFrame[] = [];
  readonly calibrationUser: PoseFrame[] = [];

  private unsubscribeEnded: (() => void) | null = null;

  constructor(private readonly options: SessionOptions) {
    this.engine = new ScoringEngine({
      lagMs: options.lagMs,
      orientation: options.orientation,
      mode: options.mode,
    });

    if (options.cachedCheckpoints) {
      for (const checkpoint of options.cachedCheckpoints) {
        this.collected.push(checkpoint);
        this.engine.addCheckpoint(checkpoint);
        // Cached checkpoints double as a sparse reference pose stream. Without
        // this a cached run has no reference frames at all, so mirror detection
        // silently gets zero samples and every routine is scored unmirrored.
        this.cachedFrames.push({
          t: checkpoint.t,
          keypoints: {},
          angles: checkpoint.angles,
          confidence: {},
          meanScore: checkpoint.confidence,
        });
      }
    }
  }

  /** True when the reference detector can be skipped entirely (spec §4 cache win). */
  private get usingCache(): boolean {
    return this.options.cachedCheckpoints !== undefined;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.webcamDetector = await createDetector('webcam');
    if (!this.usingCache) {
      this.referenceDetector = await createDetector('reference');
    }

    this.unsubscribeEnded = this.options.reference.onEnded(() => this.finish());

    await this.options.reference.play();

    this.setPhase(this.options.skipCalibration ? 'scoring' : 'waiting');
    this.lastFrameWall = performance.now();
    this.loop();
  }

  private setPhase(phase: SessionPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.options.callbacks?.onPhaseChange?.(phase);
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(() => void this.tick());
  };

  private async tick(): Promise<void> {
    if (!this.running) return;

    const wall = performance.now();
    const delta = wall - this.lastFrameWall;
    this.lastFrameWall = wall;
    if (delta > 0) {
      const fps = 1000 / delta;
      this.loopFpsEma = this.loopFpsEma === 0 ? fps : this.loopFpsEma * 0.9 + fps * 0.1;
    }

    const now = this.options.reference.clock.now();

    await this.stepWebcam(now);
    await this.stepReference(now);
    this.stepCachedReference(now);
    this.stepCalibration(now);
    this.stepScoring(now);

    this.loop();
  }

  /** Detects the user's pose and buffers it. Runs every frame. */
  private async stepWebcam(now: number): Promise<void> {
    const detector = this.webcamDetector;
    const input = this.options.webcam.frameSource();
    if (!detector || !input) {
      this.options.callbacks?.onWebcamFrame?.(null, this.framing.push(null));
      return;
    }

    const frame = await detector.estimate(input, now);
    if (frame) {
      this.buffer.push(frame);
      if (this.phase === 'calibrating') this.calibrationUser.push(frame);
    }
    this.options.callbacks?.onWebcamFrame?.(frame, this.framing.push(frame));
  }

  /** Detects the reference dancer's pose. Throttled, and skipped entirely on a cache hit. */
  private async stepReference(now: number): Promise<void> {
    if (this.usingCache) return;

    const minGap = 1000 / DETECTION.referenceFps;
    if (now - this.lastReferenceAt < minGap) return;

    const detector = this.referenceDetector;
    const input = this.options.reference.frameSource();
    if (!detector || !input) return;

    this.lastReferenceAt = now;

    const frame = await detector.estimate(input, now);
    this.options.callbacks?.onReferenceFrame?.(frame);
    if (!frame) return;

    if (this.phase === 'waiting') {
      if (this.detectRoutineStart(frame)) this.beginCalibration(now, false);
      // Nothing before the routine starts is worth keeping: checkpoints
      // extracted from a menu screen would be scored against the dancer later.
      return;
    }

    if (this.phase === 'calibrating') this.calibrationReference.push(frame);

    for (const checkpoint of this.options.checkpointDetector.push(frame)) {
      this.collected.push(checkpoint);
      this.engine.addCheckpoint(checkpoint);
    }
  }

  /**
   * Decides whether the reference has started actually dancing.
   *
   * Requires a confidently detected body *and* sustained movement. Either alone
   * is not enough: a game menu can show a standing avatar, and detector jitter
   * on a static frame produces small non-zero velocities. Movement time
   * accumulates and decays rather than resetting hard, so a held pose partway
   * through the opening phrase doesn't send it back to the start.
   */
  private detectRoutineStart(frame: PoseFrame): boolean {
    const previous = this.lastReferenceFrame;
    this.lastReferenceFrame = frame;
    if (!previous) return false;

    const dt = frame.t - previous.t;
    if (dt <= 0) return false;

    if (frame.meanScore < CONFIDENCE.checkpoint) {
      this.movingMs = 0;
      return false;
    }

    const velocity = angleVelocity(previous, frame);
    if (velocity === null) return false;

    this.movingMs =
      velocity >= CALIBRATION.routineMovementThreshold
        ? this.movingMs + dt
        : Math.max(0, this.movingMs - dt);

    return this.movingMs >= CALIBRATION.routineConfirmMs;
  }

  /**
   * The cached-run equivalent of routine-start detection.
   *
   * With checkpoints already extracted there is no reference detector running,
   * so there's nothing to watch for movement — but the checkpoints themselves
   * carry the answer: the first one marks where the routine begins, since the
   * extraction run found nothing to score before that.
   */
  private stepCachedReference(now: number): void {
    const first = this.cachedFrames[0];
    if (!this.usingCache || !first) return;

    if (this.phase === 'waiting') {
      if (now >= first.t) this.beginCalibration(first.t, false);
      return;
    }
    if (this.phase !== 'calibrating') return;

    while (this.cachedFrameCursor < this.cachedFrames.length) {
      const frame = this.cachedFrames[this.cachedFrameCursor]!;
      if (frame.t > now) break;
      this.calibrationReference.push(frame);
      this.cachedFrameCursor += 1;
    }
  }

  /** Opens the warm-up window, anchored at the moment the routine began. */
  private beginCalibration(now: number, timedOut: boolean): void {
    this.routineStartedAt = now;
    this.routineStartTimedOut = timedOut;
    this.setPhase('calibrating');
  }

  /**
   * Ends the warm-up window. Scoring stays suppressed until this fires, so the
   * user isn't penalised for the seconds spent working out their own lag.
   */
  private stepCalibration(now: number): void {
    if (this.phase === 'waiting') {
      // Safety valve: a reference the detector can never read would otherwise
      // hold the session in `waiting` for the whole song.
      if (now >= CALIBRATION.routineMaxWaitMs) this.beginCalibration(now, true);
      return;
    }

    if (this.phase !== 'calibrating') return;

    const startedAt = this.routineStartedAt ?? 0;
    if (now - startedAt < CALIBRATION.durationMs) return;

    this.options.callbacks?.onCalibrationComplete?.(
      this.calibrationReference,
      this.calibrationUser,
      { startedAt, timedOut: this.routineStartTimedOut },
    );
    this.setPhase('scoring');
  }

  private stepScoring(now: number): void {
    if (this.phase !== 'scoring') return;

    for (const scored of this.engine.update(now, this.buffer)) {
      this.options.callbacks?.onScored?.(scored, this.engine.totals);
    }
  }

  /** Applies calibration results mid-session (spec §7.2, §7.3). */
  applyCalibration(lagMs: number, orientation: Orientation, mode?: ScoringMode): void {
    this.engine.setLag(lagMs);
    this.engine.setOrientation(orientation);
    if (mode) this.engine.setMode(mode);
  }

  finish(): void {
    if (!this.running) return;

    // Resolve anything still inside its window before reporting a final score.
    for (const checkpoint of this.options.checkpointDetector.flush()) {
      this.collected.push(checkpoint);
      this.engine.addCheckpoint(checkpoint);
    }
    for (const scored of this.engine.flush(this.buffer)) {
      this.options.callbacks?.onScored?.(scored, this.engine.totals);
    }

    this.setPhase('finished');
    this.options.callbacks?.onFinished?.(this.engine.totals, this.collected);
    this.stop();
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.unsubscribeEnded?.();
    this.unsubscribeEnded = null;
    this.webcamDetector?.dispose();
    this.referenceDetector?.dispose();
    this.webcamDetector = null;
    this.referenceDetector = null;
    this.options.reference.pause();
  }

  get totals(): ScoreTotals {
    return this.engine.totals;
  }

  get currentPhase(): SessionPhase {
    return this.phase;
  }

  get debug(): SessionDebugInfo {
    return {
      webcamInferenceMs: this.webcamDetector?.meanInferenceMs ?? 0,
      referenceInferenceMs: this.referenceDetector?.meanInferenceMs ?? 0,
      loopFps: this.loopFpsEma,
      bufferSize: this.buffer.size,
      pendingCheckpoints: this.engine.pendingCount,
      videoTimeMs: this.options.reference.clock.now(),
    };
  }
}
