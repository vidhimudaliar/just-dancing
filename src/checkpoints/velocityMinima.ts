/**
 * Velocity-minima checkpoint detection (spec §6.1).
 *
 * Choreography works by hitting poses and briefly holding them. At those held
 * moments limb velocity approaches zero, so local minima in a movement signal
 * land on exactly the frames worth scoring. And because choreography is built on
 * the beat, those minima fall on the beat automatically — no audio analysis or
 * beat detection required, which is the elegant part.
 *
 * This is a drop-in replacement for `fixedInterval`: same `CheckpointDetector`
 * interface, no changes anywhere else.
 *
 * Movement is measured in angle space rather than the spec's raw keypoint
 * displacement. That's a deliberate improvement: it's scale- and
 * position-invariant, it reuses the same metric as lag estimation, and it
 * correctly treats a dancer holding a shape while stepping sideways as *still*,
 * which pixel displacement would read as motion and miss the checkpoint.
 */

import { angleVelocity } from '../calibration/lag';
import { CHECKPOINTS, CONFIDENCE } from '../tuning';
import { toCheckpoint } from './fixedInterval';
import type { CheckpointDetector } from './types';
import type { Checkpoint, PoseFrame } from '../pose/types';

interface Sample {
  frame: PoseFrame;
  /** Raw movement magnitude at this frame. */
  v: number;
  /** Centred moving average of `v`, filled in once enough neighbours exist. */
  smoothed: number;
}

/**
 * Half-width of the centred smoothing window, plus one frame either side to
 * confirm a local minimum. This is why detection is inherently retrospective:
 * a checkpoint is confirmed a few frames after it actually happened.
 */
function halfWindow(): number {
  return Math.max(1, Math.floor(CHECKPOINTS.smoothingFrames / 2));
}

export function createVelocityMinimaDetector(): CheckpointDetector {
  let samples: Sample[] = [];
  let previous: PoseFrame | null = null;
  /** Index of the next sample that could still be confirmed as a minimum. */
  let cursor = 0;
  let lastEmittedAt = -Infinity;
  /** Emission times within the last second, for the rate cap. */
  let recentEmissions: number[] = [];

  const half = halfWindow();

  /**
   * Centred moving average at `i`.
   *
   * The window is clamped at the start of the stream — an incomplete average is
   * fine there, and refusing to produce one would stall the cursor at index 0
   * forever. It returns null only when the *future* frames are missing, since
   * those genuinely haven't arrived yet.
   */
  const smooth = (i: number): number | null => {
    if (i < 0 || i >= samples.length) return null;
    if (i + half >= samples.length) return null;

    const from = Math.max(0, i - half);
    const to = i + half;
    let total = 0;
    for (let j = from; j <= to; j += 1) total += samples[j]!.v;
    return total / (to - from + 1);
  };

  const canEmit = (t: number): boolean => {
    if (t - lastEmittedAt < CHECKPOINTS.minSpacingMs) return false;
    recentEmissions = recentEmissions.filter((time) => t - time < 1000);
    return recentEmissions.length < CHECKPOINTS.maxPerSecond;
  };

  const emit = (sample: Sample): Checkpoint => {
    lastEmittedAt = sample.frame.t;
    recentEmissions.push(sample.frame.t);
    return toCheckpoint(sample.frame);
  };

  /** Trims confirmed samples, keeping enough context for the smoothing window. */
  const trim = (): void => {
    const keepFrom = Math.max(0, cursor - half - 1);
    if (keepFrom > 128) {
      samples = samples.slice(keepFrom);
      cursor -= keepFrom;
    }
  };

  return {
    push(frame: PoseFrame): Checkpoint[] {
      if (previous) {
        const v = angleVelocity(previous, frame);
        if (v !== null) samples.push({ frame, v, smoothed: Number.NaN });
      }
      previous = frame;

      const emitted: Checkpoint[] = [];

      // Confirm every sample that now has enough lookahead to judge. Both the
      // sample and its right neighbour need a smoothed value, so the cursor
      // stops as soon as either is unavailable and resumes on the next frame —
      // never skipping a sample that could still become a minimum.
      while (cursor < samples.length) {
        const centreSmoothed = smooth(cursor);
        const rightSmoothed = smooth(cursor + 1);
        if (centreSmoothed === null || rightSmoothed === null) break;

        const centre = samples[cursor]!;
        centre.smoothed = centreSmoothed;

        if (cursor >= 1) {
          const left = samples[cursor - 1]!;
          // `<=` on the left and `<` on the right: in a flat run of zeros during
          // a held pose, this fires once, on the last frame before the dancer
          // moves again — rather than never (two strict tests) or on every
          // frame of the hold (two loose ones).
          if (
            !Number.isNaN(left.smoothed) &&
            centreSmoothed <= left.smoothed &&
            centreSmoothed < rightSmoothed &&
            centre.frame.meanScore >= CONFIDENCE.checkpoint &&
            canEmit(centre.frame.t)
          ) {
            emitted.push(emit(centre));
          }
        }

        cursor += 1;
      }

      trim();
      return emitted;
    },

    flush(): Checkpoint[] {
      // Trailing frames never got the lookahead needed to confirm a minimum.
      // Rather than inventing one, drop them: the song is over and a spurious
      // final checkpoint would be scored against an empty buffer anyway.
      samples = [];
      previous = null;
      cursor = 0;
      return [];
    },

    reset(): void {
      samples = [];
      previous = null;
      cursor = 0;
      lastEmittedAt = -Infinity;
      recentEmissions = [];
    },
  };
}
