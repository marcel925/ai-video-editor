---
name: edit_video
description: Edit raw talking-head recordings into a publishable video. Transcribes every take, picks the good ones, discards failed takes, false starts and double takes, and assembles the cut with ffmpeg. Produces the plain version; the more-edited version follows via edit_video_plus. Use when the user asks to edit a video, cut footage, assemble takes, make a short, or add captions/titles/images to an edit.
---

# edit_video

Turn a folder of raw recordings into a finished video. Everything runs
locally; nothing is uploaded.

```
/edit_video <project_name> [long|short]
```

`<project_name>` is a folder under `videos/` in the working folder. The name
carries the form: `_short` edits short, anything else long. Pass an explicit
`long`/`short` (`$F`) through as `--profile` only when the user gives one. Topics
usually come in pairs (`my_topic_long`, `my_topic_short`): separate projects,
each run through the whole pipeline. Never derive the short from the long.

Formats and options for every file below are in `reference.md` next to this
file. Read it before writing an EDL or overlays for the first time.

## Paths

Start every Bash call that runs a tool with:

```bash
PY="${CLAUDE_PLUGIN_DATA}/venv/bin/python"; T="${CLAUDE_PLUGIN_ROOT}/tools"
```

Shell variables do not persist between calls, so repeat it each time. If those
values still read as literal `${...}` placeholders, the skill was loaded from
a clone of the repository: use `PY=.venv/bin/python; T=tools` from the repo
root instead.

**First run.** If `$PY` does not exist, the tools are not set up. Tell the
user, then (with their go-ahead, since it installs ffmpeg/Node on macOS via
Homebrew and downloads a transcription model) run
`bash "$T/setup.sh" --venv "${CLAUDE_PLUGIN_DATA}/venv"` (clone:
`tools/setup.sh`). If `doctor.py` reports a failure, fix it before rendering.

`$P` is `videos/<project_name>`. If the folder does not exist, list `videos/`
and ask which project they meant. To start one:
`mkdir -p videos/<name>_long/{raw_videos,assets}`.

```
videos/<project>/
  raw_videos/     the recordings (the user creates only this)
  assets/         screenshots, logos, recordings to overlay (optional)
  raw_audios/  transcripts/  build/     generated
  preview.mp4  final.mp4                the plain version
  preview_edited.mp4  final_edited.mp4  the edited version (edit_video_plus)
  upload/                               metadata + title-named copies to upload (youtube_metadata)
```

## Pipeline

```bash
$PY $T/doctor.py                          # first run only
$PY $T/ingest.py     $P [--profile $F]    # flag only if the user gave one
$PY $T/transcribe.py $P
$PY $T/prepare.py    $P
$PY $T/reframe.py    $P                   # short form only
```

**If `prepare.py` warns that speech is missing, run `transcribe.py $P
--force` before editing.** A hole is invisible from `segments.md` alone.

Read `$P/build/segments.md` in full and write `$P/build/edl.json` (the
editorial pass below). Then:

```bash
$PY $T/render.py   $P --quality preview
$PY $T/captions.py $P
```

