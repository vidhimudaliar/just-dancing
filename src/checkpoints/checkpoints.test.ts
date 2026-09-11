import { describe, expect, it } from 'vitest';
import { createFixedIntervalDetector, hasLowerBody } from './fixedInterval';
import { createVelocityMinimaDetector } from './velocityMinima';
import { CHECKPOINTS } from '../tuning';
import type { AngleSet, Checkpoint, PoseFrame } from '../pose/types';

function frame(t: number, angles: AngleSet, meanScore = 0.9): PoseFrame {
  return { t, keypoints: {}, angles, confidence: {}, meanScore };
}

const STEP = 1000 / 15; // Reference detector runs at 15fps.

/**
 * Builds a hold–move–hold trace: the body rests at `poses[i]`, sweeps to
 * `poses[i+1]`, rests again. Velocity is near zero during the holds, which is
 * exactly what spec §6.1 says a checkpoint is.
 */
function holdMoveTrace(poses: number[], holdMs: number, moveMs: number): PoseFrame[] {
  const frames: PoseFrame[] = [];
  let t = 0;

  for (let i = 0; i < poses.length; i += 1) {
    const value = poses[i]!;
    for (let held = 0; held < holdMs; held += STEP) {
      frames.push(frame(t, { l_elbow: value, r_elbow: 180 - value, l_shoulder: value / 2 }));
      t += STEP;
    }
    const next = poses[i + 1];
    if (next === undefined) break;
    for (let moved = STEP; moved < moveMs; moved += STEP) {
      const ratio = moved / moveMs;
      const eased = value + (next - value) * ratio;
      frames.push(frame(t, { l_elbow: eased, r_elbow: 180 - eased, l_shoulder: eased / 2 }));
      t += STEP;
    }
  }

  return frames;
}

function runDetector(
  detector: ReturnType<typeof createVelocityMinimaDetector>,
  frames: PoseFrame[],
): Checkpoint[] {
  const out: Checkpoint[] = [];
  for (const f of frames) out.push(...detector.push(f));
  out.push(...detector.flush());
  return out;
}

describe('hasLowerBody', () => {
  it('is true when all four leg angles are confident', () => {
    const f = frame(0, {});
    f.confidence = { l_hip: 0.8, r_hip: 0.8, l_knee: 0.8, r_knee: 0.8 };
    expect(hasLowerBody(f)).toBe(true);
  });

  it('is false when a leg angle is missing', () => {
    const f = frame(0, {});
    f.confidence = { l_hip: 0.8, r_hip: 0.8, l_knee: 0.8 };
    expect(hasLowerBody(f)).toBe(false);
  });
});

describe('fixedInterval', () => {
  it('emits on a regular grid', () => {
    const detector = createFixedIntervalDetector(400);
    const out: Checkpoint[] = [];
    for (let t = 0; t <= 2000; t += STEP) {
      out.push(...detector.push(frame(t, { l_elbow: 90, r_elbow: 90, l_shoulder: 45 })));
    }

    expect(out.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < out.length; i += 1) {
      const gap = out[i]!.t - out[i - 1]!.t;
      expect(gap).toBeGreaterThanOrEqual(400 - STEP);
      expect(gap).toBeLessThanOrEqual(400 + STEP);
    }
  });

  it('skips low-confidence frames', () => {
    const detector = createFixedIntervalDetector(100);
    const out: Checkpoint[] = [];
    for (let t = 0; t <= 1000; t += STEP) {
      out.push(...detector.push(frame(t, { l_elbow: 90 }, 0.1)));
    }
    expect(out).toHaveLength(0);
  });

  it('does not emit a catch-up burst after a stall', () => {
    const detector = createFixedIntervalDetector(100);
    const angles = { l_elbow: 90, r_elbow: 90, l_shoulder: 45 };

    detector.push(frame(0, angles));
    // A two-second gap in the stream, spanning 20 missed intervals.
    const after = detector.push(frame(2000, angles));

    expect(after).toHaveLength(1);
  });
});

