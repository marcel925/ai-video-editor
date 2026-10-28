# edit_video reference

Formats and options for the files the skill writes. `$P` is the project
folder, `$PY`/`$T` as defined in `SKILL.md`.

## The EDL: `$P/build/edl.json`

```json
{
  "profile": "long",
  "cuts": [
    {"segments": ["b01", "b02"], "note": "intro - take A was abandoned"},
    {"segments": ["c07"], "note": "the install walkthrough"},
    {"segments": ["c12"], "note": "outro", "trim_end": -0.4},
    {"segments": ["d03", "d04"], "drop": [[174.3, 182.4]], "note": "restart removed"}
  ]
}
```

- `segments` - ids from `segments.md`. **Only ever reference ids; never write
  a timestamp you calculated yourself.** The renderer looks up the real times,
  snaps each cut into the neighbouring pause, and pads it.
- All ids in one cut come from the same take. Split across takes.
- `trim_start` / `trim_end` - seconds of nudge (negative tightens), for the
  rare cut the automatic snap lands badly. Use sparingly.
- `note` - why this cut exists. It goes into the summary and the NLE export.
- `drop` - `[start, end]` **source** time ranges to excise from inside the
  cut: a sentence that restarts itself within one segment, where there is no
  id boundary to cut on. Read the range off the word timings in
  `transcripts/<take>.json`; start and end inside a pause or on a sentence
  boundary, never mid-word. Word timings drift a few tenths, so `render.py`
  moves an edge that lands in speech into a pause within 0.2s and prints it;
  an edge further from any pause is reported for `listen.py` to judge.
- `transition` - `dissolve`, `wipe` or `slide`, plus `transition_duration`,
  applied at the join before this cut. Default to none: hard cuts are the
  norm for talking-head video; a dissolve only marks a real scene change.
- `source` + `start` + `end` - raw timestamps, for material with no speech
  (a screen recording, a silent demo).
- `start_at` / `end_at` - a phrase inside the cut's first / last segment to
  start on or end with (first match), as in `shorts.json`. Cuts on the word;
  no timestamp typed.
- `hold` - seconds of picture kept after the cut's last word, exempt from
  pause trimming: a beat for an inserted song, a reaction.
- `max_pause` - this cut's own pause limit, overriding the profile (keep
  the gesture between the words of a spoken list).
- Top-level `"tight_edges": true` cuts every edge on its first and last
  word instead of the loose segment boundary - for edits that skip so much
  that a neighbouring word would leak in at the joins. Use it whenever
  segments end in a cough, a reach for the camera or chatter.
- `keep_nonspeech` - `true` keeps this cut's word-less stretches (a laugh
  that is the joke, a demonstrated gesture). By default the renderer
  (`audio.trim_nonspeech` in the profile) treats every stretch longer than
  `max_pause` with no transcribed words in it like silence and trims it,
  however loud it is: coughs, off-mic laughter, rustling, setting up.

`drop` and `source` are the only places raw times belong. List only the
segments that survive: a cut whose ids skip a segment is split at the gap,
and adjacent cuts from the same take are fused, so no pointless joins appear.

## Shorts: `$P/build/shorts.json`

```json
{
  "count": 3,
  "crops": {"IMG_6514.mov": 0.6},
  "shorts": [
    {"slug": "marketing_beats_code", "title": "Marketing > code",
     "note": "contrarian claim from a developer, then the downloads arithmetic",
     "cuts": [
       {"segments": ["c26", "c27", "c28", "c29", "c31", "c32"],
        "start_at": "marketing is more important"}
     ]},
    {"slug": "speed", "title": "The #1 startup lesson",
     "cuts": [
       {"segments": ["a04"], "note": "hook from the cold open"},
       {"segments": ["b03"], "start_at": "the most important thing"},
       {"segments": ["b05", "b06", "b07"], "end_at": "just use Firebase"}
     ]}
  ]
}
```

- `slug` - the folder name, `$P/shorts/<slug>/`. Unique.
- `title` - optional; drawn in a white card at the top for the whole short.
  Keep it under ~30 characters; it wraps into balanced lines.
- `cuts` - EDL cuts (`segments`, `drop`, `trim_start`, `trim_end`), played
  in the order listed. Ids in one cut come from one take. Skipped ids split
  a cut, as in the EDL.
