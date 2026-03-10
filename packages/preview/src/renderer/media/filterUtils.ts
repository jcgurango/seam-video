import type { Filter } from "@seam/core";

/**
 * Convert a filters array to a CSS filter string for use with ctx.filter or style.filter.
 *
 * Uses inline SVG filters (feColorMatrix, feComponentTransfer) for operations
 * that CSS filter functions can't express. All SVG filter operations run on GPU.
 *
 * FFmpeg render is authoritative — preview prioritizes performance over accuracy.
 */
export function buildCSSFilter(filters?: Filter[]): string {
  if (!filters?.length) return "";

  const parts: string[] = [];

  for (const f of filters) {
    switch (f.type) {
      case "adjust": {
        // FFmpeg eq=brightness adds to YUV luma (gamma-encoded).
        // feColorMatrix offset operates in linearRGB. Scale down to compensate
        // for linear→gamma difference (linear values are perceptually bigger).
        if (f.brightness != null && f.brightness !== 0) {
          const b = f.brightness;
          // Approximate gamma-encoded additive brightness in linear RGB space.
          // Negative values map well with slight scaling; positive values need
          // moderate compression due to sRGB gamma (linear is perceptually brighter).
          const offset = b > 0 ? b * 0.7 : b;
          parts.push(svgColorMatrix(1, 1, 1, offset, offset, offset));
        }
        // CSS contrast maps reasonably to FFmpeg eq contrast
        if (f.contrast != null && f.contrast !== 1) {
          parts.push(`contrast(${f.contrast})`);
        }
        // CSS saturate maps reasonably to FFmpeg eq saturation
        if (f.saturation != null && f.saturation !== 1) {
          parts.push(`saturate(${f.saturation})`);
        }
        // Gamma: use SVG feComponentTransfer which supports a real power curve.
        // FFmpeg applies gamma to YUV luma; we apply to individual RGB channels.
        // exponent = 1/gamma to match FFmpeg's gamma behavior.
        if (f.gamma != null && f.gamma !== 1) {
          parts.push(svgGamma(1 / f.gamma));
        }
        break;
      }
      case "opacity":
        parts.push(`opacity(${f.value})`);
        break;
      case "colorbalance": {
        // FFmpeg colorbalance adds to R/G/B channels only within tonal ranges
        // (shadows ~0-0.25, midtones ~0.25-0.75, highlights ~0.75-1.0 of luma).
        // feColorMatrix adds to ALL pixels uniformly, so we scale down significantly
        // to approximate the average effect across the pixel distribution.
        const rs = f.rs ?? 0, gs = f.gs ?? 0, bs = f.bs ?? 0;
        const rm = f.rm ?? 0, gm = f.gm ?? 0, bm = f.bm ?? 0;
        const rh = f.rh ?? 0, gh = f.gh ?? 0, bh = f.bh ?? 0;

        // Midtones affect ~50% of pixels at partial intensity → weight 0.15
        // Shadows/highlights affect ~25% of pixels at partial intensity → weight 0.06
        const rOff = rm * 0.15 + rs * 0.06 + rh * 0.06;
        const gOff = gm * 0.15 + gs * 0.06 + gh * 0.06;
        const bOff = bm * 0.15 + bs * 0.06 + bh * 0.06;

        if (Math.abs(rOff) > 0.001 || Math.abs(gOff) > 0.001 || Math.abs(bOff) > 0.001) {
          parts.push(svgColorMatrix(1, 1, 1, rOff, gOff, bOff));
        }
        break;
      }
      case "colortemperature": {
        const temp = f.temperature ?? 6500;
        if (temp !== 6500) {
          const { r, g, b } = tempToRGB(temp);
          const { r: refR, g: refG, b: refB } = tempToRGB(6500);
          parts.push(svgColorMatrix(r / refR, g / refG, b / refB));
        }
        break;
      }
    }
  }

  return parts.join(" ");
}

/**
 * Build an inline SVG feColorMatrix that scales and/or offsets R, G, B.
 * Runs on GPU via CSS filter pipeline.
 */
function svgColorMatrix(
  rScale: number, gScale: number, bScale: number,
  rOff = 0, gOff = 0, bOff = 0
): string {
  const matrix = [
    rScale, 0, 0, 0, rOff,
    0, gScale, 0, 0, gOff,
    0, 0, bScale, 0, bOff,
    0, 0, 0, 1, 0,
  ].join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><filter id="f"><feColorMatrix type="matrix" values="${matrix}"/></filter></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}#f")`;
}

/**
 * Build an inline SVG feComponentTransfer with gamma curve applied to R, G, B.
 * C' = amplitude * C^exponent + offset (amplitude=1, offset=0).
 */
function svgGamma(exponent: number): string {
  const e = exponent.toFixed(6);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg"><filter id="f"><feComponentTransfer>`,
    `<feFuncR type="gamma" amplitude="1" exponent="${e}" offset="0"/>`,
    `<feFuncG type="gamma" amplitude="1" exponent="${e}" offset="0"/>`,
    `<feFuncB type="gamma" amplitude="1" exponent="${e}" offset="0"/>`,
    `</feComponentTransfer></filter></svg>`,
  ].join("");
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}#f")`;
}

/**
 * Convert color temperature (Kelvin) to approximate RGB (0-255).
 * Based on Tanner Helland's Planckian locus algorithm.
 */
function tempToRGB(temp: number): { r: number; g: number; b: number } {
  const t = temp / 100;
  let r: number, g: number, b: number;

  if (t <= 66) {
    r = 255;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
  }

  if (t <= 66) {
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }

  if (t >= 66) {
    b = 255;
  } else if (t <= 19) {
    b = 0;
  } else {
    b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  }

  return {
    r: Math.max(0, Math.min(255, r)),
    g: Math.max(0, Math.min(255, g)),
    b: Math.max(0, Math.min(255, b)),
  };
}
