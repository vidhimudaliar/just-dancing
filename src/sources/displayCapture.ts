/**
 * Screen capture of the reference video (spec §2.1).
 *
 * A YouTube embed is a cross-origin iframe: playback can be controlled, but
 * drawing it to a canvas taints that canvas and blocks pixel access. That's a
 * browser security boundary. The way through is `getDisplayMedia()` — the user
 * explicitly shares the tab, and screen-capture MediaStreams are *not*
 * cross-origin tainted precisely because that grant was explicit.
 *
 * No video is downloaded and no video data leaves the browser. Only derived
 * keypoint coordinates are ever kept.
 *
 * Cropping uses the Region Capture API where available. The spec describes
 * cropping to the iframe's bounding rect by hand, which means tracking that rect
 * against scroll, resize, zoom and the capture stream's own scaling — a
 * persistent source of drift. `cropTo()` pins the stream to the element itself
 * and follows it, removing the whole class of bug. Manual cropping remains as
 * the fallback.
 */

import type { FrameSource } from '../pose/types';

/** Region Capture, typed locally — it isn't in the DOM lib yet. */
interface CropTargetConstructor {
  fromElement(element: Element): Promise<unknown>;
}
interface CroppableTrack extends MediaStreamTrack {
  cropTo(target: unknown): Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var CropTarget: CropTargetConstructor | undefined;
}

export class DisplayCaptureError extends Error {
  constructor(
    message: string,
    readonly recoverable: boolean,
  ) {
    super(message);
    this.name = 'DisplayCaptureError';
  }
}

export type CropMode = 'region-capture' | 'manual' | 'none';

export interface DisplayCaptureHandle {
  /** What the detector reads: the raw video, or a canvas when cropping manually. */
  frameSource(): FrameSource | null;
  readonly cropMode: CropMode;
  readonly stream: MediaStream;
  /**
   * Crops the stream to an element, and may be called after capture has already
   * started.
   *
   * That ordering matters: `getDisplayMedia` needs user activation, so it has to
   * run in the click handler, but the YouTube iframe doesn't exist until after
   * the player is created. Cropping separately lets both happen without
   * reparenting the iframe — which would reload it and reset the player.
   */
  applyCrop(target: HTMLElement | null): Promise<CropMode>;
  /** Fires if the user stops sharing from the browser's own UI. */
  onEnded(callback: () => void): () => void;
  dispose(): void;
}

export function supportsRegionCapture(): boolean {
  return typeof globalThis.CropTarget !== 'undefined';
}

export interface StartDisplayCaptureOptions {
  /**
   * The element to crop to. Usually omitted here and supplied later via
   * `applyCrop`, because the YouTube iframe doesn't exist yet at the moment the
   * user gesture is available to request capture.
   */
  target?: HTMLElement | null;
  /** How often the manual-crop canvas refreshes its source rect, in ms. */
  rectRefreshMs?: number;
}

export async function startDisplayCapture({
  target = null,
  rectRefreshMs = 500,
}: StartDisplayCaptureOptions = {}): Promise<DisplayCaptureHandle> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      // Audio stays off deliberately: the embed already plays sound, and
      // capturing it too invites an echo (spec §12).
      audio: false,
      video: { frameRate: { ideal: 30 } },
      // Nudges the picker toward the current tab, which is what we want shared.
      preferCurrentTab: true,
    } as DisplayMediaStreamOptions);
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError') {
      throw new DisplayCaptureError(
        'Screen sharing was cancelled. The app needs to see the video to score you.',
        true,
      );
    }
    throw new DisplayCaptureError(`Could not start screen capture: ${String(error)}`, false);
  }

  const [track] = stream.getVideoTracks();
  if (!track) {
    throw new DisplayCaptureError('The shared screen had no video track.', true);
  }

  const video = document.createElement('video');
  video.srcObject = stream;
  video.playsInline = true;
  video.muted = true;
  video.style.display = 'none';
  document.body.appendChild(video);
  await video.play();

  const endedCallbacks = new Set<() => void>();
  const handleEnded = () => {
    for (const callback of endedCallbacks) callback();
  };
  track.addEventListener('ended', handleEnded);

  let cropMode: CropMode = 'none';
  let canvas: HTMLCanvasElement | null = null;
  let rectTimer: ReturnType<typeof setInterval> | null = null;
  let sourceRect: { x: number; y: number; width: number; height: number } | null = null;

  const applyCrop = async (element: HTMLElement | null): Promise<CropMode> => {
    if (rectTimer !== null) {
      clearInterval(rectTimer);
      rectTimer = null;
    }
    if (!element) {
      cropMode = 'none';
      return cropMode;
    }

    // Preferred path: pin the stream to the element itself, so it follows
    // scrolling and resizing with no arithmetic on our side.
    if (supportsRegionCapture()) {
      try {
        const cropTarget = await globalThis.CropTarget!.fromElement(element);
        await (track as CroppableTrack).cropTo(cropTarget);
        cropMode = 'region-capture';
        return cropMode;
      } catch {
        // Fall through to manual cropping.
      }
    }

    // Fallback: crop by hand into a canvas, re-reading the element's rect
    // periodically so scrolling and resizing don't desynchronise it.
    cropMode = 'manual';
    canvas ??= document.createElement('canvas');

    const refreshRect = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      // The captured stream covers the whole tab viewport, which may be a
      // different pixel size than CSS pixels (zoom, HiDPI). Scale accordingly.
      const scaleX = video.videoWidth / window.innerWidth;
      const scaleY = video.videoHeight / window.innerHeight;

      sourceRect = {
        x: rect.left * scaleX,
        y: rect.top * scaleY,
        width: rect.width * scaleX,
        height: rect.height * scaleY,
      };
      canvas!.width = Math.max(1, Math.round(sourceRect.width));
      canvas!.height = Math.max(1, Math.round(sourceRect.height));
    };

    refreshRect();
    rectTimer = setInterval(refreshRect, rectRefreshMs);
    return cropMode;
  };

  if (target) await applyCrop(target);

  return {
    get cropMode() {
      return cropMode;
    },
    stream,
    applyCrop,

    frameSource(): FrameSource | null {
      if (video.readyState < 2 || video.videoWidth === 0) return null;

      if (cropMode !== 'manual' || !canvas || !sourceRect) return video;

      const ctx = canvas.getContext('2d');
      if (!ctx) return video;
      ctx.drawImage(
        video,
        sourceRect.x,
        sourceRect.y,
        sourceRect.width,
        sourceRect.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      return canvas;
    },

    onEnded(callback: () => void) {
      endedCallbacks.add(callback);
      return () => endedCallbacks.delete(callback);
    },

    dispose() {
      track.removeEventListener('ended', handleEnded);
      endedCallbacks.clear();
      if (rectTimer !== null) clearInterval(rectTimer);
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
      video.remove();
    },
  };
}