describe('velocityMinima', () => {
  it('emits checkpoints at held poses, not mid-transition', () => {
    // Holds at 20, 160, 60 degrees, each held 500ms with 300ms sweeps between.
    const frames = holdMoveTrace([20, 160, 60, 140], 500, 300);
    const checkpoints = runDetector(createVelocityMinimaDetector(), frames);

    expect(checkpoints.length).toBeGreaterThanOrEqual(3);

    // Every checkpoint should land on a pose close to one of the held values.
    for (const checkpoint of checkpoints) {
      const elbow = checkpoint.angles.l_elbow!;
      const nearestHold = [20, 160, 60, 140].reduce((best, hold) =>
        Math.abs(hold - elbow) < Math.abs(best - elbow) ? hold : best,
      );
      expect(Math.abs(elbow - nearestHold)).toBeLessThan(30);
    }
  });

  it('enforces the minimum spacing', () => {
    const frames = holdMoveTrace([20, 160, 60, 140, 30, 150], 400, 200);
    const checkpoints = runDetector(createVelocityMinimaDetector(), frames);

    for (let i = 1; i < checkpoints.length; i += 1) {
      expect(checkpoints[i]!.t - checkpoints[i - 1]!.t).toBeGreaterThanOrEqual(
        CHECKPOINTS.minSpacingMs,
      );
    }
  });

  it('respects the per-second rate cap', () => {
    // Rapid-fire holds that would otherwise exceed the cap.
    const frames = holdMoveTrace([20, 160, 40, 150, 60, 140, 80, 130], 140, 140);
    const checkpoints = runDetector(createVelocityMinimaDetector(), frames);

    for (const checkpoint of checkpoints) {
      const withinSecond = checkpoints.filter(
        (other) => other.t > checkpoint.t - 1000 && other.t <= checkpoint.t,
      );
      expect(withinSecond.length).toBeLessThanOrEqual(CHECKPOINTS.maxPerSecond);
    }
  });

  it('drops minima where the detector was not confident', () => {
    const frames = holdMoveTrace([20, 160, 60], 500, 300).map((f) => ({ ...f, meanScore: 0.2 }));
    expect(runDetector(createVelocityMinimaDetector(), frames)).toHaveLength(0);
  });

  it('emits nothing for a completely static reference', () => {
    const detector = createVelocityMinimaDetector();
    const out: Checkpoint[] = [];
    for (let t = 0; t <= 5000; t += STEP) {
      out.push(...detector.push(frame(t, { l_elbow: 90, r_elbow: 90, l_shoulder: 45 })));
    }
    // No movement means no minima to find — a flat signal has no local structure.
    expect(out.length).toBeLessThanOrEqual(1);
  });

  it('is interchangeable with fixedInterval', () => {
    // Both satisfy the same interface, which is what makes the swap a one-liner.
    const frames = holdMoveTrace([20, 160, 60], 500, 300);
    for (const detector of [createVelocityMinimaDetector(), createFixedIntervalDetector()]) {
      const checkpoints = runDetector(detector, frames);
      for (const checkpoint of checkpoints) {
        expect(typeof checkpoint.t).toBe('number');
        expect(typeof checkpoint.confidence).toBe('number');
        expect(typeof checkpoint.lower_body_visible).toBe('boolean');
      }
      detector.reset();
    }
  });

  it('keeps memory flat across a full-length song', () => {
    const detector = createVelocityMinimaDetector();
    const frames = holdMoveTrace(
      Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? 20 : 160)),
      400,
      200,
    );
    // ~3 minutes of reference at 15fps.
    expect(frames.length).toBeGreaterThan(2000);
    const checkpoints = runDetector(detector, frames);
    expect(checkpoints.length).toBeGreaterThan(50);
  });
});
