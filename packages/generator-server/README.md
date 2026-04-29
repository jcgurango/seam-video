# Seam Generator Server

FastAPI backend for offloading media-generation work that doesn't have a
good JS-native path:

- **`POST /transcribe`** — [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
  with `large-v3-turbo` and Silero VAD; returns segments and per-word
  timings.
- **`POST /enhance`** — [Resemble Enhance](https://github.com/resemble-ai/resemble-enhance)
  denoise stage; returns a denoised mono WAV.

The HTTP contract lives in [`GENERATOR-API.md`](../../GENERATOR-API.md).

## Setup

Requires **Python 3.10 or 3.11** (not 3.12+). `resemble-enhance==0.0.1`
pins `torch==2.1.1`, which has no cp312 wheels.

PyTorch needs the right CUDA wheel for your hardware — install it
manually before this project's deps. CPU works too, just slowly.

### Linux / macOS

```bash
cd packages/generator-server

python3.11 -m venv .venv
source .venv/bin/activate

pip install --upgrade pip wheel "setuptools<70"
pip install torch==2.1.1 torchaudio==2.1.1 \
    --index-url https://download.pytorch.org/whl/cu121

pip install -e .
```

### Windows

Two extra hurdles compared to Linux:

- `deepspeed==0.12.4` (transitive dep) calls `os.symlink` at build time,
  which Windows blocks unless the process holds
  `SeCreateSymbolicLinkPrivilege`. Developer Mode alone is not always
  sufficient. The fix below patches `deepspeed`'s `setup.py` to fall
  back to a copy.
- `setuptools` must be `<81` because `torch==2.1.1`'s `cpp_extension`
  imports `pkg_resources`, which was removed from setuptools 81.

```powershell
cd packages\generator-server

py -3.11 -m venv .venv
.\.venv\Scripts\activate

python -m pip install --upgrade pip wheel "setuptools<70"
pip install torch==2.1.1 torchaudio==2.1.1 `
    --index-url https://download.pytorch.org/whl/cu121

# Fetch and patch deepspeed source.
curl -L -o "$env:TEMP\deepspeed-0.12.4.tar.gz" `
    https://files.pythonhosted.org/packages/source/d/deepspeed/deepspeed-0.12.4.tar.gz
tar xzf "$env:TEMP\deepspeed-0.12.4.tar.gz" -C "$env:TEMP"
```

In `$env:TEMP\deepspeed-0.12.4\setup.py`, replace the body of
`create_dir_symlink` (around line 213) with:

```python
def create_dir_symlink(src, dest):
    import shutil
    if os.path.islink(dest):
        return
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    elif os.path.exists(dest):
        os.remove(dest)
    try:
        os.symlink(src, dest)
    except OSError:
        abs_src = os.path.normpath(os.path.join(os.path.dirname(dest), src))
        shutil.copytree(abs_src, dest)
```

Then build and install:

```powershell
$env:DS_BUILD_OPS = "0"
$env:DS_BUILD_AIO = "0"
pip install --no-build-isolation "$env:TEMP\deepspeed-0.12.4"

pip install -e . --no-build-isolation
```

`DS_BUILD_OPS=0` keeps deepspeed from pre-compiling its CUDA ops at
install time (we don't use any of them — `resemble-enhance` only needs
the deepspeed Python runtime). `--no-build-isolation` lets the build
subprocess see the torch we just installed.

## Run

```bash
generator-server                   # listens on 127.0.0.1:8000
HOST=0.0.0.0 PORT=9000 generator-server
RELOAD=1 generator-server          # auto-reload on source change (dev)
```

Equivalent direct invocation:

```bash
uvicorn generator_server.main:app --host 127.0.0.1 --port 8000
```

Once running:

- Swagger UI: <http://127.0.0.1:8000/docs>
- ReDoc:      <http://127.0.0.1:8000/redoc>
- OpenAPI:    <http://127.0.0.1:8000/openapi.json>

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8000` | Bind port |
| `RELOAD` | `0` | `1` enables uvicorn auto-reload (dev only) |
| `WHISPER_MODEL` | `large-v3-turbo` | Any `faster-whisper` model name |
| `WHISPER_DEVICE` | `auto` | `auto` / `cpu` / `cuda` |
| `WHISPER_COMPUTE_TYPE` | `default` | e.g. `float16`, `int8_float16`, `int8` |
| `ENHANCE_DEVICE` | (auto) | Override resemble-enhance device |

The Whisper model is loaded eagerly during FastAPI's startup lifespan;
the first request finds it warm. The Resemble Enhance model is
lazy-loaded by the library on the first `/enhance` request — expect the
first call to be slow.
