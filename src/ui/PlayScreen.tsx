/**
 * The dancing screen: reference video, webcam preview, score bar, live rating.
 *
 * Ratings necessarily trail the beat — a checkpoint can't be resolved until its
 * scoring window has fully elapsed (roughly 600ms behind on a cached run, ~900ms
 * on a first play while checkpoints are still being detected online). The score
 * bar therefore animates toward its target rather than stepping, so the delay
 * reads as momentum instead of lag.
 */

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { SkeletonOverlay } from './SkeletonOverlay';
import { VideoMount } from './VideoMount';
import type { CalibrationResult } from '../App';
import type { SessionDebugInfo, SessionPhase } from '../game/session';
import type { PoseFrame, Rating, ScoredCheckpoint } from '../pose/types';
import type { ScoreTotals } from '../scoring/engine';

const RATING_TONE: Record<Rating, string> = {
  Perfect: 'perfect',
  Good: 'good',
  OK: 'ok',
  Oops: 'oops',
};

export interface PlayScreenProps {
  /** Where the reference video element gets mounted; the session owns the element. */
  referenceContainerRef: MutableRefObject<HTMLDivElement | null>;
  webcamVideo: HTMLVideoElement;
  webcamFrame: PoseFrame | null;
  phase: SessionPhase;
  totals: ScoreTotals;
  lastScored: ScoredCheckpoint | null;
  /** Null until the warm-up window closes. */
  calibration: CalibrationResult | null;
  /** True once the user has manually overridden the detected orientation. */
  overridden: boolean;
  /** True when checkpoints came from cache, so no reference detector is running. */
  usingCache: boolean;
  /** Set when the shared tab appears not to contain the video (spec §12). */
  captureProblem: string | null;
  onFlipMirror(): void;
  debug: SessionDebugInfo | null;
  showDebug: boolean;
  onToggleDebug(): void;
  onStop(): void;
}

export function PlayScreen({
  referenceContainerRef,
  webcamVideo,
  webcamFrame,
  phase,
  totals,
  lastScored,
  calibration,
  overridden,
  usingCache,
  captureProblem,
  onFlipMirror,
  debug,
  showDebug,
  onToggleDebug,
  onStop,
}: PlayScreenProps) {
  const percent = totals.percent;

  return (
    <div className="screen play">
      {captureProblem && (
        <div className="banner bad">
          {captureProblem}{' '}
          <button className="ghost small" onClick={onStop}>
            Stop and start over
          </button>
        </div>
      )}

      <div className="play-stage">
        <div className="reference-pane">
          <div ref={referenceContainerRef} className="reference-video" />
          {phase === 'waiting' && (
            <div className="warmup-badge">
              <strong>Waiting for the routine…</strong>
              <span>Scoring starts once the dancer does. Skip any intro if you like.</span>
            </div>
          )}
          {phase === 'calibrating' && (
            <div className="warmup-badge">
              <strong>Warming up…</strong>
              <span>Working out your timing and which way round the routine is.</span>
            </div>
          )}
          {usingCache && <div className="cache-badge">Using saved moves</div>}
        </div>

        <div className="webcam-pane">
          <VideoMount element={webcamVideo} mirrored className="preview-video" />
          <SkeletonOverlay
            frame={webcamFrame}
            sourceWidth={webcamVideo.videoWidth}
            sourceHeight={webcamVideo.videoHeight}
            mirrored
            className="preview-overlay"
          />
          <RatingCallout scored={lastScored} suppressed={phase === 'calibrating'} />
        </div>
      </div>

      <div className="hud">
        <div className="score-bar">
          <div className="score-bar-fill" style={{ width: `${Math.min(100, percent)}%` }} />
        </div>
        <div className="hud-row">
          <span className="score-value">{percent.toFixed(0)}%</span>
          <span className="tally">
            {(['Perfect', 'Good', 'OK', 'Oops'] as const).map((rating) => (
              <span key={rating} className={`tally-item ${RATING_TONE[rating]}`}>
                {rating} <b>{totals.counts[rating]}</b>
              </span>
            ))}
          </span>
          <span className="hud-actions">
            <button
              className="ghost small"
              onClick={onFlipMirror}
              title="Use this if you're dancing correctly but everything scores as Oops"
            >
              Flip sides
            </button>
            <button className="ghost small" onClick={onToggleDebug}>
              {showDebug ? 'Hide debug' : 'Debug'}
            </button>
            <button className="ghost small" onClick={onStop}>
              Stop
            </button>
          </span>
        </div>
        {calibration && <CalibrationNote calibration={calibration} overridden={overridden} />}
      </div>

      {showDebug && debug && <DebugPanel debug={debug} totals={totals} />}
    </div>
  );
}

