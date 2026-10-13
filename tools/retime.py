#!/usr/bin/env python3
"""Move output-timeline times onto a changed cut.

  retime.py <project> [--dry-run]

Overlays and caption fixes are written in seconds on the *output* timeline,
so trimming four seconds at 1:30 leaves everything after it four seconds
late. render.py keeps the timeline the times were written against
(build/timeline.prev.json) whenever the cut changes; this maps every time
through it - old output time -> the take and the moment in it -> new output
time - in overlays.json, overlays_edited.json and caption_fixes.json, then
retires the old timeline.

A time whose moment was cut out moves to the nearest kept moment and is
reported, along with any layer whose length changed: look at those. Motion
props (`times`) are relative to their layer and travel with it.
"""
from __future__ import annotations

import argparse
import json
import sys

from common import die, fmt_ts, load_json, project_paths, save_json

FILES = ("overlays.json", "overlays_edited.json", "caption_fixes.json")


def mapper(old: dict, new: dict):
    def to_source(t: float, end: bool):
        # a time on a join belongs to the cut it starts (or, for an end, ends)
        for c in old["cuts"]:
            if (c["out_start"] < t <= c["out_end"]) if end else \
                    (c["out_start"] <= t < c["out_end"]):
                return c["source"], c["src_start"] + (t - c["out_start"])
        last = old["cuts"][-1]
        return last["source"], last["src_end"]

    def remap(t: float, end: bool = False) -> tuple[float, bool]:
        """New output time, and whether the moment itself survived."""
        src, st = to_source(float(t), end)
        best = None
        for c in new["cuts"]:
            if c["source"] != src:
                continue
            if c["src_start"] - 0.01 <= st <= c["src_end"] + 0.01:
                return round(c["out_start"] + min(max(st - c["src_start"], 0),
                                                  c["src_end"] - c["src_start"]), 3), True
            # the moment was cut: nearest edge of a cut from the same take
            for edge, out in ((c["src_start"], c["out_start"]), (c["src_end"], c["out_end"])):
                d = abs(st - edge)
                if best is None or d < best[0]:
                    best = (d, out)
        if best is None:
            return round(float(t), 3), False
        # a few tenths off a cut's edge is the pause trimming moving the edge,
        # not the moment going missing
        return round(best[1], 3), best[0] <= 0.3
    return remap


def retime_overlays(spec: dict, remap, name: str, log: list[str]) -> None:
    for ov in spec.get("overlays", []):
        label = f"{name}: {ov.get('type')} {ov.get('comp') or ov.get('note', '')[:40]}"
        if "start" in ov and "end" in ov:
            s0, e0 = float(ov["start"]), float(ov["end"])
            s1, ok1 = remap(s0)
            e1, ok2 = remap(e0, end=True)
            ov["start"], ov["end"] = s1, e1
            if not (ok1 and ok2):
                log.append(f"{label} at {fmt_ts(s0)}: its moment was cut - now "
                           f"{fmt_ts(s1)}-{fmt_ts(e1)}")
            elif abs((e1 - s1) - (e0 - s0)) > 0.05:
                log.append(f"{label} at {fmt_ts(s0)}: {e0 - s0:.2f}s -> {e1 - s1:.2f}s, "
                           f"the cut changed inside it")
        if "at" in ov:
            a0 = float(ov["at"])
            ov["at"], ok = remap(a0)
            if not ok:
                log.append(f"{label} at {fmt_ts(a0)}: its moment was cut")


def retime_fixes(spec: dict, remap, log: list[str]) -> None:
    for key in ("replace", "drop"):
        entries = spec.get(key, [])
        if not isinstance(entries, list):
            continue
        for e in entries:
            if "at" in e:
                a0 = float(e["at"])
                e["at"], ok = remap(a0)
                if not ok:
                    log.append(f"caption fix '{e.get('from', e.get('word'))}' at "
                               f"{fmt_ts(a0)}: its word was cut - delete the entry")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    paths = project_paths(args.project)
    prev = paths["build"] / "timeline.prev.json"
    if not prev.exists():
        print("nothing to do: the cut has not changed since the times were written")
        return 0
    old, new = load_json(prev), load_json(paths["build"] / "timeline.json")
    remap = mapper(old, new)
    log: list[str] = []
    for name in FILES:
        path = paths["build"] / name
        if not path.exists() or path.stat().st_size == 0:
            continue
        spec = load_json(path)
        if name == "caption_fixes.json":
            retime_fixes(spec, remap, log)
        else:
            retime_overlays(spec, remap, name, log)
        if not args.dry_run:
            save_json(path, spec)
        print(f"  retimed {name}")
    print(f"  duration {fmt_ts(old['duration'])} -> {fmt_ts(new['duration'])}")
    for line in log:
        print(f"  check: {line}")
    if not args.dry_run:
        prev.unlink()
        print("  re-run captions.py, words.py and finish.py; chapters and "
              "polish.md times move too")
    return 0


if __name__ == "__main__":
    sys.exit(main())
