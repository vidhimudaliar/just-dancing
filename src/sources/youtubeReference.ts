/**
 * The YouTube reference source: timing from the iframe, pixels from the screen
 * capture (spec §2.1).
 *
 * These have to be two different objects because the browser deliberately keeps
 * them apart — the iframe knows what time it is but won't let us read it, and
 * the capture stream has the pixels but no idea what they are. Composing them
 * behind the single `ReferenceSource` interface means the scoring engine never
 * has to know about that split.
 */

import type { DisplayCaptureHandle } from './displayCapture';
import type { ReferenceSource } from './types';
import type { YouTubeSource } from './youtubeIframe';
import type { FrameSource } from '../pose/types';

export function createYouTubeReference(
  player: YouTubeSource,
  capture: DisplayCaptureHandle,
): ReferenceSource {
  return {
    kind: 'display-capture',
    cacheKey: player.cacheKey,
    title: player.title,
    clock: player.clock,

    frameSource(): FrameSource | null {
      return capture.frameSource();
    },

    async play() {
      await player.play();
    },

    pause() {
      player.pause();
    },

    onEnded(callback: () => void) {
      // Either the song finishing or the user revoking the screen share ends
      // the run; both need the same "wrap up and show results" path.
      const unsubscribePlayer = player.onEnded(callback);
      const unsubscribeCapture = capture.onEnded(callback);
      return () => {
        unsubscribePlayer();
        unsubscribeCapture();
      };
    },

    dispose() {
      capture.dispose();
      player.dispose();
    },
  };
}
