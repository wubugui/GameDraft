type StringCategory = Record<string, string>;

export class StringsProvider {
  private data: Record<string, StringCategory> = {};

  async load(): Promise<void> {
    try {
      const resp = await fetch('/assets/data/strings.json');
      this.data = await resp.json();
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
