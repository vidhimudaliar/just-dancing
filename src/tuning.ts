/**
 * Every magic number in the app lives here.
 *
 * Spec §7.5 is explicit that these "will be wrong on the first pass" and can only
 * be fixed by dancing to the app repeatedly. Tuning must never mean hunting
 * through modules, so nothing below should be duplicated elsewhere.
 */

import type { AngleName, Rating } from './pose/types';

/** Angle weights (spec §5). Arms read as "the move" and detect more reliably than legs. */
export const ANGLE_WEIGHTS: Record<AngleName, number> = {
  l_elbow: 1.5,
  r_elbow: 1.5,
  l_shoulder: 1.5,
  r_shoulder: 1.5,
  l_hip: 1.0,
  r_hip: 1.0,
  l_knee: 1.0,
  r_knee: 1.0,
  torso_lean: 0.75,
  shoulder_tilt: 0.75,
};

export const CONFIDENCE = {
  /** Below this a keypoint is treated as absent when computing angles. */
  keypoint: 0.3,
  /** Below this an angle is excluded from scoring and weights renormalize (spec §7.4). */
  angle: 0.35,
  /** Checkpoint detection drops minima below this mean confidence (spec §6.1). */
  checkpoint: 0.6,
  /** Framing calibration needs this much confidence to call a body part "visible". */
  framing: 0.4,
};

export const SCORING = {
  /**
   * Converts mean weighted angle error (degrees) to a 0..100 similarity:
   *   similarity = max(0, 100 - meanErrorDegrees * K)
   * K = 2.0 means a 50-degree mean error scores zero and ~7.5 degrees scores 85
   * ("Perfect"). This is the single most impactful tuning knob in the app.
   */
  K: 2.0,
  /** Half-width of the candidate window around t + lag (spec §7.4). */
  windowMs: 300,
  /** How much history the user pose buffer keeps (spec §4). Must exceed lag + window. */
  bufferMs: 1500,
  /** An angle set with fewer contributing angles than this is not scored at all. */
  minAnglesForScore: 3,
};

/** Rating buckets (spec §7.5). Starting values only. */
export const RATING_BUCKETS: ReadonlyArray<{ min: number; rating: Rating; points: number }> = [
  { min: 85, rating: 'Perfect', points: 100 },
  { min: 70, rating: 'Good', points: 70 },
  { min: 55, rating: 'OK', points: 40 },
  { min: 0, rating: 'Oops', points: 0 },
];

export const CHECKPOINTS = {
  /** Fixed-interval emitter spacing (spec §6.2). */
  fixedIntervalMs: 400,
  /** Minimum gap between velocity minima (spec §6.1). */
  minSpacingMs: 300,
  /** Hard cap on checkpoint rate (spec §6.1). */
  maxPerSecond: 4,
  /** Moving-average window for velocity smoothing, in frames (spec §6.1). */
  smoothingFrames: 5,
};

export const CALIBRATION = {
  /** Length of the warm-up window where scoring is suppressed (spec §7.2). */
  durationMs: 10_000,
  /** Cross-correlation search range for user reaction lag (spec §7.2). */
  lagMinMs: 0,
  lagMaxMs: 800,
  /** Step size for the lag search. */
  lagStepMs: 33,
  /** Used when correlation is too weak to trust (spec §7.2). */
  lagDefaultMs: 300,
  /** Peak correlation below this is considered weak, triggering the default. */
  lagMinCorrelation: 0.2,
  /**
   * Choreography is built on the beat, so the movement signal is strongly
   * periodic and cross-correlation peaks repeat at the beat interval — at
   * 120bpm that's every 500ms, well inside the 0–800ms search range. Offsets
   * scoring within this much of the best are treated as tied, and the smallest
   * wins, because a human reacts in 200–400ms rather than waiting an extra beat.
   */
  lagPeakTolerance: 0.05,
  /**
   * Mirror detection needs this much separation between the two orientations to
   * commit; below it the choreography is too symmetric to tell and we keep
   * `direct` rather than coin-flipping.
   */
  mirrorMinMargin: 2.0,
};

export const DETECTION = {
  /** Reference detector throttle (spec §8 mitigation, applied from the start). */
  referenceFps: 15,
  /** Webcam detector target — runs every animation frame, capped here. */
  webcamFps: 30,
};

export const CACHE = {
  /** Bump to invalidate every stored checkpoint file. */
  version: 1,
  dbName: 'dance-scoring',
  storeName: 'checkpoints',
};
