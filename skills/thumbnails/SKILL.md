---
name: thumbnails
description: Make 3 YouTube thumbnails for a long-form video, ready for YouTube's Test & Compare A/B test - list 10 hook ideas drawn from the video (big number, before/after, screenshot proof, tool logo, mistake stamp...), score each 1-10, pick the 3 best with variety, and render them at 3840x2160 from the video's own frames (the speaker cut out with Apple Vision), checked at phone-feed and sidebar size. Runs from youtube_metadata after every final render; use directly when the user asks for thumbnails, a thumbnail A/B test or "thumbnail ideas". Accepts one project name or "all".
---

# thumbnails

Three thumbnails per long-form video, each a different idea, for YouTube
Studio's **Test & Compare**. YouTube shows each to a share of viewers and
picks the one that earns the most watch time.

```
/thumbnails <project_name>      # one video
/thumbnails all                 # every long-form project with a timeline
```

`$PY`, `$T` and `$P` are as in the `edit_video` skill (`PY=.venv/bin/python;
T=tools` in a clone). Everything renders with Remotion (`motion/`). If only
HyperFrames is installed, run `tools/setup.sh --motion remotion` once.

**Output**

```
$P/upload/thumbnails/A.jpg B.jpg C.jpg   3840x2160, under 2 MB where possible
$P/upload/thumbnails.md                  the 10 ideas, scores, picks, how to run the test
$P/build/thumbnails.json                 the layer spec (re-render after tweaks)
$P/build/thumbs/                         candidate frames, cut-outs, check.jpg
```

**Long form only.** Test & Compare doesn't run on Shorts. Custom Shorts
thumbnails (1080x1920) exist since July 2026, but only for Partner Program
channels, only from desktop Studio, and with no A/B test. Skip `_short`
projects unless the user asks for a Shorts cover. If they do, make one
1080x1920 variant: the renderer picks the size from the project's timeline.

When `youtube_metadata` calls this, go straight through without asking.

## Step 1 - read the video

1. `$PY $T/words.py $P`: the whole transcript. Mark every number, result,
   contrast, list count, named tool and strong line the speaker actually
   says. A thumbnail may only show what the video delivers. Test & Compare
   scores watch time, so a thumbnail that over-promises loses the test
   itself.
2. `$P/upload/youtube-metadata.md`: the title options. The thumbnail is read
   together with title 1 and must **add to it, never repeat it**. If there
   is no metadata yet, take a working title from the video's opening promise.
3. What visual material exists:
   - `$P/assets/` (screenshots, logos, app images) and `assets/stock/`;
   - `build/overlays_edited.json`, for b-roll and graphics that are in the
     edit (grab them with `--from edited`);
   - `videos/creator.md`, for the creator's products.
   A logo of a tool the video is about (Claude, PostHog, ...) may be
   downloaded from its official press kit or Wikimedia Commons (prefer
   CC0/public domain) into `$P/assets/logos/`. Note the source in
   `thumbnails.md`.
4. The channel's other thumbnails (`videos/*/upload/thumbnails/`). Keep one
   recognisable house style (the same font, accent yellow, outline) while
   the concepts differ.

## Step 2 - the face frames

```bash
$PY $T/thumbnail.py frames $P            # -> build/thumbs/contact.jpg + candidates.json
```

The command scans the cut every 2 s, scores each face with Apple Vision
(sharp, eyes open, facing the camera; OpenCV off macOS) and keeps the best
24, spread across the video. **Look at `contact.jpg`**: it is numbered face
close-ups with times, and `candidates.json` has what was being said at each.
Choose by expression for the idea you have in mind:

- a real smile for results and good news;
- a closed-mouth, serious or sceptical look for mistakes and warnings;
- curious or focused for how-tos.

Talking mouths (half-open, mid-word) read as awkward at thumbnail size, so
avoid them. In vidIQ's 2026 breakout study only 5% used an exaggerated face,
and in education/business it reads as clickbait.

```bash
$PY $T/thumbnail.py grab $P 52 233.5                # full-res frames from the camera files
$PY $T/thumbnail.py grab $P 410 --from edited       # a b-roll shot / screen / graphic from final_edited
$PY $T/thumbnail.py cutout $P build/thumbs/frame_52.jpg   # -> frame_52_cut.png (macOS)
```

