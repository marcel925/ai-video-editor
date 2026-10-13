#!/usr/bin/env python3
"""Step 2 - transcribe each take to word-level timestamps.

Engines, in order of preference:
  parakeet-mlx     Apple Silicon GPU, genuine per-token alignment
  mlx-whisper      Apple Silicon fallback
  faster-whisper   everywhere else (Linux, Windows, Intel Mac; CUDA if present)
All write the same schema, so nothing downstream needs to know which one ran.
"""
from __future__ import annotations

import argparse
import sys
import tempfile
import time
from pathlib import Path

from common import (die, fmt_ts, info, load_json, load_sources, project_paths, run,
                    save_json)

PARAKEET_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"
WHISPER_MODEL = "mlx-community/whisper-large-v3-turbo"
FASTER_WHISPER_MODEL = "large-v3-turbo"

# Chunking keeps a very long recording out of unified memory all at once, but
# the chunk merge can silently drop an entire chunk - a 6 minute take came
# back 172 words short with a 73s hole in the middle. So chunk only when the
# file is genuinely too big to do in one pass, and check the result either way.
CHUNK_ABOVE = 900.0
CHUNK_DURATION = 300.0
CHUNK_OVERLAP = 30.0

# A hole this long that holds at least this much speech is lost content, not
# a pause. Thinking pauses in these recordings run to a few seconds at most.
GAP_SECONDS = 12.0
GAP_SPEECH = 4.0

# The engine can also skip a stretch *inside* the transcript: the word before
# it simply runs on ("this." lasting 2.5s), and the next segment starts after
# the hole, so no gap between segments ever shows. What was skipped is usually
# a retake - the same line said again - so it reaches the video twice with
# nothing in the segment list to say so. Measured on words instead: past the
# longest a word can take, any real speech before the next word was lost.
WORD_SPAN = 1.0
HOLE_SPEECH = 1.0


def words_from_tokens(tokens) -> list[dict]:
    """parakeet emits subword tokens; a leading space marks a new word."""
    words: list[dict] = []
    for tok in tokens:
        text = getattr(tok, "text", "")
        if not text:
            continue
        if not words or text.startswith(" ") or text.startswith("▁"):
            words.append({
                "w": text.strip().replace("▁", ""),
                "s": round(float(tok.start), 3),
                "e": round(float(tok.end), 3),
            })
        else:
            words[-1]["w"] += text.replace("▁", "")
            words[-1]["e"] = round(float(tok.end), 3)
    return [w for w in words if w["w"]]


def transcribe_parakeet(wav: Path, model, duration: float) -> list[dict]:
    kwargs = ({"chunk_duration": CHUNK_DURATION,
               "overlap_duration": CHUNK_OVERLAP}
              if duration > CHUNK_ABOVE else {})
    result = model.transcribe(wav, **kwargs)
    segments = []
    for sent in result.sentences:
        text = sent.text.strip()
        if not text:
            continue
        segments.append({
            "start": round(float(sent.start), 3),
            "end": round(float(sent.end), 3),
            "text": text,
            "words": words_from_tokens(getattr(sent, "tokens", []) or []),
        })
    return segments


def transcribe_faster_whisper(wav: Path, model) -> list[dict]:
    result, _ = model.transcribe(str(wav), word_timestamps=True,
                                 condition_on_previous_text=False)
    segments = []
    for seg in result:
        text = (seg.text or "").strip()
        if not text:
            continue
        segments.append({
            "start": round(float(seg.start), 3),
            "end": round(float(seg.end), 3),
            "text": text,
            "words": [{"w": w.word.strip(), "s": round(float(w.start), 3),
                       "e": round(float(w.end), 3)}
                      for w in (seg.words or []) if w.word.strip()],
        })
    return segments


def transcribe_whisper(wav: Path) -> list[dict]:
    import mlx_whisper
    result = mlx_whisper.transcribe(
        str(wav), path_or_hf_repo=WHISPER_MODEL,
        word_timestamps=True, condition_on_previous_text=False)
    segments = []
    for seg in result.get("segments", []):
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        segments.append({
            "start": round(float(seg["start"]), 3),
            "end": round(float(seg["end"]), 3),
            "text": text,
            "words": [{"w": w["word"].strip(),
                       "s": round(float(w["start"]), 3),
                       "e": round(float(w["end"]), 3)}
                      for w in seg.get("words", []) if w.get("word", "").strip()],
        })
    return segments


