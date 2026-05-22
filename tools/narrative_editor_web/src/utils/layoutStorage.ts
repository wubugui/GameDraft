export type PanelLayout = {
  leftWidth: number;
  rightWidth: number;
  validationHeight: number;
};

const STORAGE_KEY = 'narrative-editor-layout-v2';

const DEFAULT_LAYOUT: PanelLayout = {
  leftWidth: 228,
  rightWidth: 380,
  validationHeight: 148,
};

export function loadPanelLayout(): PanelLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem('narrative-editor-layout-v1');
    if (!raw) return { ...DEFAULT_LAYOUT };
    const parsed = JSON.parse(raw) as Partial<PanelLayout>;
    return {
      leftWidth: clamp(parsed.leftWidth ?? DEFAULT_LAYOUT.leftWidth, 188, 360),
      rightWidth: clamp(parsed.rightWidth ?? DEFAULT_LAYOUT.rightWidth, 280, 560),
      validationHeight: clamp(parsed.validationHeight ?? DEFAULT_LAYOUT.validationHeight, 96, 360),
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function savePanelLayout(layout: PanelLayout): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
