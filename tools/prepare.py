#!/usr/bin/env python3
"""Step 3 - merge transcripts into one numbered segment list for the editor.

Two outputs:
  build/segments.json  machine-readable, the source of truth for timestamps
  build/segments.md    what the AI editor reads - numbered lines plus retake hints

The segment ids are the whole point: the model chooses ids, never timestamps,
so it cannot invent a cut point that does not exist.
"""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from difflib import SequenceMatcher
from pathlib import Path

from common import (die, fmt_ts, info, load_json, normalize_words,
                    project_paths, save_json)

FILLERS = {"um", "uh", "erm", "hmm", "mhm", "eh", "ah"}

# A stretch this long with this much speech in it was lost, not paused.
# transcribe.py repairs these at the source; this is the backstop that catches
# transcripts cached by an older version, because the editorial pass cannot
# tell missing footage from footage that was never shot.
GAP_SECONDS = 12.0
GAP_SPEECH = 4.0
SIM_THRESHOLD = 0.62
MIN_SHARED_RARE = 2


def build_segments(sources: list[dict], paths: dict) -> list[dict]:
    segments = []
    for source in sources:
        tfile = paths["transcripts"] / f"{source['stem']}.json"
        if not tfile.exists():
            die(f"missing transcript for {source['name']} - run tools/transcribe.py")
        data = load_json(tfile)
        for i, seg in enumerate(data["segments"], start=1):
            words = normalize_words(seg["text"])
            segments.append({
                "id": f"{source['key']}{i:02d}",
                "source": source["name"],
                "key": source["key"],
                "order": source["order"],
                "index": i,
                "start": seg["start"],
                "end": seg["end"],
                "text": seg["text"],
                "words": seg["words"],
                "norm": words,
                "filler_only": bool(words) and all(w in FILLERS for w in words),
            })
    return segments


def find_retake_groups(segments: list[dict]) -> list[list[str]]:
    """Cluster segments that say roughly the same thing.

    Uses an inverted index on rare words so we only diff plausible pairs
    instead of every pair in the project.
    """
    total = len(segments)
    if total < 2:
        return []

    doc_freq: dict[str, int] = defaultdict(int)
    for seg in segments:
        for word in set(seg["norm"]):
            doc_freq[word] += 1
    rare_cutoff = max(2, int(total * 0.12))

    index: dict[str, list[int]] = defaultdict(list)
    for i, seg in enumerate(segments):
        for word in set(seg["norm"]):
            if doc_freq[word] <= rare_cutoff:
                index[word].append(i)

    shared: dict[tuple[int, int], int] = defaultdict(int)
    for hits in index.values():
        if len(hits) > 40:          # a word this common is not a useful signal
            continue
        for a_pos, a in enumerate(hits):
            for b in hits[a_pos + 1:]:
                shared[(a, b)] += 1

    parent = list(range(total))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    for (a, b), count in shared.items():
        if count < MIN_SHARED_RARE:
            continue
        sa, sb = segments[a], segments[b]
        if len(sa["norm"]) < 4 or len(sb["norm"]) < 4:
            continue
        if SequenceMatcher(None, sa["norm"], sb["norm"]).ratio() >= SIM_THRESHOLD:
            union(a, b)

    clusters: dict[int, list[str]] = defaultdict(list)
    for i, seg in enumerate(segments):
        clusters[find(i)].append(seg["id"])
    return [sorted(ids) for ids in clusters.values() if len(ids) > 1]


