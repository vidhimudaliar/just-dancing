/**
 * Converts MoveNet's 17 COCO keypoints into the 10 tracked angles (spec §5).
 *
 * Angles are used instead of raw coordinates because they are inherently scale-
 * and position-invariant: camera distance and body proportions drop out, so no
 * normalization step is needed anywhere downstream.
 *
 * Coordinate convention: image space, y increasing **downward**. Every sign
 * below depends on that, so don't "fix" a negation without re-reading this.
 */

import { CONFIDENCE } from '../tuning';
import type {
  AngleConfidence,
  AngleName,
  AngleSet,
  Keypoint,
  KeypointMap,
  KeypointName,
} from './types';

/** Returns the keypoint only if it clears the confidence floor. */
function usable(kp: Keypoint | undefined): Keypoint | undefined {
  if (!kp) return undefined;
  return kp.score >= CONFIDENCE.keypoint ? kp : undefined;
}

/**
 * Unsigned interior angle at `b`, in degrees 0..180 — the angle between the
 * vectors b→a and b→c.
 */
export function interiorAngle(a: Keypoint, b: Keypoint, c: Keypoint): number {
  const ax = a.x - b.x;
  const ay = a.y - b.y;
  const cx = c.x - b.x;
  const cy = c.y - b.y;

  const magA = Math.hypot(ax, ay);
  const magC = Math.hypot(cx, cy);
  // Degenerate: coincident points carry no angular information.
  if (magA === 0 || magC === 0) return Number.NaN;

  const cos = (ax * cx + ay * cy) / (magA * magC);
  // Guard against floating-point drift pushing |cos| past 1.
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

/**
 * Signed lean of the torso away from vertical, in degrees.
 * Positive = shoulders displaced toward +x relative to the hips.
 */
export function torsoLean(
  lShoulder: Keypoint,
  rShoulder: Keypoint,
  lHip: Keypoint,
  rHip: Keypoint,
): number {
  const shoulderMidX = (lShoulder.x + rShoulder.x) / 2;
  const shoulderMidY = (lShoulder.y + rShoulder.y) / 2;
  const hipMidX = (lHip.x + rHip.x) / 2;
  const hipMidY = (lHip.y + rHip.y) / 2;

  const dx = shoulderMidX - hipMidX;
  const dy = shoulderMidY - hipMidY;
  if (dx === 0 && dy === 0) return Number.NaN;

  // "Up" in image space is -y, so measure dx against -dy.
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

/**
 * Signed tilt of the shoulder line away from horizontal, in degrees (-90..90].
 *
 * Measured as a *line*, not a ray: when the shoulder vector points in -x we flip
 * it, so the result stays in a half-turn range instead of jumping near ±180 when
 * the subject turns around.
 */
export function shoulderTilt(lShoulder: Keypoint, rShoulder: Keypoint): number {
  let dx = rShoulder.x - lShoulder.x;
  let dy = rShoulder.y - lShoulder.y;
  if (dx === 0 && dy === 0) return Number.NaN;

  if (dx < 0) {
    dx = -dx;
    dy = -dy;
  }
  // Negate dy to convert image space (y down) to math space (y up).
  return (Math.atan2(-dy, dx) * 180) / Math.PI;
}

/** Which keypoints each angle is computed from (spec §5 table). */
const ANGLE_INPUTS: Record<AngleName, readonly KeypointName[]> = {
  l_elbow: ['left_shoulder', 'left_elbow', 'left_wrist'],
  r_elbow: ['right_shoulder', 'right_elbow', 'right_wrist'],
  l_shoulder: ['left_elbow', 'left_shoulder', 'left_hip'],
  r_shoulder: ['right_elbow', 'right_shoulder', 'right_hip'],
  l_hip: ['left_shoulder', 'left_hip', 'left_knee'],
  r_hip: ['right_shoulder', 'right_hip', 'right_knee'],
  l_knee: ['left_hip', 'left_knee', 'left_ankle'],
  r_knee: ['right_hip', 'right_knee', 'right_ankle'],
  torso_lean: ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'],
  shoulder_tilt: ['left_shoulder', 'right_shoulder'],
};

/**
 * Computes all available angles from a keypoint map.
 *
 * An angle is **omitted** — not set to zero — when any input keypoint is missing
 * or below the confidence floor. Zero is a legitimate angle value, so the two
 * must never be conflated; downstream scoring renormalizes weights over whatever
 * angles actually survived.
 */
export function computeAngles(kps: KeypointMap): {
  angles: AngleSet;
  confidence: AngleConfidence;
} {
  const angles: AngleSet = {};
  const confidence: AngleConfidence = {};

  for (const name of Object.keys(ANGLE_INPUTS) as AngleName[]) {
    const inputs = ANGLE_INPUTS[name];
    const pts: Keypoint[] = [];
    let minScore = 1;
    let complete = true;

    for (const kpName of inputs) {
      const kp = usable(kps[kpName]);
      if (!kp) {
        complete = false;
        break;
      }
      pts.push(kp);
      minScore = Math.min(minScore, kp.score);
    }
    if (!complete) continue;

    let value: number;
    if (name === 'torso_lean') {
      value = torsoLean(pts[0]!, pts[1]!, pts[2]!, pts[3]!);
    } else if (name === 'shoulder_tilt') {
      value = shoulderTilt(pts[0]!, pts[1]!);
    } else {
      value = interiorAngle(pts[0]!, pts[1]!, pts[2]!);
    }

    if (Number.isNaN(value)) continue;

    angles[name] = value;
    // An angle is only as trustworthy as its weakest input.
    confidence[name] = minScore;
  }

  return { angles, confidence };
}

/** Mean score across detected keypoints, used for checkpoint confidence gating. */
export function meanKeypointScore(kps: KeypointMap): number {
  const scores = Object.values(kps).map((kp) => kp.score);
  if (scores.length === 0) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}
