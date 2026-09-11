# Dance Scoring Web App — Technical Specification

**Version:** 1.0
**Type:** Personal project
**Status:** Pre-build — pending validation checks (see §11)

---

## 1. Overview

A browser-based dance scoring game. The user pastes a YouTube link to an official Just Dance video, the app plays it alongside their webcam feed, and scores how well their movements match the on-screen dancer in real time.

Scoring model is **snapshot-based**: the app evaluates discrete pose checkpoints rather than continuous movement, matching how Just Dance itself works.

### Goals

- Paste a link → dance → get scored, with no manual setup per song
- Live feedback during play ("Perfect", "Good", "OK", "Oops")
- Cumulative score bar that rises proportionally to performance
- Final score at end of song
- V2: up to 4 people simultaneously, per-person scores, winner declared

### Non-goals (explicitly out of scope for now)

- Building a song library or curated content
- Accounts, persistence across devices, leaderboards
- Mobile support (desktop/laptop only for V1)
- Downloading or re-hosting any video content
- Teaching/tutorial mode, slow-motion practice

---

## 2. Design constraints

These are the four things that shape the architecture. Each was identified as a likely failure point.

### 2.1 YouTube iframes cannot be read for pixels

A YouTube embed is a cross-origin `<iframe>`. Playback can be controlled via the IFrame Player API (`playVideo`, `getCurrentTime`, state events), but drawing it to a canvas taints the canvas and blocks pixel access. This is a browser security boundary, not something to work around with configuration.

**Resolution:** use `navigator.mediaDevices.getDisplayMedia()` — the user shares the tab playing the video. Screen-capture MediaStreams are **not** cross-origin tainted, because the user explicitly granted the capture. The stream is cropped to the iframe's bounding rect and fed to the pose detector.

No video is downloaded. No video data leaves the browser. Only derived keypoint coordinates are ever stored.

### 2.2 Reaction lag

A human copying a dance is inherently 200–400ms behind the reference — reaction time, not poor dancing. Naive frame-to-frame comparison at time *t* scores even excellent dancers near zero.

**Resolution:** every checkpoint is scored against a *window* of buffered user poses (§6.2), and per-user lag is estimated during the first ~10 seconds (§7.2).

**This is the single highest-risk item in the spec.** If it is handled badly the app feels broken regardless of everything else working.

### 2.3 Mirroring

The on-screen dancer faces the user. When they raise their right hand, the natural response is to raise your left. Official Just Dance videos are often (not always) pre-mirrored, and this cannot be determined from the URL.

**Resolution:** auto-detect during calibration by scoring both orientations for the first few seconds and locking in whichever is higher (§7.3).

### 2.4 Camera framing

At normal laptop distance the webcam sees head-to-torso only. Just Dance choreography is heavily leg-driven. This is a physical setup problem, not a code problem.

**Resolution:** a mandatory framing calibration step before play (§7.1), plus graceful degradation to upper-body-only scoring when lower-body keypoints are unavailable.

---

## 3. User flow

```
1. PASTE LINK
   └─ Validate URL format
   └─ Check embeddability via oEmbed endpoint
   └─ Extract video ID → check checkpoint cache

2. PERMISSIONS
   └─ Request webcam (getUserMedia)
   └─ Request screen share (getDisplayMedia) — user selects this tab
   └─ Crop captured stream to iframe bounding rect

3. FRAMING CALIBRATION
   └─ Live webcam preview with skeleton overlay
   └─ Detect which keypoints are visible
   └─ Prompt: "Step back until your whole body is visible"
   └─ Show scoring mode: FULL BODY / UPPER BODY ONLY
   └─ User confirms → proceed

4. PLAYBACK STARTS
   └─ Wait for IFrame API state = PLAYING (handles pre-roll ads)
   └─ Establish t=0 at actual song start, not iframe load

5. AUTO-CALIBRATION (first ~10s, scoring suppressed)
   └─ Detect mirror orientation
   └─ Estimate user reaction lag via cross-correlation
   └─ Display "Warming up..." — no score changes

6. SCORING LOOP
   └─ Reference detector → checkpoint detection (or cache lookup)
   └─ Webcam detector → rolling pose buffer
   └─ On each checkpoint: score best match in window
   └─ Emit rating + increment score bar

7. END OF SONG
   └─ Final score as % of achievable points
   └─ Rating breakdown (count of Perfect/Good/OK/Oops)
   └─ Persist checkpoint data to cache, keyed by video ID
```

