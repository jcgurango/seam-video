/**
 * The headless host side of extension node types that draw themselves
 * (`NodeTypeDef.rasterizer` — e.g. the Map extension's `map`).
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
  RasterHost,
  RegisteredNodeType,
  ResolvedExtensionNode,
  ExtensionNodeView,
} from "@seam/core";
import { installFonts } from "./text/fonts.js";
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
  private readonly files: NodeFileSource[] = [];
  private readonly host: RasterHost;

  constructor(
    basePath: string,
    private readonly nodeTypes: ReadonlyMap<string, RegisteredNodeType>,
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
      const create = this.nodeTypes.get(type)?.rasterizer;
      if (create) installFonts(); // canvas text resolves to the bundled Skia families
      r = create ? create(this.host) : null;
      this.rasterizers.set(type, r);
    }
    return r;
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
    const canvas = rasterizer.draw(view, drawTime, width, height);
    if (!canvas) return null;
    const ctx = canvas.getContext("2d") as {
      getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
    };
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: id.data, width: canvas.width, height: canvas.height };
  }

  /** Dispose the rasterizers and close every file they opened. */
  async dispose(): Promise<void> {
    for (const r of this.rasterizers.values()) await r?.dispose();
    this.rasterizers.clear();
    await Promise.all(this.files.map((f) => f.close()));
    this.files.length = 0;
  }
}
