---
name: youtube_metadata
description: Write YouTube metadata for a finished video - title options, description, chapters, tags, settings, pinned comment and stock credits - into <project>/upload/youtube-metadata.md, beside title-named copies of the finals and captions.srt, so the upload/ folder holds everything needed in YouTube Studio. Use after the finals are rendered, or when the user asks for titles, descriptions, chapters, tags, "YouTube metadata" or files to upload. Accepts one project name or "all".
---

# youtube_metadata

Everything the user pastes into YouTube Studio, written from what they
actually say in the cut, plus the files to drag into the upload dialog, all
in one folder:

```
$P/upload/
  youtube-metadata.md            titles, description, chapters, tags, settings
  <title 1> (edited).mp4         copy of final_edited.mp4
  <title 1> (plain).mp4          copy of final.mp4
  captions.srt                   copy of build/captions.srt
```

```
/youtube_metadata <project_name>      # one video
/youtube_metadata all                 # every project under videos/ with a final
```

`$PY`, `$T` and `$P` are as in the `edit_video` skill:

```bash
PY="${CLAUDE_PLUGIN_DATA}/venv/bin/python"; T="${CLAUDE_PLUGIN_ROOT}/tools"
```

(or `PY=.venv/bin/python; T=tools` in a clone). `$P` is `videos/<project_name>`.

## Preconditions

`$P/build/timeline.json` must exist (run `/edit_video` first). The upload
step also needs `$P/final.mp4` and/or `$P/final_edited.mp4`. If neither
exists, write the metadata anyway and tell the user to render the finals
(`bash $T/build.sh <project_name> final`, or `npm run final --
<project_name>` in a clone), then re-run the upload step.

For `all`, handle every folder in `videos/` that has `build/timeline.json`.
Do the sibling pairs (`x_long` / `x_short`) together, so each can mention
the other.

## Step 1 - read the video

1. `$PY $T/words.py $P` prints every sentence with its time **on the output
   timeline**. That is the only source of truth for what the video says and
   for chapter times. Read all of it; never write metadata from the
   segment list or the raw transcripts, which include the cut takes.
2. `$P/assets/stock/CREDITS.md` if present (stock credits).
3. The sibling project, if any (`_long` ↔ `_short`), so each description
   can point at the other.
4. `$P/upload/youtube-metadata.md` if it already exists. **Ask before overwriting**
   a file the user may have edited, or update it in place.

The chapter times come from the timeline that was rendered last. If
`final.mp4` exists, check its duration (`ffprobe`) matches
`timeline.json`'s `duration`; if not, the edit changed after the final, so
say so rather than publishing chapters that point at the wrong place.

## Step 2 - write `$P/upload/youtube-metadata.md`

`mkdir -p "$P/upload"` first.

Use exactly these sections, so every project reads the same:

```markdown
# YouTube metadata: <project_name>

## Title (pick one)
## Description
## Tags
## Settings
## Pinned comment            (long form only)
## Stock footage credits     (only if CREDITS.md exists)
```

**Titles.** Give 2–3 options, best first, each under 70 characters so they
aren't truncated in search. Lead with the most specific claim the speaker
actually makes (a number, a result, a contrast). Shorts end with
`#Shorts`. Nothing the video doesn't deliver; no clickbait the speaker
wouldn't say themselves.

**Description.**
- The first two lines show above "…more": the hook and the promise, in
  the speaker's own framing and figures.
- Then a short summary of the content. For a list video, one line per
  item, matching the video's numbering.
- Calls to action the speaker makes in the video (comment prompts, the
  next video, their product). **No `[link]` placeholders**: they get
  pasted by mistake, and links in Shorts descriptions aren't tappable
  anyway. Use a URL only if the user has given it to you; otherwise point
  to the channel in general terms ("The full-length version is on my
  channel") and name the product so viewers can search for it. Never
  invent a URL, handle or product claim.
- Long form: a `⏱️ Chapters` block. First chapter at `0:00`, at least
  three, each at least 10 s long, times as `m:ss` taken from `words.py` at
  the sentence where the topic starts. Name chapters by content, not
  "Part 2".
- 3–5 hashtags on the last line. Shorts: `#Shorts` first.
- Shorts are brief: hook, 1–2 lines, a line saying the full-length
  version is on the channel, hashtags.

**Tags.** 8–17 comma-separated phrases, specific before generic: names
of tools/products said on camera, the topic, the format.

**Settings.** Category, audience ("Not made for kids" unless it clearly
is), language, and which file to upload as captions (`captions.srt`, in
the same folder). Long form also gets a
3–5 word thumbnail text idea. Shorts get the "related video" to link.

**Pinned comment** (long form). One question the video itself asks the
viewer, so the pin carries on the conversation.

**Stock credits.** Only apply to the edited version, which is where the
b-roll lives. Copy every line of `CREDITS.md`, dropping the trailing
`` (`file.mp4`) `` local filenames, under the heading
`## Stock footage credits (paste at the end of the description)`, and note
that they can be dropped for a plain upload.

## Step 3 - upload copies

YouTube pre-fills the title from the filename, so put title-named copies
of the finals in `$P/upload/`, using title option 1:

```bash
TITLE="<title 1, made filename-safe (below), no trailing period>"
mkdir -p "$P/upload"
clone() { [ -f "$1" ] || return 0; cp -c "$1" "$2" 2>/dev/null || cp "$1" "$2"; }
clone "$P/final_edited.mp4" "$P/upload/$TITLE (edited).mp4"
clone "$P/final.mp4"        "$P/upload/$TITLE (plain).mp4"
cp "$P/build/captions.srt" "$P/upload/captions.srt"
```

- **Copy, never rename, `final.mp4` / `final_edited.mp4`.** The pipeline
  and `npm run final` write and read those names. `cp -c` makes an APFS
  clone on macOS: instant, no extra disk space, and independent of the
  original. The fallback is a plain copy (Linux).
- Filename-safe means portable to macOS, Linux and Windows: replace `/`
  with ` per ` or `-`, `:` with ` -`, and drop `\ ? * " < > |`. Keep `$`,
  `#`, `'`, `!`, `(`, `)` - they're legal everywhere.
- Remove stale videos in `$P/upload/` from an earlier title first, after
  checking what they are. Never delete `youtube-metadata.md` there.
- A re-render doesn't update `upload/`. Re-run this step after new finals.

## Report

Per video, in a table: title 1 and the `upload/` filenames. Then list
anything the user still has to do in YouTube Studio (e.g. pick the Shorts
related video) and anything you had to judge (e.g. a list video where the
speaker's count doesn't match the items).
Don't paste the full metadata into chat; point to the files.
