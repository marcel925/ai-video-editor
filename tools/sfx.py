#!/usr/bin/env python3
"""Synthesise the small sound-effect kit the edited variant uses.

  sfx.py            write tools/sfx/*.wav (skips files that exist)
  sfx.py --force    rewrite them

Generated rather than downloaded: neither stock API serves audio, and a
whoosh is only filtered noise under an envelope. Each file is peak-normalised
to -1 dBFS; loudness in the mix is set per use by `volume` in the overlay
spec, and finish.py's defaults keep every effect well under the voice.
"""
from __future__ import annotations

import argparse
import sys
import wave
from pathlib import Path

import numpy as np

SR = 48000
OUT = Path(__file__).resolve().parent / "sfx"
rng = np.random.default_rng(7)


def t(d: float) -> np.ndarray:
    return np.arange(int(SR * d)) / SR


def sweep_lowpass(x: np.ndarray, f0: float, f1: float, peak: float = 0.5) -> np.ndarray:
    """One-pole low-pass whose cutoff rises f0 -> f1 and back by `peak`."""
    n = len(x)
    pos = np.arange(n) / n
    rise = np.clip(pos / peak, 0, 1)
    fall = np.clip((1 - pos) / (1 - peak), 0, 1)
    fc = f0 + (f1 - f0) * np.minimum(rise, fall) ** 2
    a = np.exp(-2 * np.pi * fc / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(n):
        acc = (1 - a[i]) * x[i] + a[i] * acc
        y[i] = acc
    return y


def env(n: int, attack: float, peak_at: float = None, curve: float = 2.0) -> np.ndarray:
    pos = np.arange(n) / n
    p = peak_at if peak_at is not None else attack
    up = np.clip(pos / max(p, 1e-4), 0, 1) ** curve
    down = np.clip((1 - pos) / max(1 - p, 1e-4), 0, 1) ** curve
    return np.minimum(up, down)


def whoosh(d=0.55, f0=300, f1=5500) -> np.ndarray:
    noise = rng.standard_normal(int(SR * d))
    y = sweep_lowpass(noise, f0, f1, peak=0.55)
    y -= sweep_lowpass(y, 80, 250, 0.5)            # thin out the rumble
    return y * env(len(y), 0.55, curve=1.6)


def pop() -> np.ndarray:
    tt = t(0.11)
    f = 900 * np.exp(-tt * 38) + 180                # quick downward chirp
    y = np.sin(2 * np.pi * np.cumsum(f) / SR)
    return y * np.exp(-tt * 42)


def click() -> np.ndarray:
    tt = t(0.035)
    y = rng.standard_normal(len(tt)) * np.exp(-tt * 260)
    return y + 0.5 * np.sin(2 * np.pi * 2400 * tt) * np.exp(-tt * 200)


def hit() -> np.ndarray:
    tt = t(0.7)
    f = 120 * np.exp(-tt * 9) + 42
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 6.5)
    snap = rng.standard_normal(len(tt)) * np.exp(-tt * 70) * 0.35
    return body + sweep_lowpass(snap, 3000, 3000)


def riser(d=1.2) -> np.ndarray:
    tt = t(d)
    noise = sweep_lowpass(rng.standard_normal(len(tt)), 200, 7000, peak=0.98)
    tone = np.sin(2 * np.pi * np.cumsum(200 + 600 * (tt / d) ** 2) / SR) * 0.25
    return (noise + tone) * (tt / d) ** 2.2 * np.clip((d - tt) / 0.03, 0, 1)


def ding() -> np.ndarray:
    tt = t(0.9)
    y = sum(a * np.sin(2 * np.pi * f * tt) * np.exp(-tt * k)
            for f, a, k in [(1318.5, 1.0, 5), (2637, 0.35, 8), (3951, 0.15, 11)])
    return y * np.clip(tt / 0.004, 0, 1)


def cash() -> np.ndarray:
    """Register 'ka-ching': a click, then a bright two-note ding."""
    first = click()
    tt = t(0.8)
    bell = sum(a * np.sin(2 * np.pi * f * tt) * np.exp(-tt * k)
               for f, a, k in [(1760, 1.0, 6), (2217, 0.7, 6), (3520, 0.25, 10)])
    out = np.zeros(int(SR * 0.9))
    out[:len(first)] += first
    s = int(SR * 0.07)
    out[s:s + len(bell)] += bell[:len(out) - s]
    return out


KIT = {"whoosh": lambda: whoosh(), "swoosh": lambda: whoosh(0.3, 600, 7000),
       "pop": pop, "click": click, "hit": hit, "riser": riser, "ding": ding,
       "cash": cash}


def write(name: str, y: np.ndarray) -> None:
    y = y / (np.max(np.abs(y)) + 1e-9) * 10 ** (-1 / 20)
    fade = min(len(y), int(SR * 0.004))
    y[-fade:] *= np.linspace(1, 0, fade)
    OUT.mkdir(exist_ok=True)
    with wave.open(str(OUT / f"{name}.wav"), "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(SR)
        fh.writeframes((y * 32767).astype("<i2").tobytes())


def ensure(force: bool = False) -> Path:
    for name, fn in KIT.items():
        if force or not (OUT / f"{name}.wav").exists():
            write(name, fn())
    return OUT


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    ensure(args.force)
    print("\n".join(f"  {p.name}" for p in sorted(OUT.glob("*.wav"))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
