# Just Dancing — V1

Browser-based dance scoring. Paste a YouTube link (or load a local video), dance
along, get scored against the on-screen dancer in real time.

Implements milestones M1–M6 of [dance-scoring-app-tech-spec.md](dance-scoring-app-tech-spec.md).
Multi-person (M7 / spec §10) is not included.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 99 unit tests
npm run build
```

Desktop Chrome. The camera needs permission; the YouTube path also needs a tab
share. Nothing is recorded or uploaded — only derived joint angles ever leave the
detector, and they stay in IndexedDB on this machine.

## How it works

```
YouTube iframe ──── timing (getCurrentTime, state events) ──┐
      │                                                      │
      └─ pixels unreachable (cross-origin taint)             ▼
                                                        MediaClock
getDisplayMedia ──► crop to iframe ──► reference detector ──► checkpoints
                                                                  │
webcam ──► user detector ──► pose buffer ──────────────► scoring engine ──► UI
                                                                  │
                                                    IndexedDB (angles only)
```

The four design constraints from spec §2 and where each is handled:

| Constraint | Where |
|---|---|
| YouTube iframes can't be read for pixels | [displayCapture.ts](src/sources/displayCapture.ts) — screen capture, Region Capture crop |
| Reaction lag (the highest-risk item) | [lag.ts](src/calibration/lag.ts) + windowed best-match in [engine.ts](src/scoring/engine.ts) |
| Mirroring | [mirror.ts](src/pose/mirror.ts) + [mirrorDetect.ts](src/calibration/mirrorDetect.ts) |
| Camera framing | [framing.ts](src/calibration/framing.ts) + [FramingScreen.tsx](src/ui/FramingScreen.tsx) |

## Decisions that differ from, or aren't in, the spec

**Mirroring is an angle-space transform, not a pixel flip.** Reflecting a body
swaps the `l_`/`r_` labels on the eight interior angles and negates the two signed
ones — that's the whole operation. It's cheap enough to score both orientations
every frame during calibration. `mirror.test.ts` proves the transform equals what
the detector would produce from a physically reflected pose.

**`torso_lean` and `shoulder_tilt` are stored signed.** Spec §5's example shows
bare positive numbers and doesn't say. Unsigned, they carry no directional
information and mirror detection silently loses two of its ten signals.

**Region Capture instead of bounding-rect math.** Spec §2.1 describes cropping to
the iframe's rect by hand, which means tracking it against scroll, resize and
zoom. `CropTarget.fromElement()` + `track.cropTo()` pins the stream to the element
and follows it. Manual cropping remains as the fallback.

**Lag estimation guards against beat aliasing.** Choreography is periodic by
construction, so the cross-correlation curve has near-equal peaks one beat apart —
at 120bpm that's 500ms, inside the 0–800ms search range. A plain argmax can land a
whole beat late, which reads as the app scoring the *next* move. Among
statistically tied offsets the earliest wins, since people react in 200–400ms
rather than waiting out a bar.

**Checkpoint detection measures angle velocity, not pixel displacement.** Spec
§6.1 specifies keypoint displacement. Angle velocity is scale- and
position-invariant for free, reuses the lag estimator's metric, and correctly
treats a dancer holding a shape while stepping sideways as *still* — which is what
a checkpoint is.

**Unscoreable checkpoints are excluded from the denominator, not failed.** If the
detector loses the user entirely, that checkpoint is skipped rather than scored
zero. A dropout isn't the dancer's fault, and spec §7.6 reports a percentage
precisely so checkpoint counts can differ.

**Cache is consulted before the source is built.** A hit means nothing needs
extracting, so the second play of a song never prompts for screen sharing and runs
only one detector — spec §4's main practical win.

**Only a run that reaches the end is cached.** Spec §12 left this open. A partial
extraction would poison every future play of the song with a routine that stops
halfway.

## Feedback latency — a deliberate stance

A checkpoint at video time `t` can't be resolved until `t + lag + window`, and on
a first play it isn't detected until a few frames after `t`:

```
~300ms (online checkpoint detection) + ~300ms (lag) + 300ms (window) ≈ 900ms
```

~600ms on cached replays. Ratings visibly trail the beat. The score bar animates
toward its target so the delay reads as momentum rather than lag.

## Tuning

Every constant is in [tuning.ts](src/tuning.ts) — rating thresholds, the `K`
similarity conversion, angle weights, confidence floors, window sizes, lag search
range. Spec §7.5 is explicit that these will be wrong on the first pass and need
several rounds of actual dancing.

Fastest loop: load a **local video file** (no screen share), turn on the Debug
panel, dance, adjust, repeat.

The scoring is forgiving by design (spec §7.7). `compare.test.ts` documents the
ratio: two maximally wrong elbows against eight correct angles still scores ~6
rather than 0, because a localized error is diluted by everything that went right.
If it ever feels too generous, that dilution is the reason — raise `K` or the
bucket thresholds.

## Verifying it end to end

Unit tests cover the pure logic (angles, mirroring, comparison, lag recovery,
minima detection, URL parsing). The rest needs a camera and a body:

1. Load a local video, dance a chorus. Dance well, then badly, then stand still —
   the three runs should separate clearly.
2. On the framing screen, step forward until your knees drop out. The mode should
   flip to UPPER BODY and renormalize rather than tanking your score.
3. Dance a section deliberately mirrored and confirm calibration locks the right
   orientation. Then hit **Flip sides** and confirm the score drops — that's the
   proof detection is doing real work.
4. Paste `https://www.youtube.com/watch?v=WCDRkTDtsFM`, share this tab, and
   confirm `t=0` lands on the song start rather than on a pre-roll ad.
5. Play the same video twice. The second run should show "Using saved moves" and
   never ask for screen sharing.
6. Cancel the screen-share prompt on purpose, and separately share the *wrong*
   tab — both should give a clear recovery path, not a dead end.

**Watch the Debug panel during a full song.** Two concurrent MoveNet instances is
spec §8's flagged risk. The reference detector is already throttled to 15fps as a
pre-emptive mitigation. If the webcam detector can't hold ~30fps, the remaining
levers are downscaling the cropped reference stream or dropping reference
detection to 10fps.

## Known limitations

- Snapshot scoring is gameable — holding a rough approximation of each shape
  scores well. Spec §7.7 accepts this deliberately; real Just Dance has the same
  weakness.
- Region Capture is Chrome-only. The fallback works, but V1 is desktop-Chrome-first.
- The MoveNet model is fetched from Google's host on first load, so the very first
  run needs a network connection.
