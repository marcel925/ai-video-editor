---
name: edit_video_plus
description: Make the more-edited version of a finished talking-head cut - b-roll from Pexels/Pixabay, Remotion motion graphics (title cards, counting numbers, lists, logos, screenshots), split screens, punch-in zooms and sound effects - rendered beside the plain version as preview_edited.mp4 so the two can be compared. Use after /edit_video has produced a cut, or when the user asks for a "more edited", "b-roll", "more engaging" or "both versions" edit.
---

# edit_video_plus

The second pass. `/edit_video` makes the plain cut: the right takes, clean
joins, captions, a few titles. This skill takes **that same cut** and edits
it for retention: cutaways, graphics, zooms and sound, so the user can watch
both and pick.

```
/edit_video_plus <project_name>
```

Read `best_practices.md` (next to this file) before the first edit of a
session. It holds the edit budget and the targets per form.

`$PY`, `$T` and `$P` are as in the `edit_video` skill: start every Bash call
that runs a tool with

```bash
PY="${CLAUDE_PLUGIN_DATA}/venv/bin/python"; T="${CLAUDE_PLUGIN_ROOT}/tools"
```

(or `PY=.venv/bin/python; T=tools` in a clone of the repository, where those
read as literal placeholders). The edited version also needs Node (Remotion)
and a free stock-footage API key; `doctor.py` checks both. Without a key,
skip stock b-roll and use the user's own assets and motion graphics only.

## Preconditions

The plain edit must exist: `$P/build/timeline.json`, `$P/build/cut_preview.mp4`
and, for short form, `$P/build/captions.ass`. If not, run `/edit_video` first.
The edited version never changes the EDL. It reuses the plain cut so the
comparison is only about the editing, and so captions, timings and fixes
carry over for free.

**If the plain EDL changes later, every time in `overlays_edited.json`
downstream of the change moves.** Re-run `words.py $P` and re-derive them.

## Pipeline

```bash
$PY $T/words.py   $P                 # sentence per line, output times
$PY $T/stock.py   search $P "query"  # -> contact sheet; LOOK at it
$PY $T/stock.py   get    $P <id> --name <slug>
#   write $P/build/overlays_edited.json
$PY $T/motion.py  $P                 # Remotion renders, cached
$PY $T/finish.py  $P --variant edited --quality preview
$PY $T/review.py  $P                 # contact sheet + pacing; LOOK at it
```

Output: `$P/preview_edited.mp4` beside the plain `$P/preview.mp4`. After the
user picks and approves, finals:

```bash
$PY $T/render.py   $P --quality final      # if not already done
$PY $T/captions.py $P
$PY $T/finish.py   $P --variant edited --quality final   # -> final_edited.mp4
```

Motion clips render at full resolution once and serve both preview and final.
Once the final is rendered, **run `/youtube_metadata <project_name>`
straight away**, without asking, for the titles, description, chapters and
title-named upload copies. If `upload/youtube-metadata.md` already exists,
update it in place (new chapter times, fresh copies of the finals) rather
than starting over.

## Step 1 - read the video and the frame

1. `words.py $P`: every sentence with its output time. This is the
   script you are editing to.
2. Extract one frame of `build/cut_preview.mp4` and **look at where the
   speaker is**. It decides every placement: graphics go on the empty side
   (`position: "left"` when the speaker sits right of centre), zoom `focus`
   goes on the face (e.g. `[0.68, 0.3]`), a `split` crops around the speaker
   (`focus`).
3. Read `build/overlays.json` and `build/polish.md` from the plain edit, and
   list `assets/`. The user's own screenshots and recordings are the best
   material in the project. Use every one that fits, upgraded (a screenshot
   becomes a `ScreenshotCard`, a text title becomes a `TitleCard`).

## Step 2 - plan beat by beat

Walk the transcript and give each sentence a treatment. The kinds, in the
order to reach for them:

| the words... | treatment |
|---|---|
| quote a number | `BigNumber` (count-up), or `Compare` for before/after |
| enumerate ("lesson one", "three things") | `TitleCard` per section, `ListReveal` for the overview, `KineticText` for a spoken list |
| name a tool or product | `LogoPop` on the word (logo files in `assets/`) |
| mention something the user has a screenshot/recording of | `ScreenshotCard` or `broll` of their file |
| name a concrete thing ("my first mobile app", "a personal tutor") | stock `broll`, or `split` in 9:16 |
| define a term | `LowerThird` |
| land a punchline / verdict | `Stamp`, or a zoom punch |
| admit something, joke, ask for the subscribe | **stay on the face**, zoom punch |
| anything else | `auto_zoom` handles it |

**Stay inside the edit budget** in `best_practices.md`:

| | off the talking head | plain talking head | change every | longest hold |
|---|---|---|---|---|
| long | 20–25 % | 75–80 % | ~4–5 s | ~12 s |
| short | 35–45 % | 55–65 % | ~2–3 s | ~4 s |