`grab` maps the output time back to the raw take, so it is sharper than any
render, and HDR is tone-mapped like the edit. `cutout` lifts the speaker off
the background (Apple Vision person segmentation) and crops to them. Look at
the cut-out: hands cut off at the frame edge are fine; a missing ear or
chunks of chair are not. Try a neighbouring frame if so.

## Step 3 - 10 ideas, scored

Write ten genuinely different ideas before designing anything. Draw them
from the archetypes below and from the video itself. A line the speaker
says, a number on screen or a before/after in the content beats a generic
template. For each, write:

| Field | What |
|---|---|
| # / archetype | e.g. "4 · Before/after split" |
| Concept | what the viewer sees, in one sentence |
| Text | the words on it: 0-4 is ideal, 5 at most |
| Pairs with | how it adds to title 1 (the curiosity it opens) |
| Needs | frame time(s), cut-out, asset, logo |
| Score | 1-10 |

**Scoring.** Judge each idea on these, then give one overall 1-10 (not a
sum), with one line of reasoning:

- **Glance:** understood in under a second at 168 px wide (the suggested
  sidebar size). One focal point, at most 3 elements.
- **Hook:** opens a question the title doesn't answer: a result, a contrast,
  a stake, a surprise.
- **True:** everything shown is in the video and delivered early. This is a
  hard gate: an idea that fails it scores at most 3.
- **Fit:** suits the audience (founders and developers distrust hype) and
  works with the material that exists.
- **Distinct:** stands out in a feed of similar thumbnails in the niche.

**Pick 3.**
1. Start with the top scorer.
2. Each next pick is the highest-scoring idea **with a different
   archetype**. YouTube's own advice is to test clearly different packages,
   not small tweaks, and a small channel needs big differences for a result
   to show.
3. Prefer a spread across these three: a face-led idea, a proof/object-led
   idea, and a text-led or no-text idea. 1of10's study of 300K videos found
   "business" thumbnails did worse with faces, so one variant without a
   face is worth testing.
4. Variety may beat score by about 1 point, not more: never take a 6 over
   an 8 for variety.

Say which ideas you passed over for variety, and why.

## Step 4 - design and render

Write `$P/build/thumbnails.json`: variants `A`, `B`, `C` in the order you
want them uploaded. A = the top pick, because an inconclusive test falls
back to the first one uploaded.

```json
{"variants": [
  {"id": "A", "idea": "Big number + face", "layers": [
    {"type": "rect", "gradient": "radial-gradient(circle at 70% 45%, #2b2b3a 0%, #0B0B0F 70%)"},
    {"type": "cutout", "file": "build/thumbs/frame_52_cut.png", "x": 0.72, "bottom": 1.02, "h": 1.0},
    {"type": "text", "lines": ["*$100K*", "a month"], "x": 0.05, "y": 0.12, "w": 0.48, "size": 230},
    {"type": "arrow", "from": [0.33, 0.62], "to": [0.52, 0.5]}
  ]}
]}
```

Layers draw bottom first. Positions (`x`, `y`, `w`, `h`) are fractions of
the frame. Sizes (`size`, `strokeWidth`, `outlineWidth`, `width`) are pixels
on a 1920x1080 layout; the render is at 2x. The full prop list is in
`motion/thumb/Thumbnail.tsx`.

| Layer | Use | Main props |
|---|---|---|
| `rect` | backdrop, panel, divider, darkening scrim | `color` or `gradient` (any CSS gradient), `radius`, `border` |
| `image` | full frame, screenshot card, logo | `file`, `fit` cover/contain, `focus` [x,y], `zoom`, `radius`, `border`, `shadow`, `brightness`/`saturate`/`blur` |
| `cutout` | the speaker, outlined | `file`, `x` (centre), `bottom`, `h`, `outline` (default white, `null` for none), `outlineWidth`, `glow`, `flip` |
| `text` | the words | `lines`, `*accent*` words, `size`, `font` inter/anton/montserrat, `color`, `accent`, `stroke`, `box` (highlight block behind accent words), `align`, `rotate`; long lines shrink to fit `w` |
| `badge` | pill or sticker: "BEFORE", "6x", a tool name | `text`, `bg`, `color`, `shape` pill/rect/circle, `rotate`, `size` |
| `arrow` | point from text to the proof | `from`, `to`, `curve`, `color`, `width` |
| `circle` | ring around a detail | `x`, `y`, `r` (fraction of width), `color` |

