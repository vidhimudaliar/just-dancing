import { describe, expect, it } from 'vitest';
import { correlate, estimateLag, resample, velocitySignal } from './lag';
import { detectMirror } from './mirrorDetect';
import { mirrorAngles } from '../pose/mirror';
import { CALIBRATION } from '../tuning';
import type { AngleSet, PoseFrame } from '../pose/types';

function frame(t: number, angles: AngleSet): PoseFrame {
  return { t, keypoints: {}, angles, confidence: {}, meanScore: 0.9 };
}

/**
 * A routine whose movement never exactly repeats — the sweep speeds up over
 * time. That gives cross-correlation a single unambiguous peak, which isolates
 * "can the estimator recover a shift at all?" from the separate question of what
 * it does when the signal *is* periodic (covered by `beatRoutine` below).
 */
function routine(from: number, to: number, stepMs: number, phaseMs = 0): PoseFrame[] {
  const frames: PoseFrame[] = [];
  for (let t = from; t <= to; t += stepMs) {
    const u = t - phaseMs;
    // Chirp: frequency climbs with time, so no two windows look alike.
    const phase = ((u / 1000) * (1 + u / 20_000) * Math.PI * 2);
    frames.push(
      frame(t, {
        l_elbow: 90 + 70 * Math.sin(phase),
        r_elbow: 90 + 70 * Math.cos(phase * 0.7),
        l_shoulder: 90 + 45 * Math.sin(phase * 0.37),
        r_shoulder: 90 + 45 * Math.cos(phase * 0.53),
        l_hip: 170,
        r_hip: 170,
        l_knee: 175,
        r_knee: 175,
        torso_lean: 10 * Math.sin(phase * 0.29),
        shoulder_tilt: 5 * Math.cos(phase * 0.61),
      }),
    );
  }
  return frames;
}

/** A strictly on-the-beat routine: every move repeats exactly every `beatMs`. */
function beatRoutine(to: number, stepMs: number, beatMs: number, phaseMs = 0): PoseFrame[] {
  const frames: PoseFrame[] = [];
  for (let t = 0; t <= to; t += stepMs) {
    const phase = ((t - phaseMs) / beatMs) * Math.PI * 2;
    frames.push(
      frame(t, {
        l_elbow: 90 + 70 * Math.sin(phase),
        r_elbow: 90 + 50 * Math.sin(phase + 1),
        l_shoulder: 90 + 40 * Math.sin(phase + 2),
        r_shoulder: 90 + 40 * Math.sin(phase + 0.5),
        l_hip: 170,
        r_hip: 170,
        l_knee: 175,
        r_knee: 175,
        torso_lean: 10 * Math.sin(phase),
        shoulder_tilt: 5 * Math.sin(phase + 1.5),
      }),
    );
  }
  return frames;
}

describe('velocitySignal', () => {
  it('is near zero for a held pose', () => {
    const held = [frame(0, { l_elbow: 90 }), frame(33, { l_elbow: 90 }), frame(66, { l_elbow: 90 })];
    for (const sample of velocitySignal(held)) {
      expect(sample.v).toBeCloseTo(0, 6);
    }
  });

  it('rises when the body moves', () => {
    const moving = [frame(0, { l_elbow: 0 }), frame(33, { l_elbow: 60 })];
    expect(velocitySignal(moving)[0]!.v).toBeGreaterThan(0);
  });

  it('normalizes by elapsed time so different frame rates are comparable', () => {
    const fast = velocitySignal([frame(0, { l_elbow: 0 }), frame(33, { l_elbow: 33 })]);
    const slow = velocitySignal([frame(0, { l_elbow: 0 }), frame(66, { l_elbow: 66 })]);
    // Same angular rate sampled at different intervals must agree.
    expect(fast[0]!.v).toBeCloseTo(slow[0]!.v, 6);
  });

  it('skips frames with no angles in common', () => {
    const disjoint = [frame(0, { l_elbow: 90 }), frame(33, { r_knee: 170 })];
    expect(velocitySignal(disjoint)).toHaveLength(0);
  });
});

describe('resample', () => {
  it('interpolates onto a uniform grid', () => {
    const grid = resample([{ t: 0, v: 0 }, { t: 100, v: 10 }], 0, 100, 50);
    expect(grid).toHaveLength(3);
    expect(grid[0]).toBeCloseTo(0, 6);
    expect(grid[1]).toBeCloseTo(5, 6);
    expect(grid[2]).toBeCloseTo(10, 6);
  });

  it('holds the edge value outside the signal', () => {
    const grid = resample([{ t: 100, v: 7 }], 0, 200, 100);
    expect(grid.every((v) => v === 7)).toBe(true);
  });
});

