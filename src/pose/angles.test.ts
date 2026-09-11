import { describe, expect, it } from 'vitest';
import { computeAngles, interiorAngle, shoulderTilt, torsoLean } from './angles';
import type { Keypoint, KeypointMap } from './types';

const kp = (x: number, y: number, score = 1): Keypoint => ({ x, y, score });

describe('interiorAngle', () => {
  it('measures a right angle', () => {
    // Arm bent 90 degrees: shoulder above elbow, wrist to the right of elbow.
    expect(interiorAngle(kp(0, 0), kp(0, 10), kp(10, 10))).toBeCloseTo(90, 5);
  });

  it('measures a straight limb as 180', () => {
    expect(interiorAngle(kp(0, 0), kp(0, 10), kp(0, 20))).toBeCloseTo(180, 5);
  });

  it('measures a fully folded limb as 0', () => {
    expect(interiorAngle(kp(0, 0), kp(0, 10), kp(0, 0))).toBeCloseTo(0, 5);
  });

  it('is unsigned — bending either way gives the same angle', () => {
    const left = interiorAngle(kp(0, 0), kp(0, 10), kp(-10, 10));
    const right = interiorAngle(kp(0, 0), kp(0, 10), kp(10, 10));
    expect(left).toBeCloseTo(right, 5);
  });

  it('returns NaN for coincident points rather than a fake angle', () => {
    expect(interiorAngle(kp(5, 5), kp(5, 5), kp(10, 10))).toBeNaN();
  });
});

describe('torsoLean', () => {
  it('is zero when upright', () => {
    // Shoulders directly above hips (y grows downward, so shoulders have smaller y).
    expect(torsoLean(kp(-10, 0), kp(10, 0), kp(-10, 50), kp(10, 50))).toBeCloseTo(0, 5);
  });

  it('is positive when shoulders lean toward +x', () => {
    expect(torsoLean(kp(10, 0), kp(30, 0), kp(-10, 50), kp(10, 50))).toBeGreaterThan(0);
  });

  it('is negative when shoulders lean toward -x', () => {
    expect(torsoLean(kp(-30, 0), kp(-10, 0), kp(-10, 50), kp(10, 50))).toBeLessThan(0);
  });

  it('measures a 45 degree lean', () => {
    // Shoulder midpoint 50 right and 50 up from hip midpoint.
    expect(torsoLean(kp(40, 0), kp(60, 0), kp(-10, 50), kp(10, 50))).toBeCloseTo(45, 5);
  });
});

describe('shoulderTilt', () => {
  it('is zero when shoulders are level', () => {
    expect(shoulderTilt(kp(-10, 20), kp(10, 20))).toBeCloseTo(0, 5);
  });

  it('is negative when the right shoulder is lower in image space', () => {
    // y grows downward, so a larger y on the right shoulder means it hangs lower.
    expect(shoulderTilt(kp(-10, 0), kp(10, 10))).toBeLessThan(0);
  });

  it('stays in a half-turn range when the subject turns around', () => {
    // Right shoulder now appears to the left of the left shoulder.
    const tilt = shoulderTilt(kp(10, 0), kp(-10, 10));
    expect(tilt).toBeGreaterThan(-90);
    expect(tilt).toBeLessThanOrEqual(90);
  });
});

describe('computeAngles', () => {
  /** A plausible upright figure with every keypoint confident. */
  function standingPose(score = 1): KeypointMap {
    return {
      left_shoulder: kp(-20, 100, score),
      right_shoulder: kp(20, 100, score),
      left_elbow: kp(-30, 140, score),
      right_elbow: kp(30, 140, score),
      left_wrist: kp(-35, 180, score),
      right_wrist: kp(35, 180, score),
      left_hip: kp(-15, 200, score),
      right_hip: kp(15, 200, score),
      left_knee: kp(-15, 260, score),
      right_knee: kp(15, 260, score),
      left_ankle: kp(-15, 320, score),
      right_ankle: kp(15, 320, score),
    };
  }

  it('computes all ten angles for a fully visible figure', () => {
    const { angles, confidence } = computeAngles(standingPose());
    expect(Object.keys(angles).sort()).toEqual(
      [
        'l_elbow',
        'l_hip',
        'l_knee',
        'l_shoulder',
        'r_elbow',
        'r_hip',
        'r_knee',
        'r_shoulder',
        'shoulder_tilt',
        'torso_lean',
      ].sort(),
    );
    expect(Object.keys(confidence)).toHaveLength(10);
  });

  it('omits angles rather than zeroing them when keypoints are missing', () => {
    const pose = standingPose();
    delete pose.left_ankle;
    const { angles } = computeAngles(pose);

    // Zero is a legitimate angle, so absence must be represented by absence.
    expect('l_knee' in angles).toBe(false);
    expect(angles.l_knee).toBeUndefined();
    // The other leg is unaffected.
    expect(angles.r_knee).toBeDefined();
  });

  it('omits angles whose keypoints are below the confidence floor', () => {
    const pose = standingPose();
    pose.left_wrist = kp(-35, 180, 0.05);
    const { angles } = computeAngles(pose);

    expect(angles.l_elbow).toBeUndefined();
    expect(angles.r_elbow).toBeDefined();
  });

  it('reports an angle confidence equal to its weakest input keypoint', () => {
    const pose = standingPose(0.9);
    pose.left_wrist = kp(-35, 180, 0.5);
    const { confidence } = computeAngles(pose);

    expect(confidence.l_elbow).toBeCloseTo(0.5, 5);
    expect(confidence.r_elbow).toBeCloseTo(0.9, 5);
  });

  it('degrades to upper-body angles when the legs are not visible', () => {
    const pose = standingPose();
    for (const name of ['left_knee', 'right_knee', 'left_ankle', 'right_ankle'] as const) {
      delete pose[name];
    }
    const { angles } = computeAngles(pose);

    expect(angles.l_knee).toBeUndefined();
    expect(angles.r_knee).toBeUndefined();
    expect(angles.l_hip).toBeUndefined();
    expect(angles.l_elbow).toBeDefined();
    expect(angles.torso_lean).toBeDefined();
    expect(angles.shoulder_tilt).toBeDefined();
  });
});
