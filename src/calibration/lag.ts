/**
 * Reaction-lag estimation (spec §2.2, §7.2).
 *
 * A human copying a dance is inherently 200–400ms behind the reference — that's
 * reaction time, not bad dancing. Comparing frame `t` to frame `t` scores even
 * excellent dancers near zero, which spec §2.2 calls the single highest-risk
 * item in the whole design.
 *
 * The fix is to measure each user's own delay: build a "how much is this body
 * moving right now" signal for both the reference and the user, then find the
 * time shift that best aligns them. Movement *magnitude* is used rather than
 * pose similarity because it survives mirroring and body-shape differences —
 * which matters, since lag is estimated before the mirror question is settled.
 */

import { angleDifference } from '../scoring/compare';
import { CALIBRATION } from '../tuning';
import type { AngleName, PoseFrame } from '../pose/types';

export interface VelocitySample {
  t: number;
  v: number;
}

/**
 * Movement magnitude between two frames: mean angular change per millisecond,
 * or null when the frames share no comparable angles.
 *
 * Dividing by elapsed time matters because the two detectors run at different
 * rates — the reference is throttled to ~15fps while the webcam runs at ~30 —
 * so raw per-frame deltas would not be comparable between them.
 *
 * Measuring movement in *angle* space rather than pixel displacement makes this
 * scale- and position-invariant for free, which is also why it's the right
 * signal for checkpoint detection: a dancer who holds a shape while stepping
 * sideways is still holding the shape, and shouldn't register as movement.
 */
export function angleVelocity(previous: PoseFrame, current: PoseFrame): number | null {
  const dt = current.t - previous.t;
  if (dt <= 0) return null;

  let total = 0;
  let count = 0;
  for (const name of Object.keys(current.angles) as AngleName[]) {
    const a = current.angles[name];
    const b = previous.angles[name];
    if (a === undefined || b === undefined) continue;
    total += angleDifference(name, a, b);
    count += 1;
  }

  return count === 0 ? null : total / count / dt;
}

/** Per-frame movement magnitude across a sequence. */
export function velocitySignal(frames: PoseFrame[]): VelocitySample[] {
  const out: VelocitySample[] = [];

  for (let i = 1; i < frames.length; i += 1) {
    const current = frames[i]!;
    const v = angleVelocity(frames[i - 1]!, current);
    if (v === null) continue;
    out.push({ t: current.t, v });
  }

  return out;
}

/**
 * Resamples an irregular signal onto a uniform grid by linear interpolation,
 * so the two detectors' different frame rates don't bias the correlation.
 */
export function resample(
  signal: VelocitySample[],
  from: number,
  to: number,
  stepMs: number,
): number[] {
  const out: number[] = [];
  if (signal.length === 0) return out;

  let cursor = 0;
  for (let t = from; t <= to; t += stepMs) {
    while (cursor < signal.length - 1 && signal[cursor + 1]!.t < t) cursor += 1;

    const left = signal[cursor]!;
    const right = signal[cursor + 1];

    if (!right || t <= left.t) {
      out.push(left.v);
      continue;
    }
    const span = right.t - left.t;
    const ratio = span === 0 ? 0 : (t - left.t) / span;
    out.push(left.v + (right.v - left.v) * ratio);
  }

  return out;
}

/** Pearson correlation. Returns 0 for constant input, where correlation is undefined. */
export function correlate(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;

  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i += 1) {
    sumA += a[i]!;
    sumB += b[i]!;
  }
  const meanA = sumA / n;
  const meanB = sumB / n;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }

  const denominator = Math.sqrt(varianceA * varianceB);
  return denominator === 0 ? 0 : covariance / denominator;
}

export interface LagEstimate {
  lagMs: number;
  /** Peak correlation achieved, 0..1. */
  correlation: number;
  /** False when the estimate fell back to the default. */
  confident: boolean;
}

/**
 * Estimates how far the user trails the reference.
 *
 * Falls back to `CALIBRATION.lagDefaultMs` when correlation is too weak to
 * trust — a near-static warm-up section gives nothing to align, and a confident
 * wrong answer there would be worse than a sane default.
 */
export function estimateLag(reference: PoseFrame[], user: PoseFrame[]): LagEstimate {
  const fallback: LagEstimate = {
    lagMs: CALIBRATION.lagDefaultMs,
    correlation: 0,
    confident: false,
  };

  const referenceSignal = velocitySignal(reference);
  const userSignal = velocitySignal(user);
  if (referenceSignal.length < 4 || userSignal.length < 4) return fallback;

  const step = CALIBRATION.lagStepMs;
  const from = Math.max(referenceSignal[0]!.t, userSignal[0]!.t);
  // Leave room at the end for the largest shift, so every candidate offset is
  // evaluated over the same span and longer lags aren't penalised by having
  // fewer samples.
  const to =
    Math.min(
      referenceSignal[referenceSignal.length - 1]!.t,
      userSignal[userSignal.length - 1]!.t,
    ) - CALIBRATION.lagMaxMs;

  if (to - from < step * 8) return fallback;

  const referenceGrid = resample(referenceSignal, from, to, step);

  const candidates: Array<{ lagMs: number; correlation: number }> = [];
  let peak = -Infinity;
  for (let lag = CALIBRATION.lagMinMs; lag <= CALIBRATION.lagMaxMs; lag += step) {
    const userGrid = resample(userSignal, from + lag, to + lag, step);
    const correlation = correlate(referenceGrid, userGrid);
    candidates.push({ lagMs: lag, correlation });
    if (correlation > peak) peak = correlation;
  }

  if (peak < CALIBRATION.lagMinCorrelation) return fallback;

  // Beat-aliasing guard. Choreography is periodic, so the correlation curve has
  // near-equal peaks one beat apart and a plain argmax can land a whole beat
  // late — which then reads to the user as the app scoring them on the *next*
  // move. Among statistically tied offsets, take the earliest: people react in
  // a few hundred milliseconds, they don't wait out an extra bar.
  const tied = candidates.filter((c) => c.correlation >= peak - CALIBRATION.lagPeakTolerance);
  const chosen = tied.reduce((earliest, c) => (c.lagMs < earliest.lagMs ? c : earliest));

  return { lagMs: chosen.lagMs, correlation: chosen.correlation, confident: true };
}
