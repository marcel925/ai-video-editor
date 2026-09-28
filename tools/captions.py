#!/usr/bin/env python3
"""Step 6a - build a styled ASS subtitle file for the cut.

Word timings come from the transcripts and get remapped through timeline.json
into output time, so captions stay locked to the edit even after cuts move.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from common import (ass_ts, die, find_emoji_font, info, load_json, load_profile,
                    normalize_words, project_paths)

# ASS colours are &HAABBGGRR - alpha first, then blue/green/red.
STYLES = {
    "subtle": {
        "font": "Helvetica Neue", "size_ratio": 0.034, "bold": -1,
        "primary": "&H00FFFFFF", "outline_colour": "&H00000000",
        "back": "&H80000000", "border_style": 1, "outline": 2.5, "shadow": 0,
        "align": 2, "margin_v_ratio": 0.055,
        "max_words": 8, "max_chars": 48, "karaoke": False, "emoji": False,
    },
    "bold": {
        "font": "Arial", "size_ratio": 0.055, "bold": -1,
        "primary": "&H00FFFFFF", "outline_colour": "&H00000000",
        "back": "&HB0000000", "border_style": 1, "outline": 4, "shadow": 1,
        "align": 2, "margin_v_ratio": 0.09,
        "max_words": 6, "max_chars": 34, "karaoke": False, "emoji": False,
    },
    "karaoke": {
        "font": "Arial", "size_ratio": 0.058, "bold": -1,
        "primary": "&H00FFFFFF", "outline_colour": "&H00000000",
        "back": "&H00000000", "border_style": 1, "outline": 6, "shadow": 0,
        # bottom-anchored 30% of the way up: clear of the face, and above the
        # platform's own UI chrome along the bottom edge
        "align": 2, "margin_v_ratio": 0.30,
        "max_words": 4, "max_chars": 25, "karaoke": True, "emoji": True,
        "highlight": "&H0000E5FF",
    },
}

GROUP_GAP = 0.7          # a pause this long starts a new caption
HEAD_TOL = 0.25          # how early a cut's first word may be labelled
SENTENCE_END = (".", "?", "!", "…")

# Emoji are punctuation, not decoration: one per caption at most, and never
# twice in quick succession, or the eye starts reading the badges instead of
# the face. Keys match a caption's words after stripping case and punctuation.
EMOJI = {
    "app": "\U0001F4F1", "apps": "\U0001F4F1",
    "dollars": "\U0001F4B0", "money": "\U0001F4B0", "revenue": "\U0001F4B0",
    "code": "\U0001F4BB", "coding": "\U0001F4BB",
    "users": "\U0001F465",
    "mistakes": "❌", "mistake": "❌",
    "scratch": "\U0001F195",
    "journey": "\U0001F680",
    "learning": "\U0001F9E0", "learn": "\U0001F9E0",
}
EMOJI_SPACING = 2.5      # seconds between badges, so they stay a punctuation


def collect_words(paths: dict, timeline: dict) -> list[dict]:
    """Flatten every spoken word into output-timeline coordinates.

    An ASR word's span runs from its own onset to the next word's onset, so it
    swallows whatever silence follows it. The last word before a pause can
    therefore carry a second or more of padding. Two rules fall out of that,
    and they are not symmetric:

    - at a cut's tail, judge by the onset, not the end. Demanding the whole
      word sit inside the cut drops a word that is entirely audible, because
      pause compression trims into exactly that padding. It is how "no
      revenue, no code" shipped reading "no revenue, no".
    - at a cut's head, an onset well before the cut means the word's body is
      back in the material we removed and only its padding reaches in. Those
      are the abandoned tails of other sentences - "story.", "else?",
      "important." - and they read as noise. Measured across four edits the
      two populations separate cleanly: a genuine first word starts at most
      0.2s early, a stray at least 0.26s early.

    So: keep the cuts whose range holds the word's onset, then among those
    take the one it overlaps most.
    """
    by_source: dict[str, list[dict]] = {}
    for cut in timeline["cuts"]:
        by_source.setdefault(cut["source"], []).append(cut)

    words: list[dict] = []
    for name, cuts in by_source.items():
        tfile = paths["transcripts"] / f"{Path(name).stem}.json"
        if not tfile.exists():
            die(f"missing transcript for {name}")
        data = load_json(tfile)
        for word in (w for seg in data["segments"] for w in seg["words"]):
            best, share = None, 0.0
            for cut in cuts:
                # a boundary the EDL placed by hand is exact; only a
                # snapped one needs the drift allowance
                tol = 0.02 if cut.get("exact_start") else HEAD_TOL
                if not (cut["src_start"] - tol <= word["s"] < cut["src_end"]):
                    continue
                overlap = (min(word["e"], cut["src_end"])
                           - max(word["s"], cut["src_start"]))
                if overlap > share:
                    best, share = cut, overlap
            if best is None:
                continue
            shift = best["out_start"] - best["src_start"]
            start = max(word["s"] + shift, best["out_start"])
            end = min(word["e"] + shift, best["out_end"])
            if end - start < 0.04:
                end = start + 0.04
            words.append({"w": word["w"],
                          "s": round(start, 3), "e": round(end, 3)})
    words.sort(key=lambda w: w["s"])
    return words


def bare(word: str) -> str:
    return word.strip(".,!?;:…").lower()


def apply_fixes(words: list[dict], fixes: dict) -> tuple[list[dict], int]:
    """Caption-only corrections, from build/caption_fixes.json.

    Two lists, both of whose entries take an optional `at` - an output-timeline
    second, matched within a quarter second. Without it the entry applies to
    every occurrence, which is right for a word the engine always gets wrong
    and wrong for a word that is only sometimes a mistake: "revenue" is the
    product RevenueCat once in this video and plain revenue five other times.

    `replace` is for casing, product names and numerals that read badly on
    screen. A word the engine simply misheard belongs in the transcript
    instead, where segments.md and every future render see it too.

    `drop` deletes a word. It exists because word timings drift a little in
    both directions: a word can be labelled late enough to overlap the cut
    that follows it, so a syllable nobody hears turns up in the caption. No
    timing rule separates that from a word labelled early that was spoken, so
    the call is left to the review pass rather than guessed at here.
    """
    def hits(entry: dict, word: dict) -> bool:
        if bare(entry.get("from", entry.get("word", ""))) != bare(word["w"]):
            return False
        return "at" not in entry or abs(float(entry["at"]) - word["s"]) <= 0.25

    replace = fixes.get("replace", [])
    if isinstance(replace, dict):       # {"misheard": "correct"} shorthand
        replace = [{"from": k, "to": v} for k, v in replace.items()]
    drops = fixes.get("drop", [])

    kept, log = [], []
    used = set()
    for word in words:
        hit = next((d for d in drops if hits(d, word)), None)
        if hit is not None:
            used.add(id(hit))
            log.append(f"    {word['s']:8.3f}  drop '{word['w']}'")
            continue
        for entry in replace:
            if hits(entry, word):
                used.add(id(entry))
                log.append(f"    {word['s']:8.3f}  '{word['w']}' -> "
                           f"'{entry['to']}'")
                word["w"] = entry["to"]
                break
        kept.append(word)

    # An entry that matches nothing is almost always an anchor left behind by
    # an EDL change - and an entry that matched the wrong word looks identical
    # in the count, so the log above prints what actually changed.
    for entry in replace + drops:
        if id(entry) not in used:
            log.append(f"    MISSED   {entry.get('from', entry.get('word'))!r}"
                       f" at {entry.get('at', 'any')} matched nothing")
    return kept, log


def group_words(words: list[dict], style: dict) -> list[list[dict]]:
    groups: list[list[dict]] = []
    current: list[dict] = []
    chars = 0
    for word in words:
        gap = word["s"] - current[-1]["e"] if current else 0.0
        too_long = (len(current) >= style["max_words"]
                    or chars + len(word["w"]) + 1 > style["max_chars"])
        # A caption that straddles a full stop is hard to read - break there.
        ends_sentence = bool(current) and current[-1]["w"].endswith(SENTENCE_END)
        if current and (gap > GROUP_GAP or too_long or ends_sentence):
            groups.append(current)
            current, chars = [], 0
        current.append(word)
        chars += len(word["w"]) + 1
    if current:
        groups.append(current)
    return groups


def escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")")


def header(style: dict, width: int, height: int) -> str:
    size = max(12, int(height * style["size_ratio"]))
    margin_v = int(height * style["margin_v_ratio"])
    margin_h = int(width * 0.07)
    return "\n".join([
        "[Script Info]",
        "ScriptType: v4.00+",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Cap,{style['font']},{size},{style['primary']},{style['primary']},"
        f"{style['outline_colour']},{style['back']},{style['bold']},0,0,0,"
        f"100,100,0,0,{style['border_style']},{style['outline']},{style['shadow']},"
        f"{style['align']},{margin_h},{margin_h},{margin_v},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, "
        "MarginV, Effect, Text",
    ])


def events(groups: list[list[dict]], style: dict) -> list[str]:
    lines: list[str] = []
    for g, group in enumerate(groups):
        start = group[0]["s"]
        # Hold each caption a beat longer, but never into the next one.
        end = group[-1]["e"] + 0.30
        if g + 1 < len(groups):
            end = min(end, groups[g + 1][0]["s"] - 0.02)
        if end <= start:
            continue
        if not style["karaoke"]:
            text = escape(" ".join(w["w"] for w in group))
            lines.append(f"Dialogue: 0,{ass_ts(start)},{ass_ts(end)},Cap,,0,0,0,,{text}")
            continue
        # One event per word so the active word can be tinted without
        # relying on karaoke timing support in the renderer.
        for i, word in enumerate(group):
            wstart = word["s"]
            wend = group[i + 1]["s"] if i + 1 < len(group) else end
            if wend <= wstart:
                continue
            parts = []
            for j, other in enumerate(group):
                token = escape(other["w"])
                if j == i:
                    parts.append(f"{{\\c{style['highlight']}}}{token}"
                                 f"{{\\c{style['primary']}}}")
                else:
                    parts.append(token)
            lines.append(f"Dialogue: 0,{ass_ts(wstart)},{ass_ts(wend)},"
                         f"Cap,,0,0,0,,{' '.join(parts)}")
    return lines


def draw_emoji(char: str, path: Path) -> bool:
    """Render one emoji to a square transparent PNG.

    Square on purpose: the badge is placed by width, so a fixed aspect keeps
    every emoji sitting on the same line no matter how narrow its glyph is.
    """
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return False
    found = find_emoji_font()
    if not found:
        return False
    try:
        font = ImageFont.truetype(str(found[0]), found[1])
    except OSError:
        return False
    strike = found[1]
    side = strike * 2
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).text((side // 4, side // 4), char, font=font,
                                embedded_color=True)
    box = canvas.getbbox()
    if not box:
        return False
    glyph = canvas.crop(box)
    out = Image.new("RGBA", (strike, strike), (0, 0, 0, 0))
    glyph.thumbnail((strike, strike))
    out.paste(glyph, ((strike - glyph.width) // 2,
                      (strike - glyph.height) // 2))
    path.parent.mkdir(parents=True, exist_ok=True)
    out.save(path)
    return True


def pick_emoji(groups: list[list[dict]], table: dict) -> list[tuple]:
    """Choose which captions earn a badge, and tag the word it belongs to."""
    chosen: list[tuple] = []
    last = -EMOJI_SPACING
    for group in groups:
        if group[0]["s"] - last < EMOJI_SPACING:
            continue
        for word in group:
            char = table.get(bare(word["w"]))
            if not char:
                continue
            end = group[-1]["e"] + 0.30
            if end - group[0]["s"] < 0.35:
                break
            chosen.append((char, word, group[0]["s"], end))
            last = group[0]["s"]
            break
    return chosen


def emoji_overlays(chosen: list[tuple], style: dict, width: int, height: int,
                   build: Path) -> list[dict]:
    """Place each badge just above the caption line, centred.

    libass cannot draw Apple Color Emoji - it is a bitmap sbix font, and an
    emoji in the ASS text burns in as a tofu box - so the badge is composited
    by finish.py as an image instead. The .srt still carries the real
    character, where the platform's own renderer handles it.
    """
    badge = 0.10                                  # fraction of frame width
    badge_px = width * badge
    line_h = height * style["size_ratio"] * 1.25
    cap_top = height * (1 - style["margin_v_ratio"]) - line_h
    top = cap_top - height * 0.012 - badge_px
    fy = max(0.0, min(1.0, top / max(1.0, height - badge_px)))

    overlays = []
    for char, word, start, end in chosen:
        name = "-".join(f"{ord(c):x}" for c in char)
        png = build / "emoji" / f"{name}.png"
        if not png.exists() and not draw_emoji(char, png):
            return []
        overlays.append({
            "type": "image", "file": str(png.relative_to(build.parent)),
            "start": round(start, 3), "end": round(end, 3),
            "scale": badge, "position": [0.5, round(fy, 4)], "fade": 0.12,
        })
    return overlays


def srt_ts(seconds: float) -> str:
    seconds = max(0.0, seconds)
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")


def write_srt(path: Path, groups: list[list[dict]], badges: dict) -> None:
    """Plain SRT for platforms that take an uploaded subtitle file.

    Uses whole-phrase groups even in karaoke mode - per-word events would
    produce an unreadable SRT.
    """
    blocks = []
    for i, group in enumerate(groups, 1):
        start = group[0]["s"]
        end = group[-1]["e"] + 0.30
        if i < len(groups):
            end = min(end, groups[i][0]["s"] - 0.02)
        if end <= start:
            continue
        text = " ".join(w["w"] + badges.get(id(w), "") for w in group)
        blocks.append(f"{i}\n{srt_ts(start)} --> {srt_ts(end)}\n{text}\n")
    path.write_text("\n".join(blocks))


def find_repeats(words: list[dict], n: int = 4,
                 window: float = 25.0) -> list[tuple[int, int]]:
    """(first, second) word indices of n-word phrases spoken twice close
    together - a retake that survived the cut. Parallel lists ("don't build
    your own X ... don't build your own Y") match too, so each is a candidate
    to read, not a verdict."""
    tokens = [" ".join(normalize_words(w["w"])) for w in words]
    seen: dict[tuple, int] = {}
    hits, last = [], -n
    for i in range(len(tokens) - n + 1):
        gram = tuple(tokens[i:i + n])
        j = seen.get(gram)
        seen[gram] = i
        if j is None or words[i]["s"] - words[j]["s"] > window or j - last < n:
            continue
        last = j
        hits.append((j, i))
    return hits


def join_casing(words: list[dict]) -> list[int]:
    """Word indices that start lowercase right after a full stop - usually a
    join that dropped the start of a sentence, or needs a caption fix."""
    return [i for i in range(1, len(words))
            if words[i - 1]["w"].endswith((".", "?", "!"))
            and words[i]["w"][:1].islower()]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("project")
    ap.add_argument("--style", default=None,
                    choices=sorted(STYLES) + [None])
    ap.add_argument("--out", default=None)
    ap.add_argument("--emoji", choices=["auto", "on", "off"], default="auto")
    args = ap.parse_args()

    paths = project_paths(args.project)
    tpath = paths["build"] / "timeline.json"
    if not tpath.exists():
        die("no build/timeline.json - run tools/render.py first")
    timeline = load_json(tpath)
    profile = load_profile(timeline["profile"])

    name = args.style or profile["captions"]["style"]
    if name not in STYLES:
        die(f"unknown caption style '{name}' (have: {', '.join(sorted(STYLES))})")
    style = STYLES[name]

    fixes = {}
    fpath = paths["build"] / "caption_fixes.json"
    if fpath.exists() and fpath.stat().st_size > 0:
        try:
            fixes = load_json(fpath)
        except json.JSONDecodeError as exc:
            die(f"{fpath} is not valid JSON: {exc}")

    words = collect_words(paths, timeline)
    if not words:
        die("no words landed inside the cut - check the transcripts")
    words, fixlog = apply_fixes(words, fixes)
    groups = group_words(words, style)

    out = Path(args.out) if args.out else paths["build"] / "captions.ass"
    body = header(style, timeline["width"], timeline["height"])
    out.write_text(body + "\n" + "\n".join(events(groups, style)) + "\n")

    want_emoji = (args.emoji == "on"
                  or (args.emoji == "auto" and style["emoji"]))
    table = {**EMOJI, **fixes.get("emoji", {})} if want_emoji else {}
    chosen = pick_emoji(groups, table) if table else []
    overlays = emoji_overlays(chosen, style, timeline["width"],
                              timeline["height"], paths["build"])
    if chosen and not overlays:
        info("  emoji badges skipped - no usable colour emoji font "
             "(pip install pillow, and macOS for Apple Color Emoji)")
        chosen = []
    (paths["build"] / "caption_overlays.json").write_text(
        json.dumps({"overlays": overlays}, indent=2) + "\n")

    srt = out.with_suffix(".srt")
    write_srt(srt, groups, {id(w): c for c, w, _, _ in chosen})

    print(f"{out}")
    print(f"{srt}   (upload this one alongside the video)")
    print(f"  style '{name}' · {len(words)} words · {len(groups)} caption groups")
    if fixlog:
        print(f"  {len(fixlog)} caption fix(es) from caption_fixes.json")
        print("\n".join(fixlog))
    if chosen:
        print(f"  {len(chosen)} emoji badge(s): "
              f"{' '.join(sorted({c for c, _, _, _ in chosen}))}")

    reps = find_repeats(words)
    if reps:
        print(f"\n  check: {len(reps)} phrase(s) said twice within 25s - a double "
              f"take, or a parallel list. `words.py --repeats` shows them.")
    for i in join_casing(words):
        print(f"  check: lowercase after a full stop at {words[i]['s']:.2f}: "
              f"'{words[i - 1]['w']} {words[i]['w']}'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
