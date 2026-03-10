/**
 * Filter comparison script: FFmpeg vs CSS filter output.
 *
 * Extracts a single frame from Cut0.mp4, applies various filters via both
 * FFmpeg and Puppeteer (CSS ctx.filter), then compares pixel data.
 *
 * Usage: npx tsx scripts/compare-filters.ts
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { buildCSSFilter } from "../packages/preview/src/renderer/media/filterUtils.js";
import type { Filter } from "../packages/core/src/types.js";

const require = createRequire("C:/Program Files/nodejs/node_modules/");
const puppeteer = require("puppeteer") as typeof import("puppeteer");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = "g:/American Occupation to City Pop/Cut0.mp4";
const OUT_DIR = path.join(__dirname, "../filter-comparison");
const FRAME_TIME = "00:00:01";

interface FilterTest {
  name: string;
  ffmpegFilter: string;
  filter: Filter;
}

const tests: FilterTest[] = [
  // ── adjust.brightness ──
  {
    name: "brightness_neg05",
    ffmpegFilter: "eq=brightness=-0.5",
    filter: { type: "adjust", brightness: -0.5 },
  },
  {
    name: "brightness_pos05",
    ffmpegFilter: "eq=brightness=0.5",
    filter: { type: "adjust", brightness: 0.5 },
  },
  {
    name: "brightness_pos02",
    ffmpegFilter: "eq=brightness=0.2",
    filter: { type: "adjust", brightness: 0.2 },
  },

  // ── adjust.contrast ──
  {
    name: "contrast_2",
    ffmpegFilter: "eq=contrast=2",
    filter: { type: "adjust", contrast: 2 },
  },
  {
    name: "contrast_05",
    ffmpegFilter: "eq=contrast=0.5",
    filter: { type: "adjust", contrast: 0.5 },
  },

  // ── adjust.saturation ──
  {
    name: "saturation_0",
    ffmpegFilter: "eq=saturation=0",
    filter: { type: "adjust", saturation: 0 },
  },
  {
    name: "saturation_2",
    ffmpegFilter: "eq=saturation=2",
    filter: { type: "adjust", saturation: 2 },
  },

  // ── adjust.gamma ──
  {
    name: "gamma_05",
    ffmpegFilter: "eq=gamma=0.5",
    filter: { type: "adjust", gamma: 0.5 },
  },
  {
    name: "gamma_22",
    ffmpegFilter: "eq=gamma=2.2",
    filter: { type: "adjust", gamma: 2.2 },
  },

  // ── colorbalance ──
  {
    name: "colorbalance_rs1",
    ffmpegFilter: "colorbalance=rs=1",
    filter: { type: "colorbalance", rs: 1 },
  },
  {
    name: "colorbalance_rm1",
    ffmpegFilter: "colorbalance=rm=1",
    filter: { type: "colorbalance", rm: 1 },
  },
  {
    name: "colorbalance_gm1",
    ffmpegFilter: "colorbalance=gm=1",
    filter: { type: "colorbalance", gm: 1 },
  },
  {
    name: "colorbalance_bm1",
    ffmpegFilter: "colorbalance=bm=1",
    filter: { type: "colorbalance", bm: 1 },
  },
  {
    name: "colorbalance_rs1_gm1_bh1",
    ffmpegFilter: "colorbalance=rs=1:gm=1:bh=1",
    filter: { type: "colorbalance", rs: 1, gm: 1, bh: 1 },
  },

  // ── colortemperature ──
  {
    name: "colortemp_3200",
    ffmpegFilter: "colortemperature=temperature=3200",
    filter: { type: "colortemperature", temperature: 3200 },
  },
  {
    name: "colortemp_10000",
    ffmpegFilter: "colortemperature=temperature=10000",
    filter: { type: "colortemperature", temperature: 10000 },
  },
  {
    name: "colortemp_2000",
    ffmpegFilter: "colortemperature=temperature=2000",
    filter: { type: "colortemperature", temperature: 2000 },
  },
  {
    name: "colortemp_40000",
    ffmpegFilter: "colortemperature=temperature=40000",
    filter: { type: "colortemperature", temperature: 40000 },
  },
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. Extract reference frame
  const refFrame = path.join(OUT_DIR, "reference.png");
  console.log("Extracting reference frame...");
  execSync(
    `ffmpeg -y -ss ${FRAME_TIME} -i "${SOURCE}" -frames:v 1 "${refFrame}"`,
    { stdio: "pipe" }
  );

  // 2. Generate FFmpeg-filtered frames
  console.log("\n=== Generating FFmpeg filtered frames ===");
  for (const test of tests) {
    const outPath = path.join(OUT_DIR, `ffmpeg_${test.name}.png`);
    console.log(`  ${test.name}: ${test.ffmpegFilter}`);
    execSync(
      `ffmpeg -y -ss ${FRAME_TIME} -i "${SOURCE}" -vf "${test.ffmpegFilter}" -frames:v 1 "${outPath}"`,
      { stdio: "pipe" }
    );
  }

  // 3. Generate CSS-filtered frames via Puppeteer
  console.log("\n=== Generating CSS filtered frames ===");
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  const refBase64 = fs.readFileSync(refFrame).toString("base64");
  const refDataUrl = `data:image/png;base64,${refBase64}`;

  for (const test of tests) {
    const cssFilter = buildCSSFilter([test.filter]);
    const outPath = path.join(OUT_DIR, `css_${test.name}.png`);
    console.log(`  ${test.name}: ${cssFilter}`);

    const base64 = await page.evaluate(
      async (dataUrl: string, cssFilter: string) => {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = reject;
          img.src = dataUrl;
        });

        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d")!;

        if (cssFilter && cssFilter !== "none") {
          ctx.filter = cssFilter;
        }
        ctx.drawImage(img, 0, 0);
        ctx.filter = "none";

        return canvas.toDataURL("image/png");
      },
      refDataUrl,
      cssFilter
    );

    const pngData = Buffer.from(base64.replace(/^data:image\/png;base64,/, ""), "base64");
    fs.writeFileSync(outPath, pngData);
  }

  await browser.close();

  // 4. Compare
  console.log("\n=== Detailed per-pixel analysis ===\n");

  for (const test of tests) {
    const ffmpegPath = path.join(OUT_DIR, `ffmpeg_${test.name}.png`);
    const cssPath = path.join(OUT_DIR, `css_${test.name}.png`);
    const cssFilter = buildCSSFilter([test.filter]);

    try {
      const result = execSync(
        `ffmpeg -y -i "${ffmpegPath}" -i "${cssPath}" ` +
        `-filter_complex "[0:v]scale=16:16:flags=area[a];[1:v]scale=16:16:flags=area[b];` +
        `[a][b]blend=all_mode=difference" ` +
        `-frames:v 1 -f rawvideo -pix_fmt rgb24 pipe:1`,
        { stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1024 * 1024 }
      );

      const pixels = result;
      let totalR = 0, totalG = 0, totalB = 0, maxDiff = 0;
      const numPixels = pixels.length / 3;
      for (let i = 0; i < pixels.length; i += 3) {
        totalR += pixels[i];
        totalG += pixels[i + 1];
        totalB += pixels[i + 2];
        maxDiff = Math.max(maxDiff, pixels[i], pixels[i + 1], pixels[i + 2]);
      }

      const avgR = (totalR / numPixels).toFixed(1);
      const avgG = (totalG / numPixels).toFixed(1);
      const avgB = (totalB / numPixels).toFixed(1);
      const avgTotal = ((totalR + totalG + totalB) / numPixels / 3).toFixed(1);

      let verdict: string;
      const avg = parseFloat(avgTotal);
      if (avg > 20) verdict = "⚠ LARGE DIFFERENCE";
      else if (avg > 10) verdict = "~ Moderate";
      else if (avg > 5) verdict = "~ Acceptable";
      else verdict = "✓ Close match";

      console.log(`${test.name}:`);
      console.log(`  FFmpeg: ${test.ffmpegFilter}`);
      console.log(`  CSS:    ${cssFilter.length > 80 ? cssFilter.slice(0, 77) + "..." : cssFilter}`);
      console.log(`  Avg: R=${avgR} G=${avgG} B=${avgB}  Overall=${avgTotal}/255  Max=${maxDiff}  ${verdict}`);
      console.log();
    } catch (e: any) {
      console.log(`${test.name}: comparison failed (${e.message?.slice(0, 80)})\n`);
    }
  }

  console.log(`Images saved to: ${OUT_DIR}`);
}

main().catch(console.error);
