/**
 * The scoring engine (spec §7.4, §7.6).
 *
 * Scoring is retrospective by construction. A checkpoint at reference time `t`
 * is compared against every user pose buffered in
 * `[t + lag - window, t + lag + window]`, so it cannot be resolved until the
 * clock reaches `t + lag + window`. With a typical 300ms lag that puts ratings
 * roughly 600ms behind the beat, and ~900ms on a first play where checkpoints
 * are themselves detected online. That delay is a deliberate design stance, not
 * a bug: see the latency budget in the build plan.
 */

import { applyOrientation, type Orientation } from '../pose/mirror';
import { compareAngles, rate } from './compare';
import { LOWER_BODY_ANGLES, ANGLE_NAMES } from '../pose/types';
import { SCORING } from '../tuning';
import type { PoseBuffer } from './poseBuffer';
import type { AngleName, Checkpoint, ScoredCheckpoint, ScoringMode } from '../pose/types';

const ALL_ANGLES = new Set<AngleName>(ANGLE_NAMES);
const UPPER_ONLY = new Set<AngleName>(
  ANGLE_NAMES.filter((name) => !LOWER_BODY_ANGLES.includes(name)),
);

export function anglesForMode(mode: ScoringMode): ReadonlySet<AngleName> {
  return mode === 'FULL_BODY' ? ALL_ANGLES : UPPER_ONLY;
}

export interface ScoreTotals {
  /** Points earned so far. */
  points: number;
  /** Points that were available across scored checkpoints. */
  possible: number;
  /** points / possible, as 0..100. Zero when nothing has been scored yet. */
  percent: number;
  counts: Record<ScoredCheckpoint['rating'], number>;
  /** Checkpoints skipped because no usable pose data existed in the window. */
  skipped: number;
}

export interface ScoringEngineOptions {
  lagMs: number;
  orientation: Orientation;
  mode: ScoringMode;
}

export class ScoringEngine {
  /** Checkpoints awaiting resolution, kept sorted by `t`. */
  private pending: Checkpoint[] = [];
  private lagMs: number;
  private orientation: Orientation;
  private mode: ScoringMode;

  private points = 0;
  private possible = 0;
  private skipped = 0;
  private counts: Record<ScoredCheckpoint['rating'], number> = {
    Perfect: 0,
    Good: 0,
    OK: 0,
    Oops: 0,
  };

  constructor(options: ScoringEngineOptions) {
    this.lagMs = options.lagMs;
    this.orientation = options.orientation;
    this.mode = options.mode;
  }

  setLag(lagMs: number): void {
    this.lagMs = lagMs;
  }

  setOrientation(orientation: Orientation): void {
    this.orientation = orientation;
  }

  setMode(mode: ScoringMode): void {
    this.mode = mode;
  }

  /** Queues a checkpoint for scoring. Safe to call as they stream in. */
  addCheckpoint(checkpoint: Checkpoint): void {
    this.pending.push(checkpoint);
    // Velocity-minima detection can emit slightly out of order after smoothing.
    this.pending.sort((a, b) => a.t - b.t);
  }

  /** Video time at which `checkpoint` becomes resolvable. */
  private readyAt(checkpoint: Checkpoint): number {
    return checkpoint.t + this.lagMs + SCORING.windowMs;
  }

  /**
   * Resolves every checkpoint whose window has fully elapsed, returning the
   * newly scored ones in time order. Call once per frame with the current video
   * time; returns an empty array most frames.
   */
  update(now: number, buffer: PoseBuffer): ScoredCheckpoint[] {
    const results: ScoredCheckpoint[] = [];

    while (this.pending.length > 0 && this.readyAt(this.pending[0]!) <= now) {
      const checkpoint = this.pending.shift()!;
      const scored = this.score(checkpoint, buffer);
      if (scored) results.push(scored);
    }

    return results;
  }

  /** Scores everything still pending, regardless of window. Used at end of song. */
  flush(buffer: PoseBuffer): ScoredCheckpoint[] {
    const results: ScoredCheckpoint[] = [];
    while (this.pending.length > 0) {
      const scored = this.score(this.pending.shift()!, buffer);
      if (scored) results.push(scored);
    }
    return results;
  }

  /**
   * Returns null when the checkpoint could not be scored at all — no pose data
   * in the window, or too few usable angles. Those are excluded from the
   * denominator rather than counted as failures: a detector dropout is not the
   * dancer's fault, and spec §7.6 reports a percentage precisely so that
   * checkpoint counts can differ.
   */
  private score(checkpoint: Checkpoint, buffer: PoseBuffer): ScoredCheckpoint | null {
    const center = checkpoint.t + this.lagMs;
    const candidates = buffer.range(center - SCORING.windowMs, center + SCORING.windowMs);

    if (candidates.length === 0) {
      this.skipped += 1;
      return null;
    }

    // Mirror the reference once rather than per candidate — the comparison is
    // symmetric, and there are many more candidates than checkpoints.
    const reference = applyOrientation(checkpoint.angles, this.orientation);
    const allowed = anglesForMode(this.mode);

    let best = { similarity: -1, anglesUsed: 0 };
    for (const frame of candidates) {
      const result = compareAngles(reference, frame.angles, {
        userConfidence: frame.confidence,
        allowedAngles: allowed,
      });
      if (result.anglesUsed > 0 && result.similarity > best.similarity) {
        best = { similarity: result.similarity, anglesUsed: result.anglesUsed };
      }
    }

    if (best.anglesUsed === 0) {
      this.skipped += 1;
      return null;
    }

    const { rating, points } = rate(best.similarity);
    this.points += points;
    this.possible += 100;
    this.counts[rating] += 1;

    return {
      t: checkpoint.t,
      similarity: best.similarity,
      rating,
      points,
      anglesUsed: best.anglesUsed,
    };
  }

  get totals(): ScoreTotals {
    return {
      points: this.points,
      possible: this.possible,
      percent: this.possible === 0 ? 0 : (this.points / this.possible) * 100,
      counts: { ...this.counts },
      skipped: this.skipped,
    };
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  reset(): void {
    this.pending = [];
    this.points = 0;
    this.possible = 0;
    this.skipped = 0;
    this.counts = { Perfect: 0, Good: 0, OK: 0, Oops: 0 };
  }
}
