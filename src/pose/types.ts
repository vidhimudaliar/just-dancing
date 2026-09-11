/**
 * Core data types. Every timestamp in this codebase is **video-time milliseconds**
 * produced by `clock/mediaClock.ts` — never Date.now(), never raw performance.now().
 */

/**
 * What a pose detector can read pixels from.
 *
 * Narrower than the DOM's `TexImageSource`, which also admits `OffscreenCanvas`
 * — TensorFlow.js does not accept that, so using the DOM type here would only
 * push the mismatch to the call site.
 */
export type FrameSource = HTMLVideoElement | HTMLCanvasElement | HTMLImageElement | ImageBitmap;

/** The 17 COCO keypoints MoveNet emits, in its output order. */
export const KEYPOINT_NAMES = [
  'nose',
  'left_eye',
  'right_eye',
  'left_ear',
  'right_ear',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
] as const;

export type KeypointName = (typeof KEYPOINT_NAMES)[number];

export interface Keypoint {
  x: number;
  y: number;
  /** MoveNet confidence, 0..1. */
  score: number;
}

/** Keypoints indexed by name. A missing entry means the detector returned nothing for it. */
export type KeypointMap = Partial<Record<KeypointName, Keypoint>>;

/**
 * The ten tracked angles (spec §5).
 *
 * The eight joint angles are *unsigned interior angles* in degrees (0..180).
 * `torso_lean` and `shoulder_tilt` are *signed* — sign carries the direction of
 * the lean/tilt, which is what makes them useful for mirror detection. Dropping
 * the sign would silently cost two of the ten mirror signals.
 */
export const ANGLE_NAMES = [
  'l_elbow',
  'r_elbow',
  'l_shoulder',
  'r_shoulder',
  'l_hip',
  'r_hip',
  'l_knee',
  'r_knee',
  'torso_lean',
  'shoulder_tilt',
] as const;

export type AngleName = (typeof ANGLE_NAMES)[number];

/** Angles that flip sign under mirroring rather than swapping names. */
export const SIGNED_ANGLES: readonly AngleName[] = ['torso_lean', 'shoulder_tilt'];

/** Angles belonging to the lower body — dropped in UPPER_BODY scoring mode. */
export const LOWER_BODY_ANGLES: readonly AngleName[] = ['l_knee', 'r_knee', 'l_hip', 'r_hip'];

/**
 * A computed angle set. An angle is **absent** rather than zero when the
 * keypoints it depends on were too low-confidence to trust — zero is a real
 * angle value and conflating the two poisons scoring.
 */
export type AngleSet = Partial<Record<AngleName, number>>;

/** Per-angle confidence, derived from the weakest keypoint each angle depends on. */
export type AngleConfidence = Partial<Record<AngleName, number>>;

/** One detected pose at a moment in video time. */
export interface PoseFrame {
  /** Video-time milliseconds. */
  t: number;
  keypoints: KeypointMap;
  angles: AngleSet;
  confidence: AngleConfidence;
  /** Mean score across all detected keypoints, 0..1. */
  meanScore: number;
}

/** A reference pose the user is asked to match (spec §5). */
export interface Checkpoint {
  /** Video-time milliseconds. */
  t: number;
  angles: AngleSet;
  confidence: number;
  lower_body_visible: boolean;
}

/** Persisted per-video checkpoint file (spec §5). */
export interface CheckpointFile {
  video_id: string;
  /** Bumped when the extraction algorithm changes, to invalidate stale caches. */
  version: number;
  duration_ms: number;
  source_fps: number;
  mirror_hint: 'auto' | 'direct' | 'mirrored';
  checkpoints: Checkpoint[];
}

export type ScoringMode = 'FULL_BODY' | 'UPPER_BODY' | 'INSUFFICIENT';

export type Rating = 'Perfect' | 'Good' | 'OK' | 'Oops';

export interface ScoredCheckpoint {
  /** Video time of the reference checkpoint. */
  t: number;
  /** 0..100 similarity of the best-matching pose in the window. */
  similarity: number;
  rating: Rating;
  points: number;
  /** How many angles actually contributed, after confidence gating. */
  anglesUsed: number;
}
