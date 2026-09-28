#!/usr/bin/env python3
"""Render the motion-graphics layers of an edit with Remotion.

Every `{"type": "motion", ...}` entry in build/overlays_edited.json becomes a
clip under build/motion/, named by a hash of what it draws - so re-running
after a tweak renders only the entries that changed, and finish.py finds each
clip from the same entry without any bookkeeping.

  motion.py <project> [--overlays build/overlays_edited.json] [--force]

Entry shape (times are seconds on the output timeline, like every overlay):

  {"type": "motion", "comp": "TitleCard", "start": 96.4, "end": 98.6,
   "props": {"kicker": "MISTAKE #2", "title": "Onboarding", "number": "02"}}

Components live in motion/src/comps/ - see the skill for the catalogue.
Clips render at the profile's full resolution, not the preview's, so the
preview and the final use the same files. Transparent components (bg "none")
come out as VP9 WebM with alpha; anything with a background is an opaque
H.264 card.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from common import die, digest, info, load_json, load_profile, project_paths, save_json

ROOT = Path(__file__).resolve().parent.parent
MOTION = ROOT / "motion"



def ensure_node_modules() -> None:
    """Remotion's packages. In a clone they sit in motion/node_modules. In a
    plugin install they live in the plugin's data folder (next to the venv),
    which survives plugin updates, and motion/node_modules is a link to them
    that this recreates after an update replaced the plugin folder."""
    local = MOTION / "node_modules"
    data = Path(sys.prefix).resolve().parent / "motion"
    if data.resolve() == MOTION.resolve() or not (data / "node_modules").is_dir():
        if not local.exists():
            die("Remotion is not installed - run tools/setup.sh")
        return
    if (data / "package-lock.json").read_bytes() != (MOTION / "package-lock.json").read_bytes():
        die("Remotion's dependencies changed in a plugin update - re-run setup.sh")
    if not local.exists():
        if local.is_symlink():
            local.unlink()
        local.symlink_to(data / "node_modules", target_is_directory=True)
        info("linked Remotion packages from the plugin data folder")


# the components that draw their own background unless told bg: "none"
OPAQUE_BY_DEFAULT = {"TitleCard", "Compare", "ScreenshotCard"}
COMPS = {"TitleCard", "BigNumber", "ListReveal", "KineticText", "LowerThird",
         "Compare", "LogoPop", "ScreenshotCard", "EndCard", "Stamp"}


def is_transparent(ov: dict) -> bool:
    if "transparent" in ov:
        return bool(ov["transparent"])
    bg = ov.get("props", {}).get("bg")
    if bg is None:
        return ov["comp"] not in OPAQUE_BY_DEFAULT
    return bg == "none"


def frame_size(profile: dict) -> tuple[int, int, int]:
    v = profile["video"]
    return int(v["width"]), int(v["height"]), int(v.get("fps", 30))


def fill_props(ov: dict, root: Path) -> dict:
    """Props the component needs but cannot work out itself. Runs on both
    sides - here and in finish.py - so the two compute the same file name."""
    props = ov.setdefault("props", {})
    if ov["comp"] == "ScreenshotCard" and "aspect" not in props and props.get("file"):
        # an <img> has no size until it loads, and a frame cannot wait for it
        from PIL import Image
        with Image.open(root / props["file"]) as im:
            props["aspect"] = round(im.width / im.height, 4)
    return props


_SRC_HASH: str | None = None


def source_hash() -> str:
    """Changes whenever any component or the theme does, so a design tweak
    re-renders every clip instead of silently reusing the old look."""
    global _SRC_HASH
    if _SRC_HASH is None:
        files = sorted((MOTION / "src").rglob("*.ts*"))
        _SRC_HASH = digest(*(f.read_bytes() for f in files))
    return _SRC_HASH


def motion_file(build: Path, ov: dict, profile: dict) -> Path:
    fill_props(ov, build.parent)
    w, h, fps = frame_size(profile)
    dur = round(float(ov["end"]) - float(ov["start"]), 3)
    key = digest(ov["comp"], json.dumps(ov.get("props", {}), sort_keys=True),
                 dur, is_transparent(ov), w, h, fps, source_hash())
    ext = ".webm" if is_transparent(ov) else ".mp4"
    return build / "motion" / f"{ov['comp']}_{key}{ext}"


def referenced_files(value, root: Path) -> list[str]:
    """Prop values that name a file in the project (logos, screenshots)."""
    found = []
    if isinstance(value, dict):
        for v in value.values():
            found += referenced_files(v, root)
    elif isinstance(value, list):
        for v in value:
            found += referenced_files(v, root)
    elif isinstance(value, str) and "/" in value and (root / value).is_file():
        found.append(value)
    return found


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    ap.add_argument("--overlays", default=None,
                    help="default: build/overlays_edited.json")
    ap.add_argument("--force", action="store_true", help="re-render everything")
    args = ap.parse_args()

    paths = project_paths(args.project)
    timeline = load_json(paths["build"] / "timeline.json")
    profile = load_profile(timeline["profile"])
    ov_path = Path(args.overlays) if args.overlays else paths["build"] / "overlays_edited.json"
    if not ov_path.exists():
        die(f"no {ov_path} - write the edited overlay spec first")
    entries = [o for o in load_json(ov_path).get("overlays", [])
               if o.get("type") == "motion"]
    if not entries:
        info("no motion entries - nothing to render")
        return 0
    ensure_node_modules()

    w, h, fps = frame_size(profile)
    public = paths["build"] / "motion" / "public"
    items, wanted = [], set()
    for ov in entries:
        if ov.get("comp") not in COMPS:
            die(f"unknown motion component {ov.get('comp')!r} - one of {sorted(COMPS)}")
        if float(ov["end"]) <= float(ov["start"]):
            die(f"motion {ov['comp']} at {ov['start']} has end <= start")
        out = motion_file(paths["build"], ov, profile)
        wanted.add(out.name)
        for rel in referenced_files(ov.get("props", {}), paths["root"]):
            dst = public / rel
            src = paths["root"] / rel
            if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
        if out.exists() and not args.force:
            continue
        items.append({"out": str(out), "comp": ov["comp"], "width": w, "height": h,
                      "fps": fps, "duration": round(float(ov["end"]) - float(ov["start"]), 3),
                      "transparent": is_transparent(ov), "props": ov.get("props", {})})

    # clips no entry points at any more are stale renders of an older edit
    for old in (paths["build"] / "motion").glob("*_*.*"):
        if old.is_file() and old.name not in wanted and old.suffix in (".webm", ".mp4"):
            old.unlink()

    print(f"  {len(entries)} motion layer(s), {len(items)} to render")
    if not items:
        return 0
    public.mkdir(parents=True, exist_ok=True)
    spec = paths["build"] / "motion" / "spec.json"
    save_json(spec, {"publicDir": str(public), "items": items})
    proc = subprocess.run(["node", str(MOTION / "render.mjs"), str(spec)], cwd=MOTION)
    if proc.returncode != 0:
        die("remotion render failed - see the output above")
    return 0


if __name__ == "__main__":
    sys.exit(main())
