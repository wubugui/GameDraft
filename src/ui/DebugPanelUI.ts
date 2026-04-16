import './debug-panel-dock.css';
import type { FlagStore } from '../core/FlagStore';
import type { EventBus } from '../core/EventBus';
import type { InputManager } from '../core/InputManager';
import { createDebugFlagSection, type DebugFlagSectionHandle } from './debugFlagSection';

/** 可注册的 debug 区块内容：纯文本或带操作按钮 */
export type DebugSectionContent =
  | string
  | { text: string; actions?: { label: string; fn: () => void }[] };

/** 用于外部注册 debug 区块的 API */
export interface IDebugPanelAPI {
  addSection(id: string, getter: () => DebugSectionContent): void;
  removeSection(id: string): void;
  log(message: string): void;
  clearLogs(): void;
  refresh(): void;
}

const LOG_MAX_LINES = 50;

const TAB_SYSTEM = 'system';
const TAB_TOOLS = 'tools';
const TAB_NARRATIVE = 'narrative';
const TAB_FLAGS = 'flags';
const TAB_LOG = 'log';

/** 与 DebugTools.setupDebugPanelSections 注册的区块 id 一致 */
export const NARRATIVE_DEBUG_SECTION_ID = '叙事调试';

type TabId =
  | typeof TAB_SYSTEM
  | typeof TAB_TOOLS
  | typeof TAB_NARRATIVE
  | typeof TAB_FLAGS
  | typeof TAB_LOG;

export class DebugPanelUI implements IDebugPanelAPI {
  private systemInfoProvider?: () => {
    fps?: number; sceneId?: string; state?: string; worldWidth?: number; worldHeight?: number;
    /** 深度遮挡启用时：当前运行时的 floor_offset（可被 Action 等改写） */
    floorOffsetRuntime?: number;
    /** 当前场景 depthConfig 中的原始 floor_offset；无配置时为 undefined */
    floorOffsetFromScene?: number;
    depthOcclusionEnabled?: boolean;
  };
  private sections = new Map<string, () => DebugSectionContent>();
  private logLines: string[] = [];
  private _isOpen = false;
  /** 当前选中的标签（用于系统页实时刷新） */
  private activeTab: TabId = TAB_TOOLS;
  /** 系统信息 `<pre>`，复用节点只改 textContent */
  private systemStatsPre: HTMLPreElement | null = null;
  private systemLiveRafId: number | null = null;

  private root: HTMLElement;
  private panelSystem: HTMLElement;
  private panelTools: HTMLElement;
  private panelNarrative: HTMLElement;
  private panelFlags: HTMLElement;
  private panelLog: HTMLElement;
  private logPre: HTMLElement;
  private tabButtons: Map<TabId, HTMLButtonElement> = new Map();
  private flagSectionHandle: DebugFlagSectionHandle | null = null;
  private readonly inputManager?: InputManager;

  constructor(
    systemInfoProvider?: () => {
      fps?: number; sceneId?: string; state?: string; worldWidth?: number; worldHeight?: number;
      floorOffsetRuntime?: number; floorOffsetFromScene?: number; depthOcclusionEnabled?: boolean;
    },
    inputManager?: InputManager,
  ) {
    this.systemInfoProvider = systemInfoProvider;
    this.inputManager = inputManager;

    const shell = document.getElementById('app-shell');
    let dock = document.getElementById('debug-dock');
    if (!dock) {
      dock = document.createElement('aside');
      dock.id = 'debug-dock';
      if (shell) shell.appendChild(dock);
      else document.body.appendChild(dock);
    }
    this.root = dock;
    this.root.setAttribute('aria-label', 'Debug panel');

    const header = document.createElement('header');
    header.className = 'debug-dock__header';

    const titleWrap = document.createElement('div');
    const h = document.createElement('h2');
    h.className = 'debug-dock__title';
    h.textContent = 'Debug';
    titleWrap.appendChild(h);
    const hint = document.createElement('span');
    hint.className = 'debug-dock__hint';
    hint.textContent = 'F2';
    titleWrap.appendChild(hint);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'debug-dock__close';
    closeBtn.textContent = '收起';
    closeBtn.addEventListener('click', () => this.close());

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);