def speech_seconds(silences: list, start: float, end: float) -> float:
    """How much of [start, end] is someone actually talking."""
    silent = 0.0
    for s, e in silences:
        lo, hi = max(start, float(s)), min(end, float(e))
        if hi > lo:
            silent += hi - lo
    return max(0.0, (end - start) - silent)


def coverage_gaps(segments: list[dict], silences: list,
                  duration: float) -> list[tuple[float, float]]:
    """Stretches the transcript skipped that the silence map says had speech."""
    gaps, cursor = [], 0.0
    for seg in sorted(segments, key=lambda s: s["start"]):
        if seg["start"] - cursor >= GAP_SECONDS:
            gaps.append((cursor, seg["start"]))
        cursor = max(cursor, seg["end"])
    if duration - cursor >= GAP_SECONDS:
        gaps.append((cursor, duration))
    return [(a, b) for a, b in gaps
            if speech_seconds(silences, a, b) >= GAP_SPEECH]


def shift(segments: list[dict], offset: float) -> list[dict]:
    """Move segments from a clip's own timeline onto the take's."""
    return [{
        "start": round(seg["start"] + offset, 3),
        "end": round(seg["end"] + offset, 3),
        "text": seg["text"],
        "words": [{"w": w["w"], "s": round(w["s"] + offset, 3),
                   "e": round(w["e"] + offset, 3)} for w in seg["words"]],
    } for seg in segments]


def repair_gaps(segments: list[dict], transcribe, wav: Path,
                silences: list, duration: float) -> tuple[list[dict], list]:
    """Re-transcribe anything the engine dropped on the floor.

    Lost speech is far more expensive than a wasted pass: it reaches the
    editorial step looking like footage that was never recorded, and the
    resulting cut is missing content nobody knows to look for.
    """
    gaps = coverage_gaps(segments, silences, duration)
    recovered = []
    for start, end in gaps:
        info(f"  {fmt_ts(start)}-{fmt_ts(end)} transcribed empty but holds "
             f"speech - re-transcribing that stretch")
        with tempfile.TemporaryDirectory() as tmp:
            piece = Path(tmp) / "gap.wav"
            run(["ffmpeg", "-v", "error", "-ss", f"{start:.3f}",
                 "-t", f"{end - start:.3f}", "-i", str(wav),
                 "-ar", "16000", "-ac", "1", "-y", str(piece)])
            found = transcribe(piece, end - start)
        recovered.extend(shift(found, start))
    if not recovered:
        return segments, gaps
    return sorted(segments + recovered, key=lambda s: s["start"]), gaps


def load_engine(name: str):
    """Return (engine_name, callable(wav) -> segments)."""
    if name in ("auto", "parakeet"):
        try:
            from parakeet_mlx import from_pretrained
            info(f"loading {PARAKEET_MODEL} (first run downloads ~600 MB)")
            model = from_pretrained(PARAKEET_MODEL)
            return "parakeet", lambda wav, dur: transcribe_parakeet(wav, model, dur)
        except Exception as exc:
            if name == "parakeet":
                die(f"parakeet-mlx unavailable: {exc}")
            info(f"parakeet unavailable ({exc}); falling back to whisper")
    try:
        import mlx_whisper  # noqa: F401
        info(f"loading {WHISPER_MODEL}")
        return "whisper", lambda wav, dur: transcribe_whisper(wav)
    except ImportError:
        pass
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        die("no transcription engine installed - run tools/setup.sh")
    info(f"loading faster-whisper {FASTER_WHISPER_MODEL} (first run downloads ~1.6 GB)")
    model = WhisperModel(FASTER_WHISPER_MODEL, device="auto", compute_type="default")
    return "whisper", lambda wav, dur: transcribe_faster_whisper(wav, model)


def word_holes(segments: list[dict], silences: list) -> list[tuple[dict, dict]]:
    """(word before, word after) for every stretch of speech with no words."""
    words = sorted((w for seg in segments for w in seg["words"]), key=lambda w: w["s"])
    holes = []
    for prev, nxt in zip(words, words[1:]):
        a, b = prev["s"] + WORD_SPAN, nxt["s"] - 0.05
        if b - a >= HOLE_SPEECH and speech_seconds(silences, a, b) >= HOLE_SPEECH:
            holes.append((prev, nxt))
    return holes