Plan more beats than the budget allows, then drop the weakest: generic b-roll
on abstract phrases, a second full-frame shot in a row, text that repeats
what is already on screen. At most two full-frame cutaways in a row.

## Step 3 - source the b-roll

```bash
$PY $T/stock.py search $P "programmer coding at night"   # --kind photo for stills
```

Searches Pexels and Pixabay together (orientation follows the project:
landscape for long, portrait for short), caches results for 24h as Pixabay
requires, and writes a numbered contact sheet to
`build/stock/sheets/<query>_video.jpg`. **Read the sheet**; titles lie.
Then `get` the id printed beside the number you chose. Files land in
`assets/stock/`, credits in `assets/stock/CREDITS.md` (paste into the video
description).

Query with concrete visual nouns ("person crumpling paper", "tablet with bar
chart"), not concepts ("failure", "growth"). Batch every search for a video
first, review the sheets together, then download, which is far faster than
one at a time. Clips with a beginning and an end (a bulb flickering on, a
hand crumpling paper) need `from` set so the action lands inside the slot.
Check it in the review sheet.

Keys live in `.env` (`PEXELS_API_KEY`, `PIXABAY_API_KEY`). Limits are
generous (Pexels 200 req/h, Pixabay 100 req/min), and a video needs ~20.

## Step 4 - write `build/overlays_edited.json`

Times are seconds on the output timeline, read off `words.py --find
"phrase"`. **Never estimate a time.** A cutaway that arrives half a second
after its noun looks like a mistake.

```json
{
  "auto_zoom": {"focus": [0.68, 0.3]},
  "music": {"file": "assets/music/bed.mp3", "volume": 0.12, "duck": true},
  "overlays": [
    {"type": "broll", "file": "assets/stock/coding_night.mp4", "start": 8.6, "end": 12.65,
     "from": 1, "sfx": "whoosh", "note": "'I started building my first app'"},
    {"type": "motion", "comp": "TitleCard", "start": 96.38, "end": 98.8,
     "props": {"kicker": "MISTAKE #2", "title": "Onboarding", "number": "02"}, "sfx": "whoosh"},
    {"type": "zoom", "start": 105.2, "end": 107.1, "scale": 1.08, "focus": [0.68, 0.3]}
  ]
}
```

Every layer takes a `note`: what line it answers. It is how the user (and
you, next session) can read the edit.

### Layers

| type | what | keys |
|---|---|---|
| `broll` | full-frame cutaway; voice continues | `file` (clip or still), `from` (seek into the clip), `fit`: `cover` (default) or `contain` (letterboxed on a blurred copy, for screen recordings, memes, landscape-in-9:16), `inset`, `kenburns` (e.g. `1.06` slow push; good on stills), `speaker`: `"br"`/`"bl"`/... keeps a framed picture-in-picture of the face, `fade` (default 0, hard cut) |
| `split` | b-roll on one half, speaker on the other | `file`, `from`, `side` = where the **b-roll** goes: `left`/`right` (16:9), `top`/`bottom` (9:16, default top), `focus` = speaker crop centre (x for 16:9, y for 9:16) |
| `zoom` | reframe the speaker | `scale`, `focus` `[x, y]`, `ease` (seconds to reach it; 0 = hard punch), `drift` (extra zoom across the window, a slow push) |
| `motion` | a Remotion component (below) | `comp`, `props`, optional `transparent`, `captions` |
| `image`, `text`, `box` | as in the plain skill | |
| `sfx` | a sound | `at`, `name` or `file`, `volume` |

Any layer also takes `"sfx": "whoosh"` (or `{"name": ..., "volume": ...}`)
to play a sound at its start; whooshes are led in 0.12s automatically.

Top level: `auto_zoom` alternates framing at the cut's own joins (merged to
at least `min_hold` seconds apart; explicit zooms win where they overlap).
Scale and hold come from the profile (`edited.auto_zoom`); set `focus` on
the face, or `"auto_zoom": true` to take every default.
`music` mixes a looped, ducked bed. Omit it when there is no track.

Automatic, no keys needed:
- Burned-in captions (short form) are clipped out under **opaque** motion
  cards, since the card already says the words. `"captions": true` on a layer
  keeps them, `false` hides them under any layer.
- Emoji caption badges only appear while the frame is just the speaker.
- SFX and music levels are calibrated to the voice's measured loudness, so
  the preview (not loudness-normalised) and the final sound the same.
- HDR footage (iPhone HLG) is tone-mapped to SDR bt709 so it matches the stock
  and graphics. Never add a colour grade; the footage keeps its own look.

### Sound kit (`$T/sfx/`, synthesised)

`whoosh` / `swoosh`: into a full-frame cutaway or card. `pop`: a graphic or
list item lands. `hit`: a stamp, a verdict. `cash`: money figures. `ding`:
a small number. `click`: subscribe. `riser`: build into a reveal. One
sound per *event*, never one per cut.

