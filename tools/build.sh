#!/usr/bin/env bash
# Rebuild a video's outputs from its existing edit (build/edl.json,
# build/overlays_edited.json and build/shorts.json). Does not re-edit: it
# re-runs the render steps.
#
#   tools/build.sh <name> [final|preview] [both|plain|edited|none] [shorts[=N]]
#
# Arguments may come in any order (npm appends the name after the others).
#
#   <name>    project folder under videos/ (e.g. introduction_video_long),
#             or a path to one, or "all" for every project under videos/
#             that has an edit (build/edl.json), one after another
#   final     full resolution, x264, loudness-normalised -> final.mp4 / final_edited.mp4
#   preview   half resolution, hardware encode           -> preview.mp4 / preview_edited.mp4
#   none      skip the long-form video (use with shorts)
#   shorts    also the vertical shorts picked in build/shorts.json, each as
#             shorts/<slug>/preview.mp4 or final.mp4; shorts=N only the first N.
#             Off unless asked for. Picking them is an editorial step - see the
#             edit_video skill - so it needs an existing build/shorts.json.
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

NAME="" QUALITY=final VARIANT=both SHORTS=""
for arg in "$@"; do
  case "$arg" in
    final|preview) QUALITY="$arg" ;;
    both|plain|edited|none) VARIANT="$arg" ;;
    shorts) SHORTS=all ;;
    shorts=*) SHORTS="${arg#shorts=}"
      [[ "$SHORTS" =~ ^[1-9][0-9]*$ ]] || { echo "shorts=N needs a number, got '$SHORTS'" >&2; exit 1; } ;;
    *) NAME="$arg" ;;
  esac
done

if [[ -z "$NAME" ]]; then
  echo "usage: tools/build.sh <name> [final|preview] [both|plain|edited|none] [shorts[=N]]" >&2
  echo "projects:" >&2
  ls -1 "$VIDEOS" | grep -v README >&2
  exit 1
fi

# what to hand on to each project, and to shorts.py
PASS=() COUNT=()
if [[ "$SHORTS" == all ]]; then PASS=(shorts)
elif [[ -n "$SHORTS" ]]; then PASS=("shorts=$SHORTS"); COUNT=(--count "$SHORTS")
fi

if [[ "$NAME" == all ]]; then
  found=0
  for dir in "$VIDEOS"/*/; do
    [[ -f "$dir/build/edl.json" ]] || { echo "skipping $(basename "$dir") (no edit yet)"; continue; }
    found=1
    BUILD_ALL=1 "$0" "$dir" "$QUALITY" "$VARIANT" ${PASS[@]+"${PASS[@]}"}
  done
  [[ $found == 1 ]] || { echo "no edited projects under $VIDEOS" >&2; exit 1; }
  exit 0
fi

if [[ -d "$NAME" ]]; then P="$(cd "$NAME" && pwd)"; else P="$VIDEOS/$NAME"; fi
[[ -d "$P" ]] || { echo "no project at $P" >&2; exit 1; }
[[ -f "$P/build/edl.json" ]] || { echo "no $P/build/edl.json - run /edit_video first" >&2; exit 1; }

if [[ -n "$SHORTS" && ! -f "$P/build/shorts.json" ]]; then
  if [[ -n "${BUILD_ALL:-}" ]]; then
    echo "note: $(basename "$P") has no shorts picked, building it without"
    SHORTS=""
    [[ "$VARIANT" == none ]] && exit 0
  else
    echo "no $P/build/shorts.json - pick the shorts with /edit_video first" >&2; exit 1
  fi
fi
[[ "$VARIANT" == none && -z "$SHORTS" ]] && { echo "nothing to build: 'none' needs 'shorts'" >&2; exit 1; }

want_edited=0
if [[ "$VARIANT" != plain && "$VARIANT" != none ]]; then
  if [[ -f "$P/build/overlays_edited.json" ]]; then
    want_edited=1
  elif [[ "$VARIANT" == edited ]]; then
    echo "no $P/build/overlays_edited.json - run /edit_video_plus first" >&2; exit 1
  else
    echo "note: no overlays_edited.json, building the plain version only"
  fi
fi

start=$(date +%s)
echo "==> $(basename "$P"): $QUALITY ($VARIANT${SHORTS:+, shorts})"

if [[ "$VARIANT" != none ]]; then
  "$PY" "$T/render.py" "$P" --quality "$QUALITY"
  "$PY" "$T/captions.py" "$P"
fi

if [[ "$VARIANT" == both || "$VARIANT" == plain ]]; then
  "$PY" "$T/finish.py" "$P" --quality "$QUALITY"
fi
if [[ $want_edited == 1 ]]; then
  "$PY" "$T/motion.py" "$P"
  "$PY" "$T/finish.py" "$P" --variant edited --quality "$QUALITY"
fi
if [[ -n "$SHORTS" ]]; then
  "$PY" "$T/shorts.py" render "$P" --quality "$QUALITY" ${COUNT[@]+"${COUNT[@]}"}
fi

echo "==> $(basename "$P") done in $(( $(date +%s) - start ))s"
