/**
 * 载入 SVG data URL 到 Image。移植自 PixiJS v8.17(MIT)`scene/text-html/utils/loadSVGImage.mjs`。
 */
export function loadSVGImage(image: HTMLImageElement, url: string, delay: boolean): Promise<void> {
  return new Promise<void>(async (resolve) => {
    if (delay) {
      await new Promise<void>((resolve2) => setTimeout(resolve2, 100));
    }
    image.onload = () => {
      resolve();
    };
    image.src = `data:image/svg+xml;charset=utf8,${encodeURIComponent(url)}`;
    image.crossOrigin = 'anonymous';
  });
}
