import type { AssetManager } from './AssetManager';

type StringCategory = Record<string, string>;

export class StringsProvider {
  private data: Record<string, StringCategory> = {};
  /** 在模板插值之后对整条字符串做引用解析（由 Game 注入） */
  private resolveDisplay: ((s: string) => string) | null = null;

  async load(assetManager: AssetManager): Promise<void> {
    try {
      this.data = await assetManager.loadJson<Record<string, StringCategory>>('/assets/data/strings.json');
    } catch {
      console.warn('StringsProvider: strings.json not found, using fallback strings');
    }
  }

  /** 设置/清除展示层引用解析；须在首帧前由 Game 注入 */
  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  /** 仅读 strings.json 原文，不解析 [tag:…] */
  getRaw(category: string, key: string): string {
    return this.data[category]?.[key] ?? key;
  }

  get(category: string, key: string, vars?: Record<string, string | number>): string {
    let template = this.getRaw(category, key);
    if (vars) {
      template = template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
    }
    if (this.resolveDisplay) {
      return this.resolveDisplay(template);
    }
    return template;
  }
}
