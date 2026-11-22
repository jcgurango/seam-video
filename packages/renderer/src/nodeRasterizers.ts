/**
 * The headless host side of extension node types that draw themselves
 * (`NodeTypeDef.rasterizer` — e.g. the Map extension's `map`) and of
 * extension overlays (`OverlayDef.rasterizer` — the Captions layer).
 *
 * `NodeRasterizers` creates each type's rasterizer on first use, hands it the
 * Node {@link RasterHost} (Skia canvases, byte-range sources from disk or
 * http) and turns its canvas into the RGBA frame the compositor uploads. The
 * offline renderer awaits `ensure` before every `draw`, so a frame never
 * shows half-loaded content.
 */
import { open, type FileHandle } from "node:fs/promises";
import { FetchSource } from "pmtiles";
import { createCanvas } from "@napi-rs/canvas";
import type {
  ByteSource,
  CanvasLike,
  NodeRasterizer,
  OverlayRasterizer,
  RasterHost,
  Seam,
  SurfaceView,
  ResolvedExtensionNode,
  ExtensionNodeView,
} from "@seam/core";
import { installCanvasShim } from "./text/canvasShim.js";
import { isRemoteSource, resolveSourcePath } from "./mediaInput.js";
import type { NodeFrame } from "./NodeBackend.js";

/** Byte-range reads from a local file through one lazily opened handle. */
class NodeFileSource implements ByteSource {
  private handle: FileHandle | null = null;
  constructor(private readonly filepath: string) {}
  getKey(): string {
    return this.filepath;
  }
  async getBytes(offset: number, length: number) {
    if (!this.handle) this.handle = await open(this.filepath, "r");
    const buffer = Buffer.alloc(length);
    await this.handle.read(buffer, 0, length, offset);
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    return { data: ab };
  }
  async close() {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }
}

export class NodeRasterizers {
  private readonly rasterizers = new Map<string, NodeRasterizer | null>();
  private readonly overlays = new Map<string, OverlayRasterizer | null>();
  private readonly files: NodeFileSource[] = [];
  private readonly host: RasterHost;
  private canvasReady = false;

  /** `extensions`: the Seam instance (its node types and overlays). */
  constructor(
    basePath: string,
    private readonly extensions: Pick<Seam, "nodeTypes" | "overlays">,
  ) {
    this.host = {
      createCanvas: (width, height) => createCanvas(width, height) as unknown as CanvasLike,
      openSource: async (source) => {
        // Remote (e.g. a cloud streaming URL from a remote .seam): bounded
        // Range requests over http.
        if (isRemoteSource(source)) return new FetchSource(source) as unknown as ByteSource;
        const file = new NodeFileSource(resolveSourcePath(source, basePath));
        this.files.push(file);
        return file;
      },
      // Nothing to wake: every draw is preceded by an awaited `ensure`.
      requestRepaint: () => {},
    };
  }

  private rasterizerFor(type: string): NodeRasterizer | null {
    let r = this.rasterizers.get(type);
    if (r === undefined) {
      const create = this.extensions.nodeTypes.get(type)?.rasterizer;
      if (create) this.prepareCanvas();
      r = create ? create(this.host) : null;
      this.rasterizers.set(type, r);
    }
    return r;
  }

  private overlayFor(key: string): OverlayRasterizer | null {
    let r = this.overlays.get(key);
    if (r === undefined) {
      const create = this.extensions.overlays.find((o) => o.key === key)?.rasterizer;
      if (create) this.prepareCanvas();
      r = create ? create(this.host) : null;
      this.overlays.set(key, r);
    }
    return r;
  }

  /** Canvas text on Skia: the bundled font families + the `OffscreenCanvas`
   *  polyfill core's text layout measures with (idempotent). */
  private prepareCanvas(): void {
    if (this.canvasReady) return;
    installCanvasShim();
    this.canvasReady = true;
  }

  private read(canvas: CanvasLike | null): NodeFrame | null {
    if (!canvas) return null;
    const ctx = canvas.getContext("2d") as {
      getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
    };
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: id.data, width: canvas.width, height: canvas.height };
  }

  /** Rasterize an overlay for `surface` at its inner time `t` into a
   *  `width`×`height` RGBA frame. Null when it has nothing to draw. */
  async renderOverlay(
    key: string,
    surface: SurfaceView,
    t: number,
    width: number,
    height: number,
  ): Promise<NodeFrame | null> {
    const rasterizer = this.overlayFor(key);
    if (!rasterizer) {
      throw new Error(
        `renderer: overlay "${key}" has no rasterizer — register the extension's render entry with createSeam`,
      );
    }
    await rasterizer.ensure?.(surface, t, width, height);
    return this.read(rasterizer.draw(surface, t, width, height));
  }

  /** Rasterize `node` at node-local `drawTime` into a `width`×`height` RGBA
   *  frame (the compositor's per-frame inner-canvas size). */
  async render(
    node: ResolvedExtensionNode,
    drawTime: number,
    width: number,
    height: number,
  ): Promise<NodeFrame | null> {
    const rasterizer = this.rasterizerFor(node.type);
    if (!rasterizer) {
      throw new Error(
        `renderer: node type "${node.type}" has no rasterizer — register the extension's render entry (e.g. "@seam/extension-map/render") with createSeam`,
      );
    }
    const view = node as unknown as ExtensionNodeView;
    await rasterizer.ensure?.(view, drawTime, width, height);
    return this.read(rasterizer.draw(view, drawTime, width, height));
  }

  /** The inner canvas of a node whose type measures it (`measured` — a text
   *  node that does not wrap) at node-local `drawTime`. Synchronous. */
  measure(node: ResolvedExtensionNode, drawTime: number): { w: number; h: number } | null {
    const size = this.rasterizerFor(node.type)?.measure?.(node as unknown as ExtensionNodeView, drawTime);
    return size ? { w: size.width, h: size.height } : null;
  }

  /** Dispose the rasterizers and close every file they opened. */
  async dispose(): Promise<void> {
    for (const r of this.rasterizers.values()) await r?.dispose();
    this.rasterizers.clear();
    for (const r of this.overlays.values()) await r?.dispose();
    this.overlays.clear();
    await Promise.all(this.files.map((f) => f.close()));
    this.files.length = 0;
  }
}

/**
 * A measurer for `resolveSpatial` (`ResolveSpatialOptions.measure`): sizes
 * the inner canvas of nodes whose type measures it (a text node that does
 * not wrap), so a resolved timeline carries their real rect. `dispose` when
 * done.
 */
export function createInnerMeasurer(
  seam: Pick<Seam, "nodeTypes" | "overlays">,
  basePath: string,
): {
  measure(node: ResolvedExtensionNode, t: number): { width: number; height: number } | null;
  dispose(): Promise<void>;
} {
  const nodes = new NodeRasterizers(basePath, seam);
  return {
    measure(node, t) {
      const size = nodes.measure(node, t);
      return size ? { width: size.w, height: size.h } : null;
    },
    dispose: () => nodes.dispose(),
  };
}