/**
 * Shows the most recent rating briefly, then fades.
 *
 * Keyed on the checkpoint's video time so that two consecutive identical
 * ratings still retrigger the animation — otherwise a run of "Perfect" looks
 * like the app has frozen.
 */
function RatingCallout({
  scored,
  suppressed,
}: {
  scored: ScoredCheckpoint | null;
  suppressed: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!scored || suppressed) return;
    setVisible(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setVisible(false), 700);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [scored, suppressed]);

  if (!scored || suppressed) return null;

  return (
    <div
      key={scored.t}
      className={`rating-callout ${RATING_TONE[scored.rating]} ${visible ? 'visible' : ''}`}
    >
      {scored.rating}
    </div>
  );
}

/**
 * Reports what calibration concluded, in plain language.
 *
 * Both estimates can legitimately fail — a static warm-up gives lag nothing to
 * align, and symmetric choreography makes the two orientations indistinguishable
 * — so say when a fallback was used rather than presenting a guess as a
 * measurement. That's what tells the user the "Flip sides" button might be needed.
 */
function CalibrationNote({
  calibration,
  overridden,
}: {
  calibration: CalibrationResult;
  overridden: boolean;
}) {
  const { lag, mirror, orientation, routineStart } = calibration;

  // When the routine was never detected starting, both estimates below were
  // measured over whatever happened to be on screen. Say so instead of
  // reporting them as findings.
  if (routineStart.timedOut) {
    return (
      <p className="calibration-note subtle">
        Couldn’t tell where the routine starts, so timing and mirroring are guesses.
        If everything scores as Oops, try “Flip sides”.
      </p>
    );
  }

  const lagText = lag.confident
    ? `You're about ${Math.round(lag.lagMs)}ms behind — accounted for.`
    : `Couldn't measure your timing, using ${Math.round(lag.lagMs)}ms.`;

  const mirrorText = overridden
    ? `Scoring ${orientation === 'mirrored' ? 'mirrored' : 'as shown'} (your choice).`
    : mirror.confident
      ? `Routine is ${orientation === 'mirrored' ? 'mirrored' : 'not mirrored'}.`
      : 'Too symmetric to tell which way round — try "Flip sides" if scores look wrong.';

  return (
    <p className="calibration-note subtle">
      {lagText} {mirrorText}
    </p>
  );
}

function DebugPanel({ debug, totals }: { debug: SessionDebugInfo; totals: ScoreTotals }) {
  return (
    <div className="debug-panel">
      <Stat label="Loop" value={`${debug.loopFps.toFixed(0)} fps`} />
      <Stat label="Webcam infer" value={`${debug.webcamInferenceMs.toFixed(1)} ms`} />
      <Stat
        label="Reference infer"
        value={debug.referenceInferenceMs > 0 ? `${debug.referenceInferenceMs.toFixed(1)} ms` : 'cached'}
      />
      <Stat label="Video time" value={`${(debug.videoTimeMs / 1000).toFixed(1)} s`} />
      <Stat label="Buffer" value={`${debug.bufferSize} poses`} />
      <Stat label="Pending" value={`${debug.pendingCheckpoints}`} />
      <Stat label="Skipped" value={`${totals.skipped}`} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="debug-stat">
      <span className="debug-label">{label}</span>
      <span className="debug-value">{value}</span>
    </div>
  );
}
