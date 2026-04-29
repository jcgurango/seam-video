"""Whisper transcription via faster-whisper + Silero VAD.

Loads `large-v3-turbo` once at startup. Each request streams a short
multipart upload to a temp file, runs `transcribe(...)` with word-level
timestamps and the built-in Silero VAD filter, and returns segments +
per-word timings.
"""

from __future__ import annotations

import os
from typing import Optional

from faster_whisper import WhisperModel

from .schemas import Segment, TranscriptionResponse, Word


_model: Optional[WhisperModel] = None


def setup_whisper() -> None:
    """Eager-load the model on app startup so the first request isn't
    saddled with a multi-second download/decompress."""
    global _model

    model_size = os.getenv("WHISPER_MODEL", "large-v3-turbo")
    device = os.getenv("WHISPER_DEVICE", "auto")
    compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "default")

    if device == "auto":
        try:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "cpu"

    _model = WhisperModel(model_size, device=device, compute_type=compute_type)


def get_model() -> WhisperModel:
    if _model is None:
        raise RuntimeError(
            "Whisper model not initialised — was the FastAPI lifespan run?"
        )
    return _model


def transcribe_audio(
    path: str,
    language: Optional[str] = None,
) -> TranscriptionResponse:
    """Transcribe a local audio file. faster-whisper decodes the file via
    PyAV, so any format ffmpeg can read works (wav/mp3/m4a/flac/...)."""
    model = get_model()

    segments_iter, _info = model.transcribe(
        path,
        language=language,
        word_timestamps=True,
        vad_filter=True,
        # Sensible defaults; callers can override via env later if needed.
        vad_parameters={"min_silence_duration_ms": 500},
    )

    out: list[Segment] = []
    for seg in segments_iter:
        words: list[Word] = []
        if seg.words:
            for w in seg.words:
                words.append(
                    Word(
                        start=float(w.start),
                        end=float(w.end),
                        # faster-whisper prepends a space to most words —
                        # strip it so per-word `text` is the bare token.
                        text=w.word.strip(),
                    )
                )
        out.append(
            Segment(
                start=float(seg.start),
                end=float(seg.end),
                text=seg.text.strip(),
                words=words,
            )
        )
    return out
