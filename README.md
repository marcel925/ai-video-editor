# video_editor

Record a talking-head video in one messy session: flubbed lines, restarts,
three attempts at the intro. Claude turns it into a clean cut with captions,
then a second, more edited version with b-roll, motion graphics and sound, so
you can compare the two and pick one.

Everything runs locally. Your footage never leaves the machine.

<!-- Demo video: link goes here -->

## Get started in 5 minutes

**1. Install** (in Claude Code):

```
/plugin marketplace add marcel925/ai-video-editor
/plugin install video-editor@video-editor
```

The first time you ask for an edit, Claude runs the setup for you, after
asking. It installs ffmpeg, a Python environment and a transcription model
(about 2 GB). On a Mac that uses [Homebrew](https://brew.sh); on Linux,
install `ffmpeg` and `node` from your package manager first.

**2. Get stock footage keys** (optional; only the edited version uses them).
Both are free: [Pexels](https://www.pexels.com/api/) and
[Pixabay](https://pixabay.com/api/docs/). Put them in a file called `.env`
in your working folder (one is enough):

```
PEXELS_API_KEY=your-key
PIXABAY_API_KEY=your-key
```

Without keys you still get motion graphics, your own screenshots, zooms and
sound.

**3. Record.** A few habits make the edit much better:

- **Flubbed a line? Just say it again.** The last complete take wins, so
  there's no need to stop recording or clap.
- Record as many takes and files as you like. They are ordered by when they
  were recorded, not by name.
- For vertical shorts, stay roughly still. The 9:16 crop is placed once per
  take.
- Say numbers, tool names and lists out loud ("three things", "I use
  PostHog"). That is where graphics land.

**4. Make a project folder** in your working folder and drop the recordings in:

```
videos/
  my_topic_long/          _long = YouTube 16:9, _short = Shorts/Reels 9:16
    raw_videos/           your recordings
    assets/               optional: screenshots, logos, screen recordings
```

**5. Ask for the edit:**

```
/video-editor:edit_video my_topic_long
```

You get `preview.mp4` and a summary of what was kept, what was cut and why.
**Reply with notes in plain English** ("keep the second intro", "cut the
pricing tangent", "put my screenshot over 1:24–1:37"). That back-and-forth is
the workflow. When the cut is right, Claude makes `preview_edited.mp4`, the
more edited version of the same cut, and renders finals once you approve.

### Or run it from a clone

```bash
git clone https://github.com/marcel925/ai-video-editor && cd ai-video-editor
tools/setup.sh
claude
```

The skills load as project skills (`/edit_video`, `/edit_video_plus`,
`/youtube_metadata`) and your
projects go in `videos/` inside the clone.

## Platforms

| | transcription | preview encoding | status |
|---|---|---|---|
| macOS, Apple Silicon | parakeet-mlx on the GPU (~60x realtime) | hardware (VideoToolbox) | primary |
| macOS, Intel | faster-whisper (CPU) | software x264 | supported |
| Linux | faster-whisper (CUDA if present, else CPU) | software x264 | supported |
| Windows | as Linux, inside WSL | | via WSL |

Fonts fall back from Arial to DejaVu Sans, and emoji badges from Apple Color
Emoji to Noto Color Emoji. Run `doctor.py` to see what your machine uses.

## How it works

**Machines handle the mechanics:** extract audio, transcribe to word-level
timestamps, find the pauses, cut on frame boundaries, normalise loudness,
encode.

**The AI handles the judgment:** it reads the transcript of everything you
recorded and decides which take of each line to keep, which attempts you
abandoned, and what never belonged in the video.

The AI picks *segment ids* off a numbered list and never writes a timestamp;
real times are looked up in code. That keeps cuts from clipping syllables.

```
raw_videos/  ->  audio  ->  transcript  ->  segments.md
                                                 |
                                      [ the AI reads and decides ]
                                                 |
                                              edl.json
                                                 |
                          ffmpeg  ->  preview.mp4  -> your notes -> final.mp4
```

### Re-rendering and publishing

Once a video is edited, rebuild it without Claude from the repo root:

```bash
npm run final -- my_topic_long      # final.mp4 + final_edited.mp4
npm run preview -- my_topic_long    # quick half-res check, in seconds
npm run final:all                   # every edited project in videos/, one by one
```

`final:plain`, `final:edited`, `preview:plain` and `preview:edited` build one
version. Run projects one after another rather than in parallel: each render
already uses most of the CPU.

When `/edit_video` or `/edit_video_plus` renders a final, it runs
`/youtube_metadata` automatically, so the project's `upload/` folder is
ready as soon as the final is. After an `npm run final` (which runs without
Claude), run `/youtube_metadata my_topic_long` (or `all`) yourself to
refresh it. It writes an `upload/` folder with everything YouTube Studio needs: `youtube-metadata.md`
(titles, description, chapters, tags, credits), title-named copies of the
finals and `captions.srt`.

## Two versions of every video

| | plain | edited |
|---|---|---|
| file | `preview.mp4` / `final.mp4` | `preview_edited.mp4` / `final_edited.mp4` |
| adds | captions, titles, your images | b-roll, split screens, motion graphics, zooms, sound effects |

The edited version keeps to an **edit budget** so it still reads as a person
talking: 20–25% of a long video off the talking head, 35–45% of a short. Tune
it in `profiles/*.yaml`. The editing targets are in
`skills/edit_video_plus/best_practices.md`.

## Long vs short

Not a resolution flag: a different edit.

|                | `long`                        | `short`                         |
|----------------|-------------------------------|---------------------------------|
| Frame          | 1920x1080                     | 1080x1920, cropped to the face  |
| Length         | whatever it needs             | 55 seconds, hard ceiling        |
| Opening        | intro, then content           | hook in the first 2 seconds     |
| Pauses         | kept; they read as natural    | cut                             |
| Captions       | `.srt` to upload, clean frame | burned in, word by word         |

Short form starts on the most compelling sentence in the recording, even if
it is four minutes in.

## What you get

```
videos/my_topic_long/
  preview.mp4 / final.mp4                 the plain version
  preview_edited.mp4 / final_edited.mp4   the edited version, same cut
  assets/stock/CREDITS.md                 stock credits for the description
  build/
    segments.md          every line you said, numbered
    edl.json             the edit, as data (hand-editable)
    captions.srt         subtitles to upload
    edit.otio / .fcpxml  the same cut for DaVinci Resolve or Final Cut
    overlays_edited.json the edited version's layers, as data
```

Everything except `raw_videos/` and `assets/` is generated and rebuilds in
minutes.

## The details that keep it natural

- **Cuts land in the middle of a pause**, not on the transcript's word
  boundary, so no syllable is clipped. Every join gets a 20 ms audio fade.
- **No double takes.** After every render, repeated phrases are flagged, so a
  restarted sentence cannot slip through inside a single segment.
- **Natural colour.** No grading. HDR phone footage is tone-mapped to SDR in
  the edited version so it matches stock footage and graphics.
- **Loudness normalised to −14 LUFS**, what YouTube targets.
- **Video is encoded once**; clips are stream-copied together.

## Tools

Each takes `--help`, and `build/edl.json` is plain JSON, so you can drive the
pipeline by hand.

| | |
|---|---|
| `setup.sh` / `doctor.py` | install everything / check the machine |
| `ingest.py` | probe takes, extract audio, map silences |
| `transcribe.py` | word-level transcripts |
| `prepare.py` | numbered segment list + retake grouping |
| `reframe.py` | place the 9:16 crop on the speaker |
| `render.py` | EDL → cut video |
| `captions.py` | styled `.ass` + uploadable `.srt`, plus automatic checks |
| `words.py` | word times on the output timeline (`--find`, `--repeats`) |
| `finish.py` | captions, overlays, the edited version; final encode |
| `stock.py` | search Pexels + Pixabay, contact sheet, download with credits |
| `motion.py` | render the Remotion motion graphics |
| `review.py` | contact sheet + pacing and edit-budget check |
| `export.py` | timeline for Resolve / Final Cut |

## Limitations

- **It proposes, you approve.** Budget one review pass.
- **Retake detection is text-based.** Two takes with the same words and
  different energy look identical; it tells you when it had to guess.
- **Stock b-roll is a loose match at best.** Your own screen recordings beat
  it; drop them in `assets/`.
- **No music unless you supply it** (`assets/music/`); neither stock API
  serves audio.
- **The 9:16 crop is static per take**, on purpose.

## Licence

MIT (see `LICENSE`). The motion graphics use [Remotion](https://remotion.dev),
which is free for individuals and companies of up to three people; larger
companies need a [Remotion company licence](https://remotion.pro). Stock
footage stays under the Pexels and Pixabay licences; credits are written to
`assets/stock/CREDITS.md`.
