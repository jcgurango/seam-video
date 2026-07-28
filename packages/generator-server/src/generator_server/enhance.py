"""Audio cleanup via resemble-enhance.

Two stages are exposed: `denoise_audio` runs the denoiser only, while
`enhance_audio` runs the full enhancer (denoise + enhance). resemble-enhance
lazy-loads its model on first call, so there's no eager init here — the first
request will be slower than subsequent ones.
"""

from __future__ import annotations

import io
import os
import pathlib
import platform
from typing import Optional

import torch
import torchaudio

# resemble-enhance's checkpoint was pickled on Linux with `pathlib.PosixPath`
# references. On Windows, torch.load can't reconstruct PosixPath ("cannot
# instantiate 'PosixPath' on your system"), so alias it to WindowsPath for
# the duration of the process. Safe — we only ever read these paths, never
# call POSIX-specific methods on them.
if platform.system() == "Windows":
    pathlib.PosixPath = pathlib.WindowsPath  # type: ignore[misc, assignment]

# Imported lazily inside `denoise_audio` so the rest of the app (e.g. the
# /transcribe endpoint) can boot even if resemble-enhance fails to import
# in environments without a GPU build of torch.

_device: Optional[str] = None


def setup_enhancer() -> None:
    """Pick a device for resemble-enhance to run on. The model itself is
    loaded lazily by the library on first call."""
    global _device
    forced = os.getenv("ENHANCE_DEVICE")
    if forced:
        _device = forced
        return
    _device = "cuda" if torch.cuda.is_available() else "cpu"


def get_device() -> str:
    if _device is None:
        raise RuntimeError(
            "Enhancer not initialised — was the FastAPI lifespan run?"
        )
    return _device


def _load_mono(input_path: str) -> tuple[torch.Tensor, int]:
    """Load audio as a 1D (mono) tensor — resemble-enhance expects that.
    Denoise/enhance are waveform-level operations that don't preserve
    channels, so we collapse to mono up front."""
    dwav, sr = torchaudio.load(input_path)
    if dwav.dim() == 2 and dwav.size(0) > 1:
        dwav = dwav.mean(dim=0)
    else:
        dwav = dwav.squeeze(0)
    return dwav, sr


def _to_wav_bytes(out_wav: torch.Tensor, out_sr: int) -> bytes:
    """Encode a mono waveform to WAV bytes in memory. torchaudio.save needs
    a 2D tensor (channels, samples), so unsqueeze the mono channel back in."""
    buf = io.BytesIO()
    torchaudio.save(buf, out_wav.unsqueeze(0).cpu(), out_sr, format="wav")
    return buf.getvalue()


def denoise_audio(input_path: str) -> bytes:
    """Read audio from `input_path`, run resemble-enhance's `denoise`
    stage, and return WAV bytes (mono)."""
    from resemble_enhance.enhancer.inference import denoise

    dwav, sr = _load_mono(input_path)
    out_wav, out_sr = denoise(dwav, sr, device=get_device())
    return _to_wav_bytes(out_wav, out_sr)


def enhance_audio(input_path: str) -> bytes:
    """Read audio from `input_path`, run resemble-enhance's full `enhance`
    stage (denoise + enhance), and return WAV bytes (mono)."""
    from resemble_enhance.enhancer.inference import enhance

    dwav, sr = _load_mono(input_path)
    out_wav, out_sr = enhance(dwav, sr, device=get_device())
    return _to_wav_bytes(out_wav, out_sr)
