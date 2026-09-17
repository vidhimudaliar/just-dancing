/**
 * App shell and screen flow (spec §3).
 *
 * Two routes to a reference video converge on one scoring path: paste a YouTube
 * link (oEmbed gate → screen capture → iframe playback) or load a local file
 * (no permissions beyond the camera). Everything after the source is created is
 * identical, which is what keeps the local-file route usable as both the tuning
 * harness and the recovery path when capture fails.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Session, type SessionDebugInfo, type SessionPhase } from './game/session';
import { estimateLag, type LagEstimate } from './calibration/lag';
import { detectMirror, type MirrorEstimate } from './calibration/mirrorDetect';
import { createVelocityMinimaDetector } from './checkpoints/velocityMinima';
import { loadCheckpoints, saveCheckpoints } from './cache/checkpointStore';
import { createLocalFileSource, localFileCacheKey } from './sources/localFile';
import { checkEmbeddable } from './sources/oembed';
import { startDisplayCapture, DisplayCaptureError } from './sources/displayCapture';
import { createYouTubeSource } from './sources/youtubeIframe';
import { createYouTubeReference } from './sources/youtubeReference';
import { startWebcam, WebcamError, type WebcamHandle } from './sources/webcam';
import { CALIBRATION, CHECKPOINTS, DETECTION } from './tuning';
import { FramingScreen } from './ui/FramingScreen';
import { PlayScreen } from './ui/PlayScreen';
import { ResultsScreen } from './ui/ResultsScreen';
import { SetupScreen } from './ui/SetupScreen';
import type { ReferenceSource } from './sources/types';
import type { Orientation } from './pose/mirror';
import type { PoseFrame, ScoredCheckpoint, ScoringMode } from './pose/types';
import type { ScoreTotals } from './scoring/engine';

type Screen = 'setup' | 'framing' | 'play' | 'results';

/** What the user chose to dance to, before any hardware has been acquired. */
type Selection =
  | { kind: 'file'; file: File; title: string }
  | { kind: 'youtube'; videoId: string; title: string };

export interface CalibrationResult {
  lag: LagEstimate;
  mirror: MirrorEstimate;
  /** What was actually applied, after any manual override. */
  orientation: Orientation;
}

const EMPTY_TOTALS: ScoreTotals = {
  points: 0,
  possible: 0,
  percent: 0,
  counts: { Perfect: 0, Good: 0, OK: 0, Oops: 0 },
  skipped: 0,
};

/**
 * How long to wait before deciding the shared tab isn't the one with the video.
 * Long enough to cover a pre-roll ad finishing and the model warming up.
 */
const CAPTURE_GRACE_MS = 12_000;

/** Cache identity for a selection, known before any source or stream exists. */
function selectionCacheKey(picked: Selection): string {
  return picked.kind === 'file' ? localFileCacheKey(picked.file) : picked.videoId;
}