def fill_holes(segments: list[dict], transcribe, wav: Path, silences: list,
               patch: bool = False) -> tuple[list[dict], list[dict]]:
    """Re-transcribe the stretches word_holes() finds and put the words back.

    A fresh transcript gets each recovered stretch as a segment of its own,
    so it is numbered in segments.md and a retake in it is grouped with the
    line it repeats. `patch` is for a project already edited: the words go
    into the segment before the hole instead, so every segment id the EDL
    uses stays put, and captions, words.py and listen.py see them."""
    found = []
    for prev, nxt in word_holes(segments, silences):
        start, end = prev["s"], nxt["s"]
        with tempfile.TemporaryDirectory() as tmp:
            piece = Path(tmp) / "hole.wav"
            run(["ffmpeg", "-v", "error", "-ss", f"{start:.3f}",
                 "-t", f"{end - start:.3f}", "-i", str(wav),
                 "-ar", "16000", "-ac", "1", "-y", str(piece)])
            got = shift(transcribe(piece, end - start), start)
        # the first word heard is usually the one before the hole again
        new = [w for seg in got for w in seg["words"]
               if prev["s"] + 0.3 <= w["s"] < nxt["s"] - 0.1]
        # ...and the last, the one after it
        bare = lambda w: w["w"].strip(".,!?").lower()
        while new and bare(new[-1]) == bare(nxt) and nxt["s"] - new[-1]["s"] < 0.5:
            new.pop()
        if not new:
            continue
        prev["e"] = min(prev["e"], new[0]["s"])
        text = " ".join(w["w"] for w in new)
        info(f"  {fmt_ts(start)}-{fmt_ts(end)} was skipped inside the transcript: "
             f"recovered \"{text[:70]}\"")
        found.append({"start": new[0]["s"], "end": min(new[-1]["e"], end),
                      "text": text, "words": new})
        if patch:
            home = next(seg for seg in segments if prev in seg["words"])
            home["words"] = sorted(home["words"] + new, key=lambda w: w["s"])
            home["text"] = f"{home['text']} {text}"
        else:
            for seg in segments:
                if prev in seg["words"]:
                    seg["end"] = min(seg["end"], new[0]["s"])
            segments = sorted(segments + [found[-1]], key=lambda sg: sg["start"])
    return segments, found


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("project")
    ap.add_argument("--engine", default="auto",
                    choices=["auto", "parakeet", "whisper"])
    ap.add_argument("--force", action="store_true",
                    help="re-transcribe takes that already have a transcript")
    ap.add_argument("--patch-holes", action="store_true",
                    help="for an edited project: recover speech skipped inside "
                         "existing transcripts without renumbering segments")
    args = ap.parse_args()

    paths = project_paths(args.project)
    sources_file = paths["build"] / "sources.json"
    if not sources_file.exists():
        die("no build/sources.json - run tools/ingest.py first")
    sources = load_sources(paths)["sources"]

    if args.patch_holes:
        engine, transcribe = load_engine(args.engine)
        total = 0
        for source in sources:
            out = paths["transcripts"] / f"{source['stem']}.json"
            if not out.exists():
                continue
            data = load_json(out)
            data["segments"], found = fill_holes(
                data["segments"], transcribe, Path(source["audio"]),
                source.get("silences", []), patch=True)
            if found:
                save_json(out, data)
                total += len(found)
        print(f"{total} skipped stretch(es) recovered; segment ids unchanged")
        return 0

    todo = [s for s in sources
            if args.force or not (paths["transcripts"] / f"{s['stem']}.json").exists()]
    if not todo:
        print("all takes already transcribed (use --force to redo)")
        return 0

    engine, transcribe = load_engine(args.engine)

    for source in sources:
        out = paths["transcripts"] / f"{source['stem']}.json"
        if out.exists() and not args.force:
            info(f"reusing transcript for {source['name']}")
            continue
        wav = Path(source["audio"])
        info(f"transcribing {wav.name} ({fmt_ts(source['duration'])})")
        started = time.time()
        segments = transcribe(wav, source["duration"])
        segments, gaps = repair_gaps(segments, transcribe, wav,
                                     source.get("silences", []),
                                     source["duration"])
        segments, holes = fill_holes(segments, transcribe, wav,
                                     source.get("silences", []))
        gaps = gaps + holes
        elapsed = time.time() - started
        save_json(out, {
            "source": source["name"],
            "key": source["key"],
            "engine": engine,
            "duration": source["duration"],
            "segments": segments,
        })
        words = sum(len(s["words"]) for s in segments)
        speed = source["duration"] / elapsed if elapsed else 0
        note = f"  (recovered {len(gaps)} dropped stretch(es))" if gaps else ""
        print(f"  [{source['key']}] {len(segments):4d} segments, {words:5d} words "
              f"in {elapsed:.1f}s ({speed:.0f}x realtime) -> {out.name}{note}")

    print(f"\ntranscripts written to {paths['transcripts']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
