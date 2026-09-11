/**
 * Framing calibration screen (spec §3 step 3, §7.1).
 *
 * This screen is also the app's answer to spec §11.2 — "in the actual room, with
 * the actual webcam, can full-body keypoints be detected reliably?" Rather than
 * a throwaway validation script, the check ships as the thing the user sees, so
 * the answer is measured with the exact code that will score them.
 */

import { useEffect, useRef, useState } from 'react';
import { createDetector } from '../pose/detector';
import { FramingTracker, type FramingAssessment } from '../calibration/framing';
import { SkeletonOverlay } from './SkeletonOverlay';
import { VideoMount } from './VideoMount';
import type { PoseFrame, ScoringMode } from '../pose/types';
import type { WebcamHandle } from '../sources/webcam';

const MODE_COPY: Record<ScoringMode, { label: string; tone: string }> = {
  FULL_BODY: { label: 'FULL BODY', tone: 'good' },
  UPPER_BODY: { label: 'UPPER BODY ONLY', tone: 'warn' },
  INSUFFICIENT: { label: 'NOT ENOUGH TO SCORE', tone: 'bad' },
};

export interface FramingScreenProps {
  webcam: WebcamHandle;
  /** True for the YouTube path, where confirming also triggers the share prompt. */
  needsScreenShare: boolean;
  onConfirm(mode: ScoringMode): void;
  onCancel(): void;
}

export function FramingScreen({
  webcam,
  needsScreenShare,
  onConfirm,
  onCancel,
}: FramingScreenProps) {
  const [frame, setFrame] = useState<PoseFrame | null>(null);
  const [assessment, setAssessment] = useState<FramingAssessment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const trackerRef = useRef(new FramingTracker());

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let detector: Awaited<ReturnType<typeof createDetector>> | null = null;

    (async () => {
      try {
        detector = await createDetector('framing');
      } catch (err) {
        if (!cancelled) setError(`Could not load the pose model: ${String(err)}`);
        return;
      }
      if (cancelled) {
        detector.dispose();
        return;
      }
      setLoading(false);

      const tick = async () => {
        if (cancelled || !detector) return;
        const input = webcam.frameSource();
        // Framing uses wall-clock time: there is no video playing yet, so the
        // media clock does not exist. This is the one place that's correct.
        const next = input ? await detector.estimate(input, performance.now()) : null;
        if (cancelled) return;

        setFrame(next);
        setAssessment(trackerRef.current.push(next));
        raf = requestAnimationFrame(() => void tick());
      };
      void tick();
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      detector?.dispose();
    };
  }, [webcam]);

  const mode = assessment?.mode ?? 'INSUFFICIENT';
  const copy = MODE_COPY[mode];
  const canStart = mode !== 'INSUFFICIENT';

  return (
    <div className="screen framing">
      <header className="screen-header">
        <h1>Check your framing</h1>
        <p className="subtle">
          Step back until your whole body is in shot. Green joints are being tracked well.
        </p>
      </header>

      <div className="preview-stage">
        <VideoMount element={webcam.video} mirrored className="preview-video" />
        <SkeletonOverlay
          frame={frame}
          sourceWidth={webcam.video.videoWidth}
          sourceHeight={webcam.video.videoHeight}
          mirrored
          className="preview-overlay"
        />
        {loading && <div className="stage-message">Loading pose model…</div>}
        {error && <div className="stage-message error">{error}</div>}
      </div>

      <div className={`mode-banner ${copy.tone}`}>
        <span className="mode-label">{copy.label}</span>
        <span className="mode-message">{assessment?.message ?? 'Looking for you…'}</span>
      </div>

      {mode === 'UPPER_BODY' && (
        <p className="subtle note">
          You can still play — leg angles will be dropped and the remaining ones reweighted,
          so scores stay comparable.
        </p>
      )}

      {needsScreenShare && (
        <p className="subtle note">
          Next you’ll be asked to share a tab — pick <strong>this one</strong>. That’s the
          only way the app can see the dancer; nothing is recorded or uploaded.
        </p>
      )}

      <div className="actions">
        <button className="ghost" onClick={onCancel}>
          Back
        </button>
        <button className="primary" disabled={!canStart} onClick={() => onConfirm(mode)}>
          {canStart ? (needsScreenShare ? 'Share tab and start' : 'Start dancing') : 'Waiting for a clear view…'}
        </button>
      </div>
    </div>
  );
}
