import './debug-panel-dock.css';
import type { FlagStore } from '../core/FlagStore';
import type { EventBus } from '../core/EventBus';
import type { InputManager } from '../core/InputManager';
import { createDebugFlagSection, type DebugFlagSectionHandle } from './debugFlagSection';

/** 可注册的 debug 区块内容：纯文本或带操作按钮；可选附加 DOM（如滑条） */
export type DebugSectionContent =
  | string
  | {
      text: string;
      /** noRefresh=true：点击后不重渲染整段（避免重建滑条/复位）；由按钮自行就地更新显示 */
      actions?: { label: string; fn: () => void; noRefresh?: boolean }[];
      /** 排在按钮行之后；勿在 input 回调里调用 refresh()，否则拖拽会中断 */
      extra?: HTMLElement;
    };

/** 用于外部注册 debug 区块的 API */
export interface IDebugPanelAPI {
  addSection(id: string, getter: () => DebugSectionContent): void;
  removeSection(id: string): void;
  log(message: string): void;
  clearLogs(): void;
  refresh(): void;
}

const LOG_MAX_LINES = 50;

const TAB_QUICK = 'quick';
const TAB_SYSTEM = 'system';
const TAB_TOOLS = 'tools';
const TAB_NARRATIVE = 'narrative';
const TAB_FLAGS = 'flags';
const TAB_LOG = 'log';

/** 与 DebugTools.setupDebugPanelSections 注册的区块 id 一致 */
export const NARRATIVE_DEBUG_SECTION_ID = '叙事调试';

/** pin 持久化：与 Flag 收藏一致，只走工程文件（dev 服 API 写
 * resources/editor_projects/editor_data/debug_dock_pins.json）——退出游戏/重启机器/换端口换浏览器都在。
 * 不使用 localStorage（按 origin 隔离且编辑器内嵌 WebEngine 可能不落盘，会"失忆"）。 */
const PINS_API = '/__gamedraft-api/debug-dock-pins';

/** 画面常驻卡的低频自刷间隔（按住指针时暂停，避免拖滑条被重建打断） */
const SCREEN_PINS_REFRESH_MS = 1000;

type TabId =
  | typeof TAB_QUICK
  | typeof TAB_SYSTEM
  | typeof TAB_TOOLS
  | typeof TAB_NARRATIVE
  | typeof TAB_FLAGS
  | typeof TAB_LOG;

/** 区块渲染上下文：tools 默认折叠；其余默认展开。screen=游戏画面常驻卡（只有 ✕ 取消常驻） */
type SectionContext = 'tools' | 'narrative' | 'quick' | 'screen';

function normalizePinList(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return [...new Set(data.map((x) => String(x)).filter(Boolean))].slice(0, 64);
}

/** 系统页实时信息（F2「系统」标签）。 */
interface SystemInfo {
  fps?: number; sceneId?: string; state?: string; worldWidth?: number; worldHeight?: number;
  /** 深度遮挡启用时：当前运行时的 floor_offset（可被 Action 等改写） */
  floorOffsetRuntime?: number;
  /** 当前场景 depthConfig 中的原始 floor_offset；无配置时为 undefined */
  floorOffsetFromScene?: number;
  depthOcclusionEnabled?: boolean;
  /** 当前生效气味 + 两层来源（标记 action / zone 谁在生效）。 */
  smell?: {
    source: 'action' | 'zone' | 'none';
    actionScent: string; actionIntensity: number;
    zoneScent: string; zoneIntensity: number;
    effectiveScent: string;
  };
}
type SystemInfoProvider = () => SystemInfo;

export class DebugPanelUI implements IDebugPanelAPI {
  private systemInfoProvider?: SystemInfoProvider;
  private sections = new Map<string, () => DebugSectionContent>();
  private logLines: string[] = [];
  private _isOpen = false;
  /** 当前选中的标签（用于系统页实时刷新） */
  private activeTab: TabId = TAB_TOOLS;
  /** 系统信息 `<pre>`，复用节点只改 textContent */
  private systemStatsPre: HTMLPreElement | null = null;
  private systemLiveRafId: number | null = null;

  /** 钉到「快捷」页 / 常驻到游戏画面的区块 id（工程文件持久化，Set 顺序即渲染顺序） */
  private quickPins = new Set<string>();
  private screenPins = new Set<string>();
  /** 各上下文区块展开状态（键 `${ctx}:${id}`）；tools 上下文关面板即清 → 每次打开默认折叠 */
  private sectionOpenState = new Map<string, boolean>();

