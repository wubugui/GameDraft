/**
 * 资源系统的小工具(移植自 PixiJS v8.17(MIT):`assets/utils/*`,逐个对应)。
 */
import { path } from './path';

/** url 是不是指定 MIME 的 data: 地址 */
export function checkDataUrl(url: string, mimes: string | string[]): boolean {
  if (Array.isArray(mimes)) {
    for (const mime of mimes) {
      if (url.startsWith(`data:${mime}`)) return true;
    }
    return false;
  }
  return url.startsWith(`data:${mimes}`);
}

/** url(去掉 ?query)的扩展名(小写)是不是给定的之一 */
export function checkExtension(url: string, extension: string | string[]): boolean {
  const tempURL = url.split('?')[0];
  const ext = path.extname(tempURL).toLowerCase();
  if (Array.isArray(extension)) return extension.includes(ext);
  return ext === extension;
}

/** 单个 → 数组;给了 transform 时对字符串项(或 forceTransform 时对所有项)做变换 */
export function convertToList<T>(
  input: string | T | (string | T)[],
  transform?: (input: string) => T,
  forceTransform = false,
): T[] {
  if (!Array.isArray(input)) input = [input];
  if (!transform) return input as T[];
  return (input as (string | T)[]).map((item) => {
    if (typeof item === 'string' || forceTransform) return transform(item as string);
    return item;
  });
}

function processX(base: string, ids: string[][], depth: number, result: string[], tags: string[]): void {
  const id = ids[depth];
  for (let i = 0; i < id.length; i++) {
    const value = id[i];
    if (depth < ids.length - 1) {
      processX(base.replace(result[depth], value), ids, depth + 1, result, tags);
    } else {
      tags.push(base.replace(result[depth], value));
    }
  }
}

/** 展开 `{a,b}` 形式的地址模板:`'x.{png,webp}'` → `['x.png', 'x.webp']` */
export function createStringVariations(string: string): string[] {
  const regex = /\{(.*?)\}/g;
  const result = string.match(regex);
  const tags: string[] = [];
  if (result) {
    const ids: string[][] = [];
    result.forEach((vars) => {
      const split = vars.substring(1, vars.length - 1).split(',');
      ids.push(split);
    });
    processX(string, ids, 0, result, tags);
  } else {
    tags.push(string);
  }
  return tags;
}

/** 不是数组 = 单项 */
export const isSingleItem = (item: unknown): boolean => !Array.isArray(item);
