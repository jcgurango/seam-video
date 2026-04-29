"""FastAPI application: two endpoints (transcribe, enhance) plus a
healthcheck. Models are loaded once at startup via the lifespan hook."""

from __future__ import annotations

import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator, Optional

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile

from .enhance import denoise_audio, setup_enhancer
from .schemas import TranscriptionResponse
from .transcribe import setup_whisper, transcribe_audio


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    setup_whisper()
    setup_enhancer()
    yield


app = FastAPI(
    title="Seam Generator Server",
    version="0.1.0",
    description=(
        "Backend for offloaded media generation tasks: Whisper "
        "transcription and Resemble Enhance denoise."
    ),
    lifespan=lifespan,
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


async def _spool_upload(upload: UploadFile) -> str:
    """Stream the upload to a temp file and return its path. Caller is
    responsible for removing it (we do that in the endpoint's `finally`)."""
    suffix = Path(upload.filename or "audio").suffix or ".wav"
    fd, path = tempfile.mkstemp(suffix=suffix, prefix="seamgen-")
    try:
        with os.fdopen(fd, "wb") as f:
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
    except Exception:
        # Make sure we don't leak the file if the upload errored mid-stream.
        try:
            os.unlink(path)
        finally:
            raise
    return path


@app.post(
    "/transcribe",
    response_model=TranscriptionResponse,
    summary="Transcribe audio with Whisper + Silero VAD",
)
async def transcribe(
    file: UploadFile = File(..., description="Audio file (wav/mp3/m4a/flac/...)."),
    language: Optional[str] = Form(
        None,
        description="ISO 639-1 code to skip language detection (e.g. 'en', 'fr').",
    ),
) -> TranscriptionResponse:
    path = await _spool_upload(file)
    try:
        return transcribe_audio(path, language=language)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


@app.post(
    "/enhance",
    summary="Denoise audio with Resemble Enhance",
    responses={
        200: {
            "content": {"audio/wav": {}},
            "description": "Denoised mono WAV.",
        }
    },
)
async def enhance(
    file: UploadFile = File(..., description="Audio file (wav/mp3/m4a/flac/...)."),
) -> Response:
    path = await _spool_upload(file)
    try:
        wav_bytes = denoise_audio(path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    return Response(content=wav_bytes, media_type="audio/wav")
