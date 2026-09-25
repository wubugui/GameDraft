/**
 * 取字体文件转 data URL。移植自 PixiJS v8.17(MIT)`scene/text-html/utils/loadFontAsBase64.mjs`。
 */
import { TextDOM } from '../../adapter';

export async function loadFontAsBase64(url: string): Promise<string> {
  const response = await TextDOM.get().fetch(url);
  const blob = await response.blob();
  const reader = new FileReader();
  const dataSrc = await new Promise<string>((resolve, reject) => {
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  return dataSrc;
}
