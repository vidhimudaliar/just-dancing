import { describe, expect, it } from 'vitest';
import { angleDifference, compareAngles, rate } from './compare';
import { ANGLE_WEIGHTS, SCORING } from '../tuning';
import type { AngleName, AngleSet } from '../pose/types';

const pose = (overrides: AngleSet = {}): AngleSet => ({
  l_elbow: 90,
  r_elbow: 90,
  l_shoulder: 45,
  r_shoulder: 45,
  l_hip: 170,
  r_hip: 170,
  l_knee: 175,
  r_knee: 175,
  torso_lean: 0,
  shoulder_tilt: 0,
  ...overrides,
});

describe('angleDifference', () => {
  it('subtracts directly for interior angles', () => {
    expect(angleDifference('l_elbow', 90, 120)).toBe(30);
  });

  it('wraps shoulder_tilt over a half turn', () => {
    // +89 and -89 describe nearly the same line, not a 178 degree difference.
    expect(angleDifference('shoulder_tilt', 89, -89)).toBeCloseTo(2, 5);
  });

  it('wraps torso_lean over a full turn', () => {
    expect(angleDifference('torso_lean', 179, -179)).toBeCloseTo(2, 5);
  });
});

describe('compareAngles', () => {
  it('scores identical poses as 100', () => {
    const result = compareAngles(pose(), pose());
    expect(result.similarity).toBe(100);
    expect(result.anglesUsed).toBe(10);
    expect(result.meanError).toBe(0);
  });

  it('clamps at zero rather than going negative', () => {
    const straight = pose({
      l_elbow: 0,
      r_elbow: 0,
      l_shoulder: 0,
      r_shoulder: 0,
      l_hip: 0,
      r_hip: 0,
      l_knee: 0,
      r_knee: 0,
      torso_lean: -90,
      shoulder_tilt: -45,
    });
    const opposite = pose({
      l_elbow: 180,
      r_elbow: 180,
      l_shoulder: 180,
      r_shoulder: 180,
      l_hip: 180,
      r_hip: 180,
      l_knee: 180,
      r_knee: 180,
      torso_lean: 90,
      shoulder_tilt: 45,
    });
    expect(compareAngles(straight, opposite).similarity).toBe(0);
  });

  /**
   * Documents how forgiving the scoring is, which spec §7.7 accepts deliberately.
   * Two maximally wrong elbows against eight perfect angles still lands near 6,
   * not 0 — a partial failure is diluted by everything that went right. If
   * tuning ever makes the app feel too generous, this ratio is the reason.
   */
  it('dilutes a localized error across the angles that matched', () => {
    const result = compareAngles(
      pose({ l_elbow: 0, r_elbow: 0 }),
      pose({ l_elbow: 180, r_elbow: 180 }),
    );
    expect(result.similarity).toBeGreaterThan(0);
    expect(result.similarity).toBeLessThan(15);
  });

  it('applies the K conversion to mean weighted error', () => {
    // A single 20-degree error on l_elbow (weight 1.5) across weights summing to 11.
    const totalWeight = Object.values(ANGLE_WEIGHTS).reduce((a, b) => a + b, 0);
    const expectedMeanError = (ANGLE_WEIGHTS.l_elbow * 20) / totalWeight;

    const result = compareAngles(pose(), pose({ l_elbow: 110 }));
    expect(result.meanError).toBeCloseTo(expectedMeanError, 5);
    expect(result.similarity).toBeCloseTo(100 - expectedMeanError * SCORING.K, 5);
  });

  it('weights arms above legs for the same error', () => {
    const armError = compareAngles(pose(), pose({ l_elbow: 120 }));
    const legError = compareAngles(pose(), pose({ l_knee: 145 }));
    expect(armError.similarity).toBeLessThan(legError.similarity);
  });

  it('renormalizes weights over the angles actually used', () => {
    // Upper body only, with one 20-degree arm error. The score must match what
    // the same error would produce if the leg angles had never existed, not be
    // diluted by treating missing legs as perfect.
    const allowed = new Set<AngleName>([
      'l_elbow',
      'r_elbow',
      'l_shoulder',
      'r_shoulder',
      'torso_lean',
      'shoulder_tilt',
    ]);
    const upperWeight = [...allowed].reduce((sum, name) => sum + ANGLE_WEIGHTS[name], 0);
    const expectedMeanError = (ANGLE_WEIGHTS.l_elbow * 20) / upperWeight;

    const result = compareAngles(pose(), pose({ l_elbow: 110 }), { allowedAngles: allowed });
    expect(result.anglesUsed).toBe(6);
    expect(result.meanError).toBeCloseTo(expectedMeanError, 5);
  });

  it('skips angles the user side is not confident about', () => {
    const result = compareAngles(pose(), pose({ l_elbow: 180 }), {
      userConfidence: { l_elbow: 0.05 },
    });
    // The bad angle is excluded entirely, so the rest scores clean.
    expect(result.anglesUsed).toBe(9);
    expect(result.similarity).toBe(100);
  });

  it('skips angles the reference side is not confident about', () => {
    const result = compareAngles(pose(), pose({ r_knee: 90 }), {
      referenceConfidence: { r_knee: 0.05 },
    });
    expect(result.anglesUsed).toBe(9);
    expect(result.similarity).toBe(100);
  });

  it('ignores angles the user is missing entirely', () => {
    const partial: AngleSet = { l_elbow: 90, r_elbow: 90, torso_lean: 0 };
    const result = compareAngles(pose(), partial);
    expect(result.anglesUsed).toBe(3);
    expect(result.similarity).toBe(100);
  });

  it('refuses to score on too little evidence', () => {
    const result = compareAngles(pose(), { l_elbow: 90, r_elbow: 90 });
    expect(result.anglesUsed).toBe(0);
    expect(result.similarity).toBe(0);
  });
});

describe('rate', () => {
  it('maps each bucket boundary', () => {
    expect(rate(100)).toEqual({ rating: 'Perfect', points: 100 });
    expect(rate(85)).toEqual({ rating: 'Perfect', points: 100 });
    expect(rate(84.9)).toEqual({ rating: 'Good', points: 70 });
    expect(rate(70)).toEqual({ rating: 'Good', points: 70 });
    expect(rate(69.9)).toEqual({ rating: 'OK', points: 40 });
    expect(rate(55)).toEqual({ rating: 'OK', points: 40 });
    expect(rate(54.9)).toEqual({ rating: 'Oops', points: 0 });
    expect(rate(0)).toEqual({ rating: 'Oops', points: 0 });
  });
});