```bash
$PY $T/thumbnail.py render $P     # -> upload/thumbnails/*.jpg + build/thumbs/check.jpg
```

Then **look at every full-size thumbnail and at `check.jpg`**. The check
sheet shows each variant in the phone feed (dark and light theme, with the
duration badge YouTube draws) and at sidebar size. Fix and re-render until
every variant passes:

- [ ] At sidebar size you can still say what it is and read the main words.
- [ ] Nothing important in the bottom-right corner (the duration badge,
      progress bar and hover icons sit there) or the outer 5%.
- [ ] At most 3 elements and 5 words. The text doesn't repeat the title.
- [ ] Text is 4.5:1 contrast or better against what's behind it (outline,
      shadow or a block behind it). Accent yellow is the house colour; green
      reads as money, red as a warning.
- [ ] The face is a quarter to a third of the frame height or more, eyes
      clear, and not covered by text.
- [ ] Every number and claim is said in the video.
- [ ] The three differ in concept, not just colour, and still look like
      one channel.

## Design rules

These come from the studies and creators in Sources.

- **One idea, three elements max** (Paddy Galloway's rule). A face, a
  number, a proof object. Leave 30-40% calm space.
- **Text complements the title.** If the title says "5 Mistakes I Made
  Building a $100K/Month App", the thumbnail says the stake or the feeling
  ("$100K → $0"), not "5 MISTAKES". Title and thumbnail are one package.
  28% of breakout thumbnails had no text at all.
- **Big, heavy, outlined type.** One heavy sans font (Inter Black by
  default; Anton for tall condensed headlines), an outline or a block behind
  it, in the top third or on the empty side of the frame. 1-3 lines.
- **Faces: clear beats extreme.** Use a natural expression with eye
  contact; a look toward the text pulls the viewer's eye there. Cut out and
  enlarged, with a white outline, against a darker or simpler background
  than the room.
- **Contrast.** Bright subject on a dark backdrop, or the reverse.
  Desaturate or darken a busy room; never put text on a busy background
  without a scrim.
- **Proof wins for founders.** A real dashboard, app screen, revenue number
  or before/after earns the click honestly. Blur anything private.
- **House style.** The same font, yellow accent and outline on every video,
  so a returning viewer spots the channel. The concepts still vary.

## Archetypes

Examples are what each channel's thumbnails showed in October 2026.

| # | Archetype | Looks like | Use when | Needs |
|---|---|---|---|---|
| 1 | Big number + proof | Huge "$30K" with a small "/month", hand-drawn arrow to the app or dashboard, calm face (Starter Story; Tech With Tim's arrow to a yellow "$0") | a result or revenue figure is the hook | the number said on camera, an app/dashboard image or the face |
| 2 | Dashboard proof + reaction | A real screenshot fills ~60%, the face reacts from one side (Theo: a "$316,217.35" usage bill with a shocked face) | cost, revenue or usage reveals; "how I did X" | a legible screenshot |
| 3 | Tool logo + 2-word verdict | Logo card top-left, face, 2-3 condensed words: "Claude did it…" (Alex Finn), "I'M HOOKED" pill (Riley Brown) | a video about a tool (Claude, Claude Code) | logo + expressive frame |
| 4 | A → B transform | Two icons or states joined by an arrow: "CHAT → CODE" (Riley Brown), TS → Rust (Theo) | "I replaced X with Y", "raw → finished" | two clear visuals |
| 5 | Before / after split | Left is the old or messy state (desaturated), right is the result, labels "BEFORE"/"AFTER" | transformations: raw footage → edit, old app → new | both images, ideally from the video |
| 6 | Mistake / red X | A red strike-through word (Ali Abdaal's struck "LAZY") or a red X over a screenshot, serious closed-mouth face | mistakes, warnings, "don't do this" | one concrete mistake word |
| 7 | One-word stamp | One huge word beside or behind the head: "DONE", "WHAT NOW?" (Simon Høiberg), "DELUSIONAL" (Ali Abdaal) | opinion, lesson, turning-point videos | only a face frame, so it's cheap and strong |
| 8 | Progress / milestone | Gradient progress bar with a %, or "0 → $100K" (Marc Lou's "Day N growing my SaaS to $1M") | journeys, intros, build-in-public | a milestone figure |
| 9 | Candid, no text | One striking real photo plus at most a logo (Marc Lou: just his face and the TrustMRR logo) | personal story, intro; the no-text test | a well-lit, interesting frame |
| 10 | Fake post / notification | An X post, iMessage bubble or "payment received" card holding a ≤8-word line (Greg Isenberg, Ali Abdaal) | quotable claims, milestones | the line, said in the video |
| 11 | Faceless editorial | Dark background, 2-4 stacked display words, one cut-out object (Fireship) | the no-face variant | one strong object or logo |
| 12 | List / count | "5 MISTAKES" in a highlight block with a row of icons | list videos (keep the count true) | the item count, icons/logos |

## Step 5 - write `$P/upload/thumbnails.md`

````markdown
# Thumbnails: <project_name>

Title 1: <title> · files in `upload/thumbnails/`

## Ideas

| # | Archetype | Concept | Text | Pairs with the title | Score |
|---|---|---|---|---|---|
| 1 | ... | ... | ... | ... | 8 - <one line why> |
...(10 rows)

## Picks

- **A.jpg** = idea N (<archetype>): why it's first. Frame m:ss.
- **B.jpg** = idea N: ...
- **C.jpg** = idea N: ... (passed over idea M (score 8) for variety: same archetype as A)

## Running the test

1. YouTube Studio on **desktop** → the video → Thumbnail → **Test & Compare**
   → upload A, B, C in that order (an inconclusive test keeps A).
2. Optional: "Title and thumbnail" mode to pair each with a title option
   from youtube-metadata.md: A + title 1, ...
3. Leave it alone until it finishes (up to 2 weeks); editing the title or
   thumbnail mid-test stops it. With under ~1,000 impressions per variant
   the result is usually "Inconclusive". Then keep A, or swap in the next
   idea from the list for the next test.

Assets: <logo sources and licences, if any>
````

## Report

Per video: the three picks with their scores and archetypes, and the path to
`check.jpg`. Show the user the thumbnails if the session can display images.
Mention anything you couldn't make: an idea that needed a screenshot the
project doesn't have is worth naming, so they can drop one in `assets/` and
re-run.

## Sources

- Test & Compare: https://support.google.com/youtube/answer/16391400 ; small-channel thresholds: https://outlierkit.com/resources/youtube-ab-testing-3-variants-guide-2026/ , https://influencermarketinghub.com/youtube-test-compare/
- Sizes, limits, Shorts thumbnails: https://support.google.com/youtube/answer/72431 , https://www.androidheadlines.com/2026/03/youtube-thumbnail-size-limit-50mb-tv-upgrade.html , https://vidiq.com/blog/post/youtube-shorts-custom-thumbnails/
- Safe zones and display sizes: https://thumbcrafted.com/guide/youtube-thumbnail-safe-zones , https://vidhalo.com/tools/youtube-thumbnail-tester
- Breakout study (faces, text, contrast): https://vidiq.com/research/youtube-thumbnail-study/
- Faces by niche (300K videos): https://www.searchenginejournal.com/do-faces-help-youtube-thumbnails-heres-what-the-data-says/563944/ ; type and layout: https://1of10.com/blog/youtube-thumbnail-design/
- Paddy Galloway (3-element rule, glance test, title + thumbnail as one): https://x.com/PaddyG96/status/1450463472907657220 , https://x.com/PaddyG96/status/1811083499044044951 , https://www.colinandsamir.com/resources/the-new-rules-of-youtube-from-paddy-galloway
- Channels studied (Oct 2026 uploads): Starter Story, Marc Lou, Greg Isenberg, Alex Finn, Riley Brown, Theo (t3.gg), Fireship, Ali Abdaal, Simon Høiberg, Tech With Tim.
