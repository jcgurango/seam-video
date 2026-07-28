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

### Resolve

```
seam resolve test.seam
```

Prints the resolved timeline JSON (temporal + spatial layout) to stdout, or to a
file with `-o`.

## License

MIT — see [LICENSE](./LICENSE).
