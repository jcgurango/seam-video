import { Input, UrlSource, BlobSource, ALL_FORMATS } from "mediabunny";

export class MediaStore {
  private inputCache = new Map<string, Promise<Input>>();
  private trackCache = new Map<
    string,
    Promise<{ video: Awaited<ReturnType<Input["getPrimaryVideoTrack"]>>; audio: Awaited<ReturnType<Input["getPrimaryAudioTrack"]>> }>
  >();

  getInput(sourceUrl: string): Promise<Input> {
    let cached = this.inputCache.get(sourceUrl);
    if (cached) return cached;

    cached = this.createInput(sourceUrl);
    this.inputCache.set(sourceUrl, cached);
    return cached;
  }

  private async createInput(sourceUrl: string): Promise<Input> {
    try {
      return new Input({
        source: new UrlSource(sourceUrl),
        formats: ALL_FORMATS,
      });
    } catch {
      // Fallback: fetch as blob for file:// URLs that UrlSource can't handle
      const response = await fetch(sourceUrl);
      const blob = await response.blob();
      return new Input({
        source: new BlobSource(blob),
        formats: ALL_FORMATS,
      });
    }
  }

  private getTracks(sourceUrl: string) {
    let cached = this.trackCache.get(sourceUrl);
    if (cached) return cached;

    cached = (async () => {
      const input = await this.getInput(sourceUrl);
      const [video, audio] = await Promise.all([
        input.getPrimaryVideoTrack(),
        input.getPrimaryAudioTrack(),
      ]);
      return { video, audio };
    })();
    this.trackCache.set(sourceUrl, cached);
    return cached;
  }

  async getVideoTrack(sourceUrl: string) {
    const tracks = await this.getTracks(sourceUrl);
    return tracks.video;
  }

  async getAudioTrack(sourceUrl: string) {
    const tracks = await this.getTracks(sourceUrl);
    return tracks.audio;
  }

  async getIntrinsicSize(sourceUrl: string): Promise<{ w: number; h: number }> {
    const video = await this.getVideoTrack(sourceUrl);
    if (!video) return { w: 0, h: 0 };
    return { w: video.displayWidth, h: video.displayHeight };
  }

  dispose(): void {
    this.inputCache.clear();
    this.trackCache.clear();
  }
}
