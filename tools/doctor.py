#!/usr/bin/env python3
"""Check that the machine has everything the pipeline needs.

Run it with the virtualenv's python; it checks the interpreter it runs in.
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

from common import ffmpeg_encoders, ffmpeg_filters, find_emoji_font, find_font, load_env

ROOT = Path(__file__).resolve().parent.parent
OK, BAD, WARN = "  ok  ", " FAIL ", " warn "
MAC = sys.platform == "darwin"
FULL_FFMPEG = "brew install ffmpeg-full" if MAC else "install your distro's ffmpeg"


def check(label: str, passed: bool, detail: str = "", fatal: bool = True,
          value: str = "") -> bool:
    """`detail` explains a failure; `value` is shown when the check passes."""
    tag = OK if passed else (BAD if fatal else WARN)
    note = value if passed else detail
    print(f"[{tag}] {label}" + (f" - {note}" if note else ""))
    return passed or not fatal


def has(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


def main() -> int:
    print("video_editor environment check\n")
    fine = True

    ffmpeg = shutil.which("ffmpeg")
    fine &= check("ffmpeg on PATH", bool(ffmpeg), FULL_FFMPEG, value=ffmpeg or "")
    fine &= check("ffprobe on PATH", bool(shutil.which("ffprobe")))

    if ffmpeg:
        version = subprocess.run(["ffmpeg", "-version"], capture_output=True,
                                 text=True).stdout.splitlines()[0]
        print(f"         {version}")
        names = ffmpeg_filters()
        fine &= check("drawtext filter (titles, chapters)", "drawtext" in names,
                      f"missing libfreetype - {FULL_FFMPEG}")
        fine &= check("subtitles filter (burned-in captions)", "subtitles" in names,
                      f"missing libass - {FULL_FFMPEG}")
        fine &= check("zscale + tonemap (HDR phone footage)",
                      {"zscale", "tonemap"} <= names,
                      f"missing libzimg - {FULL_FFMPEG}", fatal=False)
        enc = ffmpeg_encoders()
        fine &= check("libx264 encoder", "libx264" in enc)
        check("h264_videotoolbox (fast previews)", "h264_videotoolbox" in enc,
              "previews use software encoding instead", fatal=False)

    in_venv = sys.prefix != sys.base_prefix
    fine &= check("python virtualenv", in_venv, "run tools/setup.sh, then use "
                  "the venv's python", value=sys.prefix)
    for module, why, fatal in [
        ("yaml", "profile loading", True),
        ("PIL", "emoji badges, contact sheets", False),
        ("cv2", "9:16 auto-reframing (short form only)", False),
        ("opentimelineio", "Final Cut / Resolve export", False),
    ]:
        fine &= check(f"python: {module}", has(module), f"{why} - run tools/setup.sh",
                      fatal=fatal, value=why)
    engines = [m for m in ("parakeet_mlx", "mlx_whisper", "faster_whisper") if has(m)]
    fine &= check("transcription engine", bool(engines), "run tools/setup.sh",
                  value=", ".join(engines))

    fine &= check("font for titles", find_font("bold") is not None,
                  "install Arial or DejaVu Sans", value=str(find_font("bold")))
    emoji = find_emoji_font()
    check("colour emoji font (short-form badges)", emoji is not None,
          "badges are skipped - install Noto Color Emoji", fatal=False,
          value=str(emoji[0]) if emoji else "")

    for profile in ("long", "short"):
        p = ROOT / "profiles" / f"{profile}.yaml"
        fine &= check(f"profile: {profile}.yaml", p.exists())

    print("\nedited version (edit_video_plus) - optional")
    node = shutil.which("node")
    check("node on PATH", bool(node), "install Node 18+", fatal=False, value=node or "")
    data = Path(sys.prefix).resolve().parent / "motion" / "node_modules"
    check("remotion installed", (ROOT / "motion" / "node_modules" / "remotion").exists()
          or (data / "remotion").exists(), "run tools/setup.sh", fatal=False)
    load_env()
    keys = [k for k in ("PEXELS_API_KEY", "PIXABAY_API_KEY") if os.environ.get(k)]
    check("stock footage API key", bool(keys),
          "add PEXELS_API_KEY and/or PIXABAY_API_KEY to .env (see .env.example)",
          fatal=False, value=", ".join(keys))

    print()
    if fine:
        print("Ready. Put recordings in videos/<project>/raw_videos/ and run /edit_video.")
        return 0
    print("Some checks failed - see the notes above.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
