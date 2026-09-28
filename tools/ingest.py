#!/usr/bin/env python3
"""Step 1 - probe every raw video, extract 16 kHz mono WAV, map the silences.

Takes are ordered by recording time (creation_time, falling back to mtime), not
by filename, because "the last complete attempt wins" is the single best retake
heuristic and it only holds if the order is genuinely chronological.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from common import (VIDEO_EXTS, infer_profile, info, load_profile, probe_summary,
                    project_paths, run, save_json)

SILENCE_RE = re.compile(
    r"silence_(start|end):\s*(-?[\d.]+)")


def detect_silences(wav: Path, noise_db: float, min_dur: float,
                    duration: float) -> list[list[float]]:
    """Return [start, end] pairs of silence, via ffmpeg's silencedetect."""
    proc = run([
        "ffmpeg", "-hide_banner", "-nostats", "-i", str(wav),
        "-af", f"silencedetect=noise={noise_db}dB:d={min_dur}",
        "-f", "null", "-",
    ])
    silences: list[list[float]] = []
    pending: float | None = None
    for kind, value in SILENCE_RE.findall(proc.stderr):
        t = float(value)
        if kind == "start":
            pending = t
        elif pending is not None:
            silences.append([round(max(0.0, pending), 3), round(t, 3)])
            pending = None
    if pending is not None:          # file ends inside a silence
        silences.append([round(pending, 3), round(duration, 3)])
    return silences


def extract_audio(video: Path, wav: Path) -> None:
    """16 kHz mono PCM - what every ASR model wants, and lossless so the
    word timestamps line up with the video frame-for-frame."""
    wav.parent.mkdir(parents=True, exist_ok=True)
    run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(video),
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        str(wav),
    ])


def sort_key(entry: dict):
    created = entry["probe"].get("creation_time")
    if created:
        return (0, created, entry["name"])
    return (1, entry["probe"]["mtime"], entry["name"])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("project")
    ap.add_argument("--profile", default=None,
                    help="long or short; inferred from a _long/_short "
                         "folder suffix when omitted")
    ap.add_argument("--force", action="store_true",
                    help="re-extract audio even if the WAV already exists")
    args = ap.parse_args()

    paths = project_paths(args.project)
    profile_name = infer_profile(args.project, args.profile)
    profile = load_profile(profile_name)
    audio_cfg = profile["audio"]

    if not paths["raw_videos"].is_dir():
        print(f"error: no raw_videos/ folder in {paths['root']}", file=sys.stderr)
        return 1

    videos = sorted(p for p in paths["raw_videos"].iterdir()
                    if p.suffix.lower() in VIDEO_EXTS and not p.name.startswith("."))
    if not videos:
        print(f"error: no video files in {paths['raw_videos']}", file=sys.stderr)
        return 1

    entries = []
    for video in videos:
        info(f"probing {video.name}")
        entries.append({"name": video.name, "path": str(video),
                        "probe": probe_summary(video)})

    entries.sort(key=sort_key)

    sources = []
    for index, entry in enumerate(entries):
        video = Path(entry["path"])
        stem = video.stem
        wav = paths["raw_audios"] / f"{stem}.wav"
        if args.force or not wav.exists():
            info(f"extracting audio -> {wav.name}")
            extract_audio(video, wav)
        else:
            info(f"reusing {wav.name}")

        probe = entry["probe"]
        info(f"mapping silences in {wav.name}")
        silences = detect_silences(wav, audio_cfg["silence_noise_db"],
                                   audio_cfg["silence_min_duration"],
                                   probe["duration"])

        sources.append({
            # Single letter per take: segment ids come out as a01, b07, ...
            "key": chr(ord("a") + index) if index < 26 else f"z{index}",
            "order": index,
            "name": video.name,
            "stem": stem,
            "video": str(video),
            "audio": str(wav),
            "silences": silences,
            **probe,
        })

    out = paths["build"] / "sources.json"
    save_json(out, {"profile": profile_name, "sources": sources})

    print(f"\ningested {len(sources)} take(s) -> {out}")
    total = 0.0
    for s in sources:
        total += s["duration"]
        stamp = (s["creation_time"] or "no timestamp")[:19]
        print(f"  [{s['key']}] {s['name']:<38} {s['duration']:7.1f}s  "
              f"{s['width']}x{s['height']} @{s['fps']:g}fps  {stamp}")
    print(f"  total raw footage: {total / 60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
