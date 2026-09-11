/**
 * The single source of time for the whole app.
 *
 * Every timestamp — reference poses, user poses, checkpoints, buffer entries —
 * is video-time milliseconds produced here. Never `Date.now()`, never raw
 * `performance.now()`. Mixing wall-clock and video-time is the kind of bug that
 * manifests as "scoring feels randomly wrong" rather than as a crash.
 *
 * The underlying players report position coarsely: the YouTube IFrame API
 * updates `getCurrentTime()` roughly four times a second, and an
 * `HTMLVideoElement` only advances `currentTime` per rendered frame. Since the
 * scoring windows are ±300ms, that granularity is too blunt to use raw, so this
 * class interpolates between samples with `performance.now()` and corrects drift.
 */

export interface ClockSource {
  /** Current position in video-time milliseconds, or null if not yet known. */
  positionMs(): number | null;
  isPlaying(): boolean;
  durationMs(): number;
}

/** A jump larger than this is treated as a seek and resynced hard, not smoothed. */
const SEEK_THRESHOLD_MS = 400;
/** Fraction of small drift corrected per sample, to avoid visible time jitter. */
const DRIFT_CORRECTION = 0.25;

export class MediaClock {
  private anchorVideoMs = 0;
  private anchorWallMs = 0;
  private started = false;
  private lastPlaying = false;
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly source: ClockSource,
    private readonly pollIntervalMs = 100,
  ) {}

  /**
   * Begins tracking. For YouTube this must be called on the first PLAYING state
   * event rather than on iframe load, so that pre-roll ads don't shift t=0 (spec §11.3).
   */
  start(): void {
    if (this.pollHandle !== null) return;
    this.sync(true);
    this.pollHandle = setInterval(() => this.sync(false), this.pollIntervalMs);
  }

  /** Pulls a fresh sample from the player and re-anchors the interpolation. */
  private sync(force: boolean): void {
    const sampled = this.source.positionMs();
    const playing = this.source.isPlaying();
    const wall = performance.now();

    if (sampled === null) return;

    if (force || !this.started) {
      this.anchorVideoMs = sampled;
      this.anchorWallMs = wall;
      this.started = true;
      this.lastPlaying = playing;
      return;
    }

    // Crossing a play/pause boundary invalidates the interpolation entirely.
    if (playing !== this.lastPlaying) {
      this.anchorVideoMs = sampled;
      this.anchorWallMs = wall;
      this.lastPlaying = playing;
      return;
    }

    if (!playing) {
      this.anchorVideoMs = sampled;
      this.anchorWallMs = wall;
      return;
    }

    const predicted = this.anchorVideoMs + (wall - this.anchorWallMs);
    const drift = sampled - predicted;

    if (Math.abs(drift) > SEEK_THRESHOLD_MS) {
      // A real seek (or a long stall). Snap rather than crawl toward it.
      this.anchorVideoMs = sampled;
      this.anchorWallMs = wall;
    } else {
      // Nudge toward the truth so time stays monotonic and smooth.
      this.anchorVideoMs = predicted + drift * DRIFT_CORRECTION;
      this.anchorWallMs = wall;
    }
  }

  /** Current video-time in milliseconds. */
  now(): number {
    if (!this.started) return 0;
    if (!this.lastPlaying) return this.anchorVideoMs;
    return this.anchorVideoMs + (performance.now() - this.anchorWallMs);
  }

  get isPlaying(): boolean {
    return this.lastPlaying;
  }

  get durationMs(): number {
    return this.source.durationMs();
  }

  dispose(): void {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.started = false;
  }
}

/** Clock source backed by a plain `<video>` element (local-file path). */
export function videoElementSource(video: HTMLVideoElement): ClockSource {
  return {
    positionMs: () => video.currentTime * 1000,
    isPlaying: () => !video.paused && !video.ended && video.readyState >= 2,
    durationMs: () => (Number.isFinite(video.duration) ? video.duration * 1000 : 0),
  };
}
