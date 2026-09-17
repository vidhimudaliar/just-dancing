/**
 * MoveNet wrapper (spec §8).
 *
 * Two detector instances run concurrently — one on the webcam, one on the
 * reference video — which spec §8 flags as the main performance risk. The
 * mitigation is applied from the start rather than held in reserve: the
 * reference detector is throttled (see `DETECTION.referenceFps`), because
 * checkpoint detection at 300ms spacing does not need 30fps.
 */

import * as poseDetection from '@tensorflow-models/pose-detection';
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-webgl';

import { computeAngles, meanKeypointScore } from './angles';
import type { FrameSource, KeypointMap, KeypointName, PoseFrame } from './types';

/**
 * The MoveNet weights, served from this app rather than fetched from the
 * internet.
 *
 * The library's default points at `tfhub.dev`, which now redirects to Kaggle and
 * answers with an HTML error page instead of the model — so the default is
 * simply broken, and the app would fail at "Loading pose model…". Kaggle serves
 * the real thing only as a tar.gz, which tfjs can't consume directly, so the
 * extracted `model.json` and its weight shards live in `public/models/`.
 *
 * Vendoring also means first load doesn't depend on a third party being up, and
 * the app works offline after the initial page load.
 */
const MODEL_URL = `${import.meta.env.BASE_URL}models/movenet-singlepose-lightning/model.json`;

let backendReady: Promise<void> | null = null;

/** Initializes the WebGL backend once, no matter how many detectors are created. */
export async function initBackend(): Promise<void> {
  if (!backendReady) {
    backendReady = (async () => {
      await tf.setBackend('webgl');
      await tf.ready();
    })();
  }
  return backendReady;
}

export interface PoseDetectorHandle {
  /** Identifies this detector in the debug overlay, e.g. "webcam" or "reference". */
  readonly label: string;
  /** Detects a pose and converts it to angles. Returns null when nobody is found. */
  estimate(input: FrameSource, t: number): Promise<PoseFrame | null>;
  /** Rolling mean inference time in ms, for the debug overlay. */
  readonly meanInferenceMs: number;
  dispose(): void;
}

/**
 * Creates a MoveNet SinglePose Lightning detector — the fastest variant, chosen
 * because running two at once is the binding constraint (spec §8).
 */
export async function createDetector(label: string): Promise<PoseDetectorHandle> {
  await initBackend();

  const detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
    modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
    enableSmoothing: true,
    modelUrl: MODEL_URL,
  });

  let inferenceEma = 0;
  let samples = 0;
  let disposed = false;

  return {
    label,

    async estimate(input: FrameSource, t: number): Promise<PoseFrame | null> {
      if (disposed) return null;

      const started = performance.now();
      const poses = await detector.estimatePoses(input, { maxPoses: 1, flipHorizontal: false });
      const elapsed = performance.now() - started;

      // Exponential moving average, seeded by the first sample so the debug
      // readout doesn't spend its first seconds climbing from zero.
      inferenceEma = samples === 0 ? elapsed : inferenceEma * 0.9 + elapsed * 0.1;
      samples += 1;

      const pose = poses[0];
      if (!pose) return null;

      const keypoints: KeypointMap = {};
      for (const kp of pose.keypoints) {
        if (!kp.name) continue;
        keypoints[kp.name as KeypointName] = {
          x: kp.x,
          y: kp.y,
          score: kp.score ?? 0,
        };
      }

      const { angles, confidence } = computeAngles(keypoints);
      return {
        t,
        keypoints,
        angles,
        confidence,
        meanScore: meanKeypointScore(keypoints),
      };
    },

    get meanInferenceMs() {
      return inferenceEma;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      detector.dispose();
    },
  };
}
