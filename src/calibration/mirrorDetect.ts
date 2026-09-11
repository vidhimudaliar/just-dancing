/**
 * Mirror detection (spec §2.3, §7.3).
 *
 * The on-screen dancer faces the user, so raising their right hand naturally
 * prompts the user to raise their left. Official routines are often — but not
 * always — pre-mirrored to compensate, and nothing in the URL says which.
 *
 * So both orientations are scored over the warm-up window and the better one is
 * locked in for the rest of the song. Comparison happens in angle space (see
 * pose/mirror.ts), which makes evaluating both orientations nearly free.
 */

import { compareAngles } from '../scoring/compare';
import { mirrorAngles } from '../pose/mirror';
import { CALIBRATION } from '../tuning';
import { anglesForMode } from '../scoring/engine';
import type { Orientation } from '../pose/mirror';
import type { PoseFrame, ScoringMode } from '../pose/types';

export interface MirrorEstimate {
  orientation: Orientation;
  directScore: number;
  mirroredScore: number;
  /**
   * False when the two orientations scored too similarly to tell apart — the
   * choreography was too symmetric during the warm-up. `direct` is kept in that
   * case rather than coin-flipping on noise.
   */
  confident: boolean;
  samples: number;
}

/** Finds the buffered user frame closest in time to `t`, within `toleranceMs`. */
function nearest(frames: PoseFrame[], t: number, toleranceMs: number): PoseFrame | null {
  let best: PoseFrame | null = null;
  let bestDistance = Infinity;

  for (const frame of frames) {
    const distance = Math.abs(frame.t - t);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = frame;
    }
    // Frames are time-ordered, so once we start moving away we're done.
    if (frame.t > t && distance > bestDistance) break;
  }

  return bestDistance <= toleranceMs ? best : null;
}

/**
 * Decides which way round the routine is.
 *
 * `lagMs` should be the estimate from `estimateLag`, so that each reference pose
 * is compared against what the user was doing at the moment they were actually
 * responding to it — otherwise reaction lag adds noise to a question that has
 * nothing to do with timing.
 */
export function detectMirror(
  reference: PoseFrame[],
  user: PoseFrame[],
  lagMs: number,
  mode: ScoringMode = 'FULL_BODY',
): MirrorEstimate {
  const allowed = anglesForMode(mode);
  const tolerance = 150;

  let directTotal = 0;
  let mirroredTotal = 0;
  let samples = 0;

  for (const referenceFrame of reference) {
    const match = nearest(user, referenceFrame.t + lagMs, tolerance);
    if (!match) continue;

    const direct = compareAngles(referenceFrame.angles, match.angles, {
      userConfidence: match.confidence,
      allowedAngles: allowed,
    });
    const mirrored = compareAngles(mirrorAngles(referenceFrame.angles), match.angles, {
      userConfidence: match.confidence,
      allowedAngles: allowed,
    });

    if (direct.anglesUsed === 0 || mirrored.anglesUsed === 0) continue;

    directTotal += direct.similarity;
    mirroredTotal += mirrored.similarity;
    samples += 1;
  }

  if (samples === 0) {
    return {
      orientation: 'direct',
      directScore: 0,
      mirroredScore: 0,
      confident: false,
      samples: 0,
    };
  }

  const directScore = directTotal / samples;
  const mirroredScore = mirroredTotal / samples;
  const margin = Math.abs(directScore - mirroredScore);
  const confident = margin >= CALIBRATION.mirrorMinMargin;

  return {
    orientation: confident && mirroredScore > directScore ? 'mirrored' : 'direct',
    directScore,
    mirroredScore,
    confident,
    samples,
  };
}