  private root: HTMLElement;
  private panelQuick: HTMLElement;
  private panelSystem: HTMLElement;
  private panelTools: HTMLElement;
  private panelNarrative: HTMLElement;
  private panelFlags: HTMLElement;
  private panelLog: HTMLElement;
  private logPre: HTMLElement;
  private tabButtons: Map<TabId, HTMLButtonElement> = new Map();
  private flagSectionHandle: DebugFlagSectionHandle | null = null;
  private readonly inputManager?: InputManager;

  /** 游戏画面常驻卡容器（挂 #game-mount，F2 收起也显示） */
  private screenOverlay: HTMLElement;
  private screenOverlayTimer: number | null = null;
  private screenOverlayPointerDown = false;
  private screenOverlayPointerUpHandler: () => void = () => {};

  constructor(
    systemInfoProvider?: SystemInfoProvider,
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
    mkTab(TAB_QUICK, '快捷');
    mkTab(TAB_SYSTEM, '系统');
    mkTab(TAB_TOOLS, '工具');
    mkTab(TAB_NARRATIVE, '叙事调试');
    mkTab(TAB_FLAGS, 'Flag');
    mkTab(TAB_LOG, '日志');

    const panels = document.createElement('div');
    panels.className = 'debug-dock__panels';

    this.panelQuick = this.mkPanel('quick-panel');
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

    panels.appendChild(this.panelQuick);
    panels.appendChild(this.panelSystem);
    panels.appendChild(this.panelTools);
    panels.appendChild(this.panelNarrative);
    panels.appendChild(this.panelFlags);
    panels.appendChild(this.panelLog);

    this.root.appendChild(header);
    this.root.appendChild(tabBar);
    this.root.appendChild(panels);

    // 画面常驻卡容器：与 dock 独立，收起 F2 也显示；无 pin 时整体隐藏不挡画面
    let overlay = document.getElementById('debug-screen-pins');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'debug-screen-pins';
      (document.getElementById('game-mount') ?? document.body).appendChild(overlay);
    }
    this.screenOverlay = overlay;
    this.screenOverlay.addEventListener('pointerdown', () => {
      this.screenOverlayPointerDown = true;
    });
    this.screenOverlayPointerUpHandler = () => {
      this.screenOverlayPointerDown = false;
    };
    window.addEventListener('pointerup', this.screenOverlayPointerUpHandler);
    window.addEventListener('pointercancel', this.screenOverlayPointerUpHandler);

    // pin 从工程文件异步载入；有快捷钉选时 syncPinsFromFile 会把默认页切到「快捷」
    this.selectTab(TAB_TOOLS);
    void this.syncPinsFromFile();
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
    this.panelQuick.classList.toggle('is-active', id === TAB_QUICK);
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

  /** 挂载 Flag 调试（登记表键 + 可搜索 + 收藏写入 resources/editor_projects/editor_data/debug_flag_favorites.json）；在 loadFlagRegistry 之后调用一次 */
  attachFlagDebug(flagStore: FlagStore, eventBus: EventBus): void {
    if (this.flagSectionHandle) return;
    this.flagSectionHandle = createDebugFlagSection(flagStore, eventBus, (m) => this.log(m));
    if (this._isOpen) this.render();
  }

  setSystemInfoProvider(provider: SystemInfoProvider): void {
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
    void this.syncPinsFromFile();
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
    // 工具页折叠状态不跨开合：下次打开一律回到默认折叠
    for (const k of [...this.sectionOpenState.keys()]) {
      if (k.startsWith('tools:')) this.sectionOpenState.delete(k);
    }
  }

  addSection(id: string, getter: () => DebugSectionContent): void {
    this.sections.set(id, getter);
    if (this._isOpen) this.render();
    this.renderScreenPins();
  }

  removeSection(id: string): void {
    this.sections.delete(id);
    if (this._isOpen) this.render();
    this.renderScreenPins();
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
    this.renderScreenPins();
  }

