# Just Dancing — V1

Browser-based dance scoring. Paste a YouTube link (or load a local video), dance
along, get scored against the on-screen dancer in real time.

Implements milestones M1–M6 of [dance-scoring-app-tech-spec.md](dance-scoring-app-tech-spec.md).
Multi-person (M7 / spec §10) is not included.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 105 unit tests
npm run build
```

Desktop Chrome. The camera needs permission; the YouTube path also needs a tab
share. Nothing is recorded or uploaded — only derived joint angles ever leave the
detector, and they stay in IndexedDB on this machine. The camera is released the
moment the results screen appears, so the indicator light goes out rather than
staying lit behind your score.

> **Status: built, not yet verified end to end.** All six milestones are
> implemented, the unit tests pass, and it typechecks and builds — but no
> complete successful play-through has been confirmed by anyone. Every tuning
> constant is still a first guess (spec §7.5 expects several rounds of real
> dancing). Treat the verification checklist below as outstanding work, not as a
> record of what passed.

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

**Caching requires checkpoint density, not just reaching the end.** Spec §12 left
the retry question open. "Did the run finish?" turns out to be the wrong test —
seeking forward also reaches the end, with the middle never extracted, which
silently saved a 7-checkpoint fragment as a complete 3:47 routine. A run must
average at least 0.5 checkpoints per second to be stored, and the results screen
says when one wasn't. That threshold also catches a reference the detector
couldn't read, without needing to tell the two cases apart.

**Calibration is anchored to the routine, not to video t=0.** Spec §7.2
calibrates over "the first ~10 seconds"; §11.3 got as far as pre-roll *ads* but
conflated "playback started" with "the song started." Many Just Dance uploads
open with in-game footage of someone navigating menus, so those ten seconds are
often nobody dancing — lag estimation falls back to its default and mirror
detection gets *zero* samples, silently scoring a mirrored routine unmirrored for
the whole song. A `waiting` phase now holds until the reference shows a
confidently detected body **and** 1.5s of sustained movement. Both are required:
a menu can show a standing avatar, and detector jitter on a static frame produces
small non-zero velocities.

**The MoveNet model is vendored, not fetched.** `@tensorflow-models/pose-detection`
defaults to `tfhub.dev`, which now redirects to Kaggle and returns an HTML error
page instead of the model — the library's default is simply broken. Kaggle serves
it only as a tar.gz that tfjs can't consume, so the extracted `model.json` and its
two weight shards live in `public/models/` (4.6MB). To refresh them:

```bash
curl -L -o model.tar.gz \
  "https://www.kaggle.com/models/google/movenet/TfJs/singlepose-lightning/4/download?tfjs-format=file"
tar xzf model.tar.gz -C public/models/movenet-singlepose-lightning
```

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
minima detection, routine-start thresholds, URL parsing). The rest needs a camera
and a body, and **none of it has been done yet**:

**Start here — one run exercises most of the risk.** Paste a routine with a
*human* dancer, stand back far enough that your knees are in frame, and play it
straight through without skipping. That single pass covers the model loading,
routine-start detection, lag, mirroring, checkpoint density, the cache write and
the camera release. If it finishes with a plausible score and the results screen
doesn't say it skipped caching, the pipeline works.

Then, individually:

1. Load a local video and dance a chorus three times: well, deliberately badly,
   then standing still. The three should separate clearly. If they don't, the
   scoring is wrong regardless of everything else.
2. On the framing screen, step forward until your knees drop out. The mode should
   flip to UPPER BODY and renormalize rather than tanking your score.
3. Dance a section deliberately mirrored and confirm calibration locks the right
   orientation. Then hit **Flip sides** and confirm the score drops — that's the
   proof detection is doing real work.
4. Use a video that opens with menu navigation. It should sit on **"Waiting for
   the routine…"** through the intro and only then warm up — not calibrate
   against a static screen.
5. Paste `https://www.youtube.com/watch?v=WCDRkTDtsFM`, share this tab, and
   confirm scoring starts at the song rather than during a pre-roll ad.
6. Play the same video twice. The second run should show "Using saved moves",
   never ask for screen sharing, and still calibrate — cached runs derive the
   routine start from the first cached checkpoint.
7. Fast-forward through a run on purpose. The results screen should say it wasn't
   saved, and the next play should re-extract rather than reusing a fragment.
8. Confirm the camera indicator goes out when the results screen appears, and
   that **Dance again** reacquires it.
9. Cancel the screen-share prompt on purpose, and separately share the *wrong*
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
- The framing gate can pass a seated head-and-shoulders view, where MoveNet
  misplaces the shoulders because it expects to see a body. Known, unfixed.

## Open questions

**Can MoveNet read stylized dancers?** Many Just Dance routines feature costumed
mascots rather than human dancers — `WCDRkTDtsFM` ("Timber") is a cartoon panda
with an oversized head and non-human proportions. MoveNet is trained on human
bodies, so those routines may not be detectable at all, which would narrow the
paste-any-link premise to human-dancer uploads. The spec never considered this:
§2 worried about whether the pixels could be *reached*, never about whether
what's in them is human-shaped.

**Genuinely untested.** It was raised off a run that turned out to be truncated,
so nothing so far is evidence either way. To settle it: play a mascot routine
straight through, then a human-dancer routine, and compare checkpoint counts —
the results screen reports when a run was too sparse to cache, which surfaces the
answer directly.
