/**
 * Rolling buffer of recent user poses, indexed by video time (spec §4).
 *
 * Scoring is inherently retrospective: a checkpoint at video time `t` can only be
 * resolved once the clock passes `t + lag + window`, so the engine must be able
 * to look back roughly a second. The buffer holds ~1.5s, which covers the worst
 * case (800ms lag + 300ms window) with margin.
 */

import { SCORING } from '../tuning';
import type { PoseFrame } from '../pose/types';

export class PoseBuffer {
  private frames: PoseFrame[] = [];
  /** Index of the oldest live frame; everything before it is expired. */
  private start = 0;

  constructor(private readonly retentionMs: number = SCORING.bufferMs) {}

  /**
   * Appends a frame. Frames are expected in non-decreasing time order — the
   * detector produces them that way, and out-of-order frames would silently
   * break the binary search in `range()`, so they're dropped rather than
   * inserted.
   */
  push(frame: PoseFrame): void {
    const last = this.frames[this.frames.length - 1];
    if (last && frame.t < last.t) return;

    this.frames.push(frame);
    this.evict(frame.t - this.retentionMs);
  }

  /** Drops frames older than `cutoff`, compacting only when it's worth it. */
  private evict(cutoff: number): void {
    while (this.start < this.frames.length && this.frames[this.start]!.t < cutoff) {
      this.start += 1;
    }
    // Compact once the dead prefix dominates, to keep memory flat over a song.
    if (this.start > 256 && this.start * 2 > this.frames.length) {
      this.frames = this.frames.slice(this.start);
      this.start = 0;
    }
  }

  /** All buffered frames with `from <= t <= to`, oldest first. */
  range(from: number, to: number): PoseFrame[] {
    const out: PoseFrame[] = [];
    for (let i = this.lowerBound(from); i < this.frames.length; i += 1) {
      const frame = this.frames[i]!;
      if (frame.t > to) break;
      out.push(frame);
    }
    return out;
  }

  /** Index of the first live frame with `t >= target`. */
  private lowerBound(target: number): number {
    let lo = this.start;
    let hi = this.frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.frames[mid]!.t < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Video time of the most recent frame, or null when empty. */
  get latestTime(): number | null {
    const last = this.frames[this.frames.length - 1];
    return last ? last.t : null;
  }

  get size(): number {
    return this.frames.length - this.start;
  }

  clear(): void {
    this.frames = [];
    this.start = 0;
  }
}
