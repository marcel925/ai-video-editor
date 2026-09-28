#!/usr/bin/env bash
# Prepare this machine for the video pipeline. Safe to re-run.
#
#   tools/setup.sh                 venv at <repo>/.venv (a clone of the repo)
#   tools/setup.sh --venv DIR      venv somewhere else (the plugin data folder)
#
# macOS uses Homebrew. Linux needs ffmpeg and node from the distro first.
# Windows: run it inside WSL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.venv"
if [ "${1:-}" = "--venv" ] && [ -n "${2:-}" ]; then VENV="$2"; fi
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

say "remotion (motion graphics for the edited version)"
if ! need node; then
  if [ "$OS" = "Darwin" ]; then brew install node
  else echo "  node not found - install Node 18+ for the edited version (skipping)"
  fi
fi
if need node; then
  DATA="$(dirname "$VENV")"
  if [ "$DATA" = "$ROOT" ]; then
    (cd motion && npm install --no-fund --no-audit)
  else
    # Plugin install: keep the packages in the data folder, which survives
    # plugin updates, and link them into motion/ (motion.py relinks as needed).
    mkdir -p "$DATA/motion"
    cp motion/package.json motion/package-lock.json "$DATA/motion/"
    (cd "$DATA/motion" && npm install --no-fund --no-audit)
    rm -rf motion/node_modules
    ln -s "$DATA/motion/node_modules" motion/node_modules
  fi
fi

say "sound effects"
"$VENV/bin/python" tools/sfx.py >/dev/null

say "checking"
"$VENV/bin/python" tools/doctor.py
