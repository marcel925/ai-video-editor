#!/usr/bin/env python3
"""Check an edited render without watching it: a contact sheet plus pacing.

  review.py <project> [--variant edited|plain] [--quality preview|final]

Writes build/review_<variant>.jpg - one labelled frame from the *rendered*
file at the middle of every layer - and prints pacing numbers:

  - how much of the runtime is off the talking head (b-roll, splits, cards),
    against the form's edit budget
  - the longest stretch with no visual change at all, and where it is
  - every gap longer than the profile's target, so you know where to add one

Read the sheet. It is the only way to catch a clip that matched its search
words but not its sentence, a graphic sitting on the speaker's face, or a
caption colliding with a title - none of which show up in the spec.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from common import die, find_font, fmt_ts, load_json, load_profile, project_paths
from motion import is_transparent

FULL_FRAME = ("broll", "split")


def layers(spec: dict) -> list[dict]:
    out = []
    for ov in spec.get("overlays", []):
        t = ov.get("type")
        if t in ("sfx",):
            continue
        if t == "flash":
            s = float(ov["at"])
            out.append({"type": t, "start": s, "end": s + 0.2, "label": "flash"})
            continue
        label = ov.get("comp") or Path(ov.get("file", "")).stem or ov.get("text", "")[:24] or t
        out.append({"type": t, "start": float(ov["start"]), "end": float(ov["end"]),
                    "label": f"{t}:{label}"[:34],
                    "full": t in FULL_FRAME or (t == "motion" and not is_transparent(ov))})
    return sorted(out, key=lambda x: x["start"])


def change_points(ls: list[dict], spec: dict, timeline: dict,
                  zoom_defaults: dict | None) -> list[float]:
    pts = {0.0, timeline["duration"]}
    for l in ls:
        pts.add(l["start"])
        pts.add(l["end"])
    # the auto zoom's real windows, exactly as finish.py builds them
    from finish import auto_zooms
    explicit = [o for o in spec.get("overlays", []) if o.get("type") == "zoom"]
    for z in auto_zooms(spec, timeline, explicit, zoom_defaults):
        pts.update((z["start"], z["end"]))
    return sorted(p for p in pts if 0 <= p <= timeline["duration"])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    ap.add_argument("--variant", default="edited", choices=["edited", "plain"])
    ap.add_argument("--quality", default="preview", choices=["preview", "final"])
    ap.add_argument("--cols", type=int, default=0)
    args = ap.parse_args()

    paths = project_paths(args.project)
    timeline = load_json(paths["build"] / "timeline.json")
    profile = timeline["profile"]
    suffix = "_edited" if args.variant == "edited" else ""
    video = paths["root"] / f"{'final' if args.quality == 'final' else 'preview'}{suffix}.mp4"
    spec_path = paths["build"] / ("overlays_edited.json" if suffix else "overlays.json")
    if not video.exists():
        die(f"no {video.name} - render it first")
    spec = load_json(spec_path) if spec_path.exists() else {"overlays": []}
    ls = layers(spec)
    dur = timeline["duration"]

    # ---- pacing
    full = sum(l["end"] - l["start"] for l in ls if l.get("full"))
    budget = load_profile(profile).get("edited", {})
    pts = change_points(ls, spec, timeline, budget.get("auto_zoom"))
    gaps = [(b - a, a, b) for a, b in zip(pts, pts[1:])]
    target = float(budget.get("max_hold", 12))
    long_gaps = sorted([g for g in gaps if g[0] > target], reverse=True)
    print(f"\n{video.name}  {fmt_ts(dur)}  ({profile})")
    lo, hi = budget.get("off_face", [20, 25])
    share = 100 * full / dur
    verdict = ("over budget - cut the weakest cutaways" if share > hi + 0.5 else
               "under budget" if share < lo - 0.5 else "on budget")
    print(f"  layers: {len(ls)}   off the talking head: {full:.0f}s ({share:.0f}%, "
          f"target {lo}-{hi}%: {verdict})")
    print(f"  visual changes: {len(pts) - 2}, one every {dur / max(1, len(pts) - 2):.1f}s on average")
    if long_gaps:
        print(f"  holds longer than {target:.0f}s:")
        for g, a, b in long_gaps[:12]:
            print(f"    {fmt_ts(a)} -> {fmt_ts(b)}  {g:.1f}s")
    else:
        print(f"  no hold longer than {target:.0f}s")

    # ---- contact sheet
    if not ls:
        return 0
    from PIL import Image, ImageDraw, ImageFont
    tmp = paths["build"] / "overlay_tmp" / "review"
    tmp.mkdir(parents=True, exist_ok=True)
    vertical = timeline["height"] > timeline["width"]
    tw = 240 if vertical else 400
    th = int(tw * timeline["height"] / timeline["width"])
    cols = args.cols or (8 if vertical else 5)
    rows = (len(ls) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tw, rows * (th + 22)), (20, 20, 20))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype(str(find_font("bold")), 13)
    except OSError:
        font = ImageFont.load_default()
    for i, l in enumerate(ls):
        # a little past the middle: most graphics are still animating in early
        t = l["start"] + (l["end"] - l["start"]) * 0.6
        f = tmp / f"{i:03d}.jpg"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", str(video),
                        "-frames:v", "1", "-vf", f"scale={tw}:{th}", str(f)], check=True)
        x, y = (i % cols) * tw, (i // cols) * (th + 22)
        sheet.paste(Image.open(f), (x, y))
        draw.text((x + 4, y + th + 3), f"{fmt_ts(l['start'])[:-3]} {l['label']}",
                  fill=(255, 229, 0) if l.get("full") else (220, 220, 220), font=font)
    out = paths["build"] / f"review_{args.variant}.jpg"
    sheet.save(out, quality=82)
    print(f"\n  {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
