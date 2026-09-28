# What makes these videos good to watch

The reference behind `edit_video_plus`. The plain edit decides *what is said*;
this decides *what the viewer sees and hears while it is said*. The content is
talking-head video: the speaker is the product, and every edit serves them
rather than replacing them.

## The edit budget

The edited version should still feel like a person talking to camera. Aim for
these shares of runtime, and check them with `review.py`:

| | long form | short form |
|---|---|---|
| **off the talking head** (b-roll, splits, full-frame cards) | **20–25 %** | **35–45 %** |
| plain talking head (full frame, nothing replacing it) | **75–80 %** | **55–65 %** |
| visual change (any layer, zoom or cut) | every ~4–5 s | every ~2–3 s |
| longest hold with no change | ~12 s | ~4 s |

The budget and zoom defaults live in `profiles/long.yaml` and
`profiles/short.yaml` under `edited:`; change them there, not in the spec.

Text and graphics laid *over* the speaker do not count as off the face, but
they spend the same attention. Keep at most one on screen at a time, and leave
stretches of plain speaker between them.

When a video is over budget, cut in this order: generic b-roll that illustrates
an abstract phrase ("learn together", "the next step"), a second full-frame
shot in a row, text that repeats something already on screen, and stamps or
cards that restate a title card.

## Principles

**Look natural.** Keep the footage's own colour, exposure and framing. No
grades, filters, flashes or glows. HDR phone footage is tone-mapped to SDR by
`finish.py` so it matches the stock and graphics; nothing else touches colour.

**Regular change, not constant change.** Attention resets on a visual change:
a cutaway, a graphic arriving, a card, a gentle reframe. The rhythm matters
more than the size of any one change.

**Every visual is earned by the words.** B-roll lands on a noun the speaker
says, a graphic on a number or a list they say, a logo on a tool they name.
Decoration "for energy" reads as filler.

**Cut on the word.** A cutaway starts on the syllable it illustrates (or ~0.1 s
before) and ends on a sentence boundary. Take every time from
`words.py --find`.

**Keep the face for the human moments.** Admissions, jokes, direct asks
("subscribe", "tell me in the comments") and the emotional peak of a story stay
on the speaker, at most with a small punch-in.

**One visual language.** One font, one accent colour, the same position for the
same kind of thing, the same sound for the same kind of event.

**Graphics never sit on the face.** Look at a frame first. Panels go on the
empty side; in 9:16 they go in the chest band between face and captions.

**Sound on events, not on cuts.** A soft whoosh into a full-frame cutaway, a pop
when a graphic lands, a hit on a stamp. Keep them 8–12 dB under the voice.

**Stock footage.** Prefer clips with motion. Match the sentence, not the search
term, and look at the frame you will use. Avoid clichés (handshakes, glowing
brains), watermarks, other brands' logos and foreign-language text. Portrait
for 9:16, landscape for 16:9; letterbox on a blurred copy (`fit: "contain"`)
rather than crop a face in half.

**The creator's own material first.** Their screenshots and screen recordings
beat any stock clip. Stock is for abstract beats with nothing real to show.

## Long form (YouTube, 16:9)

| | target |
|---|---|
| b-roll shot | 2.5–5 s; at most 2 full-frame shots in a row |
| full-frame title card | 2–3 s |
| zoom punch-in | 1.04–1.10; `auto_zoom` 1.06 with `min_hold` ≥ 10 s |
| captions | not burned in; upload the `.srt` |

- **Hook in the first 15 s.** Open on the strongest line; the first graphic
  lands within ~3 s.
- **Show the structure.** A roadmap list when one is spoken, a numbered title
  card per section.
- **Numbers become graphics** (`BigNumber`, `Compare`), **named tools become
  logos**, **spoken lists become kinetic text**.
- **End screen.** An end card for the last 5–20 s. One "next video" card, not
  two.

## Short form (Shorts / Reels / TikTok, 9:16)

| | target |
|---|---|
| b-roll shot | 1.2–3 s |
| zoom | 1.05–1.12; `auto_zoom` 1.08 with `min_hold` ≥ 4 s |
| captions | burned in, word by word |

- **The first 1–2 seconds decide everything.** Open on the hook, with the first
  visual change inside 1.5 s.
- **Safe zones.** Top ~12 % is platform UI, bottom ~25 % is captions and CTA,
  the right edge holds the buttons. Graphics go at ~38–58 % height.
- **Split screen** (b-roll top, face bottom) is the default b-roll treatment;
  save full-frame for the two or three punchiest beats.
- **Layer, don't queue.** A number counting up over the speaker is one beat.
- **CTA on screen** for the last 2–4 s.

## Music

A quiet bed (about -25 to -30 LUFS, ducked under speech) is optional.
`finish.py` mixes one from `assets/music/` when the spec names it. Neither
stock API serves audio, so the track has to be supplied.
