/**
 * Weighted angle comparison (spec §7.4).
 *
 * Produces a 0..100 similarity between a reference angle set and a user angle
 * set, scoring only the angles both sides actually have at sufficient confidence
 * and renormalizing the weights over those. That renormalization is what lets
 * UPPER_BODY mode work without tanking scores: dropping four leg angles reduces
 * the evidence, not the score.
 */

import { ANGLE_WEIGHTS, CONFIDENCE, RATING_BUCKETS, SCORING } from '../tuning';
import type { AngleConfidence, AngleName, AngleSet, Rating } from '../pose/types';

/**
 * How far apart two values of a given angle are, in degrees.
 *
 * Interior angles live in 0..180 and never wrap. The two signed angles do wrap,
 * so a naive subtraction would report a near-maximal error for two poses that
 * are in fact almost identical (e.g. a shoulder tilt of +89° vs -89°, which is
 * a 2° difference in the line's orientation).
 */
export function angleDifference(name: AngleName, a: number, b: number): number {
  const raw = Math.abs(a - b);
  if (name === 'shoulder_tilt') {
    // Measured as a line: period 180.
    return Math.min(raw, 180 - raw);
  }
  if (name === 'torso_lean') {
    // Measured as a direction: period 360.
    return Math.min(raw, 360 - raw);
  }
  return raw;
}

export interface ComparisonResult {
  /** 0..100. */
  similarity: number;
  /** How many angles contributed after gating. */
  anglesUsed: number;
  /** Mean weighted error in degrees, before the K conversion — useful for tuning. */
  meanError: number;
}

/** Returned when there wasn't enough usable evidence to score. */
export const NO_COMPARISON: ComparisonResult = {
  similarity: 0,
  anglesUsed: 0,
  meanError: Number.NaN,
};

/**
 * Compares one user pose against one reference pose.
 *
 * `allowedAngles` restricts scoring to a subset (UPPER_BODY mode). Angles below
 * the confidence floor on either side are skipped and their weight removed from
 * the denominator, per spec §7.4 step 4.
 */
export function compareAngles(
  reference: AngleSet,
  user: AngleSet,
  options: {
    userConfidence?: AngleConfidence;
    referenceConfidence?: AngleConfidence;
    allowedAngles?: ReadonlySet<AngleName>;
  } = {},
): ComparisonResult {
  const { userConfidence, referenceConfidence, allowedAngles } = options;

  let weightedError = 0;
  let totalWeight = 0;
  let anglesUsed = 0;

  for (const name of Object.keys(reference) as AngleName[]) {
    if (allowedAngles && !allowedAngles.has(name)) continue;

    const refValue = reference[name];
    const userValue = user[name];
    if (refValue === undefined || userValue === undefined) continue;

    const uc = userConfidence?.[name];
    if (uc !== undefined && uc < CONFIDENCE.angle) continue;
    const rc = referenceConfidence?.[name];
    if (rc !== undefined && rc < CONFIDENCE.angle) continue;

    const weight = ANGLE_WEIGHTS[name];
    weightedError += weight * angleDifference(name, userValue, refValue);
    totalWeight += weight;
    anglesUsed += 1;
  }

  if (anglesUsed < SCORING.minAnglesForScore || totalWeight === 0) {
    return NO_COMPARISON;
  }

  const meanError = weightedError / totalWeight;
  const similarity = Math.max(0, 100 - meanError * SCORING.K);

  return { similarity, anglesUsed, meanError };
}

/** Maps a 0..100 similarity to its rating bucket (spec §7.5). */
export function rate(similarity: number): { rating: Rating; points: number } {
  for (const bucket of RATING_BUCKETS) {
    if (similarity >= bucket.min) {
      return { rating: bucket.rating, points: bucket.points };
    }
  }
  // RATING_BUCKETS ends at min: 0, so this is unreachable for finite input.
  return { rating: 'Oops', points: 0 };
}
