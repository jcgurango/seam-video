# Generator Server API

HTTP contract for the optional Python backend that runs Whisper
transcription and Resemble Enhance denoise. Source lives in
[`packages/generator-server/`](packages/generator-server/).

The server is a FastAPI app, so an OpenAPI schema is always available at
`/openapi.json` (with browsable UIs at `/docs` and `/redoc`). This
document is the authoritative human-friendly version.

Base URL: configurable via `HOST` / `PORT` env vars. Default
`http://127.0.0.1:8000`.

All audio uploads are sent as `multipart/form-data` with a single `file`
field. Any audio format ffmpeg/PyAV/torchaudio can decode is accepted
(WAV, MP3, M4A, FLAC, OGG, ...). Sample rate is converted internally;
multi-channel input is downmixed to mono.

---

## `GET /health`

Liveness probe. No model warm-up — useful for orchestrators.

**Response 200**
```json
{ "status": "ok" }
```

---

## `POST /transcribe`

Transcribe speech in an audio file using faster-whisper
(`large-v3-turbo`) with Silero VAD enabled. Returns one entry per
detected segment, each with per-word timings.

**Request**

`multipart/form-data`:

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | audio file | yes | The audio to transcribe |
| `language` | string | no | ISO 639-1 language code (e.g. `en`, `fr`). Skips auto-detect when set. |

**Response 200** — `application/json`

A JSON array of segments:

```json
[
  {
    "start": 0,
    "end": 1,
    "text": "Subscribe to my channel!",
    "words": [
      { "start": 0,   "end": 0.5, "text": "Subscribe" },
      { "start": 0.5, "end": 0.6, "text": "to" },
      { "start": 0.6, "end": 0.7, "text": "my" },
      { "start": 0.7, "end": 1,   "text": "channel!" }
    ]
  }
]
```

| Field | Type | Description |
|---|---|---|
| `start` | number | Segment start time in seconds |
| `end` | number | Segment end time in seconds |
| `text` | string | Segment text (concatenation of its words, trimmed) |
| `words` | array | Per-word timings (may be empty if Whisper didn't produce any) |
| `words[].start` | number | Word start time in seconds |
| `words[].end` | number | Word end time in seconds |
| `words[].text` | string | The word, with surrounding whitespace stripped |

Silero VAD is used to skip silence; only voiced regions are transcribed,
so segment boundaries cluster around speech rather than the full audio
length. Tweakable via env (`WHISPER_*`) on the server side, not via the
HTTP API itself.

**Errors**

- `422` — missing or malformed multipart fields (FastAPI default validation).
- `500` — model error (decoding, OOM, etc.); body is `{ "detail": "<message>" }`.

**curl example**

```bash
curl -X POST http://127.0.0.1:8000/transcribe \
  -F file=@interview.wav \
  -F language=en
```

---

## `POST /enhance`

Run Resemble Enhance's **denoise** stage on the uploaded audio. The
full enhancement (`enhance`) stage is deliberately not exposed — only
denoise.

**Request**

`multipart/form-data`:

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | audio file | yes | The audio to denoise |

**Response 200** — `audio/wav`

Raw WAV bytes (mono). The sample rate matches Resemble Enhance's output
(typically 44.1 kHz). The body is the audio file itself, not JSON.

**Errors**

- `422` — missing `file` field.
- `500` — denoise model failure; body is `{ "detail": "<message>" }`.

**curl example**

```bash
curl -X POST http://127.0.0.1:8000/enhance \
  -F file=@noisy-vo.wav \
  -o denoised.wav
```

---

## Notes for callers

- The first `/enhance` call after server start lazy-loads the model and
  will be noticeably slower. `/transcribe` warms its model during the
  FastAPI lifespan, so the first call is already hot.
- There's no auth layer — run this server on a trusted network, or put
  it behind a reverse proxy that handles auth/rate limiting.
- Uploads are streamed to a temp file and removed after the response is
  sent; no audio is persisted on disk.
- CORS is wide-open by default (`Access-Control-Allow-Origin: *`) so the
  editor can hit it from any origin during development. Set
  `CORS_ALLOW_ORIGINS=https://my.host,https://other.host` (comma-separated)
  to lock it down.