### Motion components (`$T/../motion/src/comps/`)

All size themselves to 16:9 or 9:16. `bg`: `"none"` renders transparent
over the speaker (in a dark panel where text needs one); `"dark"`,
`"accent"` (yellow) or `"light"` make an opaque full-frame card. Words in
`*stars*` render in the accent colour. `times` are seconds from the
layer's start, taken from `words.py --find` minus the layer start, so each
line lands on its word.

| comp | use | props (defaults) |
|---|---|---|
| `TitleCard` | section break, full frame | `kicker`, `title`, `subtitle`, `number` ("02", faint behind), `bg` (dark) |
| `BigNumber` | a quoted figure, counting up | `value`, `prefix`, `suffix`, `label`, `decimals`, `from`, `countSeconds`, `position` center/top/left/right, `bg` (none) |
| `ListReveal` | running list with active item | `title`, `items`, `active` (-1 = overview), `times`, `side` left/right/top/center |
| `KineticText` | lines slamming in on their words | `lines`, `times`, `position` center/top/bottom/left/right, `size` (96), `align`, `panel`, `bg` (none), `accent` |
| `LowerThird` | a term, a name, a product | `title`, `subtitle`, `side` |
| `Compare` | before/after bars | `title`, `before`/`after` `{value, label, display}`, `badge` ("6×"), `afterAt`, `bg` (dark) |
| `LogoPop` | named tools, on their words | `items: [{file, label, over, time}]`, `position` |
| `ScreenshotCard` | the user's screenshot as an object | `file`, `frame` phone/browser/none, `caption`, `highlight` ("+28.88%"), `bg` (dark); aspect is measured for you |
| `EndCard` | next video + subscribe click | `kicker`, `title`, `cta` (SUBSCRIBE; FOLLOW for shorts), `position`, `bg` |
| `Stamp` | one-word punchline | `text`, `color`, `rotate`, `position` `[x, y]`, `size` |

`motion.py` renders each entry to `build/motion/<Comp>_<hash>.webm` (alpha)
or `.mp4` (opaque). The hash covers the props, the duration, the frame size
and the component source, so editing a prop or a component re-renders exactly
what changed. To add a component: write it in `motion/src/comps/`, register it
in `motion/src/Root.tsx` and add its name to `COMPS` in `tools/motion.py`
(all relative to the plugin root, `$T/..`).
**Never give a Composition real `defaultProps`**: Remotion merges them into
every render, so sample values leak onto cards that never asked for them.

## Step 5 - render and review

```bash
$PY $T/motion.py  $P
$PY $T/finish.py  $P --variant edited --quality preview
$PY $T/review.py  $P
```

`review.py` prints the pacing (share of runtime off the face against the
edit budget, average change interval, every hold longer than the form's
target) and writes `build/review_edited.jpg`: one frame from the rendered
file inside every layer, labelled. **Read the sheet every time.** Look for:

- a clip landing on a black frame (a flickering lightbulb; fix `from`)
- a clip whose action happens after the slot ends (fix `from`)
- a graphic on the speaker's face, or colliding with captions
- a caption repeating a card (should be automatic; check it is)
- a component sample prop leaking into a render (see above)

If the off-face share is over budget, remove the weakest layers before
reporting. Fix, re-run `motion.py` + `finish.py`, and re-check. Also compare loudness against the plain version (`ffmpeg -af
ebur128`): the integrated figure should barely move.

## Step 6 - report

Tell the user, per video:

- where both files are (`preview.mp4` vs `preview_edited.mp4`) and that they
  share the exact same cut
- the pacing numbers from `review.py`, including the off-face share against
  the budget
- a short list of the beats by kind (how many cutaways, cards, graphics), and
  the three or four strongest moments to watch first, with timestamps
- anything you were unsure about (a stock clip that is only a loose match,
  a joke you kept on the face instead of illustrating)
- that `assets/stock/CREDITS.md` has the credits for the description
- that music is not included unless they supply a track

Then wait. Their notes ("drop the crowd shot", "the stamp is too much") are
edits to `overlays_edited.json` and a `finish.py` re-run.

## Rules

- Same cut as the plain version. Never touch `edl.json` from this skill.
- Every time comes from `words.py`. Never invent one.
- Look at every contact sheet before downloading, and at the review sheet
  before reporting.
- Stay inside the edit budget: 20–25% off the face for long form, 35–45%
  for short.
- Never cover the face on an admission, a joke or a direct ask.
- No colour grades, flashes or glows. The footage keeps its natural look.
- Nothing on the face; nothing in the short-form caption band.
- One visual language: the stock components, the accent yellow, the sound kit.
- Credit stock in `CREDITS.md`; never hotlink.
- Never delete or modify `raw_videos/`, and never overwrite the plain
  `preview.mp4` / `final.mp4`. The edited variant always writes `*_edited.mp4`.
