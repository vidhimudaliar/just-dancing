/**
 * Webcam capture via getUserMedia.
 *
 * Note the deliberate split between how the feed is *displayed* and how it is
 * *analysed*: the preview is CSS-mirrored so it behaves like a mirror for the
 * dancer, but the pixels handed to the detector are never flipped, and all
 * keypoints and angles are computed in raw camera coordinates. Mixing those two
 * up produces a left/right inversion that looks exactly like a broken mirror
 * detector, so keep them separate.
 */

import type { FrameSource } from '../pose/types';

export interface WebcamHandle {
  video: HTMLVideoElement;
  stream: MediaStream;
  /** The element to feed the detector — raw, never mirrored. */
  frameSource(): FrameSource | null;
  dispose(): void;
}

export class WebcamError extends Error {
  constructor(
    message: string,
    readonly recoverable: boolean,
  ) {
    super(message);
    this.name = 'WebcamError';
  }
}

export async function startWebcam(): Promise<WebcamHandle> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError') {
      throw new WebcamError('Camera permission was denied. Allow it and try again.', true);
    }
    if (name === 'NotFoundError') {
      throw new WebcamError('No camera found. Connect one and try again.', true);
    }
    throw new WebcamError(`Could not start the camera: ${String(error)}`, false);
  }

  const video = document.createElement('video');
  video.srcObject = stream;
  video.playsInline = true;
  video.muted = true;
  video.style.display = 'none';
  document.body.appendChild(video);

  await video.play();
  // Dimensions can still be zero immediately after play() resolves, and a
  // zero-sized texture makes the detector throw rather than return nothing.
  if (video.videoWidth === 0) {
    await new Promise<void>((resolve) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    });
  }

  return {
    video,
    stream,
    frameSource() {
      return video.readyState >= 2 && video.videoWidth > 0 ? video : null;
    },
    dispose() {
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
      video.remove();
    },
  };
}
