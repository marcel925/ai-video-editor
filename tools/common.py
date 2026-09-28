"""Shared helpers for the video editing pipeline."""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

VIDEO_EXTS = {".mov", ".mp4", ".m4v", ".mkv", ".avi", ".mts", ".webm"}


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def info(msg: str) -> None:
    print(f"  {msg}", file=sys.stderr)


def run(cmd: list[str], quiet: bool = True) -> subprocess.CompletedProcess:
    """Run a command, raising with captured stderr on failure."""
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-25:])
        raise RuntimeError(f"command failed: {' '.join(cmd[:6])} ...\n{tail}")
    if not quiet and proc.stderr:
        print(proc.stderr, file=sys.stderr)
    return proc


def ffprobe(path: Path) -> dict:
    proc = run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ])
    return json.loads(proc.stdout)


def probe_summary(path: Path) -> dict:
    """Pull the fields the pipeline actually cares about out of ffprobe."""
    data = ffprobe(path)
    fmt = data.get("format", {})
    video = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
    audio = next((s for s in data["streams"] if s["codec_type"] == "audio"), None)
    if video is None:
        die(f"{path.name} has no video stream")

    # Rotation metadata means the stored frame is sideways vs. how it displays.
    rotation = 0
    for sd in video.get("side_data_list", []) or []:
        if "rotation" in sd:
            rotation = int(sd["rotation"]) % 360
    width, height = int(video["width"]), int(video["height"])
    if rotation in (90, 270):
        width, height = height, width

    num, den = (video.get("r_frame_rate") or "0/1").split("/")
    fps = float(num) / float(den) if float(den) else 0.0

    tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
    vtags = {k.lower(): v for k, v in (video.get("tags") or {}).items()}
    created = tags.get("creation_time") or vtags.get("creation_time")

    return {
        "duration": float(fmt.get("duration") or video.get("duration") or 0.0),
        "width": width,
        "height": height,
        "fps": round(fps, 4),
        "rotation": rotation,
        "creation_time": created,
        "mtime": path.stat().st_mtime,
        "has_audio": audio is not None,
        "audio_rate": int(audio["sample_rate"]) if audio else 0,
        "vcodec": video.get("codec_name"),
    }


def load_env() -> None:
    """API keys: the environment wins, then .env in the working folder (your
    workspace), then .env next to the tools (a clone of the repo)."""
    for env in (Path.cwd() / ".env", Path(__file__).resolve().parent.parent / ".env"):
        if not env.exists():
            continue
        for line in env.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip().strip('"').strip("'")
            if v:
                os.environ.setdefault(k.strip(), v)


def load_json(path: Path) -> dict:
    with open(path) as fh:
        return json.load(fh)


def save_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as fh:
        json.dump(obj, fh, indent=2)


def digest(*parts) -> str:
    h = hashlib.sha1()
    for p in parts:
        h.update(str(p).encode())
    return h.hexdigest()[:16]


def fmt_ts(seconds: float) -> str:
    m, s = divmod(max(0.0, seconds), 60)
    h, m = divmod(int(m), 60)
    if h:
        return f"{h}:{m:02d}:{s:05.2f}"
    return f"{m}:{s:05.2f}"


def ass_ts(seconds: float) -> str:
    """ASS uses H:MM:SS.cc with centisecond precision."""
    seconds = max(0.0, seconds)
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def project_paths(project: str) -> dict:
    root = Path(project).expanduser().resolve()
    if not root.is_dir():
        die(f"project folder not found: {root}")
    return {
        "root": root,
        "raw_videos": root / "raw_videos",
        "raw_audios": root / "raw_audios",
        "transcripts": root / "transcripts",
        "assets": root / "assets",
        "build": root / "build",
    }


def infer_profile(project: str, explicit: str | None = None) -> str:
    """Pick the profile. An explicit --profile always wins; otherwise the
    folder name decides, so `videos/foo_short` edits as a short without the
    flag. Falls back to long, which is what an unsuffixed folder means."""
    if explicit:
        return explicit
    name = Path(project).expanduser().resolve().name.lower()
    if name.endswith("_short") or name.endswith("-short"):
        return "short"
    return "long"


