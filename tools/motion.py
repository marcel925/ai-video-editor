#!/usr/bin/env python3
"""Render the motion-graphics layers of an edit, with Remotion or HyperFrames.

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

Two engines draw the same components (motion/src/comps). MOTION_ENGINE picks
one, from the environment or .env, like the API keys:

  remotion      motion/       - the original renderer. Free for individuals
                                and companies of up to 3 people; larger ones
                                need a Remotion company licence.
  hyperframes   hyperframes/  - HeyGen's Apache-2.0 renderer; the components
                                run on a small Remotion shim.

Unset, it is whichever one setup.sh installed, Remotion if both. Clips from
the two engines are cached under different names, so switching re-renders.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from common import die, digest, info, load_env, load_json, load_profile, project_paths, save_json

ROOT = Path(__file__).resolve().parent.parent
MOTION = ROOT / "motion"
# engine -> (its folder, the package that shows it is installed, display name)
ENGINES = {
    "remotion": (MOTION, "remotion", "Remotion"),
    "hyperframes": (ROOT / "hyperframes", "@hyperframes/producer", "HyperFrames"),
}


def data_dir(engine: str) -> Path:
    """Where a plugin install keeps an engine's packages: the plugin's data
    folder, next to the venv, which survives plugin updates."""
    return Path(sys.prefix).resolve().parent / ENGINES[engine][0].name


def installed(engine: str) -> bool:
    folder, package, _ = ENGINES[engine]
    return any((d / "node_modules" / package).exists() for d in (folder, data_dir(engine)))


_ENGINE: str | None = None


def motion_engine() -> str:
    """MOTION_ENGINE if set; otherwise the installed engine, Remotion first.
    motion.py and finish.py both ask, so they name the same files."""
    global _ENGINE
    if _ENGINE is None:
        load_env()
        name = os.environ.get("MOTION_ENGINE", "").strip().lower()
        if name and name not in ENGINES:
            die(f"MOTION_ENGINE={name!r} - use one of {sorted(ENGINES)}")
        _ENGINE = name or ("hyperframes" if installed("hyperframes") and not installed("remotion")
                           else "remotion")
    return _ENGINE


def ensure_node_modules(engine: str) -> None:
    """The engine's packages. In a clone they sit in <engine>/node_modules. In
    a plugin install they live in the plugin's data folder and
    <engine>/node_modules is a link to them, which this recreates after an
    update replaced the plugin folder."""
    folder, _, label = ENGINES[engine]
    local = folder / "node_modules"
    data = data_dir(engine)
    if data.resolve() == folder.resolve() or not (data / "node_modules").is_dir():
        if not local.exists():
            die(f"{label} is not installed - run tools/setup.sh --motion {engine}")
        return
    if (data / "package-lock.json").read_bytes() != (folder / "package-lock.json").read_bytes():
        die(f"{label}'s dependencies changed in a plugin update - re-run setup.sh --motion {engine}")
    if not local.exists():
        if local.is_symlink():
            local.unlink()
        local.symlink_to(data / "node_modules", target_is_directory=True)
        info(f"linked {label} packages from the plugin data folder")


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
    re-renders every clip instead of silently reusing the old look. Under
    HyperFrames the shim and the page count too."""
    global _SRC_HASH
    if _SRC_HASH is None:
        files = sorted((MOTION / "src").rglob("*.ts*"))
        if motion_engine() == "hyperframes":
            hf = ENGINES["hyperframes"][0]
            files += sorted((hf / "shim").rglob("*.ts*")) + sorted((hf / "src").rglob("*.ts*"))
            files.append(hf / "render.mjs")
        _SRC_HASH = digest(*(f.read_bytes() for f in files))
    return _SRC_HASH


def motion_file(build: Path, ov: dict, profile: dict) -> Path:
    fill_props(ov, build.parent)
    w, h, fps = frame_size(profile)
    dur = round(float(ov["end"]) - float(ov["start"]), 3)
    parts = [ov["comp"], json.dumps(ov.get("props", {}), sort_keys=True),
             dur, is_transparent(ov), w, h, fps, source_hash()]
    # Remotion's names predate the second engine; keep them so existing
    # caches stay valid
    if motion_engine() != "remotion":
        parts.append(motion_engine())
    key = digest(*parts)
    ext = ".webm" if is_transparent(ov) else ".mp4"
    return build / "motion" / f"{ov['comp']}_{key}{ext}"


def source_file(rel: str, root: Path) -> Path | None:
    """A prop's file: in the project, or a shared asset named from the repo
    root (assets/<...>/<file>), such as a logo every project reuses."""
    for base in (root, ROOT):
        if (base / rel).is_file():
            return base / rel
    return None


def referenced_files(value, root: Path) -> list[str]:
    """Prop values that name a file in the project or in the repo's assets/."""
    found = []
    if isinstance(value, dict):
        for v in value.values():
            found += referenced_files(v, root)
    elif isinstance(value, list):
        for v in value:
            found += referenced_files(v, root)
    elif isinstance(value, str) and "/" in value and source_file(value, root):
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
    engine = motion_engine()
    ensure_node_modules(engine)

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
            src = source_file(rel, paths["root"])
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

    print(f"  {len(entries)} motion layer(s), {len(items)} to render ({ENGINES[engine][2]})")
    if not items:
        return 0
    public.mkdir(parents=True, exist_ok=True)
    spec = paths["build"] / "motion" / "spec.json"
    save_json(spec, {"publicDir": str(public), "items": items})
    folder = ENGINES[engine][0]
    proc = subprocess.run(["node", str(folder / "render.mjs"), str(spec)], cwd=folder)
    if proc.returncode != 0:
        die(f"{ENGINES[engine][2]} render failed - see the output above")
    return 0


if __name__ == "__main__":
    sys.exit(main())
