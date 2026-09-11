/**
 * Fixed-interval checkpoint detection (spec §6.2).
 *
 * Emits a checkpoint every `fixedIntervalMs` regardless of what the dancer is
 * doing. Crude — it will sometimes sample mid-transition and ask the user to
 * match a blur — but it gets the whole loop running end to end, which is the
 * point. `velocityMinima` replaces it behind the same interface.
 */

import { CHECKPOINTS, CONFIDENCE } from '../tuning';
import { LOWER_BODY_ANGLES } from '../pose/types';
import type { CheckpointDetector } from './types';
import type { Checkpoint, PoseFrame } from '../pose/types';

/** True when the frame has enough leg detail for lower-body angles to count. */
export function hasLowerBody(frame: PoseFrame): boolean {
  return LOWER_BODY_ANGLES.every((name) => {
    const confidence = frame.confidence[name];
    return confidence !== undefined && confidence >= CONFIDENCE.framing;
  });
}

export function toCheckpoint(frame: PoseFrame): Checkpoint {
  return {
    t: frame.t,
    angles: frame.angles,
    confidence: frame.meanScore,
    lower_body_visible: hasLowerBody(frame),
  };
}

export function createFixedIntervalDetector(
  intervalMs: number = CHECKPOINTS.fixedIntervalMs,
): CheckpointDetector {
  let nextAt: number | null = null;

  return {
    push(frame: PoseFrame): Checkpoint[] {
      if (frame.meanScore < CONFIDENCE.checkpoint) return [];

      if (nextAt === null) {
        // Anchor the grid to the first usable frame rather than to t=0, so a
        // late-starting reference stream still gets evenly spaced checkpoints.
        nextAt = frame.t;
      }
      if (frame.t < nextAt) return [];

      // Advance past any interval boundaries the stream skipped (a stall, or a
      // run of low-confidence frames), instead of emitting a burst to catch up.
      while (nextAt <= frame.t) nextAt += intervalMs;

      return [toCheckpoint(frame)];
    },

    flush(): Checkpoint[] {
      return [];
    },

    reset(): void {
      nextAt = null;
    },
  };
}
