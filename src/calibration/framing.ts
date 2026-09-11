/**
 * Framing calibration (spec §2.4, §7.1).
 *
 * At normal laptop distance a webcam sees head-to-torso only, while Just Dance
 * choreography is heavily leg-driven. That's a physical setup problem, not a
 * code problem, so the app measures what it can actually see and tells the user
 * — rather than silently scoring legs it never detected.
 */

import { CONFIDENCE } from '../tuning';
import type { KeypointName, PoseFrame, ScoringMode } from '../pose/types';

const CORE: readonly KeypointName[] = [
  'left_shoulder',
  'right_shoulder',
  'left_hip',
  'right_hip',
];
const LEGS: readonly KeypointName[] = [
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
];

export interface FramingAssessment {
  mode: ScoringMode;
  /** Which keypoint groups cleared the confidence floor. */
  coreVisible: boolean;
  legsVisible: boolean;
  /** Per-keypoint confidence, for the live overlay readout. */
  scores: Partial<Record<KeypointName, number>>;
  /** What to tell the user right now. */
  message: string;
}

function visible(frame: PoseFrame, names: readonly KeypointName[]): boolean {
  return names.every((name) => (frame.keypoints[name]?.score ?? 0) >= CONFIDENCE.framing);
}

/** Classifies a single frame. Callers should smooth this — see `FramingTracker`. */
export function assessFrame(frame: PoseFrame | null): FramingAssessment {
  if (!frame) {
    return {
      mode: 'INSUFFICIENT',
      coreVisible: false,
      legsVisible: false,
      scores: {},
      message: 'No one detected — step into view and check the lighting.',
    };
  }

  const scores: Partial<Record<KeypointName, number>> = {};
  for (const [name, kp] of Object.entries(frame.keypoints)) {
    scores[name as KeypointName] = kp.score;
  }

  const coreVisible = visible(frame, CORE);
  const legsVisible = visible(frame, LEGS);

  if (!coreVisible) {
    return {
      mode: 'INSUFFICIENT',
      coreVisible,
      legsVisible,
      scores,
      message: 'Can’t see your shoulders and hips clearly — fix the lighting or step back.',
    };
  }

  if (!legsVisible) {
    return {
      mode: 'UPPER_BODY',
      coreVisible,
      legsVisible,
      scores,
      message: 'Upper body only. Step back to include your legs for full scoring.',
    };
  }

  return {
    mode: 'FULL_BODY',
    coreVisible,
    legsVisible,
    scores,
    message: 'Full body visible — ready to dance.',
  };
}

/**
 * Smooths the per-frame assessment over a short history.
 *
 * Raw MoveNet confidence flickers frame to frame, and a mode indicator that
 * strobes between FULL BODY and UPPER BODY is both useless and alarming. A mode
 * must hold for a majority of the recent window before it's reported.
 */
export class FramingTracker {
  private history: ScoringMode[] = [];
  private latest: FramingAssessment = assessFrame(null);

  constructor(private readonly windowSize = 15) {}

  push(frame: PoseFrame | null): FramingAssessment {
    const assessment = assessFrame(frame);
    this.history.push(assessment.mode);
    if (this.history.length > this.windowSize) this.history.shift();

    const counts: Record<ScoringMode, number> = {
      FULL_BODY: 0,
      UPPER_BODY: 0,
      INSUFFICIENT: 0,
    };
    for (const mode of this.history) counts[mode] += 1;

    let winner: ScoringMode = 'INSUFFICIENT';
    let best = -1;
    for (const mode of ['FULL_BODY', 'UPPER_BODY', 'INSUFFICIENT'] as const) {
      if (counts[mode] > best) {
        best = counts[mode];
        winner = mode;
      }
    }

    // Report the smoothed mode, but the live scores and message from this frame.
    this.latest = { ...assessment, mode: winner, message: messageFor(winner, assessment) };
    return this.latest;
  }

  get current(): FramingAssessment {
    return this.latest;
  }

  reset(): void {
    this.history = [];
    this.latest = assessFrame(null);
  }
}

function messageFor(mode: ScoringMode, frameAssessment: FramingAssessment): string {
  if (mode === frameAssessment.mode) return frameAssessment.message;
  // The smoothed verdict disagrees with this frame; describe the stable state.
  if (mode === 'FULL_BODY') return 'Full body visible — ready to dance.';
  if (mode === 'UPPER_BODY') return 'Upper body only. Step back to include your legs for full scoring.';
  return 'Can’t see you clearly — fix the lighting or step back.';
}
