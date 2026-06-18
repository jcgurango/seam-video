/**
 * Preview-side adapter over the shared {@link Compositor}. Keeps the original
 * `init(canvas)/resize/render/dispose/ready` surface that Timeline.tsx drives,
 * delegating all GPU work to `@seam/compositor` through a {@link BrowserBackend}.
 *
 * The heavy compositing logic now lives in @seam/compositor and is shared
 * verbatim with the headless Node renderer, so the preview and the final
 * render composite identically by construction.
 */
import { Compositor, type RenderCommand } from "@seam/compositor";
import type {
  ResolvedClip,
  ResolvedGraphic,
  ResolvedStatic,
  ResolvedText,
} from "@seam/core";
import { BrowserBackend, type BrowserFrame } from "./BrowserBackend.js";

type Drawable = ResolvedClip | ResolvedStatic | ResolvedText | ResolvedGraphic;

export class WebGPURenderer {
  private backend = new BrowserBackend();
  private compositor: Compositor<BrowserFrame> | null = null;

  get ready(): boolean {
    return this.compositor?.ready ?? false;
  }

  async init(canvas: HTMLCanvasElement): Promise<void> {
    // Idempotent: re-init on a fresh canvas (remount / hot reload) tears down
    // the old device-bound state first. Timeline.tsx also gates on canvas
    // identity so we don't fire overlapping inits.
    if (this.compositor) this.dispose();
    await this.backend.init(canvas);
    this.compositor = new Compositor<BrowserFrame>(this.backend);
    this.compositor.init();
  }

  resize(width: number, height: number): void {
    this.compositor?.resize(width, height);
  }

  render(
    commands: RenderCommand[],
    getFrame: (clip: Drawable) => BrowserFrame | null,
  ): void {
    // Fire-and-forget: the browser backend's present() is a no-op, so all GPU
    // work is submitted synchronously before the returned promise's first await.
    void this.compositor?.render(commands, getFrame);
  }

  dispose(): void {
    this.compositor?.dispose();
    this.compositor = null;
    this.backend.dispose();
  }
}
