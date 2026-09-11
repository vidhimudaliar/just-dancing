/**
 * Embeddability gate (spec §11.1).
 *
 * Ubisoft can disable embedding on official uploads. If embedding is off the
 * iframe shows an error and the whole paste-a-link premise fails for that video,
 * so it's worth one cheap request before asking the user for camera and screen
 * permissions — a dead end after two permission prompts is a much worse
 * experience than a dead end before them.
 *
 * The endpoint allows cross-origin requests (it reflects the Origin header), so
 * this runs client-side with no backend.
 */

export interface EmbedCheck {
  ok: boolean;
  videoId: string | null;
  title?: string;
  author?: string;
  reason?: string;
}

/**
 * Pulls the video ID out of the URL forms people actually paste: watch links,
 * youtu.be short links, /embed/ and /shorts/ paths, with or without a protocol.
 */
export function extractVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // A bare 11-character ID.
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '');

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  }

  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'music.youtube.com') {
    return null;
  }

  const watchParam = url.searchParams.get('v');
  if (watchParam && /^[\w-]{11}$/.test(watchParam)) return watchParam;

  const match = url.pathname.match(/^\/(?:embed|shorts|v|live)\/([\w-]{11})/);
  return match?.[1] ?? null;
}

/**
 * Asks YouTube whether this video can be embedded.
 *
 * A 401 means embedding is disabled; a 404 means the video is missing or
 * private. Anything else that goes wrong — offline, blocked by an extension —
 * is reported as unknown rather than as a refusal, because failing closed on a
 * flaky network would block videos that are perfectly fine.
 */
export async function checkEmbeddable(input: string): Promise<EmbedCheck> {
  const videoId = extractVideoId(input);
  if (!videoId) {
    return { ok: false, videoId: null, reason: 'That doesn’t look like a YouTube link.' };
  }

  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${videoId}`,
  )}&format=json`;

  let response: Response;
  try {
    response = await fetch(endpoint);
  } catch {
    return {
      ok: true,
      videoId,
      reason: 'Couldn’t reach YouTube to check this video — trying anyway.',
    };
  }

  if (response.status === 401) {
    return {
      ok: false,
      videoId,
      reason: 'This video has embedding disabled, so it can’t be played here. Try another upload of the same routine, or use a local video file.',
    };
  }

  if (response.status === 404) {
    return { ok: false, videoId, reason: 'That video doesn’t exist or is private.' };
  }

  if (!response.ok) {
    return { ok: true, videoId, reason: 'Couldn’t verify this video — trying anyway.' };
  }

  try {
    const data = (await response.json()) as { title?: string; author_name?: string };
    return { ok: true, videoId, title: data.title, author: data.author_name };
  } catch {
    return { ok: true, videoId };
  }
}
