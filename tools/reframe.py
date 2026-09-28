#!/usr/bin/env python3
"""Optional - work out where to crop a wide take for a 9:16 short.

Samples frames, finds the speaker, and writes one static crop centre per take.
Static on purpose: a crop that chases the face frame-by-frame looks like a
handheld camera operator who has had too much coffee.
"""
from __future__ import annotations

import argparse
import statistics
import sys
from pathlib import Path

from common import die, info, load_json, project_paths, save_json


def sample_faces(video: str, duration: float, samples: int) -> list[tuple[float, float]]:
    import cv2

    cascade_path = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
    cascade = cv2.CascadeClassifier(str(cascade_path))
    if cascade.empty():
        die("could not load the OpenCV face cascade")

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        die(f"could not open {video}")

    centres: list[tuple[float, float]] = []
    for i in range(samples):
        position = duration * (i + 0.5) / samples
        cap.set(cv2.CAP_PROP_POS_MSEC, position * 1000.0)
        ok, frame = cap.read()
        if not ok:
            continue
        height, width = frame.shape[:2]
        scale = 640.0 / max(1, width)
        small = cv2.resize(frame, (int(width * scale), int(height * scale)))
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=6,
                                         minSize=(40, 40))
        if len(faces) == 0:
            continue
        # Biggest face wins - that is the person talking, not someone in a poster.
        x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
        centres.append(((x + w / 2) / small.shape[1],
                        (y + h / 2) / small.shape[0]))
    cap.release()
    return centres


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("project")
    ap.add_argument("--samples", type=int, default=24)
    ap.add_argument("--headroom", type=float, default=0.12,
                    help="keep the face this far above the crop centre")
    args = ap.parse_args()

    paths = project_paths(args.project)
    sources_file = paths["build"] / "sources.json"
    if not sources_file.exists():
        die("no build/sources.json - run tools/ingest.py first")
    sources = load_json(sources_file)["sources"]

    focus = {}
    for source in sources:
        info(f"scanning {source['name']} for faces")
        centres = sample_faces(source["video"], source["duration"], args.samples)
        if not centres:
            print(f"  [{source['key']}] no face found - centring the crop")
            focus[source["name"]] = {"x": 0.5, "y": 0.4, "confidence": 0.0}
            continue
        fx = statistics.median(c[0] for c in centres)
        fy = statistics.median(c[1] for c in centres)
        # Faces sit above centre in a good vertical framing.
        fy = min(0.85, max(0.0, fy + args.headroom))
        focus[source["name"]] = {"x": round(fx, 4), "y": round(fy, 4),
                                 "confidence": round(len(centres) / args.samples, 2)}
        print(f"  [{source['key']}] {source['name']}: focus x={fx:.2f} y={fy:.2f} "
              f"({len(centres)}/{args.samples} frames)")

    out = paths["build"] / "focus.json"
    save_json(out, focus)
    print(f"\n-> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
