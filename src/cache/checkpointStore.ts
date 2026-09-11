/**
 * Checkpoint cache (spec §4, §9 M6).
 *
 * This is the app's main practical multiplier: the first play of a song extracts
 * checkpoints from the screen-captured video, and every play after that reads
 * them back and needs only the webcam — no screen share, no second detector, and
 * the whole reference-side performance risk disappears.
 *
 * Only derived keypoint angles are stored. No video, no images, no audio —
 * nothing that is the copyrighted work itself. A three-minute song is tens of
 * kilobytes (spec §5).
 */

import { openDB, type IDBPDatabase } from 'idb';
import { CACHE } from '../tuning';
import type { Checkpoint, CheckpointFile } from '../pose/types';

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(CACHE.dbName, 1, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(CACHE.storeName)) {
          database.createObjectStore(CACHE.storeName, { keyPath: 'video_id' });
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Reads cached checkpoints, or null on a miss.
 *
 * A stored file from an older `version` is treated as a miss rather than an
 * error: the extraction algorithm changed, so those checkpoints describe poses
 * the current scorer would not have chosen. It gets overwritten on the next
 * clean run.
 */
export async function loadCheckpoints(cacheKey: string): Promise<CheckpointFile | null> {
  try {
    const stored = (await (await db()).get(CACHE.storeName, cacheKey)) as
      | CheckpointFile
      | undefined;

    if (!stored) return null;
    if (stored.version !== CACHE.version) return null;
    if (!Array.isArray(stored.checkpoints) || stored.checkpoints.length === 0) return null;

    return stored;
  } catch {
    // A private window, a disabled storage setting, or a corrupt database all
    // mean the same thing here: no cache. Never let it block playing.
    return null;
  }
}

export interface SaveOptions {
  cacheKey: string;
  checkpoints: Checkpoint[];
  durationMs: number;
  sourceFps: number;
  mirrorHint?: CheckpointFile['mirror_hint'];
}

/**
 * Persists checkpoints for a video.
 *
 * Call this **only** when a run reached the end of the song. Spec §12 leaves the
 * retry question open; this is the answer: a run that was aborted, or that died
 * partway, has only partial checkpoint coverage, and caching that would silently
 * poison every future play of the song with a routine that stops halfway.
 */
export async function saveCheckpoints({
  cacheKey,
  checkpoints,
  durationMs,
  sourceFps,
  mirrorHint = 'auto',
}: SaveOptions): Promise<void> {
  if (checkpoints.length === 0) return;

  const file: CheckpointFile = {
    video_id: cacheKey,
    version: CACHE.version,
    duration_ms: durationMs,
    source_fps: sourceFps,
    mirror_hint: mirrorHint,
    checkpoints,
  };

  try {
    await (await db()).put(CACHE.storeName, file);
  } catch {
    // Caching is an optimization; failing to write must never fail a play-through.
  }
}

/** Lists what's cached, for a future "manage cached songs" view. */
export async function listCached(): Promise<
  Array<{ cacheKey: string; checkpoints: number; durationMs: number }>
> {
  try {
    const all = (await (await db()).getAll(CACHE.storeName)) as CheckpointFile[];
    return all
      .filter((file) => file.version === CACHE.version)
      .map((file) => ({
        cacheKey: file.video_id,
        checkpoints: file.checkpoints.length,
        durationMs: file.duration_ms,
      }));
  } catch {
    return [];
  }
}

export async function clearCached(cacheKey: string): Promise<void> {
  try {
    await (await db()).delete(CACHE.storeName, cacheKey);
  } catch {
    // Nothing to do — the entry is unreachable either way.
  }
}