  private clearPanelBodies(): void {
    this.systemStatsPre = null;
    this.panelQuick.replaceChildren();
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
    this.renderQuick();
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
    if (info.smell) {
      const sm = info.smell;
      const srcLabel = sm.source === 'action' ? 'action（生效）' : sm.source === 'zone' ? 'zone（生效）' : '无味';
      lines.push('—— 气味 ——');
      lines.push(`生效来源: ${srcLabel}`);
      const aStr = sm.actionScent ? `${sm.actionScent}(${sm.actionIntensity})` : '—';
      const zStr = sm.zoneScent ? `${sm.zoneScent}(${sm.zoneIntensity})` : '—';
      const aMark = sm.source === 'action' ? ' ←生效' : '';
      const zMark = sm.source === 'zone' ? ' ←生效' : (sm.actionScent && sm.zoneScent ? '（被 action 压住）' : '');
      lines.push(`  action 层: ${aStr}${aMark}`);
      lines.push(`  zone 层:   ${zStr}${zMark}`);
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

  // ---- 区块渲染（折叠 + pin） ---------------------------------------------

  /** pin 到「快捷」页 / 游戏画面（写入工程文件 debug_dock_pins.json，重启游戏仍生效） */
  private toggleQuickPin(id: string): void {
    if (this.quickPins.has(id)) this.quickPins.delete(id);
    else this.quickPins.add(id);
    this.persistPins();
    this.refresh();
  }

  private toggleScreenPin(id: string): void {
    if (this.screenPins.has(id)) this.screenPins.delete(id);
    else this.screenPins.add(id);
    this.persistPins();
    this.syncScreenOverlayTimer();
    this.refresh();
  }

  private persistPins(): void {
    if (!import.meta.env.DEV) {
      this.log('调试 pin 仅能在 npm run dev 时写入 resources/editor_projects/editor_data/debug_dock_pins.json（本次仅内存生效）');
      return;
    }
    const body = JSON.stringify({ quick: [...this.quickPins], screen: [...this.screenPins] });
    void (async () => {
      try {
        const r = await fetch(PINS_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } catch (e) {
        this.log(`调试 pin 保存失败（仅本次会话生效；dev server 太旧请重启）: ${String(e)}`);
      }
    })();
  }

  /** 从工程文件同步 pin（debug_dock_pins.json，重启游戏/跨端口跨浏览器都在）；构造与每次打开面板时各拉一次。 */
  private async syncPinsFromFile(): Promise<void> {
    if (!import.meta.env.DEV) return;
    try {
      const r = await fetch(PINS_API);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: unknown = await r.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      const rec = data as { quick?: unknown; screen?: unknown };
      // 文件还不存在时开发服返回 {}：无记忆可载
      if (rec.quick === undefined && rec.screen === undefined) return;
      this.quickPins = new Set(normalizePinList(rec.quick));
      this.screenPins = new Set(normalizePinList(rec.screen));
      this.syncScreenOverlayTimer();
      if (!this._isOpen && this.quickPins.size > 0) this.selectTab(TAB_QUICK);
      this.refresh();
    } catch (e) {
      this.log(`调试 pin 读取失败（dev server 太旧请重启）: ${String(e)}`);
    }
  }

  private buildPinButtons(id: string, ctx: SectionContext): HTMLElement {
    const row = document.createElement('span');
    row.className = 'debug-dock__section-pins';
    const mk = (label: string, title: string, on: boolean, fn: () => void): void => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'debug-dock__pin-btn' + (on ? ' is-on' : '');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', (ev) => {
        // summary 内的点击默认会折叠/展开区块
        ev.preventDefault();
        ev.stopPropagation();
        fn();
      });
      row.appendChild(b);
    };
    if (ctx === 'screen') {
      mk('✕', '从游戏画面移除该常驻卡', false, () => this.toggleScreenPin(id));
      return row;
    }
    const inQuick = this.quickPins.has(id);
    mk('★', inQuick ? '从「快捷」页移除' : '钉到「快捷」页', inQuick, () => this.toggleQuickPin(id));
    const onScreen = this.screenPins.has(id);
    mk('📌', onScreen ? '取消游戏画面常驻' : '常驻到游戏画面（F2 收起也显示）', onScreen, () => this.toggleScreenPin(id));
    return row;
  }