- `start_at` / `end_at` - a phrase inside the cut's first / last segment to
  start on or end with. Found in the word timings, so no time is typed.
- Every edge of every run is cut on its first and last word, not on the
  loose segment boundary, so nothing of a skipped neighbour leaks in.
- `drop` ranges and edge trims from the long EDL apply automatically to the
  same segments. A `drop` written on the short's cut replaces an inherited
  one it overlaps (to correct a range the long edit placed badly).
- `crops` - optional; the 9:16 window's centre per take, as a fraction of
  the frame width (or `[x, y]`). Default: the median detected face.
- `count` - how many to render (the first N); `--count` overrides.
- `caption_fixes` / `overlays` - optional, per short, in the short's own
  output time, merged after the automatic ones. The long edit's spelling
  fixes (product names, numerals) are re-timed onto each short by themselves.

## Images, titles, chapters: `$P/build/overlays.json`

Applied by `finish.py`; re-running it alone is the fast iteration loop. Times
are seconds on the **output** timeline (`words.py --find "phrase"`).

```json
{"overlays": [
  {"type": "image", "file": "assets/diagram.png", "start": 84, "end": 97,
   "scale": 0.8, "position": "center", "fade": 0.3},
  {"type": "text", "text": "2. Configuring the CLI", "start": 84, "end": 89,
   "style": "chapter"},
  {"type": "box", "start": 120, "end": 124, "color": "black@0.6"}
]}
```

- `file` - PNG/JPEG still, animated `.gif`, or a clip (`.mp4`, `.mov`,
  `.webm`). A still is frozen for its slot; a gif or clip loops to fill it.
- `scale` - fraction of frame width. `position` - `center`, `top`, `bottom`,
  `left`, `right`, `tl`, `tr`, `bl`, `br`, or `[x, y]` fractions.
- `fade` - seconds of alpha fade in and out.
- Text `style` - `title` (full-frame card), `lower_third` (a term or name),
  `chapter` (running counter in the corner), `caption`.
- `box` dims the whole frame, e.g. behind a full-screen title.

"Put that diagram over 1:24 to 1:37 at 80%" is one entry here and a
`finish.py` re-run.

## Captions

`captions.py` writes `$P/build/captions.ass` (styled, for burn-in) and
`$P/build/captions.srt` (for upload).

- **Short form burns in** (karaoke style, above the platform UI). **Long form
  does not**: upload the `.srt` to YouTube, where viewers can turn it off,
  it is indexed and translated, and typos can be fixed after publishing.
  Override with `finish.py --captions on|off` or `captions.py --style
  subtle|bold|karaoke`. Never both burn in and upload.
- Short form adds **emoji badges** above the caption on keywords (at most one
  per caption), composited as images from the system's colour emoji font.
  Without Pillow or an emoji font they are skipped with a warning.

After writing, `captions.py` prints `check:` lines: phrases said twice within
25s, and lowercase words straight after a full stop (a join that cut a
sentence start). Resolve each one.

### Caption fixes: `$P/build/caption_fixes.json`

```json
{"replace": [{"at": 43.6, "from": "post", "to": "PostHog."}],
 "drop":    [{"at": 44.1, "word": "hoc"}]}
```

`at` is output-timeline seconds, matched within a quarter second; leave it out
to apply everywhere (right for a word the engine always gets wrong). **These
times move whenever the EDL changes** - re-check them after a re-cut.

Look for:

- **Product and brand names** split or mangled ("Revenue Cat", "post hoc").
- **Stray words at a join** - a fragment of the removed material. If it is
  audible, fix the EDL (`trim_end`), not the caption.
- **Casing after a join** - "big. so I read" -> "So".
- **Numbers and initialisms** - "A B experiments" -> "A/B".

Do not "fix" the speaker: stammers and repeated words that are really in the
audio stay. Correcting a misheard word in `transcripts/<take>.json` is fine
when the audio plainly says otherwise; re-run `prepare.py` and tell the user.

## Handing off to a real editor

```bash
$PY $T/export.py $P
```

Writes `$P/build/edit.otio` (DaVinci Resolve: File -> Import -> Timeline) and
`$P/build/edit.fcpxml` (Final Cut, Premiere), referencing the original
footage, so every decision carries over.
