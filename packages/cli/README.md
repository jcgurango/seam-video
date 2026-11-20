# seam

Command-line tool for **Seam Video** — a flowing video editor where edits are
defined as JSON (`.seam` files). Instead of absolute timecodes, clips are
defined by their source ranges; everything shifts automatically when you add,
remove, or reorder.

This package is self-contained: it bundles the Seam core and renderer (headless
WebGPU compositing via Dawn). Native rendering dependencies (WebGPU/Dawn, Skia
canvas, ffmpeg-free mux via mediabunny) install as prebuilt binaries.

## Install

```
npm install -g @seam-media/cli
```

Requires Node.js >= 22.

## Usage

```
Usage: seam [options] [command]

Commands:
  render [options] <file>   Render a .seam file to mp4
  resolve [options] <file>  Print the resolved timeline JSON for a .seam file
  help [command]            display help for command
```

### Render

```
seam render test.seam
```

Validates the `.seam` file and renders it to `test.mp4`. Output dimensions come
from the root composition's `contentWidth`/`contentHeight`, or override with
`--width`/`--height`. Quality presets (`--quality`) range `very-low` →
`very-high`.

```
seam render test.seam --agc
```

`--agc` masters the final mix for short-form platforms: a slow automatic gain
control evens out quiet and loud passages, the integrated loudness is
normalised to **−14 LUFS** (what Instagram Reels, YouTube Shorts and TikTok
normalise to, so your clip plays at the same level as the next one) and a
true-peak limiter keeps peaks under **−1 dBTP**. Pass another target as
`--agc=-16` (use the `=` form for negative numbers). The before/after
loudness, peak, gain range and limiter depth are printed when the render
finishes.

### Resolve

```
seam resolve test.seam
```

Prints the resolved timeline JSON (temporal + spatial layout) to stdout, or to a
file with `-o`.

## License

MIT — see [LICENSE](./LICENSE).
