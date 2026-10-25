#!/usr/bin/env python3
"""Recover a human editor's cut list from their finished video.

Transcribes the edited video, aligns its words with the project's raw
transcripts, and prints where every run of the edit came from: which take,
which raw time, what was said. Jumps in raw time are the cuts; raw that
never appears is what the editor removed.

  compare.py <project> <edited.mp4> [--ours]

This is how editorial rules are learned from a human edit, and how an AI
edit is scored against a human one: --ours prints the same table for the
project's own cut (build/cut_preview.mp4) underneath, for a side-by-side
read.

Words the edit has that no raw transcript does (a song, a sound bite the
editor added, a word the recogniser missed) are listed as "not in the raw".
"""
from __future__ import annotations

import argparse
import difflib
import sys
from pathlib import Path

from common import die, fmt_ts, load_json, normalize_words, project_paths


def edit_words(video: Path) -> list[dict]:
    from transcribe import load_engine
    import subprocess
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "a.wav"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(video), "-ac", "1",
                        "-ar", "16000", str(wav)], check=True)
        dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                    "-of", "csv=p=0", str(wav)], capture_output=True,
                                   text=True).stdout.strip())
        _, run = load_engine("auto")
        segs = run(wav, dur)
    return [w for s in segs for w in s["words"]]


def raw_words(paths: dict) -> list[dict]:
    out = []
    for f in sorted(paths["transcripts"].glob("*.json")):
        data = load_json(f)
        for s in data["segments"]:
            for w in s["words"]:
                out.append({**w, "take": data.get("source", f.stem)})
    return out


def cut_list(ew: list[dict], rw: list[dict]) -> list[dict]:
    """Runs of the edit that play contiguous raw from one take."""
    flat_e = [(i, t) for i, w in enumerate(ew) for t in normalize_words(w["w"])[:1]]
    flat_r = [(j, t) for j, w in enumerate(rw) for t in normalize_words(w["w"])[:1]]
    sm = difflib.SequenceMatcher(None, [t for _, t in flat_e], [t for _, t in flat_r], autojunk=False)
    match: dict[int, int] = {}
    for a, b, n in sm.get_matching_blocks():
        for k in range(n):
            match[flat_e[a + k][0]] = flat_r[b + k][0]
    runs: list[dict] = []
    for i, w in enumerate(ew):
        j = match.get(i)
        r = rw[j] if j is not None else None
        off = None if r is None else r["s"] - w["s"]
        last = runs[-1] if runs else None
        same = (last and r and last["take"] == r["take"] and last["off"] is not None
                and abs(off - last["off"]) < 0.3)
        missing = last and r is None and last["off"] is None
        if same or missing:
            last["words"].append(w["w"])
            last["end"] = w["e"]
            if r:
                last["raw_end"] = r["e"]
        else:
            runs.append({"out": w["s"], "end": w["e"], "take": r["take"] if r else None,
                         "raw": r["s"] if r else None, "raw_end": r["e"] if r else None,
                         "off": off, "words": [w["w"]]})
    return runs


def show(title: str, runs: list[dict]) -> None:
    print(f"\n{title}\n")
    for r in runs:
        where = (f"{r['take']} {fmt_ts(r['raw'])}-{fmt_ts(r['raw_end'])}" if r["take"]
                 else "not in the raw")
        text = " ".join(r["words"])
        print(f"  {fmt_ts(r['out']):>7}  {where:<32} {text[:90]}")
    print(f"\n  {len(runs)} runs")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    ap.add_argument("edited", help="the human-edited video")
    ap.add_argument("--ours", action="store_true",
                    help="also align the project's own build/cut_preview.mp4")
    args = ap.parse_args()
    paths = project_paths(args.project)
    rw = raw_words(paths)
    if not rw:
        die("no transcripts - run ingest.py and transcribe.py on the project first")
    show(f"{Path(args.edited).name}", cut_list(edit_words(Path(args.edited)), rw))
    if args.ours:
        ours = paths["build"] / "cut_preview.mp4"
        if not ours.exists():
            die(f"no {ours} - run render.py first")
        show("this project's cut", cut_list(edit_words(ours), rw))
    return 0


if __name__ == "__main__":
    sys.exit(main())
