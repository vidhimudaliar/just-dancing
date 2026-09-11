import { describe, expect, it } from 'vitest';
import { PoseBuffer } from './poseBuffer';
import { ScoringEngine, anglesForMode } from './engine';
import { SCORING } from '../tuning';
import type { AngleSet, Checkpoint, PoseFrame } from '../pose/types';

const BASE: AngleSet = {
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

function frame(t: number, angles: AngleSet = BASE): PoseFrame {
  return { t, keypoints: {}, angles, confidence: {}, meanScore: 0.9 };
}

function checkpoint(t: number, angles: AngleSet = BASE): Checkpoint {
  return { t, angles, confidence: 0.9, lower_body_visible: true };
}

/** Fills a buffer with one pose every 33ms across the given span. */
function bufferWith(from: number, to: number, angles: AngleSet = BASE): PoseBuffer {
  const buffer = new PoseBuffer(10_000);
  for (let t = from; t <= to; t += 33) buffer.push(frame(t, angles));
  return buffer;
}

describe('PoseBuffer', () => {
  it('returns only frames inside the requested window', () => {
    const buffer = bufferWith(0, 2000);
    const range = buffer.range(500, 800);
    expect(range.length).toBeGreaterThan(0);
    for (const f of range) {
      expect(f.t).toBeGreaterThanOrEqual(500);
      expect(f.t).toBeLessThanOrEqual(800);
    }
  });

  it('evicts frames older than the retention window', () => {
    const buffer = new PoseBuffer(1000);
    for (let t = 0; t <= 5000; t += 100) buffer.push(frame(t));

    // Nothing older than 4000ms should survive.
    expect(buffer.range(0, 3900)).toHaveLength(0);
    expect(buffer.range(4000, 5000).length).toBeGreaterThan(0);
  });

  it('drops out-of-order frames rather than corrupting the search', () => {
    const buffer = new PoseBuffer(10_000);
    buffer.push(frame(1000));
    buffer.push(frame(500));
    expect(buffer.size).toBe(1);
    expect(buffer.latestTime).toBe(1000);
  });

  it('keeps memory flat over a long run', () => {
    const buffer = new PoseBuffer(1500);
    for (let t = 0; t <= 200_000; t += 33) buffer.push(frame(t));
    // ~45 frames fit in 1.5s; compaction should keep it near that, not 6000.
    expect(buffer.size).toBeLessThan(200);
  });
});

describe('anglesForMode', () => {
  it('scores all ten angles in full-body mode', () => {
    expect(anglesForMode('FULL_BODY').size).toBe(10);
  });

  it('drops the four leg angles in upper-body mode', () => {
    const upper = anglesForMode('UPPER_BODY');
    expect(upper.size).toBe(6);
    expect(upper.has('l_knee')).toBe(false);
    expect(upper.has('r_hip')).toBe(false);
    expect(upper.has('l_elbow')).toBe(true);
  });
});

describe('ScoringEngine', () => {
  it('does not resolve a checkpoint before its window has elapsed', () => {
    const engine = new ScoringEngine({ lagMs: 300, orientation: 'direct', mode: 'FULL_BODY' });
    engine.addCheckpoint(checkpoint(1000));
    const buffer = bufferWith(0, 3000);

    // Window closes at 1000 + 300 + 300 = 1600.
    expect(engine.update(1599, buffer)).toHaveLength(0);
    expect(engine.update(1600, buffer)).toHaveLength(1);
  });

  it('scores a matching pose as Perfect', () => {
    const engine = new ScoringEngine({ lagMs: 300, orientation: 'direct', mode: 'FULL_BODY' });
    engine.addCheckpoint(checkpoint(1000));

    const [scored] = engine.update(2000, bufferWith(0, 3000));
    expect(scored?.rating).toBe('Perfect');
    expect(scored?.similarity).toBe(100);
  });

  it('finds the best match anywhere in the window, not just at the centre', () => {
    const engine = new ScoringEngine({ lagMs: 300, orientation: 'direct', mode: 'FULL_BODY' });
    engine.addCheckpoint(checkpoint(1000));

    // The user hits the pose only at the far edge of the window and is wrong
    // everywhere else. Spec §7.4 takes the max, so this must still be Perfect.
    const buffer = new PoseBuffer(10_000);
    const wrong: AngleSet = { ...BASE, l_elbow: 10, r_elbow: 170, l_shoulder: 150 };
    for (let t = 0; t <= 3000; t += 33) {
      buffer.push(frame(t, Math.abs(t - 1590) < 20 ? BASE : wrong));
    }

    const [scored] = engine.update(2000, buffer);
    expect(scored?.rating).toBe('Perfect');
  });

  /**
   * The reaction-lag correction from spec §2.2 — the highest-risk item in the
   * spec. A dancer who is perfectly correct but 300ms behind must score full
   * marks, and the same performance scored with no lag correction must not.
   */
  it('credits a lagging dancer once lag is accounted for', () => {
    const buffer = new PoseBuffer(10_000);
    const wrong: AngleSet = { ...BASE, l_elbow: 10, r_elbow: 170, l_shoulder: 150 };
    // User hits the pose at 1400ms for a checkpoint at 1000ms — 400ms behind.
    for (let t = 0; t <= 3000; t += 33) {
      buffer.push(frame(t, Math.abs(t - 1400) < 40 ? BASE : wrong));
    }

    const corrected = new ScoringEngine({ lagMs: 400, orientation: 'direct', mode: 'FULL_BODY' });
    corrected.addCheckpoint(checkpoint(1000));
    expect(corrected.update(3000, buffer)[0]?.rating).toBe('Perfect');

    // With zero lag the window is [700, 1300] and never sees the good pose.
    const naive = new ScoringEngine({ lagMs: 0, orientation: 'direct', mode: 'FULL_BODY' });
    naive.addCheckpoint(checkpoint(1000));
    expect(naive.update(3000, buffer)[0]?.rating).not.toBe('Perfect');
  });

  it('scores a mirrored routine correctly only in mirrored orientation', () => {
    // Reference raises one arm; user raises the opposite one.
    const reference: AngleSet = { ...BASE, l_elbow: 170, r_elbow: 30, l_shoulder: 160, r_shoulder: 20 };
    const user: AngleSet = { ...BASE, l_elbow: 30, r_elbow: 170, l_shoulder: 20, r_shoulder: 160 };
    const buffer = bufferWith(0, 3000, user);

    const mirrored = new ScoringEngine({ lagMs: 300, orientation: 'mirrored', mode: 'FULL_BODY' });
    mirrored.addCheckpoint(checkpoint(1000, reference));
    expect(mirrored.update(2000, buffer)[0]?.similarity).toBe(100);

    const direct = new ScoringEngine({ lagMs: 300, orientation: 'direct', mode: 'FULL_BODY' });
    direct.addCheckpoint(checkpoint(1000, reference));
    expect(direct.update(2000, buffer)[0]?.similarity).toBeLessThan(60);
  });

  it('excludes unscoreable checkpoints from the denominator', () => {
    const engine = new ScoringEngine({ lagMs: 300, orientation: 'direct', mode: 'FULL_BODY' });
    engine.addCheckpoint(checkpoint(1000));
    // Scored normally.
    engine.update(2000, bufferWith(0, 3000));

    // A second checkpoint with no pose data at all in its window.
    engine.addCheckpoint(checkpoint(5000));
    const results = engine.update(7000, bufferWith(0, 3000));

    expect(results).toHaveLength(0);
    const totals = engine.totals;
    expect(totals.skipped).toBe(1);
    // A detector dropout must not be scored as a failure.
    expect(totals.possible).toBe(100);
    expect(totals.percent).toBe(100);
  });

  it('reports a percentage of achievable points', () => {
    const engine = new ScoringEngine({ lagMs: 0, orientation: 'direct', mode: 'FULL_BODY' });
    const good = bufferWith(0, 1000);
    const badAngles: AngleSet = { ...BASE, l_elbow: 0, r_elbow: 180, l_shoulder: 170, r_shoulder: 0 };

    engine.addCheckpoint(checkpoint(100));
    engine.update(1000, good);
    engine.addCheckpoint(checkpoint(2100));
    engine.update(3000, bufferWith(1500, 2600, badAngles));

    const totals = engine.totals;
    expect(totals.possible).toBe(200);
    expect(totals.counts.Perfect).toBe(1);
    expect(totals.percent).toBeLessThan(100);
    expect(totals.percent).toBeCloseTo((totals.points / 200) * 100, 5);
  });

  it('resolves checkpoints in time order even when added out of order', () => {
    const engine = new ScoringEngine({ lagMs: 0, orientation: 'direct', mode: 'FULL_BODY' });
    engine.addCheckpoint(checkpoint(2000));
    engine.addCheckpoint(checkpoint(1000));
    engine.addCheckpoint(checkpoint(1500));

    const results = engine.update(5000, bufferWith(0, 5000));
    expect(results.map((r) => r.t)).toEqual([1000, 1500, 2000]);
  });

  it('flush scores everything still pending at end of song', () => {
    const engine = new ScoringEngine({ lagMs: 300, orientation: 'direct', mode: 'FULL_BODY' });
    engine.addCheckpoint(checkpoint(2900));
    const buffer = bufferWith(0, 3000);

    // The window has not closed, so update() leaves it pending.
    expect(engine.update(3000, buffer)).toHaveLength(0);
    expect(engine.pendingCount).toBe(1);
    expect(engine.flush(buffer)).toHaveLength(1);
    expect(engine.pendingCount).toBe(0);
  });

  it('uses the configured window half-width', () => {
    const engine = new ScoringEngine({ lagMs: 0, orientation: 'direct', mode: 'FULL_BODY' });
    engine.addCheckpoint(checkpoint(1000));
    // Only frames well outside ±windowMs exist.
    const buffer = bufferWith(1000 + SCORING.windowMs + 100, 3000);
    expect(engine.update(3000, buffer)).toHaveLength(0);
    expect(engine.totals.skipped).toBe(1);
  });
});
