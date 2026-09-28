#!/usr/bin/env python3
"""Optional - export the edit as a timeline you can open in a real NLE.

The escape hatch. When the AI cut is 90% right and the last 10% wants a
human on a scrubber, this hands the exact same decisions to Resolve or
Final Cut instead of making you start over.

  build/edit.otio    DaVinci Resolve (File > Import > Timeline)
  build/edit.fcpxml  Final Cut Pro, Premiere
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

from common import die, load_json, project_paths

# FCPXML wants every time as a rational multiple of the frame duration.
FRAME_DURATIONS = {
    23.976: (1001, 24000), 24.0: (100, 2400), 25.0: (100, 2500),
    29.97: (1001, 30000), 30.0: (100, 3000), 50.0: (100, 5000),
    59.94: (1001, 60000), 60.0: (100, 6000),
}


def frame_duration(fps: float) -> tuple[int, int]:
    best = min(FRAME_DURATIONS, key=lambda f: abs(f - fps))
    if abs(best - fps) > 0.05:
        return (100, int(round(fps * 100)))
    return FRAME_DURATIONS[best]


def fcp_time(seconds: float, fps: float, num: int, den: int) -> str:
    frames = int(round(seconds * fps))
    return f"{frames * num}/{den}s"


def write_fcpxml(path: Path, timeline: dict, sources: list[dict],
                 title: str) -> None:
    fps = timeline["fps"]
    num, den = frame_duration(fps)
    by_name = {s["name"]: s for s in sources}
    used = [n for n in dict.fromkeys(c["source"] for c in timeline["cuts"])]

    fcpxml = ET.Element("fcpxml", version="1.10")
    resources = ET.SubElement(fcpxml, "resources")
    ET.SubElement(resources, "format", id="r0",
                  name=f"FFVideoFormat{timeline['height']}p{int(round(fps))}",
                  frameDuration=f"{num}/{den}s",
                  width=str(timeline["width"]), height=str(timeline["height"]),
                  colorSpace="1-1-1 (Rec. 709)")

    asset_ids = {}
    for i, name in enumerate(used, start=1):
        source = by_name[name]
        asset_id = f"r{i}"
        asset_ids[name] = asset_id
        asset = ET.SubElement(
            resources, "asset", id=asset_id, name=Path(name).stem,
            start="0s", duration=fcp_time(source["duration"], fps, num, den),
            hasVideo="1", hasAudio="1", format="r0",
            audioSources="1", audioChannels="2", audioRate="48000")
        ET.SubElement(asset, "media-rep", kind="original-media",
                      src=Path(source["video"]).absolute().as_uri())

    library = ET.SubElement(fcpxml, "library")
    event = ET.SubElement(library, "event", name=title)
    project = ET.SubElement(event, "project", name=title)
    sequence = ET.SubElement(project, "sequence", format="r0",
                             duration=fcp_time(timeline["duration"], fps, num, den),
                             tcStart="0s", tcFormat="NDF",
                             audioLayout="stereo", audioRate="48k")
    spine = ET.SubElement(sequence, "spine")

    for n, cut in enumerate(timeline["cuts"], 1):
        length = cut["src_end"] - cut["src_start"]
        clip = ET.SubElement(
            spine, "asset-clip", ref=asset_ids[cut["source"]],
            name=cut["note"] or f"clip {n}",
            offset=fcp_time(cut["out_start"], fps, num, den),
            start=fcp_time(cut["src_start"], fps, num, den),
            duration=fcp_time(length, fps, num, den),
            format="r0", tcFormat="NDF")
        if cut["note"]:
            ET.SubElement(clip, "note").text = cut["note"]

    ET.indent(fcpxml, space="  ")
    body = ET.tostring(fcpxml, encoding="unicode")
    path.write_text('<?xml version="1.0" encoding="UTF-8"?>\n'
                    '<!DOCTYPE fcpxml>\n' + body + "\n")


def write_otio(path: Path, timeline_data: dict, sources: list[dict],
               title: str) -> None:
    import opentimelineio as otio

    fps = timeline_data["fps"]
    by_name = {s["name"]: s for s in sources}
    timeline = otio.schema.Timeline(name=title)
    track = otio.schema.Track(name="V1", kind=otio.schema.TrackKind.Video)
    timeline.tracks.append(track)

    for n, cut in enumerate(timeline_data["cuts"], 1):
        source = by_name[cut["source"]]
        media = otio.schema.ExternalReference(
            target_url=Path(source["video"]).absolute().as_uri(),
            available_range=otio.opentime.TimeRange(
                otio.opentime.RationalTime(0, fps),
                otio.opentime.RationalTime(round(source["duration"] * fps), fps)))
        clip = otio.schema.Clip(
            name=cut["note"] or f"clip {n}",
            media_reference=media,
            source_range=otio.opentime.TimeRange(
                otio.opentime.RationalTime(round(cut["src_start"] * fps), fps),
                otio.opentime.RationalTime(
                    round((cut["src_end"] - cut["src_start"]) * fps), fps)))
        clip.metadata["segments"] = cut["segments"]
        track.append(clip)

    otio.adapters.write_to_file(timeline, str(path), adapter_name="otio_json")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("project")
    ap.add_argument("--title", default=None)
    args = ap.parse_args()

    paths = project_paths(args.project)
    tpath = paths["build"] / "timeline.json"
    if not tpath.exists():
        die("no build/timeline.json - run tools/render.py first")
    timeline = load_json(tpath)
    sources = load_json(paths["build"] / "sources.json")["sources"]
    title = args.title or paths["root"].name

    otio_path = paths["build"] / "edit.otio"
    fcp_path = paths["build"] / "edit.fcpxml"
    write_otio(otio_path, timeline, sources, title)
    write_fcpxml(fcp_path, timeline, sources, title)

    print(f"{otio_path}   (Resolve: File > Import > Timeline)")
    print(f"{fcp_path}  (Final Cut / Premiere)")
    print(f"  {len(timeline['cuts'])} clips referencing the original footage")
    return 0


if __name__ == "__main__":
    sys.exit(main())
