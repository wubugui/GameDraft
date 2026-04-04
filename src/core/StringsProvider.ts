import type { AssetManager } from './AssetManager';

type StringCategory = Record<string, string>;

export class StringsProvider {
  private data: Record<string, StringCategory> = {};

  async load(assetManager: AssetManager): Promise<void> {
    try {
      this.data = await assetManager.loadJson<Record<string, StringCategory>>('/assets/data/strings.json');
    } catch {
      console.warn('StringsProvider: strings.json not found, using fallback strings');
    }
  }

  get(category: string, key: string, vars?: Record<string, string | number>): string {
    const template = this.data[category]?.[key] ?? key;
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
  }
}
