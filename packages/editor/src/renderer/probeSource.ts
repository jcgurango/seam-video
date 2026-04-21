import { resolveSource } from "@seam/preview";

const cache = new Map<string, number>();

/** Probe the duration of a video source via a hidden <video> element. */
export function probeSourceDuration(
  source: string,
  basePath: string
): Promise<number> {
  const url = resolveSource(source, basePath);
  const cached = cache.get(url);
  if (cached != null) return Promise.resolve(cached);

  return new Promise((res, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      cache.set(url, video.duration);
      res(video.duration);
      video.remove();
    };
    video.onerror = () => {
      video.remove();
      reject(new Error(`Could not read metadata for ${source}`));
    };
    video.src = url;
  });
}