---

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                            BROWSER                                │
│                                                                   │
│  ┌────────────────────┐         ┌──────────────────────────┐    │
│  │  YouTube IFrame    │         │  getDisplayMedia stream   │    │
│  │  (visual + audio)  │────────▶│  cropped to iframe rect   │    │
│  │                    │  pixels │                           │    │
│  │  IFrame API:       │         └───────────┬──────────────┘    │
│  │  - getCurrentTime  │                     │                    │
│  │  - state events    │                     ▼                    │
│  └─────────┬──────────┘         ┌──────────────────────────┐    │
│            │                     │  Pose Detector A          │    │
│            │ timestamp           │  (reference dancer)       │    │
│            │                     └───────────┬──────────────┘    │
│            │                                 │ keypoints          │
│            │                                 ▼                    │
│            │                     ┌──────────────────────────┐    │
│            │                     │  Checkpoint Detector      │    │
│            │                     │  (velocity minima)        │    │
│            │                     └───────────┬──────────────┘    │
│            │                                 │                    │
│            ▼                                 ▼                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              SCORING ENGINE                                │   │
│  │  - joint angle comparison                                  │   │
│  │  - windowed best-match search                              │   │
│  │  - lag + mirror correction                                 │   │
│  │  - rating buckets, running score                           │   │
│  └───────────────────────▲──────────────────────────────────┘   │
│                          │ buffered poses                        │
│  ┌───────────────────────┴──────────────────────────────────┐   │
│  │  Pose Detector B (user webcam) ← getUserMedia             │   │
│  │  Rolling buffer: last ~1.5s of poses                       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                          │                                        │
│                          ▼                                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  UI: score bar, live rating, skeleton overlay, results     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                          │                                        │
└──────────────────────────┼────────────────────────────────────────┘
                           │ checkpoint JSON only (no video/images)
                           ▼
              ┌────────────────────────────┐
              │  CACHE (optional backend)   │
              │  key: youtube_video_id      │
              │  IndexedDB → later, server  │
              └────────────────────────────┘
```

### Key architectural properties

- **Fully client-side for V1.** No backend required to ship. The cache starts as IndexedDB and can be promoted to a shared server later.
- **Two concurrent pose detectors.** Feasible because snapshot scoring means the reference detector's output is consumed sparsely (§5).
- **No video data ever transmitted or stored.** Only keypoint coordinate arrays, which are derived data, not the copyrighted work.
- **Cache is a genuine multiplier.** The first play of a song extracts checkpoints; every subsequent play skips screen capture entirely and needs only the webcam.

---

## 5. Data model

### Checkpoint file (per video)

```json
{
  "video_id": "WCDRkTDtsFM",
  "version": 1,
  "duration_ms": 210000,
  "source_fps": 30,
  "mirror_hint": "auto",
  "checkpoints": [
    {
      "t": 1240,
      "angles": {
        "l_elbow": 168.2, "r_elbow": 91.4,
        "l_shoulder": 45.0, "r_shoulder": 132.7,
        "l_hip": 175.1, "r_hip": 170.3,
        "l_knee": 178.9, "r_knee": 160.2,
        "torso_lean": 4.1, "shoulder_tilt": 2.3
      },
      "confidence": 0.91,
      "lower_body_visible": true
    }
  ]
}
```

**Why angles and not raw coordinates:** joint angles are inherently scale- and position-invariant. No normalization step is needed, camera distance doesn't matter, and body proportions don't matter. Storing raw keypoints would require normalization at every comparison and would still be more fragile.

**Size:** a 3-minute song at ~3 checkpoints/sec is roughly 500 checkpoints × ~10 floats. Tens of kilobytes. Compare to ~5,400 full frames × 33 landmarks × 4 floats for continuous frame data — several megabytes. This is one of the main practical wins from snapshot scoring.

### Tracked angles (10 total)

| Angle | Computed from | Weight |
|---|---|---|
| `l_elbow` / `r_elbow` | shoulder–elbow–wrist | 1.5 |
| `l_shoulder` / `r_shoulder` | elbow–shoulder–hip | 1.5 |
| `l_hip` / `r_hip` | shoulder–hip–knee | 1.0 |
| `l_knee` / `r_knee` | hip–knee–ankle | 1.0 |
| `torso_lean` | hip-midpoint→shoulder-midpoint vs vertical | 0.75 |
| `shoulder_tilt` | shoulder line vs horizontal | 0.75 |

Arms are weighted higher: they read as "the move" visually, and they're detected more reliably than legs at typical webcam framing.

---

## 6. Checkpoint detection

### 6.1 Velocity minima method (preferred)

Choreography works by hitting poses and briefly holding them. At those held moments, limb velocity approaches zero. Because choreography is built on the beat, these minima land on the beat automatically — no audio analysis or beat detection required.

```
1. Compute per-frame keypoint displacement:
     v[i] = Σ_joints |pos[i][j] − pos[i−1][j]|
