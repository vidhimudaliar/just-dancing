/**
 * Mirror handling (spec §2.3, §7.3).
 *
 * Official Just Dance videos are often — but not always — pre-mirrored, and this
 * cannot be determined from the URL. Rather than flipping pixels and re-running
 * detection, mirroring is applied in *angle space*, which makes it cheap enough
 * to score both orientations on every frame during calibration.
 *
 * Reflecting a body about a vertical axis has exactly two effects on the ten
 * tracked angles:
 *   1. The eight unsigned interior angles keep their values but swap l_/r_ labels
 *      (the reflected body's left elbow occupies the original's right elbow).
 *   2. `torso_lean` and `shoulder_tilt` negate, because their sign encodes a
 *      direction along the x axis. See the derivation in angles.ts.
 */

import type { AngleConfidence, AngleName, AngleSet } from './types';

export type Orientation = 'direct' | 'mirrored';

/** l_ ↔ r_ pairs. Angles absent from this map are unaffected by the swap. */
const SWAP: Partial<Record<AngleName, AngleName>> = {
  l_elbow: 'r_elbow',
  r_elbow: 'l_elbow',
  l_shoulder: 'r_shoulder',
  r_shoulder: 'l_shoulder',
  l_hip: 'r_hip',
  r_hip: 'l_hip',
  l_knee: 'r_knee',
  r_knee: 'l_knee',
};

/**
 * Reflects an angle set. This is its own inverse: `mirror(mirror(a))` deep-equals `a`.
 */
export function mirrorAngles(angles: AngleSet): AngleSet {
  const out: AngleSet = {};
  for (const key of Object.keys(angles) as AngleName[]) {
    const value = angles[key];
    if (value === undefined) continue;

    if (key === 'torso_lean' || key === 'shoulder_tilt') {
      // Negating zero yields -0, which compares equal to 0 but serializes
      // differently; normalize so cached JSON round-trips cleanly.
      out[key] = value === 0 ? 0 : -value;
    } else {
      out[SWAP[key] ?? key] = value;
    }
  }
  return out;
}

/** Confidences follow the same l_/r_ swap; they have no sign to flip. */
export function mirrorConfidence(confidence: AngleConfidence): AngleConfidence {
  const out: AngleConfidence = {};
  for (const key of Object.keys(confidence) as AngleName[]) {
    const value = confidence[key];
    if (value === undefined) continue;
    out[SWAP[key] ?? key] = value;
  }
  return out;
}

/** Applies a mirror only when the orientation calls for it. */
export function applyOrientation(angles: AngleSet, orientation: Orientation): AngleSet {
  return orientation === 'mirrored' ? mirrorAngles(angles) : angles;
}
