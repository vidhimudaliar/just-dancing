/**
 * Checkpoint detection interface (spec §6).
 *
 * Two implementations exist and are interchangeable: `fixedInterval` (crude,
 * ships first) and `velocityMinima` (the real one). Spec §6.2 calls for building
 * with the former to get the loop running end to end, then swapping. Keeping the
 * interface identical is what makes that swap a one-line change instead of a
 * refactor — so resist widening it to suit one implementation.
 */

import type { Checkpoint, PoseFrame } from '../pose/types';

export interface CheckpointDetector {
  /**
   * Feeds one reference pose frame. Returns any checkpoints that became
   * confirmed as a result — possibly none, possibly one, and for a detector that
   * needs lookahead, one confirmed slightly after the fact.
   */
  push(frame: PoseFrame): Checkpoint[];

  /** Emits anything still buffered. Called at end of song. */
  flush(): Checkpoint[];

  reset(): void;
}
