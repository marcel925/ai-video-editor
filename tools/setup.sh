#!/usr/bin/env bash
# Prepare this machine for the video pipeline. Safe to re-run.
#
#   tools/setup.sh                 venv at <repo>/.venv (a clone of the repo)
#   tools/setup.sh --venv DIR      venv somewhere else (the plugin data folder)
#   tools/setup.sh --motion ENGINE motion-graphics engine(s) to install:
#                                  remotion (default), hyperframes or both.
#                                  Defaults to $MOTION_ENGINE when that is set.
#
# macOS uses Homebrew. Linux needs ffmpeg and node from the distro first.
# Windows: run it inside WSL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.venv"
MOTION_ENGINES="${MOTION_ENGINE:-remotion}"
while [ $# -gt 0 ]; do
  case "$1" in
    --venv) VENV="$2"; shift 2 ;;
    --motion) MOTION_ENGINES="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$MOTION_ENGINES" in
  remotion|hyperframes) ;;
  both) MOTION_ENGINES="remotion hyperframes" ;;
  *) echo "--motion takes remotion, hyperframes or both" >&2; exit 2 ;;
esac
cd "$ROOT"

say() { printf '\n==> %s\n' "$1"; }
need() { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"
ARCH="$(uname -m)"
APPLE_SILICON=false
[ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ] && APPLE_SILICON=true

say "ffmpeg"
if [ "$OS" = "Darwin" ]; then
  need brew || { echo "Homebrew is required on macOS: https://brew.sh" >&2; exit 1; }
  # Homebrew's plain 'ffmpeg' has no libass/freetype (no captions, no titles).
  brew list --versions ffmpeg-full >/dev/null 2>&1 || brew install ffmpeg-full
  if ! ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' subtitles '; then
    brew unlink ffmpeg 2>/dev/null || true
    brew link --overwrite ffmpeg-full
  fi
else
  need ffmpeg || { echo "Install ffmpeg first, e.g.  sudo apt install ffmpeg fonts-dejavu fonts-noto-color-emoji" >&2; exit 1; }
fi

say "python virtualenv at $VENV"
if ! need uv; then
  if [ "$OS" = "Darwin" ]; then brew install uv
  else curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH"
  fi
fi
# Not 3.13+: the ML wheels lag a release or two behind.
[ -x "$VENV/bin/python" ] || uv venv --python 3.12 "$VENV"

say "python packages"
if $APPLE_SILICON; then
  ASR=(parakeet-mlx mlx-whisper)          # Apple GPU
else
  ASR=(faster-whisper)                    # CPU, or CUDA when present
fi
uv pip install --python "$VENV/bin/python" \
  "${ASR[@]}" \
  "opencv-python-headless<5" \
  opentimelineio \
  pyyaml \
  pillow \
  numpy \
  requests

say "motion graphics for the edited version: $MOTION_ENGINES"
# Remotion runs on Node 18+; HyperFrames needs 22+.
if ! need node; then
  if [ "$OS" = "Darwin" ]; then brew install node
  else echo "  node not found - install Node 22+ for the edited version (skipping)"
  fi
fi
if need node; then
  DATA="$(dirname "$VENV")"
  for dir in $MOTION_ENGINES; do
    [ "$dir" = remotion ] && dir=motion
    if [ "$dir" = hyperframes ] && [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
      echo "  HyperFrames needs Node 22+ (found $(node -v)) - skipping it" >&2
      continue
    fi
    if [ "$DATA" = "$ROOT" ]; then
      (cd "$dir" && npm install --no-fund --no-audit)
    else
      # Plugin install: keep the packages in the data folder, which survives
      # plugin updates, and link them in (motion.py relinks as needed).
      mkdir -p "$DATA/$dir"
      cp "$dir/package.json" "$dir/package-lock.json" "$DATA/$dir/"
      (cd "$DATA/$dir" && npm install --no-fund --no-audit)
      rm -rf "$dir/node_modules"
      ln -s "$DATA/$dir/node_modules" "$dir/node_modules"
    fi
  done
fi

say "sound effects"
"$VENV/bin/python" tools/sfx.py >/dev/null

say "checking"
"$VENV/bin/python" tools/doctor.py
