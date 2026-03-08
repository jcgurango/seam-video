import { CanvasSink } from "mediabunny";
import type { WrappedCanvas } from "mediabunny";
import type { MediaStore } from "./MediaStore.js";

export class ClipPlayer {
  private canvasSink: CanvasSink | null = null;
  private videoIterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private nextFrame: WrappedCanvas | null = null;
  private currentFrameCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private asyncId = 0;
  private disposed = false;

  async init(mediaStore: MediaStore, sourceUrl: string): Promise<void> {
    const videoTrack = await mediaStore.getVideoTrack(sourceUrl);
    if (!videoTrack || !(await videoTrack.canDecode())) {
      this.canvasSink = null;
      return;
    }
    this.canvasSink = new CanvasSink(videoTrack, { poolSize: 2 });
  }

  async startPlayback(sourceTime: number): Promise<void> {
    if (!this.canvasSink || this.disposed) return;

    this.asyncId++;
    const myAsyncId = this.asyncId;

    void this.videoIterator?.return();
    this.nextFrame = null;

    this.videoIterator = this.canvasSink.canvases(sourceTime);

    // Prime with first two frames
    const first = await this.videoIterator.next();
    if (this.asyncId !== myAsyncId || this.disposed) return;

    if (first.value) {
      this.currentFrameCanvas = first.value.canvas;
    }

    const second = await this.videoIterator.next();
    if (this.asyncId !== myAsyncId || this.disposed) return;

    if (second.value) {
      this.nextFrame = second.value;
    }
  }

  async seek(sourceTime: number): Promise<void> {
    if (!this.canvasSink || this.disposed) return;

    this.asyncId++;
    const myAsyncId = this.asyncId;

    void this.videoIterator?.return();
    this.videoIterator = null;
    this.nextFrame = null;

    const frame = await this.canvasSink.getCanvas(sourceTime);
    if (this.asyncId !== myAsyncId || this.disposed) return;

    if (frame) {
      this.currentFrameCanvas = frame.canvas;
    }
  }

  getFrame(sourceTime: number): HTMLCanvasElement | OffscreenCanvas | null {
    if (this.nextFrame && this.nextFrame.timestamp <= sourceTime) {
      this.currentFrameCanvas = this.nextFrame.canvas;
      this.nextFrame = null;
      void this.advanceIterator(sourceTime);
    }
    return this.currentFrameCanvas;
  }

  private async advanceIterator(currentTime: number): Promise<void> {
    if (!this.videoIterator || this.disposed) return;

    const myAsyncId = this.asyncId;

    while (true) {
      const result = await this.videoIterator.next();
      if (this.asyncId !== myAsyncId || this.disposed) return;

      if (!result.value) break;

      if (result.value.timestamp <= currentTime) {
        // Frame is in the past, draw immediately and keep going
        this.currentFrameCanvas = result.value.canvas;
      } else {
        // Frame is in the future, buffer it
        this.nextFrame = result.value;
        break;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.asyncId++;
    void this.videoIterator?.return();
    this.videoIterator = null;
    this.nextFrame = null;
    this.currentFrameCanvas = null;
    this.canvasSink = null;
  }
}