  /** 渲染单个区块为可折叠 <details>；ctx 决定默认展开与 pin 按钮形态 */
  private buildSectionBlock(id: string, getter: () => DebugSectionContent, ctx: SectionContext): HTMLElement {
    const details = document.createElement('details');
    details.className = 'debug-dock__section';
    if (ctx === 'screen') details.classList.add('debug-screen-pins__card');
    const stateKey = `${ctx}:${id}`;
    details.open = this.sectionOpenState.get(stateKey) ?? ctx !== 'tools';
    details.addEventListener('toggle', () => {
      this.sectionOpenState.set(stateKey, details.open);
    });

    const summary = document.createElement('summary');
    summary.className = 'debug-dock__section-title';
    const titleText = document.createElement('span');
    titleText.className = 'debug-dock__section-title-text';
    titleText.textContent = id;
    summary.appendChild(titleText);
    summary.appendChild(this.buildPinButtons(id, ctx));
    details.appendChild(summary);

    try {
      const data = getter();
      const text = typeof data === 'string' ? data : data.text;
      const actions = typeof data === 'string' ? undefined : data.actions;
      const extra = typeof data === 'string' ? undefined : data.extra;

      if (text) {
        const pre = document.createElement('pre');
        pre.className = 'debug-dock__pre';
        pre.textContent = text;
        details.appendChild(pre);
      }

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
              if (!a.noRefresh) this.refresh();
            } catch (e) {
              this.log(`Error: ${String(e)}`);
            }
          });
          row.appendChild(btn);
        }
        details.appendChild(row);
      }
      if (extra) details.appendChild(extra);
    } catch (e) {
      const err = document.createElement('p');
      err.className = 'debug-dock__err';
      err.textContent = `[${id}] ${String(e)}`;
      details.appendChild(err);
    }
    return details;
  }

  /** @returns 实际渲染的区块数量 */
  private appendSectionBlocks(
    scroll: HTMLElement,
    predicate: (id: string) => boolean,
    ctx: SectionContext,
  ): number {
    let count = 0;
    for (const [id, getter] of this.sections) {
      if (!predicate(id)) continue;
      count++;
      scroll.appendChild(this.buildSectionBlock(id, getter, ctx));
    }
    return count;
  }

  private renderQuick(): void {
    this.panelQuick.replaceChildren();
    const scroll = document.createElement('div');
    scroll.className = 'debug-dock__scroll';
    const hint = document.createElement('p');
    hint.className = 'debug-dock__quick-hint';
    hint.textContent = '区块标题右侧：「★」钉到本页；「📌」常驻到游戏画面（F2 收起也显示）。';
    scroll.appendChild(hint);
    let n = 0;
    for (const id of this.quickPins) {
      const getter = this.sections.get(id);
      if (!getter) continue; // pin 的区块本次会话未注册（如非 dev 模式）：保留 pin 不渲染
      scroll.appendChild(this.buildSectionBlock(id, getter, 'quick'));
      n++;
    }
    if (n === 0) {
      scroll.appendChild(this.p('（暂无钉选。去「工具」等页点区块标题右侧的「★」。）'));
    }
    this.panelQuick.appendChild(scroll);
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
      const n = this.appendSectionBlocks(scroll, (id) => id !== NARRATIVE_DEBUG_SECTION_ID, 'tools');
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
    const n = this.appendSectionBlocks(scroll, (id) => id === NARRATIVE_DEBUG_SECTION_ID, 'narrative');
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

  // ---- 游戏画面常驻卡（📌） -------------------------------------------------

  /** 无论 F2 开合都渲染；无 pin（或 pin 的区块未注册）时整体隐藏不挡画面 */
  private renderScreenPins(): void {
    const frag = document.createDocumentFragment();
    let n = 0;
    for (const id of this.screenPins) {
      const getter = this.sections.get(id);
      if (!getter) continue;
      frag.appendChild(this.buildSectionBlock(id, getter, 'screen'));
      n++;
    }
    this.screenOverlay.replaceChildren(frag);
    this.screenOverlay.classList.toggle('is-visible', n > 0);
  }

  /** 有画面常驻卡时低频自刷读数；按住指针时暂停，避免拖滑条被 DOM 重建打断 */
  private syncScreenOverlayTimer(): void {
    const want = this.screenPins.size > 0;
    if (want && this.screenOverlayTimer == null) {
      this.screenOverlayTimer = window.setInterval(() => {
        if (this.screenOverlayPointerDown) return;
        this.renderScreenPins();
      }, SCREEN_PINS_REFRESH_MS);
    } else if (!want && this.screenOverlayTimer != null) {
      clearInterval(this.screenOverlayTimer);
      this.screenOverlayTimer = null;
    }
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
    if (this.screenOverlayTimer != null) {
      clearInterval(this.screenOverlayTimer);
      this.screenOverlayTimer = null;
    }
    window.removeEventListener('pointerup', this.screenOverlayPointerUpHandler);
    window.removeEventListener('pointercancel', this.screenOverlayPointerUpHandler);
    this.screenOverlay.replaceChildren();
    this.screenOverlay.remove();
    this.flagSectionHandle?.destroy();
    this.flagSectionHandle = null;
    this.close();
    this.sections.clear();
    this.sectionOpenState.clear();
    this.logLines = [];
    this.root.replaceChildren();
    this.root.classList.remove('is-open');
  }
}
