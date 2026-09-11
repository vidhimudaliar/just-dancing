/**
 * YouTube IFrame Player API wrapper (spec §2.1, §11.3).
 *
 * The iframe is the timing source and the legal playback route. Its pixels are
 * unreachable — a cross-origin iframe taints any canvas it's drawn to, and that
 * is a browser security boundary, not a configuration problem — so pose
 * detection reads the screen-capture stream instead (see displayCapture.ts).
 *
 * The important detail here is `t=0`: the clock starts on the first PLAYING
 * state event, not on iframe load. Pre-roll ads mean those two moments can be
 * half a minute apart, and anchoring to the wrong one shifts every checkpoint in
 * the song (spec §11.3).
 */

import { MediaClock, type ClockSource } from '../clock/mediaClock';
import type { FrameSource } from '../pose/types';
import type { ReferenceSource } from './types';

/** Minimal shape of the bits of the IFrame API we use. */
interface YouTubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  destroy(): void;
}

declare global {
  interface Window {
    YT?: {
      Player: new (element: HTMLElement | string, options: unknown) => YouTubePlayer;
      PlayerState: { ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<void> | null = null;

/** Loads the IFrame API script once and resolves when it's ready to use. */
function loadIframeApi(): Promise<void> {
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<void>((resolve, reject) => {
    if (window.YT?.Player) {
      resolve();
      return;
    }

    const existing = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      existing?.();
      resolve();
    };

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => reject(new Error('Could not load the YouTube player.'));
    document.head.appendChild(script);
  });

  return apiPromise;
}

export interface YouTubeSourceOptions {
  videoId: string;
  title: string;
  container: HTMLElement;
}

export interface YouTubeSource extends ReferenceSource {
  /** The iframe element, needed as the Region Capture crop target. */
  readonly iframe: HTMLIFrameElement | null;
  /** Resolves once playback has genuinely started (past any pre-roll ad). */
  waitForPlaying(): Promise<void>;
}

export async function createYouTubeSource({
  videoId,
  title,
  container,
}: YouTubeSourceOptions): Promise<YouTubeSource> {
  await loadIframeApi();

  const host = document.createElement('div');
  container.appendChild(host);

  const endedCallbacks = new Set<() => void>();
  let started = false;
  let playingResolve: (() => void) | null = null;
  const playingPromise = new Promise<void>((resolve) => {
    playingResolve = resolve;
  });

  const player = await new Promise<YouTubePlayer>((resolve, reject) => {
    const YT = window.YT;
    if (!YT) {
      reject(new Error('YouTube player unavailable.'));
      return;
    }

    const instance = new YT.Player(host, {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: {
        // No related-video grid at the end, no extra chrome to confuse the crop.
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        controls: 1,
      },
      events: {
        onReady: () => resolve(instance),
        onError: () => reject(new Error('This video can’t be played here.')),
        onStateChange: (event: { data: number }) => {
          if (event.data === YT.PlayerState.PLAYING && !started) {
            // The real song start. Everything downstream is timed from here.
            started = true;
            playingResolve?.();
          }
          if (event.data === YT.PlayerState.ENDED) {
            for (const callback of endedCallbacks) callback();
          }
        },
      },
    });
  });

  const clockSource: ClockSource = {
    positionMs: () => {
      // Before the first PLAYING event, position is either meaningless or an
      // ad's timeline. Reporting null keeps the clock from anchoring to it.
      if (!started) return null;
      const seconds = player.getCurrentTime();
      return Number.isFinite(seconds) ? seconds * 1000 : null;
    },
    isPlaying: () => player.getPlayerState() === window.YT?.PlayerState.PLAYING,
    durationMs: () => {
      const seconds = player.getDuration();
      return Number.isFinite(seconds) ? seconds * 1000 : 0;
    },
  };

  const clock = new MediaClock(clockSource);

  return {
    kind: 'display-capture',
    cacheKey: videoId,
    title,
    clock,

    get iframe() {
      return container.querySelector('iframe');
    },

    // The iframe's pixels are unreachable by design (spec §2.1). Pose detection
    // for this source comes from the screen-capture stream instead.
    frameSource(): FrameSource | null {
      return null;
    },

    async play() {
      player.playVideo();
      await playingPromise;
      clock.start();
    },

    pause() {
      player.pauseVideo();
    },

    waitForPlaying() {
      return playingPromise;
    },

    onEnded(callback: () => void) {
      endedCallbacks.add(callback);
      return () => endedCallbacks.delete(callback);
    },

    dispose() {
      endedCallbacks.clear();
      clock.dispose();
      try {
        player.destroy();
      } catch {
        // The player may already be gone if the iframe was torn down first.
      }
      host.remove();
    },
  };
}