2. Smooth v with a moving average (window ≈ 5 frames)
3. Find local minima in smoothed v
4. Filter:
     - enforce minimum spacing of 300ms
     - drop minima where mean keypoint confidence < 0.6
     - cap at 4 checkpoints/second
5. Emit checkpoint at each surviving minimum
```

### 6.2 Fixed-interval method (fallback / V0)

Emit a checkpoint every 400ms regardless of movement. Cruder — it will sometimes sample mid-transition, producing checkpoints that ask the user to match a blur — but it is roughly twenty minutes of work versus an afternoon.

**Recommendation:** build with fixed-interval to get the loop running end-to-end, then upgrade to velocity minima once everything else works. The interface between checkpoint detection and scoring is identical, so this is a drop-in swap.

---

## 7. Scoring

### 7.1 Framing calibration

Before play, run pose detection on the webcam feed and classify:

- **FULL BODY** — hips, knees, ankles all above confidence threshold → all 10 angles scored
- **UPPER BODY** — hips visible, knees/ankles not → score 6 upper angles, renormalize weights, display mode indicator to user
- **INSUFFICIENT** — shoulders/hips unreliable → block start, prompt to fix lighting or position

Show a live skeleton overlay during this step so the user can see what's being detected rather than guessing.

### 7.2 Lag estimation

During the first ~10 seconds (scoring suppressed), cross-correlate the user's movement velocity signal against the reference's across candidate offsets from 0 to 800ms. Take the offset maximizing correlation. Clamp to a sane range and fall back to a 300ms default if correlation is weak.

### 7.3 Mirror detection

Over the same calibration window, compute mean similarity under both orientations:
- **Direct** — user's left compared to reference's left
- **Mirrored** — user's left compared to reference's right

Lock in the higher-scoring orientation for the rest of the song. Expose a manual override in settings for the case where calibration guesses wrong.

### 7.4 Checkpoint scoring

For a checkpoint at reference time *t*, with estimated lag *L*:

```
1. Candidate window = user poses buffered in [t + L − 300ms, t + L + 300ms]
2. For each candidate pose:
     diff = Σ_angles ( weight[a] × |user_angle[a] − ref_angle[a]| )
     normalized = diff / Σ weights
     similarity = max(0, 100 − normalized × K)     // K tuned empirically
3. score = max(similarity) across candidates
4. Skip angles where either side has low keypoint confidence;
   renormalize weights over the angles actually used
