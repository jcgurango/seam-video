import type { ObjectFit, SpatialAnchor, Filter } from "@seam/core";
import { buildCSSFilter } from "./filterUtils.js";

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement | OffscreenCanvas,
  containerW: number,
  containerH: number,
  videoW: number,
  videoH: number,
  objectFit?: ObjectFit,
  anchor?: SpatialAnchor,
  filters?: Filter[]
): void {
  ctx.clearRect(0, 0, containerW, containerH);

  const cssFilter = buildCSSFilter(filters);
  if (cssFilter) {
    ctx.filter = cssFilter;
  }

  let scaledW: number;
  let scaledH: number;

  if (!objectFit || objectFit === "fill") {
    // Fill: stretch to container
    ctx.drawImage(source, 0, 0, containerW, containerH);
    ctx.filter = "none";
    return;
  }

  if (objectFit === "center") {
    scaledW = videoW;
    scaledH = videoH;
  } else if (objectFit === "fit") {
    const scale = Math.min(containerW / videoW, containerH / videoH);
    scaledW = videoW * scale;
    scaledH = videoH * scale;
  } else {
    // cover
    const scale = Math.max(containerW / videoW, containerH / videoH);
    scaledW = videoW * scale;
    scaledH = videoH * scale;
  }

  // Position within container based on anchor edges
  let offsetX: number;
  let offsetY: number;

  if (anchor?.right != null && anchor?.left == null) {
    offsetX = containerW - scaledW;
  } else if (anchor?.left != null && anchor?.right == null) {
    offsetX = 0;
  } else {
    offsetX = (containerW - scaledW) / 2;
  }

  if (anchor?.bottom != null && anchor?.top == null) {
    offsetY = containerH - scaledH;
  } else if (anchor?.top != null && anchor?.bottom == null) {
    offsetY = 0;
  } else {
    offsetY = (containerH - scaledH) / 2;
  }

  ctx.drawImage(source, offsetX, offsetY, scaledW, scaledH);
  ctx.filter = "none";
}