    const tabBar = document.createElement('div');
    tabBar.className = 'debug-dock__tabs';
    tabBar.setAttribute('role', 'tablist');

    const mkTab = (id: TabId, label: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'debug-dock__tab';
      b.textContent = label;
      b.setAttribute('role', 'tab');
      b.dataset.tab = id;
      b.addEventListener('click', () => this.selectTab(id));
      tabBar.appendChild(b);
      this.tabButtons.set(id, b);
    };
    mkTab(TAB_SYSTEM, '系统');
    mkTab(TAB_TOOLS, '工具');
    mkTab(TAB_NARRATIVE, '叙事调试');
    mkTab(TAB_FLAGS, 'Flag');
    mkTab(TAB_LOG, '日志');

    const panels = document.createElement('div');
    panels.className = 'debug-dock__panels';

    this.panelSystem = this.mkPanel('system-panel');
    this.panelTools = this.mkPanel('tools-panel');
    this.panelNarrative = this.mkPanel('narrative-panel');
    this.panelFlags = this.mkPanel('flags-panel');
    this.panelLog = this.mkPanel('log-panel');

    const logScroll = document.createElement('div');
    logScroll.className = 'debug-dock__scroll';
    this.logPre = document.createElement('pre');
    this.logPre.className = 'debug-dock__log';
    logScroll.appendChild(this.logPre);

    const logBar = document.createElement('div');
    logBar.className = 'debug-dock__log-tools';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'debug-dock__btn debug-dock__btn--danger';
    clearBtn.textContent = '清空日志';
    clearBtn.addEventListener('click', () => this.clearLogs());
    logBar.appendChild(clearBtn);

    this.panelLog.appendChild(logScroll);
    this.panelLog.appendChild(logBar);

    panels.appendChild(this.panelSystem);
    panels.appendChild(this.panelTools);
    panels.appendChild(this.panelNarrative);
    panels.appendChild(this.panelFlags);
    panels.appendChild(this.panelLog);

    this.root.appendChild(header);
    this.root.appendChild(tabBar);
    this.root.appendChild(panels);

