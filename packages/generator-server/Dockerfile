# Seam generator server (FastAPI: Whisper transcription + Resemble Enhance).
# Build context is this directory (it has no monorepo dependencies).
#
# CPU baseline — works everywhere but transcription/enhance are slow. For GPU,
# switch to an nvidia/cuda base image, install a CUDA build of torch, and give
# the service GPU access (see docker-compose.yml note).
FROM python:3.11-slim

# System libs: ffmpeg (audio decode for faster-whisper/torchaudio), libsndfile
# (soundfile), git + build tools for any source-built dependency.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg libsndfile1 git build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# uv drives the install from the committed lockfile (reproducible).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
# Install dependencies first (cached layer), then the package source.
COPY pyproject.toml uv.lock ./
COPY src ./src
RUN uv sync --frozen --no-dev

ENV HOST=0.0.0.0 \
    PORT=8000 \
    # Persist downloaded models (Whisper large-v3-turbo, enhancer weights) on
    # the mounted /cache volume so restarts don't re-download.
    HF_HOME=/cache/huggingface \
    TORCH_HOME=/cache/torch
VOLUME ["/cache"]
EXPOSE 8000

# `uv run` executes inside the synced virtualenv.
CMD ["uv", "run", "generator-server"]
