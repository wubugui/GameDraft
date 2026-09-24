/**
 * 世界脑的名字牌（开发期 DOM 浮层）：归世界脑管的每个人身旁标上他的称呼，可开可关。
 *
 * 只是给人看的：不进渲染管线、不改实体；位置每帧由 Game 按相机投影给（头顶锚点 → 屏幕像素 → 页面坐标）。
 * 点名字 = 打开这个人的详情面板。正在看的那个人高亮。
 */
export interface NameTagEntry {
  npcId: string;
  label: string;
  /**
   * 页面坐标（CSS 像素）：牌子左边沿的中点。Game 摆在人身旁、齐胸高——头顶留给气泡（摆在头上会被气泡盖住）。
   */
  x: number;
  y: number;
  /** 被世界脑接管了（没接管的人走默认逻辑，牌子淡一点） */
  takenOver: boolean;
}

const stop = (ev: Event) => ev.stopPropagation();

export class WorldBrainNameTags {
  private root: HTMLDivElement | null = null;
  private readonly tags = new Map<string, HTMLDivElement>();
  private visible = true;

  constructor(private readonly onPick: (npcId: string) => void) {}

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (this.root) this.root.style.display = v ? 'block' : 'none';
  }

  mount(): void {
    if (this.root || typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.setAttribute('data-world-brain-name-tags', '');
    Object.assign(el.style, {
      position: 'fixed', left: '0', top: '0', width: '0', height: '0', zIndex: '8990', pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(el);
    this.root = el;
  }

  /** 每帧：entries 为空（世界脑关着 / 本场景没配置）就全收起 */
  update(entries: readonly NameTagEntry[], highlight: string | null): void {
    const root = this.root;
    if (!root) return;
    if (!this.visible) return;
    const seen = new Set<string>();
    for (const t of entries) {
      seen.add(t.npcId);
      let el = this.tags.get(t.npcId);
      if (!el) {
        el = document.createElement('div');
        Object.assign(el.style, {
          position: 'absolute', whiteSpace: 'nowrap', pointerEvents: 'auto', cursor: 'pointer',
          font: '12px/1.2 "Microsoft YaHei", sans-serif', padding: '1px 5px', borderRadius: '3px',
          transform: 'translate(0, -50%)', userSelect: 'none',
        } satisfies Partial<CSSStyleDeclaration>);
        const id = t.npcId;
        for (const evName of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'wheel']) el.addEventListener(evName, stop);
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.onPick(id);
        });
        root.appendChild(el);
        this.tags.set(t.npcId, el);
      }
      if (el.textContent !== t.label) el.textContent = t.label;
      const on = t.npcId === highlight;
      el.style.left = `${Math.round(t.x)}px`;
      el.style.top = `${Math.round(t.y)}px`;
      el.style.display = 'block';
      el.style.color = on ? '#1a1206' : t.takenOver ? '#f6e7c1' : '#c9c0ab';
      el.style.background = on ? 'rgba(240,200,110,0.95)' : 'rgba(20,16,10,0.62)';
      el.style.border = on ? '1px solid #fff2c8' : '1px solid rgba(200,170,110,0.45)';
    }
    for (const [id, el] of this.tags) if (!seen.has(id)) el.style.display = 'none';
  }

  /** 世界脑关了 / 换场景：全收起（下次 update 再现） */
  hideAll(): void {
    for (const el of this.tags.values()) el.style.display = 'none';
  }

  destroy(): void {
    this.root?.remove();
    this.root = null;
    this.tags.clear();
  }
}