Resolve every `check:` line `captions.py` prints, run `words.py $P
--repeats`, and read `$P/build/captions.srt` end to end (see "No double
takes" and `reference.md`). Then:

```bash
$PY $T/finish.py   $P --quality preview
```

Show the user `$P/preview.mp4` with the report, and **wait for notes**. Only
after they approve:

```bash
$PY $T/render.py   $P --quality final
$PY $T/captions.py $P
$PY $T/finish.py   $P --quality final
```

**Then run `/youtube_metadata <project_name>` straight away**, without
asking, when this is the project's last final: the user asked for plain
only, or `final_edited.mp4` already exists. Otherwise the edited version
comes next and `edit_video_plus` runs it after its own final, so both
copies land in `upload/`. Tell the user once it is done.

Ingest and transcription are cached; a re-render only re-encodes the clips
that changed.

## Two versions of every video

Every project gets two edits of the **same cut**, so the user can compare:
the plain one here (titles, a few images) and the edited one from
`edit_video_plus` (b-roll, graphics, zooms, sound). Settle the cut on the
plain version first, then continue with `edit_video_plus` unless the user
asked for plain only. Never start the edited version while the EDL is still
changing: every time in it hangs off the cut.

## The editorial pass

Read every segment before deciding anything. Work out what the video is
trying to be, then cut toward it. The folder name is a label, not a brief:
when it disagrees with the footage, cut the footage and say so.

**Retakes.** `segments.md` groups near-identical wording under `~dup`
markers; keep exactly one per group. The later attempt usually wins, but read
the words after each candidate: a take that ends in "sorry", "let me try that
again" or trails off is the failed one wherever it sits. Consecutive items of
a parallel list ("don't build your own auth, use X... don't build your own
payments, use Y") can match without being retakes; keep them all and say so.

**Discard on sight.** `~filler` segments, false starts, self-corrections and
everything between the flub and the restart, setup chatter ("is this
recording"), and tangents off the topic.

**Leave alone.** Do not remove individual "um"s from inside a good sentence;
each removal is an audible chop. Cut whole segments.

**Pacing.** Long silences inside a cut are trimmed mechanically
(`audio.max_pause`: 0.55s long, 0.35s short). In long form keep thinking
pauses as beats; in short form cut everything that is not the point.

**No double takes.** The finished cut never contains the same line twice.
The `~dup` markers only catch retakes that land in different segments; they
often sit inside one ("My second most important lesson is my second most
important lesson is the onboarding"). After every render:

```bash
$PY $T/words.py $P --repeats
```

It lists every phrase said twice within 25 seconds. A restart, an abandoned
sentence followed by its fixed version ("...the much more important part that
got me from - but it was really good marketing..."), or a clause said twice in
a row is a double take: remove the first attempt with `drop` (or
`trim_start` when it opens the segment) and re-render. A parallel list is
not. A point made twice paragraphs apart is judgement: keep the better
telling and say which in the report. After a `drop`, check the casing of the
word that now follows the join.

**Short form is a different edit.** The first two seconds are the hook, so
open on the most compelling sentence in the whole recording, even if it is
four minutes in. One idea, under 55 seconds, no preamble.

**Order** is chronological within the winning takes unless the recording was
made out of order; say so if you reorder.

**The static frame.** The renderer adds a small punch-in (`video.punch_in`,
4-7%) on alternate clips at sentence-ending pauses. Keep it small; above ~10%
it reads as a mistake. Overlays (below) do the rest.

## Reporting the cut

Check the render first:

- The rendered runtime should match the sum of the kept segments within a few
  seconds. A bigger gap means the timeline does not match the EDL.
- Grep the flattened `.srt` for a phrase from each thing you dropped and each
  thing that must survive:

  ```bash
  flat() { grep -vE '^[0-9]+$|-->' "$1" | tr '\n' ' ' | tr -s ' '; }
  flat $P/build/captions.srt | grep -c "the phrase"
  ```

Then tell the user:

- runtime, and how much raw footage it came from
- what you kept, in order, by `note`
- **what you dropped and why**, especially every retake and double-take decision
- anything you were unsure about, named so they can check it
- **overlay proposals** (below). A report without them is unfinished.

The preview is a proposal, not a finished video.

## Suggesting polish

End every edit by proposing where to break the frame: 3-5 places in a short,
5-10 in a long form. Write them to `$P/build/polish.md` and show them as a
table the user can answer line by line:

| # | at | for | what | why |
|---|------|------|--------------------------------|--------------------------|
| 1 | 0:41 | 4s | screenshot of the RevenueCat SDK | the product is named; show it |
| 2 | 1:57 | 3s | reaction gif, exasperated | the "I ignored analytics" beat |

- `at` is output-timeline time; it moves when the EDL changes.
- Pick moments the words point at: a named product, a quoted number, a
  described before/after, a joke. Say concretely what the asset is.
- Space them out, and suggest a length: 3-5s for a logo or title, 6-10s for
  something with detail to read.
- Vary the kind: **text** (enumerations, a quoted number, a defined term; no
  asset needed, so lead with these and give the exact words), screenshot,
  screen recording, stock footage, gif, chart or logo.

Then stop and let the user choose. They drop files into `$P/assets/`; you
turn their answers into `$P/build/overlays.json` and re-run `finish.py` only.

## Rules

- Never invent a timestamp for spoken content. Segment ids only.
- Always show a preview before the final. Ask before overwriting an existing
  `final.mp4`.
- Never delete or modify anything in `raw_videos/`.
- Never edit from a transcript `prepare.py` flagged as incomplete.
- Run `words.py --repeats` after every render. No line may appear twice.
- Read the generated `.srt` before finishing.
- Finish every edit with overlay proposals, then make the edited version
  with `edit_video_plus`. It never replaces the plain files.
- Never reword what the speaker actually said.
- Every final render ends with `/youtube_metadata`, run automatically. A
  project is not finished until its `upload/` folder is current.
