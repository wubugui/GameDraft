export type PanelLayout = {
  leftWidth: number;
  rightWidth: number;
};

const STORAGE_KEY = 'narrative-editor-layout-v1';

const DEFAULT_LAYOUT: PanelLayout = {
  leftWidth: 260,
  rightWidth: 380,
};

export function loadPanelLayout(): PanelLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const parsed = JSON.parse(raw) as Partial<PanelLayout>;
    return {
      leftWidth: clamp(parsed.leftWidth ?? DEFAULT_LAYOUT.leftWidth, 200, 420),
      rightWidth: clamp(parsed.rightWidth ?? DEFAULT_LAYOUT.rightWidth, 280, 560),
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