def load_profile(name: str) -> dict:
    import yaml
    path = Path(__file__).resolve().parent.parent / "profiles" / f"{name}.yaml"
    if not path.exists():
        die(f"unknown profile '{name}' (expected profiles/{name}.yaml)")
    with open(path) as fh:
        return yaml.safe_load(fh)


WORD_RE = re.compile(r"[a-z0-9']+")


def normalize_words(text: str) -> list[str]:
    return WORD_RE.findall(text.lower())


# First existing file wins: macOS, then Linux, then Windows.
FONT_CANDIDATES = {
    "regular": ["/System/Library/Fonts/Supplemental/Arial.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                "/usr/share/fonts/dejavu/DejaVuSans.ttf",
                "C:/Windows/Fonts/arial.ttf"],
    "bold": ["/System/Library/Fonts/Supplemental/Arial Bold.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
             "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
             "C:/Windows/Fonts/arialbd.ttf"],
    "black": ["/System/Library/Fonts/Supplemental/Arial Black.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
              "C:/Windows/Fonts/ariblk.ttf"],
    # (path, bitmap strike size): colour emoji fonts only render at their strike
    "emoji": [("/System/Library/Fonts/Apple Color Emoji.ttc", 160),
              ("/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", 109),
              ("/usr/share/fonts/noto/NotoColorEmoji.ttf", 109),
              ("C:/Windows/Fonts/seguiemj.ttf", 109)],
}
_FC_PATTERN = {"regular": "sans", "bold": "sans:bold", "black": "sans:black"}


def find_font(kind: str = "bold") -> Path | None:
    """A usable font file for drawtext / Pillow, on any platform."""
    for cand in FONT_CANDIDATES[kind]:
        if kind != "emoji" and Path(cand).exists():
            return Path(cand)
    if kind in _FC_PATTERN:
        try:
            out = subprocess.run(["fc-match", "-f", "%{file}", _FC_PATTERN[kind]],
                                 capture_output=True, text=True).stdout.strip()
            if out and Path(out).exists():
                return Path(out)
        except FileNotFoundError:
            pass
    return None


def find_emoji_font() -> tuple[Path, int] | None:
    for path, strike in FONT_CANDIDATES["emoji"]:
        if Path(path).exists():
            return Path(path), strike
    return None


def ffmpeg_encoders() -> set[str]:
    proc = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"],
                          capture_output=True, text=True)
    return {p[1] for p in (l.split() for l in proc.stdout.splitlines()) if len(p) >= 2}


_PREVIEW_ENCODER: list[str] | None = None


def preview_encoder(bitrate: str) -> list[str]:
    """Hardware H.264 where there is one, fast software H.264 otherwise."""
    global _PREVIEW_ENCODER
    if _PREVIEW_ENCODER is None:
        _PREVIEW_ENCODER = (["h264_videotoolbox"]
                            if "h264_videotoolbox" in ffmpeg_encoders() else [])
    if _PREVIEW_ENCODER:
        return ["-c:v", "h264_videotoolbox", "-b:v", bitrate]
    return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "20"]


def ffmpeg_filters() -> set[str]:
    """Names of every filter this ffmpeg build actually has."""
    proc = subprocess.run(["ffmpeg", "-hide_banner", "-filters"],
                          capture_output=True, text=True)
    names = set()
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 4 and not line.startswith("Filters"):
            names.add(parts[1])
    return names


def require_filters(*needed: str) -> None:
    have = ffmpeg_filters()
    missing = [f for f in needed if f not in have]
    if missing:
        die(f"this ffmpeg build has no {', '.join(missing)} filter(s).\n"
            f"  It needs libass and freetype. macOS: brew install ffmpeg-full;\n"
            f"  Linux: your distro's ffmpeg package usually has both.")
