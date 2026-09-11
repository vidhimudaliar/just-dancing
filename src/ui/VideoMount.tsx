/**
 * Mounts an externally-created `<video>` element into the React tree.
 *
 * The webcam and reference sources create their own video elements because they
 * own the media lifecycle (streams, object URLs, play/pause). This component
 * just adopts one for display without taking ownership of it — on unmount the
 * element is detached, never torn down.
 */

import { useEffect, useRef } from 'react';

export interface VideoMountProps {
  element: HTMLVideoElement | null;
  /** Display-only mirroring, so the webcam preview behaves like a mirror. */
  mirrored?: boolean;
  className?: string;
}

export function VideoMount({ element, mirrored = false, className }: VideoMountProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !element) return;

    element.style.display = 'block';
    element.style.width = '100%';
    element.style.height = '100%';
    element.style.objectFit = 'contain';
    element.style.transform = mirrored ? 'scaleX(-1)' : '';
    host.appendChild(element);

    return () => {
      // The source still owns this element; just stop showing it here.
      if (element.parentElement === host) host.removeChild(element);
    };
  }, [element, mirrored]);

  return <div ref={hostRef} className={className} />;
}
