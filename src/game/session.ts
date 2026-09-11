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
import { CALIBRATION, DETECTION } from '../tuning';
import type { CheckpointDetector } from '../checkpoints/types';
import type { Orientation } from '../pose/mirror';
import type { ReferenceSource } from '../sources/types';
import type { WebcamHandle } from '../sources/webcam';
import type { Checkpoint, PoseFrame, ScoredCheckpoint, ScoringMode } from '../pose/types';

export type SessionPhase = 'idle' | 'calibrating' | 'scoring' | 'finished';

export interface SessionCallbacks {
  onScored?(scored: ScoredCheckpoint, totals: ScoreTotals): void;
  onWebcamFrame?(frame: PoseFrame | null, framing: FramingAssessment): void;
  onReferenceFrame?(frame: PoseFrame | null): void;
  onPhaseChange?(phase: SessionPhase): void;
  /** Fires once the warm-up window closes, carrying the frames gathered during it. */
  onCalibrationComplete?(referenceFrames: PoseFrame[], userFrames: PoseFrame[]): void;
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

    this.setPhase(this.options.skipCalibration ? 'scoring' : 'calibrating');
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

    if (this.phase === 'calibrating') this.calibrationReference.push(frame);

    for (const checkpoint of this.options.checkpointDetector.push(frame)) {
      this.collected.push(checkpoint);
      this.engine.addCheckpoint(checkpoint);
    }
  }

  /**
   * Ends the warm-up window. Scoring stays suppressed until this fires, so the
   * user isn't penalised for the seconds spent working out their own lag.
   */
  private stepCalibration(now: number): void {
    if (this.phase !== 'calibrating') return;
    if (now < CALIBRATION.durationMs) return;

    this.options.callbacks?.onCalibrationComplete?.(this.calibrationReference, this.calibrationUser);
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
