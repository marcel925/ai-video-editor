#!/usr/bin/env python3
"""Word-level times on the output timeline - for landing an edit on a word.

  words.py <project>                    sentence per line, with its start time
  words.py <project> --find "no code"   every output time the phrase is spoken
  words.py <project> --repeats          phrases said twice within a few seconds

Writes build/words.json as well. Times come through the same remapping the
captions use, so a b-roll cut or a sound effect placed at a --find result
lands on the syllable, not on a guess. Re-run after any EDL change: every
time downstream of a trim moves.
"""
from __future__ import annotations

import argparse
import sys

from captions import apply_fixes, collect_words, find_repeats
from common import load_json, normalize_words, project_paths, save_json


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("project")
    ap.add_argument("--find", action="append", default=[],
                    help="phrase to locate; repeatable")
    ap.add_argument("--repeats", action="store_true",
                    help="list 4-word phrases repeated within 25s - retakes "
                         "that survived the cut")
    args = ap.parse_args()

    paths = project_paths(args.project)
    timeline = load_json(paths["build"] / "timeline.json")
    words = collect_words(paths, timeline)
    fixes = paths["build"] / "caption_fixes.json"
    if fixes.exists():
        words, _ = apply_fixes(words, load_json(fixes))
    save_json(paths["build"] / "words.json", words)

    if args.find:
        tokens = [normalize_words(w["w"]) for w in words]
        flat = [(i, t) for i, ts in enumerate(tokens) for t in ts]
        for phrase in args.find:
            want = normalize_words(phrase)
            hits = []
            for k in range(len(flat) - len(want) + 1):
                if [t for _, t in flat[k:k + len(want)]] == want:
                    first, last = words[flat[k][0]], words[flat[k + len(want) - 1][0]]
                    hits.append(f"{first['s']:.2f}-{last['e']:.2f}")
            print(f"{phrase!r}: {', '.join(hits) if hits else 'not found'}")
        return 0

    if args.repeats:
        ctx = lambda k: " ".join(w["w"] for w in words[max(0, k - 3):k + 12])
        for j, i in find_repeats(words):
            print(f"{words[j]['s']:7.2f}  {ctx(j)}\n{words[i]['s']:7.2f}  {ctx(i)}\n")
        return 0

    line, start = [], None
    for w in words:
        if start is None:
            start = w["s"]
        line.append(w["w"])
        if w["w"].endswith((".", "?", "!")) or len(line) >= 18:
            print(f"{start:7.2f}  {' '.join(line)}")
            line, start = [], None
    if line:
        print(f"{start:7.2f}  {' '.join(line)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