def write_markdown(path: Path, sources: list[dict], segments: list[dict],
                   groups: list[list[str]], profile: str) -> None:
    by_id = {s["id"]: s for s in segments}
    group_of = {sid: n for n, ids in enumerate(groups, 1) for sid in ids}

    lines = [
        f"# Segment list ({profile} form)",
        "",
        f"{len(sources)} take(s), {len(segments)} segments, "
        f"{sum(s['duration'] for s in sources) / 60:.1f} min of raw footage.",
        "",
        "Takes are listed in **recording order**. When the same line appears in",
        "several takes, the later one is usually the keeper - but read them, the",
        "last attempt is not always the best one.",
        "",
    ]

    for source in sources:
        mine = [s for s in segments if s["key"] == source["key"]]
        stamp = (source.get("creation_time") or "")[:19]
        lines += [
            f"## [{source['key']}] {source['name']}",
            f"_{fmt_ts(source['duration'])} · {source['width']}x{source['height']} "
            f"· recorded {stamp or 'unknown'}_",
            "",
        ]
        for seg in mine:
            marks = []
            if seg["id"] in group_of:
                marks.append(f"~dup{group_of[seg['id']]}")
            if seg["filler_only"]:
                marks.append("~filler")
            suffix = f"  `{' '.join(marks)}`" if marks else ""
            lines.append(
                f"- `{seg['id']}` {fmt_ts(seg['start'])}–{fmt_ts(seg['end'])} "
                f"({seg['end'] - seg['start']:.1f}s) {seg['text']}{suffix}"
            )
        lines.append("")

    if groups:
        lines += ["## Possible retakes", "",
                  "Segments grouped by near-identical wording. Pick one per group.", ""]
        for n, ids in enumerate(groups, 1):
            lines.append(f"**dup{n}**")
            for sid in sorted(ids, key=lambda i: (by_id[i]["order"], by_id[i]["index"])):
                seg = by_id[sid]
                lines.append(f"  - `{sid}` [{seg['key']}] {fmt_ts(seg['start'])} "
                             f"— {seg['text']}")
            lines.append("")

    path.write_text("\n".join(lines))


def report_gaps(sources: list[dict], segments: list[dict]) -> int:
    """Warn about takes whose transcript skips over audible speech."""
    by_take = defaultdict(list)
    for seg in segments:
        by_take[seg["source"]].append(seg)

    flagged = 0
    for source in sources:
        silences = source.get("silences") or []
        duration = float(source["duration"])
        cursor, holes = 0.0, []
        for seg in sorted(by_take.get(source["name"], []),
                          key=lambda s: s["start"]):
            if seg["start"] - cursor >= GAP_SECONDS:
                holes.append((cursor, seg["start"]))
            cursor = max(cursor, seg["end"])
        if duration - cursor >= GAP_SECONDS:
            holes.append((cursor, duration))

        for start, end in holes:
            silent = sum(max(0.0, min(end, float(e)) - max(start, float(s)))
                         for s, e in silences)
            if (end - start) - silent < GAP_SPEECH:
                continue
            flagged += 1
            info(f"  {source['name']} has no transcript for "
                 f"{fmt_ts(start)}-{fmt_ts(end)} but there is speech there - "
                 f"re-run transcribe.py --force")
    return flagged


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("project")
    args = ap.parse_args()

    paths = project_paths(args.project)
    sources_file = paths["build"] / "sources.json"
    if not sources_file.exists():
        die("no build/sources.json - run tools/ingest.py first")
    manifest = load_json(sources_file)
    sources = manifest["sources"]

    segments = build_segments(sources, paths)
    if not segments:
        die("no transcript segments found - did transcription produce anything?")
    groups = find_retake_groups(segments)

    save_json(paths["build"] / "segments.json", {
        "profile": manifest.get("profile", "long"),
        "retake_groups": groups,
        "segments": [{k: v for k, v in s.items() if k != "norm"} for s in segments],
    })
    write_markdown(paths["build"] / "segments.md", sources, segments, groups,
                   manifest.get("profile", "long"))

    gaps = report_gaps(sources, segments)

    spoken = sum(s["end"] - s["start"] for s in segments)
    print(f"{len(segments)} segments across {len(sources)} take(s)")
    if gaps:
        print(f"  WARNING: {gaps} stretch(es) of speech missing from the "
              f"transcript - the cut would silently omit them")
    print(f"  spoken content: {spoken / 60:.1f} min")
    print(f"  retake clusters: {len(groups)}")
    print(f"  -> {paths['build'] / 'segments.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
