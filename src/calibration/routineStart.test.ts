/**
 * Routine-start detection is exercised through `angleVelocity`, the signal the
 * session thresholds on. These tests pin the property that matters: menu
 * footage must read as still, and dancing must read as moving, with enough
 * separation that one threshold cleanly divides them.
 */

import { describe, expect, it } from 'vitest';
import { angleVelocity } from './lag';
import { CALIBRATION } from '../tuning';
import type { AngleSet, PoseFrame } from '../pose/types';

const STEP = 1000 / 15; // Reference detector runs at 15fps.

function frame(t: number, angles: AngleSet, meanScore = 0.9): PoseFrame {
  return { t, keypoints: {}, angles, confidence: {}, meanScore };
}

const NEUTRAL: AngleSet = {
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
};

/** Adds small random wobble, standing in for detector jitter on a still subject. */
function jittered(base: AngleSet, amount: number, seed: number): AngleSet {
  const out: AngleSet = {};
  let n = seed;
  for (const [key, value] of Object.entries(base)) {
    // Deterministic pseudo-random so the test can't flake.
    n = (n * 1103515245 + 12345) % 2147483648;
    const offset = ((n / 2147483648) * 2 - 1) * amount;
    out[key as keyof AngleSet] = value + offset;
  }
  return out;
}

describe('routine-start signal', () => {
  it('reads a perfectly static screen as no movement', () => {
    const a = frame(0, NEUTRAL);
    const b = frame(STEP, NEUTRAL);
    expect(angleVelocity(a, b)).toBe(0);
  });

  it('keeps detector jitter on a still subject below the threshold', () => {
    // A couple of degrees of wobble per frame is normal MoveNet noise. If this
    // cleared the threshold, every menu screen would look like dancing.
    let previous = frame(0, jittered(NEUTRAL, 2, 1));
    for (let i = 1; i < 40; i += 1) {
      const current = frame(i * STEP, jittered(NEUTRAL, 2, i + 1));
      const velocity = angleVelocity(previous, current)!;
      expect(velocity).toBeLessThan(CALIBRATION.routineMovementThreshold);
      previous = current;
    }
  });

  it('reads real dancing as above the threshold', () => {
    // A limb sweeping through ~90 degrees over about half a second.
    let previous = frame(0, NEUTRAL);
    let above = 0;
    let total = 0;

    for (let i = 1; i < 40; i += 1) {
      const t = i * STEP;
      const phase = (t / 500) * Math.PI;
      const current = frame(t, {
        ...NEUTRAL,
        l_elbow: 90 + 60 * Math.sin(phase),
        r_elbow: 90 + 60 * Math.cos(phase),
        l_shoulder: 45 + 40 * Math.sin(phase),
        r_shoulder: 45 + 40 * Math.cos(phase),
      });
      const velocity = angleVelocity(previous, current)!;
      if (velocity >= CALIBRATION.routineMovementThreshold) above += 1;
      total += 1;
      previous = current;
    }

    // The overwhelming majority of dancing frames must clear the bar, or the
    // confirm window would never accumulate.
    expect(above / total).toBeGreaterThan(0.8);
  });

  it('separates a held pose from a transition', () => {
    const held = angleVelocity(frame(0, NEUTRAL), frame(STEP, NEUTRAL))!;
    const moving = angleVelocity(
      frame(0, NEUTRAL),
      frame(STEP, { ...NEUTRAL, l_elbow: 150, r_elbow: 30 }),
    )!;
    expect(moving).toBeGreaterThan(held);
    expect(moving).toBeGreaterThan(CALIBRATION.routineMovementThreshold);
  });

  it('is frame-rate independent, so the threshold holds at any detector speed', () => {
    // Same angular rate, sampled at 15fps and at 30fps.
    const slow = angleVelocity(frame(0, NEUTRAL), frame(66, { ...NEUTRAL, l_elbow: 156 }))!;
    const fast = angleVelocity(frame(0, NEUTRAL), frame(33, { ...NEUTRAL, l_elbow: 123 }))!;
    expect(slow).toBeCloseTo(fast, 4);
  });

  it('confirm window is long enough to reject a brief menu transition', () => {
    // A UI wipe might register movement for a few frames; the routine must
    // require substantially more than that before calibration begins.
    const framesToConfirm = CALIBRATION.routineConfirmMs / STEP;
    expect(framesToConfirm).toBeGreaterThan(10);
  });
});
