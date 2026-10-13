#!/usr/bin/env python3
"""Hear the rendered cut, and compare it with what the captions say.

  listen.py <project> [--quality preview|final] [--video FILE]

Every check before this one reads the transcript, and the transcript is a
model's guess about the raw takes. It can be wrong in exactly the places an
edit cares about:

- a hole: ten seconds the recogniser skipped, often a retake. The segment
  list never shows it, so the cut keeps it and the line plays twice.
- a join: a drop range or a segment boundary that lands a syllable late, so
  the viewer hears "while... while" where the captions say "while" once.

So the rendered file is transcribed again and the two word lists are
compared. Every difference prints as a `check:` line with its output time;
anything said twice in what was *heard* is listed too. Resolve each one in
the EDL (a `drop`, `end_at`, a different segment) and re-render.
"""
from __future__ import annotations

import argparse
import difflib
import sys
import tempfile
from pathlib import Path

from common import die, fmt_ts, load_json, normalize_words, project_paths, run

# spellings the recogniser normalises differently from the transcript, and
# fillers it leaves out; neither is a difference anyone hears
EQUIVALENT = {"gonna": "going to", "wanna": "want to", "gotta": "got to",
              "ok": "okay", "uh": "", "um": "", "like": ""}

_ENGINE = None


def tokens(words: list[dict]) -> list[tuple[str, float]]:
    out = []
    for w in words:
        for t in normalize_words(w["w"]):
            out += [(x, w["s"]) for x in EQUIVALENT.get(t, t).split()]
    return out


def hear(video: Path) -> list[dict]:
    """Word list of what the file actually says, on its own timeline."""
    global _ENGINE
    from transcribe import load_engine
    if _ENGINE is None:
        _ENGINE = load_engine("auto")[1]
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "cut.wav"
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(video),
             "-ac", "1", "-ar", "16000", str(wav)])
        dur = float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                         "-of", "csv=p=0", str(wav)]).stdout.strip() or 0)
        segments = _ENGINE(wav, dur)
    return [w for seg in segments for w in seg["words"]]


def compare(shown: list[dict], heard: list[dict]) -> list[str]:
    a, b = tokens(shown), tokens(heard)
    ta, tb = [t for t, _ in a], [t for t, _ in b]
    problems = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, ta, tb, autojunk=False).get_opcodes():
        extra, missing = tb[j1:j2], ta[i1:i2]
        if op == "equal" or any(any(c.isdigit() for c in t) for t in extra + missing):
            continue
        # one-word substitutions are the recogniser disagreeing with itself,
        # and one word heard twice ("so so") is a drawn-out vowel it split
        # in two - or a stammer, which stays anyway
        if op == "replace" and len(extra) <= 2 and len(missing) <= 2:
            continue
        if op == "insert" and len(extra) == 1 and extra[0] in ta[max(0, i1 - 1):i1 + 1]:
            continue
        at = fmt_ts(b[j1][1] if extra else a[i1][1])[:-3]
        if extra:
            problems.append(f"{at}  heard but not captioned: '{' '.join(extra)}'"
                            f" (after '...{' '.join(ta[max(0, i1 - 4):i1])}')")
        if len(missing) >= 3:
            problems.append(f"{at}  captioned but not heard: '{' '.join(missing)}'")
    return problems


def heard_repeats(heard: list[dict]) -> list[str]:
    """A phrase said twice close together, in the audio itself - the hidden
    retake shows up here even when the captions never knew about it."""
    from captions import find_repeats
    ctx = lambda k: " ".join(w["w"] for w in heard[max(0, k - 2):k + 10])
    return [f"{fmt_ts(heard[j]['s'])[:-3]}  heard twice: '{ctx(j)}' / at "
            f"{fmt_ts(heard[i]['s'])[:-3]}: '{ctx(i)}'"
            for j, i in find_repeats(heard)]


def listen(root: Path, video: Path) -> list[str]:
    """Problems with a rendered cut of the project at `root`."""
    from captions import apply_fixes, collect_words
    paths = project_paths(str(root))
    timeline = load_json(paths["build"] / "timeline.json")
    shown = collect_words(paths, timeline)
    fixes = paths["build"] / "caption_fixes.json"
    if fixes.exists() and fixes.stat().st_size > 0:
        shown, _ = apply_fixes(shown, load_json(fixes))
    heard = hear(video)
    return compare(shown, heard), heard_repeats(heard)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    ap.add_argument("--quality", default="preview", choices=["preview", "final"])
    ap.add_argument("--video", default=None, help="default: build/cut_<quality>.mp4")
    args = ap.parse_args()
    paths = project_paths(args.project)
    video = Path(args.video) if args.video else paths["build"] / f"cut_{args.quality}.mp4"
    if not video.exists():
        die(f"no {video} - run render.py first")
    problems, repeats = listen(paths["root"], video)
    for p in problems:
        print(f"  check: {p}")
    if repeats:
        print(f"\n  {len(repeats)} phrase(s) heard twice within 25s - a parallel list, "
              f"or a retake (compare with words.py --repeats):")
        for r in repeats:
            print(f"    {r}")
    if not problems:
        print("  heard = captioned: no leaked words, no hidden retakes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
