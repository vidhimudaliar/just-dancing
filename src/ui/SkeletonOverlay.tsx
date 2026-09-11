/**
 * Draws the detected skeleton over a video feed.
 *
 * Spec §7.1 asks for this during framing calibration so the user can see what's
 * actually being detected instead of guessing. Joints are tinted by confidence,
 * which turns "why is my score bad?" into a visible answer.
 *
 * The `mirrored` prop flips only the *drawing*, to match a CSS-mirrored preview.
 * The keypoints themselves stay in raw camera coordinates everywhere else.
 */

import { useEffect, useRef } from 'react';
import { CONFIDENCE } from '../tuning';
import type { KeypointMap, KeypointName, PoseFrame } from '../pose/types';

const SKELETON: ReadonlyArray<[KeypointName, KeypointName]> = [
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  ['left_hip', 'right_hip'],
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],
];

/** Green when confident, amber when marginal, red when effectively unusable. */
function confidenceColor(score: number): string {
  if (score >= 0.6) return '#4ade80';
  if (score >= CONFIDENCE.framing) return '#fbbf24';
  return '#f87171';
}

export interface SkeletonOverlayProps {
  frame: PoseFrame | null;
  /** Natural dimensions of the source video, for coordinate scaling. */
  sourceWidth: number;
  sourceHeight: number;
  mirrored?: boolean;
  className?: string;
}

export function SkeletonOverlay({
  frame,
  sourceWidth,
  sourceHeight,
  mirrored = false,
  className,
}: SkeletonOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx || sourceWidth === 0 || sourceHeight === 0) return;

    if (canvas.width !== sourceWidth || canvas.height !== sourceHeight) {
      canvas.width = sourceWidth;
      canvas.height = sourceHeight;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!frame) return;

    ctx.save();
    if (mirrored) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }

    drawSkeleton(ctx, frame.keypoints);
    ctx.restore();
  }, [frame, sourceWidth, sourceHeight, mirrored]);

  return <canvas ref={canvasRef} className={className} />;
}

function drawSkeleton(ctx: CanvasRenderingContext2D, keypoints: KeypointMap): void {
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';

  for (const [from, to] of SKELETON) {
    const a = keypoints[from];
    const b = keypoints[to];
    if (!a || !b) continue;

    const weakest = Math.min(a.score, b.score);
    if (weakest < CONFIDENCE.keypoint) continue;

    ctx.strokeStyle = confidenceColor(weakest);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  for (const kp of Object.values(keypoints)) {
    if (kp.score < CONFIDENCE.keypoint) continue;
    ctx.fillStyle = confidenceColor(kp.score);
    ctx.beginPath();
    ctx.arc(kp.x, kp.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}