    this.selectTab(TAB_TOOLS);
  }

  private mkPanel(id: string): HTMLElement {
    const p = document.createElement('div');
    p.className = 'debug-dock__panel';
    p.id = id;
    p.setAttribute('role', 'tabpanel');
    return p;
  }

  private selectTab(id: TabId): void {
    this.activeTab = id;
    for (const [tid, btn] of this.tabButtons) {
      const on = tid === id;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    this.panelSystem.classList.toggle('is-active', id === TAB_SYSTEM);
    this.panelTools.classList.toggle('is-active', id === TAB_TOOLS);
    this.panelNarrative.classList.toggle('is-active', id === TAB_NARRATIVE);
    this.panelFlags.classList.toggle('is-active', id === TAB_FLAGS);
    this.panelLog.classList.toggle('is-active', id === TAB_LOG);
    this.updateSystemLiveLoop();
  }

  /** 打开且停在「系统」标签时，每帧刷新 FPS 等；切走或收起则停止 */
  private updateSystemLiveLoop(): void {
    if (this.systemLiveRafId != null) {
      cancelAnimationFrame(this.systemLiveRafId);
      this.systemLiveRafId = null;
    }
    if (!this._isOpen || this.activeTab !== TAB_SYSTEM || !this.systemInfoProvider) return;

    this.renderSystem();
    const tick = (): void => {
      this.systemLiveRafId = null;
      if (!this._isOpen || this.activeTab !== TAB_SYSTEM || !this.systemInfoProvider) return;
      this.renderSystem();
      this.systemLiveRafId = requestAnimationFrame(tick);
    };
    this.systemLiveRafId = requestAnimationFrame(tick);
  }

  /** 挂载 Flag 调试（登记表键 + 可搜索 + 收藏写入 editor_data/debug_flag_favorites.json）；在 loadFlagRegistry 之后调用一次 */
  attachFlagDebug(flagStore: FlagStore, eventBus: EventBus): void {
    if (this.flagSectionHandle) return;
    this.flagSectionHandle = createDebugFlagSection(flagStore, eventBus, (m) => this.log(m));
    if (this._isOpen) this.render();
  }

  setSystemInfoProvider(provider: () => {
    fps?: number; sceneId?: string; state?: string; worldWidth?: number; worldHeight?: number;
    floorOffsetRuntime?: number; floorOffsetFromScene?: number; depthOcclusionEnabled?: boolean;
  }): void {
    this.systemInfoProvider = provider;
    if (this._isOpen) {
      this.render();
      this.updateSystemLiveLoop();
    }
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  open(): void {
    if (this._isOpen) return;
    this.inputManager?.setGameKeyboardBlocked(true);
    this._isOpen = true;
    this.root.classList.add('is-open');
    this.root.setAttribute('aria-hidden', 'false');
    this.render();
    this.flagSectionHandle?.syncFavoritesFromFile();
    this.updateSystemLiveLoop();
  }

  close(): void {
    if (!this._isOpen) return;
    if (this.systemLiveRafId != null) {
      cancelAnimationFrame(this.systemLiveRafId);
      this.systemLiveRafId = null;
    }
    this._isOpen = false;
    this.inputManager?.setGameKeyboardBlocked(false);
    this.root.classList.remove('is-open');
    this.root.setAttribute('aria-hidden', 'true');
    this.clearPanelBodies();
  }

  addSection(id: string, getter: () => DebugSectionContent): void {
    this.sections.set(id, getter);
    if (this._isOpen) this.render();
  }

  removeSection(id: string): void {
    this.sections.delete(id);
    if (this._isOpen) this.render();
  }

  log(message: string): void {
    this.logLines.push(message);
    if (this.logLines.length > LOG_MAX_LINES) this.logLines.shift();
    if (this._isOpen) this.renderLogOnly();
  }

  clearLogs(): void {
    this.logLines = [];
    if (this._isOpen) this.renderLogOnly();
  }

  refresh(): void {
    if (this._isOpen) this.render();
  }

  private clearPanelBodies(): void {
    this.systemStatsPre = null;
    this.panelSystem.replaceChildren();
    this.panelTools.replaceChildren();
    this.panelNarrative.replaceChildren();
    this.panelFlags.replaceChildren();
    this.logPre.textContent = '';
  }

  private renderLogOnly(): void {
    this.logPre.textContent = this.logLines.slice(-80).join('\n') || '(empty)';
  }

  private render(): void {
    this.renderSystem();
    this.renderTools();
    this.renderNarrative();
    this.renderFlags();
    this.renderLogOnly();
  }

  private renderSystem(): void {
    if (!this.systemInfoProvider) {
      this.systemStatsPre = null;
      this.panelSystem.replaceChildren();
      const scroll = document.createElement('div');
      scroll.className = 'debug-dock__scroll';
      scroll.appendChild(this.p('无系统信息。'));
      this.panelSystem.appendChild(scroll);
      return;
    }

    const info = this.systemInfoProvider();
    const lines: string[] = [];
    if (info.fps != null) lines.push(`FPS: ${Math.round(info.fps)}`);
    if (info.sceneId) lines.push(`Scene: ${info.sceneId}`);
    if (info.state) lines.push(`State: ${info.state}`);
    if (info.worldWidth != null) lines.push(`worldWidth: ${info.worldWidth}`);
    if (info.worldHeight != null) lines.push(`worldHeight: ${info.worldHeight}`);
    if (info.depthOcclusionEnabled && info.floorOffsetRuntime != null) {
      const cfg = info.floorOffsetFromScene;
      const r = Number(info.floorOffsetRuntime);
      const cfgStr = cfg != null ? Number(cfg).toFixed(4) : '—';
      lines.push(
        `floor_offset（运行）: ${r.toFixed(4)}（场景配置: ${cfgStr}）`,
      );
    } else {
      lines.push('floor_offset: （当前场景未启用深度遮挡）');
    }
    const text = lines.length === 0 ? '（暂无）' : lines.join('\n');

    let pre = this.systemStatsPre;
    const scrollEl = pre?.parentElement;
    if (!pre || !scrollEl || scrollEl.parentElement !== this.panelSystem) {
      this.panelSystem.replaceChildren();
      const scroll = document.createElement('div');
      scroll.className = 'debug-dock__scroll';
      pre = document.createElement('pre');
      pre.className = 'debug-dock__pre';
      scroll.appendChild(pre);
      this.panelSystem.appendChild(scroll);
      this.systemStatsPre = pre;
    }
    pre.textContent = text;
  }

  /** @returns 实际渲染的区块数量 */
  private appendSectionBlocks(
    scroll: HTMLElement,
    predicate: (id: string) => boolean,
  ): number {
    let count = 0;
    for (const [id, getter] of this.sections) {
      if (!predicate(id)) continue;
      count++;
      try {
        const data = getter();
        const text = typeof data === 'string' ? data : data.text;
        const actions = typeof data === 'string' ? undefined : data.actions;

        const sec = document.createElement('section');
        sec.className = 'debug-dock__section';

        const st = document.createElement('h3');
        st.className = 'debug-dock__section-title';
        st.textContent = id;
        sec.appendChild(st);

        const pre = document.createElement('pre');
        pre.className = 'debug-dock__pre';
        pre.textContent = text;
        sec.appendChild(pre);

        if (actions && actions.length > 0) {
          const row = document.createElement('div');
          row.className = 'debug-dock__actions';
          for (const a of actions) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'debug-dock__btn';
            btn.textContent = a.label;
            btn.addEventListener('click', () => {
              try {
                a.fn();
                this.refresh();
              } catch (e) {
                this.log(`Error: ${String(e)}`);
              }
            });
            row.appendChild(btn);
          }
          sec.appendChild(row);
        }
        scroll.appendChild(sec);
      } catch (e) {
        const err = document.createElement('p');
        err.className = 'debug-dock__err';
        err.textContent = `[${id}] ${String(e)}`;
        scroll.appendChild(err);
      }
    }
    return count;
  }

  private renderTools(): void {
    this.panelTools.replaceChildren();
    const column = document.createElement('div');
    column.className = 'debug-dock__tools-column';

    const scroll = document.createElement('div');
    scroll.className = 'debug-dock__scroll';

    if (this.sections.size === 0) {
      scroll.appendChild(this.p('未注册调试区块。'));
    } else {
      const n = this.appendSectionBlocks(scroll, (id) => id !== NARRATIVE_DEBUG_SECTION_ID);
      if (n === 0) {
        scroll.appendChild(this.p('（此页暂无工具项；叙事调试与 Flag 已单独分页。）'));
      }
    }
    column.appendChild(scroll);
    this.panelTools.appendChild(column);
  }

  private renderNarrative(): void {
    this.panelNarrative.replaceChildren();
    const scroll = document.createElement('div');
    scroll.className = 'debug-dock__scroll';
    const n = this.appendSectionBlocks(scroll, (id) => id === NARRATIVE_DEBUG_SECTION_ID);
    if (n === 0) {
      scroll.appendChild(this.p('（未注册叙事调试区块）'));
    }
    this.panelNarrative.appendChild(scroll);
  }

  private renderFlags(): void {
    this.panelFlags.replaceChildren();
    const scroll = document.createElement('div');
    scroll.className = 'debug-dock__scroll';
    if (this.flagSectionHandle) {
      scroll.appendChild(this.flagSectionHandle.root);
    } else {
      scroll.appendChild(this.p('（Flag 调试未挂载，需在加载 Flag 登记表之后打开面板）'));
    }
    this.panelFlags.appendChild(scroll);
  }

  private p(text: string): HTMLParagraphElement {
    const el = document.createElement('p');
    el.className = 'debug-dock__pre';
    el.textContent = text;
    return el;
  }

  destroy(): void {
    if (this.systemLiveRafId != null) {
      cancelAnimationFrame(this.systemLiveRafId);
      this.systemLiveRafId = null;
    }
    this.flagSectionHandle?.destroy();
    this.flagSectionHandle = null;
    this.close();
    this.sections.clear();
    this.logLines = [];
    this.root.replaceChildren();
    this.root.classList.remove('is-open');
  }
}
