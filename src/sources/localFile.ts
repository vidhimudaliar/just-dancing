/**
 * Reference source backed by a local video file.
 *
 * This is not a second-class fallback. It needs no screen share and taints no
 * canvas, which makes it the practical harness for tuning the scoring constants
 * (spec §7.5 expects several rounds of that), and it's the recovery path when a
 * YouTube embed is blocked or the user denies screen capture (spec §12).
 */

import { MediaClock, videoElementSource } from '../clock/mediaClock';
import type { ReferenceSource } from './types';

/**
 * Cache identity for a local file.
 *
 * Name plus size is stable across sessions and cheap — enough to tell a handful
 * of local files apart without hashing megabytes of video. Exported so the cache
 * can be consulted *before* the source is built, which is what lets a cache hit
 * skip screen capture entirely.
 */
export function localFileCacheKey(file: File): string {
  return `local:${file.name}:${file.size}`;
}

export interface LocalFileSourceOptions {
  file: File;
  /** Where to mount the hidden video element. Defaults to document.body. */
  container?: HTMLElement;
  /** Render the reference video visibly so the user can dance along. */
  visible?: boolean;
}

export function createLocalFileSource({
  file,
  container,
  visible = true,
}: LocalFileSourceOptions): ReferenceSource {
  const objectUrl = URL.createObjectURL(file);

  const video = document.createElement('video');
  video.src = objectUrl;
  video.playsInline = true;
  video.controls = false;
  video.preload = 'auto';
  if (!visible) {
    video.style.display = 'none';
  } else {
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'contain';
  }
  (container ?? document.body).appendChild(video);

  const clock = new MediaClock(videoElementSource(video));

  const endedCallbacks = new Set<() => void>();
  const handleEnded = () => {
    for (const callback of endedCallbacks) callback();
  };
  video.addEventListener('ended', handleEnded);

  return {
    kind: 'local-file',
    cacheKey: localFileCacheKey(file),
    title: file.name,
    clock,

    frameSource() {
      // HAVE_CURRENT_DATA: anything less and the detector would read a blank frame.
      return video.readyState >= 2 ? video : null;
    },

    async play() {
      await video.play();
      clock.start();
    },

    pause() {
      video.pause();
    },

    onEnded(callback: () => void) {
      endedCallbacks.add(callback);
      return () => endedCallbacks.delete(callback);
    },

    dispose() {
      video.removeEventListener('ended', handleEnded);
      endedCallbacks.clear();
      clock.dispose();
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
      URL.revokeObjectURL(objectUrl);
    },
  };
}
