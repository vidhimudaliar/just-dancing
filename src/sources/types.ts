/**
 * Where the reference dancer's pixels come from.
 *
 * Two implementations: `localFile` (a plain `<video>`, no permissions, untainted
 * canvas) and `displayCapture` (getDisplayMedia cropped to the YouTube iframe,
 * per spec §2.1). The scoring engine never learns which one it got — that's what
 * lets the local-file path serve as both the tuning harness and the recovery
 * route when a screen share is denied or an embed is blocked.
 */

import type { MediaClock } from '../clock/mediaClock';
import type { FrameSource } from '../pose/types';

export type ReferenceSourceKind = 'local-file' | 'display-capture';

export interface ReferenceSource {
  readonly kind: ReferenceSourceKind;

  /**
   * Stable identity for the cache (spec §6). For YouTube this is the video ID;
   * for a local file it's derived from the file's name and size.
   */
  readonly cacheKey: string;

  /** Human-readable name for the UI. */
  readonly title: string;

  /** The clock driving all timestamps for this source. */
  readonly clock: MediaClock;

  /**
   * The element to hand the pose detector, or null while it isn't ready.
   * Returning null is normal during startup and buffering; callers skip the frame.
   */
  frameSource(): FrameSource | null;

  play(): Promise<void>;
  pause(): void;

  /** Resolves when the media reaches its end. */
  onEnded(callback: () => void): () => void;

  dispose(): void;
}