export function App() {
  const [screen, setScreen] = useState<Screen>('setup');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyMessage, setBusyMessage] = useState<string>();

  const [webcam, setWebcam] = useState<WebcamHandle | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [mode, setMode] = useState<ScoringMode>('FULL_BODY');

  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [totals, setTotals] = useState<ScoreTotals>(EMPTY_TOTALS);
  const [webcamFrame, setWebcamFrame] = useState<PoseFrame | null>(null);
  const [lastScored, setLastScored] = useState<ScoredCheckpoint | null>(null);
  const [debug, setDebug] = useState<SessionDebugInfo | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [calibration, setCalibration] = useState<CalibrationResult | null>(null);
  const [usingCache, setUsingCache] = useState(false);
  const [captureProblem, setCaptureProblem] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  /** Set when a finished run was too sparse to be worth caching. */
  const [cacheSkipped, setCacheSkipped] = useState<string | null>(null);

  /**
   * Manual mirror override (spec §7.3), for when auto-detection guesses wrong.
   * Held in a ref as well as state because the calibration callback fires from
   * the session loop and must read the value current at that moment, not the
   * one captured when the session was created.
   */
  const [override, setOverride] = useState<Orientation | null>(null);
  const overrideRef = useRef<Orientation | null>(null);

  const sessionRef = useRef<Session | null>(null);
  const sourceRef = useRef<ReferenceSource | null>(null);
  const referenceContainerRef = useRef<HTMLDivElement | null>(null);
  /** Set once the reference detector has actually found a dancer in the capture. */
  const sawReferenceRef = useRef(false);
  /**
   * Mirrors the `webcam` state. The teardown effect reads the handle from here
   * rather than from state so it can carry an empty dependency list: keyed on
   * `webcam`, StrictMode's double-invoked effects would run the cleanup
   * immediately after the camera started and stop the tracks we just acquired.
   */
  const webcamRef = useRef<WebcamHandle | null>(null);

  /** Tears down the session and reference video, leaving the webcam running. */
  const teardownSession = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    sourceRef.current?.dispose();
    sourceRef.current = null;
  }, []);

  const disposeWebcam = useCallback(() => {
    webcamRef.current?.dispose();
    webcamRef.current = null;
    setWebcam(null);
  }, []);

  /**
   * Acquires the camera, releasing any handle already held first.
   *
   * Every path that starts a camera goes through here. Calling `startWebcam`
   * directly would strand the previous MediaStream — its tracks stay live and
   * the indicator light stays on — whenever one is somehow still open.
   */
  const acquireWebcam = useCallback(async (): Promise<WebcamHandle> => {
    webcamRef.current?.dispose();
    webcamRef.current = null;

    const handle = await startWebcam();
    webcamRef.current = handle;
    setWebcam(handle);
    return handle;
  }, []);

  // Nothing holding hardware may outlive the app.
  useEffect(() => {
    return () => {
      sessionRef.current?.stop();
      sourceRef.current?.dispose();
      webcamRef.current?.dispose();
    };
  }, []);

  /** Acquires the camera and moves to the framing check. */
  const proceedToFraming = useCallback(async (picked: Selection) => {
    setError(null);
    setBusy(true);
    setBusyMessage('Starting camera…');
    try {
      // Ask for the camera before showing the framing screen, so a denial
      // surfaces here rather than as an empty preview.
      await acquireWebcam();
      setSelection(picked);
      setScreen('framing');
    } catch (err) {
      setError(
        err instanceof WebcamError ? err.message : `Could not start the camera: ${String(err)}`,
      );
    } finally {
      setBusy(false);
      setBusyMessage(undefined);
    }
  }, [acquireWebcam]);

  const handlePickFile = useCallback(
    (picked: File) => {
      void proceedToFraming({ kind: 'file', file: picked, title: picked.name });
    },
    [proceedToFraming],
  );

  const handleSubmitUrl = useCallback(
    async (url: string) => {
      setError(null);
      setBusy(true);
      setBusyMessage('Checking the video…');

      // Spec §11.1: verify embeddability before asking for any permissions, so a
      // blocked video is a clear message rather than a dead end two prompts in.
      const check = await checkEmbeddable(url);
      setBusy(false);
      setBusyMessage(undefined);

      if (!check.ok || !check.videoId) {
        setError(check.reason ?? 'That video can’t be used.');
        return;
      }

      await proceedToFraming({
        kind: 'youtube',
        videoId: check.videoId,
        title: check.title ?? 'YouTube video',
      });
    },
    [proceedToFraming],
  );

  /**
   * Builds the reference source for the current selection.
   *
   * For YouTube this is where the ordering constraint lives: `getDisplayMedia`
   * needs user activation so it must run first, but the iframe it crops to
   * doesn't exist until the player is created. Capture starts uncropped, then
   * `applyCrop` pins it to the iframe once that exists — which avoids ever
   * reparenting the iframe, an operation that reloads it and resets the player.
   */
  const buildSource = useCallback(
    async (
      picked: Selection,
      container: HTMLElement,
      skipCapture: boolean,
    ): Promise<ReferenceSource> => {
      if (picked.kind === 'file') {
        return createLocalFileSource({ file: picked.file, container });
      }

      if (skipCapture) {
        // Spec §4's main practical win: with checkpoints already cached there is
        // nothing to extract, so the second play of a song never asks for screen
        // sharing and runs only one detector.
        return createYouTubeSource({
          videoId: picked.videoId,
          title: picked.title,
          container,
        });
      }

      const capture = await startDisplayCapture();
      try {
        const player = await createYouTubeSource({
          videoId: picked.videoId,
          title: picked.title,
          container,
        });
        await capture.applyCrop(player.iframe);
        return createYouTubeReference(player, capture);
      } catch (err) {
        capture.dispose();
        throw err;
      }
    },
    [],
  );

  const startSession = useCallback(
    async (confirmedMode: ScoringMode, picked: Selection) => {
      const currentWebcam = webcamRef.current;
      if (!currentWebcam) return;

      setMode(confirmedMode);
      setTotals(EMPTY_TOTALS);
      setLastScored(null);
      setCalibration(null);
      setCaptureProblem(null);
      sawReferenceRef.current = false;
      setPhase('idle');
      setScreen('play');

      // Wait a frame so the reference container exists before mounting into it.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const container = referenceContainerRef.current;
      if (!container) {
        setError('Could not mount the video.');
        setScreen('setup');
        return;
      }

      // The cache is consulted before the source is built, not after: a hit means
      // there is nothing to extract, so this run can skip screen capture
      // altogether rather than prompting for a share it will never read.
      const cacheKey = selectionCacheKey(picked);
      const cached = await loadCheckpoints(cacheKey);
      setUsingCache(cached !== null);

      let source: ReferenceSource;
      try {
        source = await buildSource(picked, container, cached !== null);
      } catch (err) {
        setError(
          err instanceof DisplayCaptureError ? err.message : `Could not start playback: ${String(err)}`,
        );
        setScreen('setup');
        return;
      }
      sourceRef.current = source;

      const session = new Session({
        webcam: currentWebcam,
        reference: source,
        checkpointDetector: createVelocityMinimaDetector(),
        cachedCheckpoints: cached?.checkpoints,
        mode: confirmedMode,
        // Starting values; the warm-up window replaces them with measured ones.
        lagMs: CALIBRATION.lagDefaultMs,
        orientation: 'direct',
        callbacks: {
          onPhaseChange: setPhase,
          onWebcamFrame: (frame) => setWebcamFrame(frame),
          onReferenceFrame: (frame) => {
            if (frame) sawReferenceRef.current = true;
          },
          onCalibrationComplete: (referenceFrames, userFrames) => {
            const lag = estimateLag(referenceFrames, userFrames);
            // Mirror detection uses the lag estimate so that each reference pose
            // is compared against what the user was doing when they actually
            // responded to it — otherwise timing error pollutes a question that
            // has nothing to do with timing.
            const mirror = detectMirror(referenceFrames, userFrames, lag.lagMs, confirmedMode);
            // A manual override wins over detection (spec §7.3).
            const orientation = overrideRef.current ?? mirror.orientation;

            sessionRef.current?.applyCalibration(lag.lagMs, orientation);
            setCalibration({ lag, mirror, orientation });
          },
          onScored: (scored, next) => {
            setLastScored(scored);
            setTotals(next);
          },
          onFinished: (finalTotals, checkpoints) => {
            setTotals(finalTotals);
            setScreen('results');

            // Reaching the end of the song is not enough to justify caching:
            // skipping ahead also reaches the end, with the middle never
            // extracted. Require the checkpoints to be dense enough to describe
            // the whole routine, or the next play would score against a version
            // of the song with most of it missing.
            const durationMs = source.clock.durationMs;
            const density =
              durationMs > 0 ? checkpoints.length / (durationMs / 1000) : 0;
            const worthCaching = density >= CHECKPOINTS.minCacheDensityPerSecond;

            if (!cached && !worthCaching) {
              setCacheSkipped(
                `Not saving this routine — only ${checkpoints.length} checkpoints across ${Math.round(
                  durationMs / 1000,
                )}s. Play it through without skipping to save it.`,
              );
            }

            if (!cached && worthCaching) {
              void saveCheckpoints({
                cacheKey: source.cacheKey,
                checkpoints,
                durationMs,
                sourceFps: DETECTION.referenceFps,
              });
            }
          },
        },
      });
      sessionRef.current = session;

      try {
        await session.start();
      } catch (err) {
        setError(`Could not start the session: ${String(err)}`);
        teardownSession();
        setScreen('setup');
      }
    },
    [buildSource, teardownSession],
  );

  /**
   * Screen-share recovery (spec §12).
   *
   * If the user picked the wrong tab, everything appears to work — the video
   * plays, the webcam tracks — but every checkpoint is missing because no
   * reference dancer was ever found. Without this the run just silently scores
   * nothing, which is exactly the dead end the spec asks to avoid.
   */
  useEffect(() => {
    if (screen !== 'play' || usingCache || selection?.kind !== 'youtube') return;
    if (phase !== 'calibrating' && phase !== 'scoring') return;

    const timer = setTimeout(() => {
      if (!sawReferenceRef.current) {
        setCaptureProblem(
          'No dancer found in the shared tab. You may have shared the wrong one — stop and try again, or use a local video file instead.',
        );
      }
    }, CAPTURE_GRACE_MS);

    return () => clearTimeout(timer);
  }, [screen, phase, usingCache, selection]);

  /**
   * Releases the camera as soon as scoring is over.
   *
   * The results screen has no use for it, and a camera indicator still lit while
   * you're reading your score reads as the app continuing to watch you. Doing
   * this in an effect rather than inside `onFinished` matters: `onFinished`
   * fires *before* `Session.stop()`, so disposing there would pull the video
   * element out from under an inference call still in flight.
   */
  useEffect(() => {
    if (screen === 'results') disposeWebcam();
  }, [screen, disposeWebcam]);

  // Poll the debug readout separately from the scoring loop, so rendering it
  // never competes with inference for frame budget.
  useEffect(() => {
    if (screen !== 'play' || !showDebug) return;
    const handle = setInterval(() => {
      setDebug(sessionRef.current?.debug ?? null);
    }, 250);
    return () => clearInterval(handle);
  }, [screen, showDebug]);

  const stopPlaying = useCallback(() => {
    sessionRef.current?.finish();
  }, []);

  /**
   * Flips which way round the routine is scored, mid-song (spec §7.3).
   *
   * Auto-detection can guess wrong when the warm-up section happens to be
   * symmetric, and the failure mode — every move scoring as Oops while the user
   * is dancing correctly — is bad enough that it needs a one-click escape.
   */
  const flipMirror = useCallback(() => {
    const current = overrideRef.current ?? calibration?.orientation ?? 'direct';
    const next: Orientation = current === 'direct' ? 'mirrored' : 'direct';

    overrideRef.current = next;
    setOverride(next);
    sessionRef.current?.applyCalibration(calibration?.lag.lagMs ?? CALIBRATION.lagDefaultMs, next);
    setCalibration((previous) => (previous ? { ...previous, orientation: next } : previous));
  }, [calibration]);

  /**
   * Restarts the same routine.
   *
   * The camera was released when the results screen appeared, so it has to be
   * reacquired before a session can start — `startSession` reads the handle and
   * would otherwise bail silently, leaving the button looking broken. The
   * browser remembers the permission for this origin, so this is a short delay
   * rather than a second prompt.
   */
  const playAgain = useCallback(async () => {
    if (!selection) return;
    teardownSession();

    setRestarting(true);
    try {
      await acquireWebcam();
    } catch (err) {
      setError(
        err instanceof WebcamError ? err.message : `Could not restart the camera: ${String(err)}`,
      );
      setScreen('setup');
      return;
    } finally {
      setRestarting(false);
    }

    await startSession(mode, selection);
  }, [teardownSession, startSession, acquireWebcam, mode, selection]);

  const newSong = useCallback(() => {
    teardownSession();
    disposeWebcam();
    setSelection(null);
    setCaptureProblem(null);
    setScreen('setup');
  }, [teardownSession, disposeWebcam]);

  if (screen === 'framing' && webcam && selection) {
    return (
      <FramingScreen
        webcam={webcam}
        needsScreenShare={selection.kind === 'youtube'}
        onConfirm={(confirmed) => void startSession(confirmed, selection)}
        onCancel={newSong}
      />
    );
  }

  if (screen === 'play' && webcam) {
    return (
      <PlayScreen
        referenceContainerRef={referenceContainerRef}
        webcamVideo={webcam.video}
        webcamFrame={webcamFrame}
        phase={phase}
        totals={totals}
        lastScored={lastScored}
        calibration={calibration}
        overridden={override !== null}
        usingCache={usingCache}
        captureProblem={captureProblem}
        onFlipMirror={flipMirror}
        debug={debug}
        showDebug={showDebug}
        onToggleDebug={() => setShowDebug((value) => !value)}
        onStop={stopPlaying}
      />
    );
  }

  if (screen === 'results') {
    return (
      <ResultsScreen
        totals={totals}
        title={selection?.title ?? ''}
        restarting={restarting}
        cacheSkipped={cacheSkipped}
        onPlayAgain={() => void playAgain()}
        onNewSong={newSong}
      />
    );
  }

  return (
    <SetupScreen
      onPickFile={handlePickFile}
      onSubmitUrl={(url) => void handleSubmitUrl(url)}
      error={error}
      busy={busy}
      busyMessage={busyMessage}
    />
  );
}
