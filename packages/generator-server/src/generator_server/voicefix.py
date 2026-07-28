"""Speech restoration via VoiceFixer.

Exposes `fix_audio`, which runs VoiceFixer's `restore` in one of its three
modes (0 = original model, 1 = with preprocessing, 2 = train mode, useful
for severely degraded speech). The model is loaded lazily on first call —
constructing `VoiceFixer` downloads its checkpoints on first ever use, so
eager init at startup would block boot on a cold cache.
"""

from __future__ import annotations

import os
import tempfile

import torch

_voicefixer = None  # lazy singleton; VoiceFixer() loads both model checkpoints


def _get_voicefixer():
    global _voicefixer
    if _voicefixer is None:
        from voicefixer import VoiceFixer

        _voicefixer = VoiceFixer()
    return _voicefixer


def fix_audio(input_path: str, mode: int = 0) -> bytes:
    """Read audio from `input_path`, run VoiceFixer's `restore` with the
    given mode (0/1/2), and return WAV bytes (mono, 44.1 kHz)."""
    if mode not in (0, 1, 2):
        raise ValueError(f"mode must be 0, 1 or 2 (got {mode})")
    model = _get_voicefixer()
    cuda = torch.cuda.is_available()
    # VoiceFixer only writes to a file path, so round-trip through a temp wav.
    fd, out_path = tempfile.mkstemp(suffix=".wav", prefix="seamgen-vf-")
    os.close(fd)
    try:
        model.restore(input=input_path, output=out_path, cuda=cuda, mode=mode)
        with open(out_path, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(out_path)
        except OSError:
            pass
