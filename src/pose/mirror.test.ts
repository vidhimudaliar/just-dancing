import { describe, expect, it } from 'vitest';
import { computeAngles } from './angles';
import { applyOrientation, mirrorAngles, mirrorConfidence } from './mirror';
import type { AngleName, AngleSet, Keypoint, KeypointMap, KeypointName } from './types';

const kp = (x: number, y: number, score = 1): Keypoint => ({ x, y, score });

/** An asymmetric pose — symmetric ones can't detect a broken mirror. */
function lopsidedPose(): KeypointMap {
  return {
    left_shoulder: kp(-20, 100),
    right_shoulder: kp(25, 110),
    left_elbow: kp(-45, 70),
    right_elbow: kp(40, 150),
    left_wrist: kp(-30, 30),
    right_wrist: kp(70, 175),
    left_hip: kp(-15, 200),
    right_hip: kp(18, 205),
    left_knee: kp(-40, 255),
    right_knee: kp(20, 262),
    left_ankle: kp(-25, 315),
    right_ankle: kp(35, 322),
  };
}

/**
 * Physically reflects a pose about a vertical axis: negate x, and swap the
 * anatomical left/right labels, because a detector looking at the reflected
 * image would label the limbs the other way round.
 */
function reflectKeypoints(pose: KeypointMap): KeypointMap {
  const out: KeypointMap = {};
  for (const [name, point] of Object.entries(pose) as [KeypointName, Keypoint][]) {
    const swapped = name.startsWith('left_')
      ? (name.replace('left_', 'right_') as KeypointName)
      : (name.replace('right_', 'left_') as KeypointName);
    out[swapped] = { x: -point.x, y: point.y, score: point.score };
  }
  return out;
}

function expectAnglesClose(actual: AngleSet, expected: AngleSet): void {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const name of Object.keys(expected) as AngleName[]) {
    expect(actual[name]).toBeCloseTo(expected[name]!, 5);
  }
}

describe('mirrorAngles', () => {
  it('swaps left and right interior angles', () => {
    const mirrored = mirrorAngles({ l_elbow: 90, r_elbow: 170 });
    expect(mirrored.l_elbow).toBe(170);
    expect(mirrored.r_elbow).toBe(90);
  });

  it('negates the signed angles', () => {
    const mirrored = mirrorAngles({ torso_lean: 12, shoulder_tilt: -5 });
    expect(mirrored.torso_lean).toBe(-12);
    expect(mirrored.shoulder_tilt).toBe(5);
  });

  it('normalizes negative zero so cached JSON round-trips', () => {
    expect(Object.is(mirrorAngles({ torso_lean: 0 }).torso_lean, 0)).toBe(true);
  });

  it('is its own inverse', () => {
    const original = computeAngles(lopsidedPose()).angles;
    expectAnglesClose(mirrorAngles(mirrorAngles(original)), original);
  });

  it('preserves absence — a missing angle stays missing', () => {
    const mirrored = mirrorAngles({ l_elbow: 90 });
    expect('r_elbow' in mirrored).toBe(true);
    expect('l_elbow' in mirrored).toBe(false);
  });

  /**
   * The real proof: mirroring in angle space must equal what the detector would
   * have produced from a physically reflected body. If this passes, the app
   * never needs to flip pixels.
   */
  it('matches angles computed from a physically reflected pose', () => {
    const pose = lopsidedPose();
    const fromReflectedPixels = computeAngles(reflectKeypoints(pose)).angles;
    const fromAngleTransform = mirrorAngles(computeAngles(pose).angles);

    expectAnglesClose(fromAngleTransform, fromReflectedPixels);
  });
});

describe('mirrorConfidence', () => {
  it('swaps sides without touching values', () => {
    const swapped = mirrorConfidence({ l_knee: 0.4, r_knee: 0.9, torso_lean: 0.7 });
    expect(swapped.l_knee).toBe(0.9);
    expect(swapped.r_knee).toBe(0.4);
    expect(swapped.torso_lean).toBe(0.7);
  });
});

describe('applyOrientation', () => {
  it('leaves angles untouched when direct', () => {
    const angles: AngleSet = { l_elbow: 90, torso_lean: 5 };
    expect(applyOrientation(angles, 'direct')).toBe(angles);
  });

  it('mirrors when mirrored', () => {
    expect(applyOrientation({ l_elbow: 90 }, 'mirrored').r_elbow).toBe(90);
  });
});
