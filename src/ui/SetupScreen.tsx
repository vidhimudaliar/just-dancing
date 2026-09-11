/**
 * Song selection: paste a YouTube link, or load a local video file.
 *
 * The local-file route is a permanent first-class option, not a fallback. It
 * needs no screen share, it's the practical harness for tuning the scoring
 * constants, and it's the recovery path when an embed is blocked or a capture
 * is denied (spec §12).
 */

import { useRef, useState } from 'react';

export interface SetupScreenProps {
  onPickFile(file: File): void;
  onSubmitUrl(url: string): void;
  error: string | null;
  busy: boolean;
  busyMessage?: string;
}

export function SetupScreen({
  onPickFile,
  onSubmitUrl,
  error,
  busy,
  busyMessage,
}: SetupScreenProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [dragging, setDragging] = useState(false);

  const accept = (files: FileList | null) => {
    const file = files?.[0];
    if (file) onPickFile(file);
  };

  return (
    <div className="screen setup">
      <header className="screen-header">
        <h1>Just Dancing</h1>
        <p className="subtle">Paste a routine, dance along, get scored.</p>
      </header>

      <form
        className="url-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (url.trim()) onSubmitUrl(url);
        }}
      >
        <input
          type="text"
          className="url-input"
          placeholder="https://www.youtube.com/watch?v=…"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={busy}
        />
        <button type="submit" className="primary" disabled={busy || !url.trim()}>
          Go
        </button>
      </form>

      <div className="divider">
        <span>or</span>
      </div>

      <div
        className={`dropzone ${dragging ? 'dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          accept(event.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
      >
        <strong>Drop a video file here</strong>
        <span className="subtle">no screen sharing needed</span>
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          hidden
          onChange={(event) => accept(event.target.files)}
        />
      </div>

      {error && <div className="banner bad">{error}</div>}
      {busy && <div className="banner">{busyMessage ?? 'Getting ready…'}</div>}

      <p className="subtle note">
        You’ll be asked for camera access, then shown a framing check. A YouTube link
        also asks you to share this tab so the app can see the dancer — nothing is
        recorded or uploaded.
      </p>
    </div>
  );
}