describe('correlate', () => {
  it('is 1 for identical signals', () => {
    expect(correlate([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1, 6);
  });

  it('is -1 for inverted signals', () => {
    expect(correlate([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 6);
  });

  it('is 0 for a constant signal, where correlation is undefined', () => {
    expect(correlate([1, 2, 3, 4], [5, 5, 5, 5])).toBe(0);
  });
});

describe('estimateLag', () => {
  it('recovers a known shift', () => {
    const reference = routine(0, 10_000, 66);
    // The user does the same routine 300ms later.
    const user = routine(0, 10_000, 33, 300);

    const estimate = estimateLag(reference, user);
    expect(estimate.confident).toBe(true);
    expect(estimate.lagMs).toBeGreaterThanOrEqual(300 - CALIBRATION.lagStepMs * 2);
    expect(estimate.lagMs).toBeLessThanOrEqual(300 + CALIBRATION.lagStepMs * 2);
  });

  it('recovers a different shift', () => {
    const estimate = estimateLag(routine(0, 10_000, 66), routine(0, 10_000, 33, 500));
    expect(estimate.confident).toBe(true);
    expect(Math.abs(estimate.lagMs - 500)).toBeLessThanOrEqual(CALIBRATION.lagStepMs * 2);
  });

  it('handles the two detectors running at different frame rates', () => {
    // Reference throttled to 15fps, webcam at 30fps — the real configuration.
    const estimate = estimateLag(routine(0, 10_000, 1000 / 15), routine(0, 10_000, 1000 / 30, 300));
    expect(estimate.confident).toBe(true);
    expect(Math.abs(estimate.lagMs - 300)).toBeLessThanOrEqual(CALIBRATION.lagStepMs * 2);
  });

  /**
   * Beat aliasing. Choreography is periodic by construction, so the correlation
   * curve has near-equal peaks one beat apart — at 120bpm that's 500ms, inside
   * the search range. A plain argmax can pick the later peak and put the app a
   * whole beat behind, which would feel like it is scoring the *next* move.
   */
  it('prefers the earliest of several beat-spaced peaks', () => {
    const beatMs = 500;
    const reference = beatRoutine(12_000, 66, beatMs);
    const user = beatRoutine(12_000, 33, beatMs, 250);

    const estimate = estimateLag(reference, user);
    expect(estimate.confident).toBe(true);
    // 250 and 750 correlate equally well; the human-plausible one must win.
    expect(estimate.lagMs).toBeLessThan(beatMs);
    expect(Math.abs(estimate.lagMs - 250)).toBeLessThanOrEqual(CALIBRATION.lagStepMs * 2);
  });

  it('never reports a lag outside the configured search range', () => {
    const estimate = estimateLag(routine(0, 10_000, 66), routine(0, 10_000, 33, 400));
    expect(estimate.lagMs).toBeGreaterThanOrEqual(CALIBRATION.lagMinMs);
    expect(estimate.lagMs).toBeLessThanOrEqual(CALIBRATION.lagMaxMs);
  });

  it('falls back to the default when the user barely moves', () => {
    const reference = routine(0, 10_000, 66);
    const stillAngles: AngleSet = { l_elbow: 90, r_elbow: 90, l_shoulder: 45, r_shoulder: 45 };
    const still: PoseFrame[] = [];
    for (let t = 0; t <= 10_000; t += 33) still.push(frame(t, stillAngles));

    const estimate = estimateLag(reference, still);
    expect(estimate.confident).toBe(false);
    expect(estimate.lagMs).toBe(CALIBRATION.lagDefaultMs);
  });

  it('falls back when there is too little data to align', () => {
    const estimate = estimateLag(routine(0, 200, 66), routine(0, 200, 33));
    expect(estimate.confident).toBe(false);
    expect(estimate.lagMs).toBe(CALIBRATION.lagDefaultMs);
  });
});

describe('detectMirror', () => {
  const reference = routine(0, 10_000, 66);

  it('picks direct when the user copies the routine as shown', () => {
    const user = routine(0, 10_000, 33, 300);
    const estimate = detectMirror(reference, user, 300);

    expect(estimate.orientation).toBe('direct');
    expect(estimate.confident).toBe(true);
    expect(estimate.directScore).toBeGreaterThan(estimate.mirroredScore);
  });

  it('picks mirrored when the user dances the reflection', () => {
    const user = routine(0, 10_000, 33, 300).map((f) => ({
      ...f,
      angles: mirrorAngles(f.angles),
    }));

    const estimate = detectMirror(reference, user, 300);
    expect(estimate.orientation).toBe('mirrored');
    expect(estimate.confident).toBe(true);
    expect(estimate.mirroredScore).toBeGreaterThan(estimate.directScore);
  });

  it('stays with direct when the choreography is too symmetric to tell', () => {
    // Identical left and right angles: the two orientations are indistinguishable.
    const symmetric: PoseFrame[] = [];
    for (let t = 0; t <= 10_000; t += 66) {
      const sweep = 90 + 70 * Math.sin((t / 1000) * Math.PI * 2);
      symmetric.push(
        frame(t, {
          l_elbow: sweep,
          r_elbow: sweep,
          l_shoulder: sweep,
          r_shoulder: sweep,
          l_hip: 170,
          r_hip: 170,
          l_knee: 175,
          r_knee: 175,
          torso_lean: 0,
          shoulder_tilt: 0,
        }),
      );
    }

    const estimate = detectMirror(symmetric, symmetric, 0);
    expect(estimate.confident).toBe(false);
    expect(estimate.orientation).toBe('direct');
  });

  it('reports no confidence when the user was never detected', () => {
    const estimate = detectMirror(reference, [], 300);
    expect(estimate.samples).toBe(0);
    expect(estimate.confident).toBe(false);
    expect(estimate.orientation).toBe('direct');
  });

  it('ignores user frames too far from the reference moment', () => {
    // User frames exist, but all of them are seconds away from any reference time.
    const user = routine(60_000, 70_000, 33);
    expect(detectMirror(reference, user, 300).samples).toBe(0);
  });
});
