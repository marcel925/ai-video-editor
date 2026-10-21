#!/usr/bin/env python3
"""Check the copy-paste posts in <project>/upload/social-posts.md.

  postcheck.py <project>

Every post block in that file is a fenced code block preceded by a marker:

  <!-- check: x 280 -->          X weighting (URL = 23, emoji/CJK = 2), limit 280
  <!-- check: chars 500 -->      plain code points, limit 500
  <!-- check: chars 3000 fold=140 -->   also print the text above "see more"

For each block it prints the platform heading, the count against the limit
and, with fold=N, the first N characters, which is all a reader sees before
expanding the post. It also flags the tells that a model re-introduces most
often after an unslop pass: em/en dashes, "[link]"-style placeholders and a
short list of stock phrases. Exits 1 if any block is over its limit or
carries a dash or a placeholder.
"""
from __future__ import annotations

import argparse
import re
import sys
import unicodedata
from pathlib import Path

MARK = re.compile(r"<!--\s*check:\s*(x|chars)\s+(\d+)(?:\s+fold=(\d+))?\s*-->")
FENCE = re.compile(r"^(`{3,})")
URL = re.compile(r"https?://\S+")
PLACEHOLDER = re.compile(r"\[(?:link|url|video link|youtube link)[^\]]*\]|<(?:link|url)>|\{\{", re.I)
STOCK = [
    "🧵", "a thread", "let's dive", "dive in", "delve", "game-changer", "game changer",
    "here's the thing", "here's the kicker", "the result?", "the best part?", "it's not just",
    "not just about", "unlock", "in today's", "fast-paced", "agree?", "thoughts?",
    "comment yes", "tag a friend", "like for part",
]


def x_weight(text: str) -> int:
    """X counts a URL as 23 and most emoji / CJK as 2 (twitter-text v3)."""
    n = 0
    for part in re.split(r"(https?://\S+)", text):
        if URL.fullmatch(part):
            n += 23
            continue
        for ch in part:
            cp = ord(ch)
            if unicodedata.category(ch) in ("Mn", "Me") or cp in (0x200D, 0xFE0F):
                continue  # combining marks, ZWJ and variation selectors ride along
            light = (cp <= 0x10FF or 0x2000 <= cp <= 0x200D or 0x2010 <= cp <= 0x201F
                     or 0x2032 <= cp <= 0x2037)
            n += 1 if light else 2
    return n


def blocks(md: str):
    lines = md.splitlines()
    heading, i = "", 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("## "):
            heading = line[3:].strip()
        m = MARK.search(line)
        if m:
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            f = FENCE.match(lines[j]) if j < len(lines) else None
            if not f:
                yield heading, m, None, i + 1
                i += 1
                continue
            body, k = [], j + 1
            while k < len(lines) and not lines[k].startswith(f.group(1)):
                body.append(lines[k])
                k += 1
            yield heading, m, "\n".join(body), i + 1
            i = k
        i += 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    args = ap.parse_args()

    path = Path(args.project).expanduser().resolve() / "upload" / "social-posts.md"
    if not path.exists():
        print(f"error: {path} not found", file=sys.stderr)
        return 1
    md = path.read_text()

    bad = 0
    for heading, m, text, line in blocks(md):
        mode, limit, fold = m.group(1), int(m.group(2)), m.group(3)
        if text is None:
            print(f"line {line}: marker with no code block after it")
            bad += 1
            continue
        n = x_weight(text) if mode == "x" else len(text)
        problems = []
        if n > limit:
            problems.append(f"OVER by {n - limit}")
        if "—" in text or "–" in text:
            problems.append("em/en dash")
        if PLACEHOLDER.search(text):
            problems.append("placeholder")
        bad += bool(problems)
        low = text.lower()
        stock = [s for s in STOCK if s in low]
        flag = f"  !! {', '.join(problems)}" if problems else ""
        warn = f"  (check: {', '.join(stock)})" if stock else ""
        print(f"line {line:4}  {heading[:28]:28}  {n:5}/{limit:<5}{flag}{warn}")
        if fold:
            above = text[: int(fold)].replace("\n", " / ")
            print(f"            above the fold: {above}")
    if bad:
        print(f"\n{bad} block(s) need fixing", file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
