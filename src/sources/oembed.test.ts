import { describe, expect, it } from 'vitest';
import { extractVideoId } from './oembed';

describe('extractVideoId', () => {
  const id = 'WCDRkTDtsFM';

  it('reads a standard watch URL', () => {
    expect(extractVideoId(`https://www.youtube.com/watch?v=${id}`)).toBe(id);
  });

  it('reads a watch URL with extra params', () => {
    expect(extractVideoId(`https://www.youtube.com/watch?v=${id}&list=PL123&t=42s`)).toBe(id);
  });

  it('reads a youtu.be short link', () => {
    expect(extractVideoId(`https://youtu.be/${id}`)).toBe(id);
    expect(extractVideoId(`https://youtu.be/${id}?t=10`)).toBe(id);
  });

  it('reads embed, shorts and live paths', () => {
    expect(extractVideoId(`https://www.youtube.com/embed/${id}`)).toBe(id);
    expect(extractVideoId(`https://www.youtube.com/shorts/${id}`)).toBe(id);
    expect(extractVideoId(`https://www.youtube.com/live/${id}`)).toBe(id);
  });

  it('reads mobile and music hosts', () => {
    expect(extractVideoId(`https://m.youtube.com/watch?v=${id}`)).toBe(id);
    expect(extractVideoId(`https://music.youtube.com/watch?v=${id}`)).toBe(id);
  });

  it('tolerates a missing protocol', () => {
    expect(extractVideoId(`youtube.com/watch?v=${id}`)).toBe(id);
    expect(extractVideoId(`www.youtube.com/watch?v=${id}`)).toBe(id);
  });

  it('tolerates surrounding whitespace', () => {
    expect(extractVideoId(`  https://www.youtube.com/watch?v=${id}  `)).toBe(id);
  });

  it('accepts a bare video id', () => {
    expect(extractVideoId(id)).toBe(id);
  });

  it('rejects non-YouTube hosts', () => {
    expect(extractVideoId(`https://vimeo.com/watch?v=${id}`)).toBeNull();
    // A lookalike host must not pass — this is the one that matters.
    expect(extractVideoId(`https://youtube.com.evil.test/watch?v=${id}`)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(extractVideoId('')).toBeNull();
    expect(extractVideoId('   ')).toBeNull();
    expect(extractVideoId('not a url')).toBeNull();
    expect(extractVideoId('https://www.youtube.com/watch?v=tooshort')).toBeNull();
    expect(extractVideoId('https://www.youtube.com/')).toBeNull();
  });
});