```

The ±300ms window on top of the lag offset absorbs both residual timing error and general sloppiness.

### 7.5 Rating buckets

| Score | Rating | Points awarded |
|---|---|---|
| ≥ 85 | Perfect | 100 |
| ≥ 70 | Good | 70 |
| ≥ 55 | OK | 40 |
| < 55 | Oops | 0 |

Thresholds are **starting values only**. They will be wrong on the first pass and can only be tuned by actually dancing to the app repeatedly. Expect several rounds.

### 7.6 Final score

```
final_pct = (sum of points awarded) / (checkpoint_count × 100) × 100
```

Reported as a percentage, not a raw total. Percentages are comparable across songs of different lengths and, in V2, across players who may have had different numbers of valid checkpoints.

### 7.7 Known limitation

Snapshot scoring is gameable — a user who holds a rough approximation of each shape scores well without really dancing. Real Just Dance has the same weakness (the "just wave the controller" exploit).

For a personal fun project this is an acceptable and arguably desirable tradeoff: forgiving scoring keeps it enjoyable for people who can't dance. Recorded here so it registers as a deliberate choice rather than a bug discovered later.

---

## 8. Tech stack

| Layer | Choice | Rationale |
|---|---|---|
| Framework | React + TypeScript (Vite) | Fast dev loop; types genuinely help with keypoint data structures |
| Pose detection | TensorFlow.js `@tensorflow-models/pose-detection` | Runs client-side, no server GPU |
| Model (V1) | MoveNet SinglePose Lightning | Fastest option; two concurrent instances is the constraint driving this |
| Model (V2) | MoveNet MultiPose Lightning | Handles up to 6 people |
| Backend (WebGL) | `@tensorflow/tfjs-backend-webgl` | Required for real-time performance |
| Video playback | YouTube IFrame Player API | Timing source and legal playback |
| Reference pixels | `getDisplayMedia()` | Only route to pixels without downloading |
| Cache | IndexedDB (V1) → optional server later | No backend needed to ship |
| Styling | Whatever's comfortable | Not a differentiator here |

**Performance note:** two concurrent MoveNet Lightning instances is the main risk to validate. Mitigations if it doesn't hold: run the reference detector at reduced frame rate (checkpoint detection doesn't need 30fps), downscale the cropped reference stream, or extract checkpoints in a warm-up pass before scoring begins.

---

## 9. Build order

**M0 — Validation** (§11). Do this before writing app code.

**M1 — Scoring loop, no YouTube.** Hardcode a short reference sequence from a local video file. Build webcam detection, angle comparison, checkpoint scoring, rating display, score bar. *This validates the hardest and most novel part: does scoring feel fair and fun?* Everything else is plumbing around this.

**M2 — Calibration.** Framing check, lag estimation, mirror detection. These are what turn a technically-correct scorer into something that feels fair.

**M3 — Screen capture ingestion.** `getDisplayMedia`, cropping to the iframe rect, live reference detection.

**M4 — Full link flow.** Paste → oEmbed validation → permissions → play → results. Fixed-interval checkpoints.

**M5 — Velocity-minima checkpoints.** Drop-in upgrade from M4's fixed interval.

**M6 — Caching.** IndexedDB keyed by video ID. Second play of a song skips screen capture.

**M7 — Multi-person.** Only after M1–M6 feel good.

---

## 10. V2: Multi-person

MoveNet MultiPose detects up to 6 people, so detection itself is solved. Two things aren't:

**Identity tracking.** Per-frame detections return in arbitrary order. Without tracking, scores swap between people when they cross paths. Centroid-based tracking (match each detection to the nearest previous-frame centroid, with a distance threshold) handles most cases. Occlusion and crossing remain imperfect.

**Accuracy degradation.** Four people in one webcam frame means each occupies roughly a quarter of the width, further from the camera, with correspondingly noisier keypoints. Expect meaningfully lower confidence and consider loosening thresholds in multi-person mode.

**Per-person calibration** is impractical — you can't estimate four separate lag values reliably. Use a single shared lag estimate derived from aggregate movement.

Scores per person, percentage-based, winner shown at end.

---

## 11. Pre-build validation

Both are short checks that can invalidate core assumptions. Do them first.

### 11.1 Embeddability

Ubisoft can disable embedding on official uploads. If embedding is off, the iframe shows an error and the entire paste-a-link premise fails.

```
GET https://www.youtube.com/oembed?url=<video-url>&format=json
```

A 401 or 404 means embedding is disabled. Test the target video (`WCDRkTDtsFM`) plus 5–10 other official Just Dance uploads to gauge how common the problem is. If it's widespread, the fallback is user-uploaded video files, which changes the product meaningfully.

### 11.2 Physical framing

In the actual room, with the actual webcam, at the actual distance: can full-body keypoints be detected reliably while dancing? Run MoveNet on a webcam feed and watch the confidence values for knees and ankles.

If full body isn't achievable in a normal room, upper-body-only scoring becomes the default rather than a degraded mode — which is workable, but should be a known design decision rather than a surprise.

### 11.3 Pre-roll ads

Check whether ads play in the embed. If they do, `t=0` at iframe load is not the song start. Use IFrame API state events to detect actual playback start.

---

## 12. Open questions

- **Audio source.** The YouTube embed provides audio, but screen capture with audio may produce echo or feedback. Likely fine (embed audio plays normally, capture is video-only), but untested.
- **Restart / retry flow.** Not specified. Does a failed run discard cached checkpoints or keep them?
- **Score bar behavior on "Oops".** Spec says score stays flat. Consider whether a visible combo multiplier makes performance feel more responsive than a flat bar.
- **What happens if screen share is denied or the wrong tab is picked?** Needs a clear recovery path, not a dead end.
