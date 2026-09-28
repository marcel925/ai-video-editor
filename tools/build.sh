#!/usr/bin/env bash
# Rebuild a video's outputs from its existing edit (build/edl.json and
# build/overlays_edited.json). Does not re-edit: it re-runs the render steps.
#
#   tools/build.sh <name> [final|preview] [both|plain|edited]
#
# Arguments may come in any order (npm appends the name after the others).
#
#   <name>    project folder under videos/ (e.g. introduction_video_long),
#             or a path to one, or "all" for every project under videos/
#             that has an edit (build/edl.json), one after another
#   final     full resolution, x264, loudness-normalised -> final.mp4 / final_edited.mp4
#   preview   half resolution, hardware encode           -> preview.mp4 / preview_edited.mp4
#
# Works from a clone (npm run final -- <name>) and from a plugin install
# (bash "$CLAUDE_PLUGIN_ROOT/tools/build.sh" <name>). Projects are looked up in
# ./videos of the current directory, falling back to the repo's videos/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$ROOT/tools"
if [[ -z "${PY:-}" ]]; then
  if [[ -x "$ROOT/.venv/bin/python" ]]; then PY="$ROOT/.venv/bin/python"
  elif [[ -n "${CLAUDE_PLUGIN_DATA:-}" && -x "$CLAUDE_PLUGIN_DATA/venv/bin/python" ]]; then PY="$CLAUDE_PLUGIN_DATA/venv/bin/python"
  else echo "no Python environment found - run tools/setup.sh first (or set PY)" >&2; exit 1
  fi
fi
if [[ -d "$PWD/videos" ]]; then VIDEOS="$PWD/videos"; else VIDEOS="$ROOT/videos"; fi

NAME="" QUALITY=final VARIANT=both
for arg in "$@"; do
  case "$arg" in
    final|preview) QUALITY="$arg" ;;
    both|plain|edited) VARIANT="$arg" ;;
    *) NAME="$arg" ;;
  esac
done

if [[ -z "$NAME" ]]; then
  echo "usage: tools/build.sh <name> [final|preview] [both|plain|edited]" >&2
  echo "projects:" >&2
  ls -1 "$VIDEOS" | grep -v README >&2
  exit 1
fi

if [[ "$NAME" == all ]]; then
  found=0
  for dir in "$VIDEOS"/*/; do
    [[ -f "$dir/build/edl.json" ]] || { echo "skipping $(basename "$dir") (no edit yet)"; continue; }
    found=1
    "$0" "$dir" "$QUALITY" "$VARIANT"
  done
  [[ $found == 1 ]] || { echo "no edited projects under $VIDEOS" >&2; exit 1; }
  exit 0
fi

if [[ -d "$NAME" ]]; then P="$(cd "$NAME" && pwd)"; else P="$VIDEOS/$NAME"; fi
[[ -d "$P" ]] || { echo "no project at $P" >&2; exit 1; }
[[ -f "$P/build/edl.json" ]] || { echo "no $P/build/edl.json - run /edit_video first" >&2; exit 1; }

want_edited=0
if [[ "$VARIANT" != plain ]]; then
  if [[ -f "$P/build/overlays_edited.json" ]]; then
    want_edited=1
  elif [[ "$VARIANT" == edited ]]; then
    echo "no $P/build/overlays_edited.json - run /edit_video_plus first" >&2; exit 1
  else
    echo "note: no overlays_edited.json, building the plain version only"
  fi
fi

start=$(date +%s)
echo "==> $(basename "$P"): $QUALITY ($VARIANT)"

"$PY" "$T/render.py" "$P" --quality "$QUALITY"
"$PY" "$T/captions.py" "$P"

if [[ "$VARIANT" != edited ]]; then
  "$PY" "$T/finish.py" "$P" --quality "$QUALITY"
fi
if [[ $want_edited == 1 ]]; then
  "$PY" "$T/motion.py" "$P"
  "$PY" "$T/finish.py" "$P" --variant edited --quality "$QUALITY"
fi

echo "==> $(basename "$P") done in $(( $(date +%s) - start ))s"
