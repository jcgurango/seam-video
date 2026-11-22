// Adjustments — the first Seam extension.
//
// Six first-class, keyframeable fields on every visual node (clip, static,
// text, rect, circle, map, composition):
//
//   brightness   −1 … 1        0 = unchanged
//   contrast     −1000 … 1000  1 = unchanged
//   saturation   0 … 3         1 = unchanged (0 = greyscale)
//   gamma        0.1 … 10      1 = unchanged
//   temperature  1000 … 40000  6500 K = unchanged (lower = warmer)
//   tint         −1 … 1        0 = unchanged (+ magenta, − green)
//
// and one colour stage, fused into the compositor's fragment shader, that
// applies them in a fixed order: brightness/contrast → gamma → saturation
// (in BT.601 Y'CbCr, FFmpeg `eq`'s formula) → temperature × tint (an RGB
// scale). Values are gamma-encoded; nothing is linearized.
//
// These are quick corrections that make a shot sit next to its neighbours.
// Looks are built outside Seam.
//
// The extension imports only the public extension API (types from
// `@seam/core`).

import type { ColorStage, FieldSpec, SeamExtension } from "@seam/core";

const GROUP = "Adjustments";

const fields: FieldSpec[] = [
  {
    key: "brightness", nodes: "visual", type: "number", animatable: true,
    min: -1, max: 1, default: 0, step: 0.01, label: "Brightness", group: GROUP,
  },
  {
    key: "contrast", nodes: "visual", type: "number", animatable: true,
    min: -1000, max: 1000, softMin: 0, softMax: 2, default: 1, step: 0.01,
    label: "Contrast", group: GROUP,
  },
  {
    key: "saturation", nodes: "visual", type: "number", animatable: true,
    min: 0, max: 3, softMin: 0, softMax: 2, default: 1, step: 0.01,
    label: "Saturation", group: GROUP,
  },
  {
    key: "gamma", nodes: "visual", type: "number", animatable: true,
    min: 0.1, max: 10, softMin: 0.1, softMax: 3, default: 1, step: 0.01,
    label: "Gamma", group: GROUP,
  },
  {
    key: "temperature", nodes: "visual", type: "number", animatable: true,
    min: 1000, max: 40000, softMin: 2000, softMax: 12000, default: 6500, step: 50,
    unit: "K", label: "Temperature", group: GROUP,
  },
  {
    key: "tint", nodes: "visual", type: "number", animatable: true,
    min: -1, max: 1, default: 0, step: 0.01, label: "Tint", group: GROUP,
  },
];

// ── Temperature → RGB scale (Planckian-locus fit, normalised to 6500 K) ──

function tempToRGB(temp: number): [number, number, number] {
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

  return [
    Math.max(0, Math.min(255, r)),
    Math.max(0, Math.min(255, g)),
    Math.max(0, Math.min(255, b)),
  ];
}

const REF = tempToRGB(6500);

/** Per-channel multiplier for a colour temperature; exactly 1,1,1 at 6500 K. */
export function temperatureScale(kelvin: number): [number, number, number] {
  const t = tempToRGB(kelvin);
  return [t[0] / REF[0], t[1] / REF[1], t[2] / REF[2]];
}

/** How far a full `tint` of ±1 pulls the affected channel(s) down. */
const TINT_STRENGTH = 0.5;

/** Per-channel multiplier for a tint: positive pulls green down (towards
 *  magenta), negative pulls red and blue down (towards green). Only ever
 *  attenuates, so it can't clip. */
export function tintScale(tint: number): [number, number, number] {
  if (tint > 0) return [1, 1 - TINT_STRENGTH * tint, 1];
  if (tint < 0) {
    const k = 1 + TINT_STRENGTH * tint;
    return [k, 1, k];
  }
  return [1, 1, 1];
}

// ── The colour stage ──

const WGSL = /* wgsl */ `
fn adj_rgb_to_yuv(rgb: vec3f) -> vec3f {
  let y = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
  let u = -0.169 * rgb.r - 0.331 * rgb.g + 0.500 * rgb.b + 0.5;
  let v =  0.500 * rgb.r - 0.419 * rgb.g - 0.081 * rgb.b + 0.5;
  return vec3f(y, u, v);
}

fn adj_yuv_to_rgb(yuv: vec3f) -> vec3f {
  let y = yuv.x;
  let u = yuv.y - 0.5;
  let v = yuv.z - 0.5;
  let r = y + 1.402 * v;
  let g = y - 0.344 * u - 0.714 * v;
  let b = y + 1.772 * u;
  return vec3f(r, g, b);
}

// eq:    brightness, contrast, saturation, gamma
// scale: temperature × tint RGB multiplier (w unused)
fn adj_stage(rgb_in: vec3f, eq: vec4f, scale: vec4f) -> vec3f {
  // brightness / contrast / gamma / saturation — FFmpeg eq's create_lut order
  var yuv = adj_rgb_to_yuv(rgb_in);
  // Step 1: contrast + brightness (before gamma)
  var y = eq.y * (yuv.x - 0.5) + 0.5 + eq.x;
  // Step 2: gamma (applied to the contrast/brightness result)
  y = max(y, 0.0);
  let gamma_inv = 1.0 / eq.w;
  y = pow(y, gamma_inv);
  yuv.x = y;
  yuv.y = (yuv.y - 0.5) * eq.z + 0.5;
  yuv.z = (yuv.z - 0.5) * eq.z + 0.5;
  var rgb = clamp(adj_yuv_to_rgb(yuv), vec3f(0.0), vec3f(1.0));

  // temperature × tint
  rgb = clamp(rgb * scale.xyz, vec3f(0.0), vec3f(1.0));
  return rgb;
}
`;

const colorStage: ColorStage = {
  slots: 2,
  wgsl: WGSL,
  entry: "adj_stage",
  prepare(values, out) {
    out[0] = values.brightness ?? 0;
    out[1] = values.contrast ?? 1;
    out[2] = values.saturation ?? 1;
    out[3] = values.gamma ?? 1;

    let r = 1, g = 1, b = 1;
    const temperature = values.temperature;
    if (temperature != null && temperature !== 6500) {
      [r, g, b] = temperatureScale(temperature);
    }
    const tint = values.tint;
    if (tint != null && tint !== 0) {
      const [tr, tg, tb] = tintScale(tint);
      r *= tr; g *= tg; b *= tb;
    }
    out[4] = r;
    out[5] = g;
    out[6] = b;
    out[7] = 0;
  },
};

/** The Adjustments extension. Register with `createSeam([adjustments, …])`. */
export const adjustments: SeamExtension = {
  name: "adjustments",
  fields,
  colorStage,
};

export default adjustments;
