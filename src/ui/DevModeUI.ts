import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import { UITheme } from './UITheme';
import { drawPanelBase, SKINS } from './PanelSkin';
import { createStyledText } from '../core/styledText';

export interface DevModeCallbacks {
  getCutsceneIds(): string[];
  playCutscene(id: string): void;
  /**
   * 开发模式可切换场景（id 用于 loadScene；name 来自各场景 JSON 的 name，供列表展示）
   */
  getScenes(): Promise<Array<{ id: string; name: string }>>;
  /** 进入指定场景（默认出生点） */
  loadScene(id: string): void;
  reload(): void;
  /** Minigames 列表 */
  getMinigameEntries(): Array<{ id: string; label: string; kind: 'water' | 'sugarWheel' | 'paperCraft' | 'objectExamine' }>;
  launchMinigame(entry: { id: string; label: string; kind: 'water' | 'sugarWheel' | 'paperCraft' | 'objectExamine' }): void;
  /**
   * 叙事编排跳转：列出所有可直接进入的叙事，点击后自动满足前置状态并进入对应场景。
   * `issues` = 冷启动预检发现的铺垫缺口（图/状态已改名或删除、只能一发直达等），
   * 非空即在菜单里标出来——坏掉的跳转点要在点进去之前就看得见。
   */
  getNarrativeWarps(): Array<{ id: string; label: string; issues?: string[] }>;
  enterNarrativeWarp(id: string): void;
  /**
   * 日夜现状：时刻/时段/天 + 本场景受日程管的 NPC 及其在场性。
   * `leaving` / `arriving` 是正在演离场/入场的实例 id——调「NPC 有没有当面消失」就看它。
   */
  getDayNightState(): {
    minutes: number;
    phase: string;
    day: number;
    phases: Array<{ id: string; label: string }>;
    sceneEnabled: boolean;
    leaving: string[];
    arriving: string[];
    managed: Array<{ id: string; present: boolean }>;
  };
  /** 推进时刻（分钟）；transition 由面板当前档决定。 */
  devAdvanceTime(minutes: number, transition: string): void;
  /** 推进到指定时段起点。 */
  devAdvanceTimeToPhase(phase: string, transition: string): void;
}

const CATEGORY_WIDTH = 178;
const HEADER_HEIGHT = 48;
const ITEM_HEIGHT = 36;
const SCROLL_SPEED = 30;
const TAB_H = 40;

export class DevModeUI {
  private renderer: Renderer;
  private callbacks: DevModeCallbacks;
  private container: Container;
  private _isOpen = false;
  private scrollY = 0;
  private maxScrollY = 0;
  private contentMask: Graphics | null = null;
  private contentContainer: Container | null = null;
  private boundWheel: ((e: WheelEvent) => void) | null = null;
  private section: 'cutscene' | 'scene' | 'minigames' | 'narrative' | 'daynight' = 'cutscene';
  /** 日夜面板当前的推进档；只影响调试按钮，不改任何数据。 */
  private devTransition: 'seamless' | 'timelapse' | 'fade' | 'cut' = 'seamless';
  /**
   * 日夜面板的轮询刷新：leaving/arriving 只在 NPC 走的那几秒存在，不轮询就盯不到。
   * 只在该分区开启，close/destroy 必清（生命周期对称）。
   */
  private dayNightTimer: ReturnType<typeof setInterval> | null = null;

  constructor(renderer: Renderer, callbacks: DevModeCallbacks) {
    this.renderer = renderer;
    this.callbacks = callbacks;
    this.container = new Container();
    this.container.visible = false;
    this.renderer.uiLayer.addChild(this.container);
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.scrollY = 0;
    this.section = 'cutscene';
    this.rebuild();
    this.container.visible = true;
    this.boundWheel = (e: WheelEvent) => this.onWheel(e);
    window.addEventListener('wheel', this.boundWheel, { passive: false });
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.container.visible = false;
    this.stopDayNightPolling();
    this.clearChildren();
    if (this.boundWheel) {
      window.removeEventListener('wheel', this.boundWheel);
      this.boundWheel = null;
    }
  }

  destroy(): void {
    this.close();
    this.stopDayNightPolling();
    if (this.container.parent) this.container.parent.removeChild(this.container);
    this.container.destroy({ children: true });
  }

  /**
   * 切分区的唯一入口：**轮询启停只能挂在这里**，不能放进 rebuild——
   * 轮询自身会调 rebuild，放进去等于每拍把定时器重置，永远不触发。
   */
  private setSection(s: 'cutscene' | 'scene' | 'minigames' | 'narrative' | 'daynight'): void {
    this.section = s;
    this.syncDayNightPolling();
    this.rebuild();
  }

  private stopDayNightPolling(): void {
    if (this.dayNightTimer !== null) {
      clearInterval(this.dayNightTimer);
      this.dayNightTimer = null;
    }
  }

  /** 进/离日夜分区时启停轮询。重复调用幂等（先停后起）。 */
  private syncDayNightPolling(): void {
    this.stopDayNightPolling();
    if (!this._isOpen || this.section !== 'daynight') return;
    this.dayNightTimer = setInterval(() => {
      // 面板被关掉/切走后残留的这一拍：自查后停表，不去动已清空的容器。
      if (!this._isOpen || this.section !== 'daynight') {
        this.stopDayNightPolling();
        return;
      }
      this.rebuild();
    }, 500);
  }

  private clearChildren(): void {
    if (this.contentMask) {
      this.contentMask.destroy();
      this.contentMask = null;
    }
    this.contentContainer = null;
    const removed = this.container.removeChildren();
    for (const child of removed) {
      child.destroy({ children: true });
    }
  }

  private rebuild(): void {
    this.clearChildren();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const pad = 40;
    const panelW = Math.min(sw - pad * 2, 800);
    const panelH = Math.min(sh - pad * 2, 660);
    const panelX = (sw - panelW) / 2;
    const panelY = (sh - panelH) / 2;

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlayDark });
    overlay.eventMode = 'static';
    this.container.addChild(overlay);

    const panel = new Graphics();
    drawPanelBase(panel, panelX, panelY, panelW, panelH, SKINS.panel);
    this.container.addChild(panel);

    const title = createStyledText({
      text: 'Dev Mode',
      style: {
        fontSize: 20,
        fill: UITheme.colors.title,
        fontFamily: UITheme.fonts.display,
        fontWeight: 'bold',
      },
    });
    title.x = panelX + 16;
    title.y = panelY + (HEADER_HEIGHT - title.height) / 2;
    this.container.addChild(title);

    const refreshBtn = this.makeButton('Reload', panelX + panelW - 100, panelY + 8, 84, 32, () => {
      this.callbacks.reload();
    });
    this.container.addChild(refreshBtn);

    const divider = new Graphics();
    divider.rect(panelX, panelY + HEADER_HEIGHT, panelW, 1);
    divider.fill(UITheme.colors.panelBorder);
    this.container.addChild(divider);

    const bodyY = panelY + HEADER_HEIGHT + 1;
    const bodyH = panelH - HEADER_HEIGHT - 1;

    const catBg = new Graphics();
    catBg.rect(panelX, bodyY, CATEGORY_WIDTH, bodyH);
    catBg.fill({ color: UITheme.colors.panelBgAlt, alpha: 0.8 });
    this.container.addChild(catBg);

    const tabY0 = bodyY + 8;
    this.container.addChild(this.makeSectionTab(
      'Cutscene', panelX, tabY0, this.section === 'cutscene', () => {
        this.setSection('cutscene');
      },
    ));
    this.container.addChild(this.makeSectionTab(
      '场景', panelX, tabY0 + TAB_H + 4, this.section === 'scene', () => {
        this.setSection('scene');
      },
    ));
    this.container.addChild(this.makeSectionTab(
      'Minigames', panelX, tabY0 + (TAB_H + 4) * 2, this.section === 'minigames', () => {
        this.setSection('minigames');
      },
    ));
    this.container.addChild(this.makeSectionTab(
      '叙事', panelX, tabY0 + (TAB_H + 4) * 3, this.section === 'narrative', () => {
        this.setSection('narrative');
      },
    ));
    this.container.addChild(this.makeSectionTab(
      '日夜', panelX, tabY0 + (TAB_H + 4) * 4, this.section === 'daynight', () => {
        this.setSection('daynight');
      },
    ));

    const catDivider = new Graphics();
    catDivider.rect(panelX + CATEGORY_WIDTH, bodyY, 1, bodyH);
    catDivider.fill(UITheme.colors.panelBorder);
    this.container.addChild(catDivider);

    const contentX = panelX + CATEGORY_WIDTH + 1;
    const contentW = panelW - CATEGORY_WIDTH - 1;
    if (this.section === 'cutscene') {
      this.buildCutsceneList(contentX, bodyY, contentW, bodyH);
    } else if (this.section === 'scene') {
      this.buildSceneList(contentX, bodyY, contentW, bodyH);
    } else if (this.section === 'narrative') {
      this.buildNarrativeList(contentX, bodyY, contentW, bodyH);
    } else if (this.section === 'daynight') {
      this.buildDayNightPanel(contentX, bodyY, contentW, bodyH);
    } else {
      this.buildMinigameList(contentX, bodyY, contentW, bodyH);
    }
  }

  /**
   * 日夜面板：看时刻/时段、按档推进、盯 NPC 有没有「当面消失」。
   *
   * 判据就是 `leaving` / `arriving` 两行——正在演离场的实例会列在那儿，
   * 且它此刻必须仍算「在场」；一旦看到某个 NPC 不在这两行里却已经不见了，就是穿帮。
   */
  private buildDayNightPanel(x: number, y: number, w: number, h: number): void {
    const st = this.callbacks.getDayNightState();

    this.contentMask = new Graphics();
    this.contentMask.rect(x, y, w, h);
    this.contentMask.fill(0xffffff);
    this.container.addChild(this.contentMask);

    this.contentContainer = new Container();
    this.contentContainer.mask = this.contentMask;
    this.container.addChild(this.contentContainer);

    const pad = 8;
    let cy = 0;

    const addLine = (text: string, dim = false): void => {
      const t = createStyledText({
        text,
        style: {
          fontSize: 14,
          fill: dim ? UITheme.colors.hint : UITheme.colors.body,
          fontFamily: UITheme.fonts.ui,
          wordWrap: true,
          wordWrapWidth: w - pad * 2,
          // 行距一律 lineHeight，禁 leading（量高比实绘矮半个 leading，末行会被裁）
          lineHeight: 18,
        },
      });
      t.x = x + pad;
      t.y = y + cy;
      this.contentContainer!.addChild(t);
      cy += Math.max(20, t.height + 4);
    };
    const addButton = (label: string, onClick: () => void): void => {
      const row = this.makeListItem(label, x + pad, y + cy, w - pad * 2, ITEM_HEIGHT, onClick);
      this.contentContainer!.addChild(row);
      cy += ITEM_HEIGHT + 2;
    };

    const hh = String(Math.floor(st.minutes / 60)).padStart(2, '0');
    const mm = String(st.minutes % 60).padStart(2, '0');
    addLine(`第 ${st.day} 天  ${hh}:${mm}  ·  时段 ${st.phase}`);
    addLine(
      st.sceneEnabled
        ? '本场景已开日夜（NPC 受日程管）'
        : '本场景未开日夜：时刻照走，但 NPC 不受日程管',
      !st.sceneEnabled,
    );
    cy += 6;

    addButton(`推进方式：${this.devTransition}（点此切换）`, () => {
      const order = ['seamless', 'timelapse', 'fade', 'cut'] as const;
      const i = order.indexOf(this.devTransition);
      this.devTransition = order[(i + 1) % order.length];
      this.rebuild();
    });
    addLine(
      this.devTransition === 'seamless'
        ? '无缝：NPC 会走到出口才隐去（看穿帮就用这档）'
        : '有画面遮挡：不演离场，直接重贴',
      true,
    );
    cy += 6;

    for (const mins of [30, 60, 180]) {
      addButton(`+${mins} 分钟`, () => {
        this.callbacks.devAdvanceTime(mins, this.devTransition);
        this.rebuild();
      });
    }
    for (const p of st.phases) {
      addButton(`跳到 ${p.label || p.id}`, () => {
        this.callbacks.devAdvanceTimeToPhase(p.id, this.devTransition);
        this.rebuild();
      });
    }

    cy += 8;
    addLine(`离场中 leaving：${st.leaving.length ? st.leaving.join('、') : '（无）'}`);
    addLine(`入场中 arriving：${st.arriving.length ? st.arriving.join('、') : '（无）'}`);
    cy += 4;
    if (st.managed.length === 0) {
      addLine('本场景没有受日程管的 NPC（没配 characterId 或没配日程表）', true);
    } else {
      addLine('受日程管的 NPC：');
      for (const m of st.managed) {
        addLine(`  ${m.id}  ${m.present ? '在场' : '不在场'}`, !m.present);
      }
    }

    this.maxScrollY = Math.max(0, cy - h);
    this.applyScroll();
  }

  private buildCutsceneList(x: number, y: number, w: number, h: number): void {
    const ids = this.callbacks.getCutsceneIds();

    this.contentMask = new Graphics();
    this.contentMask.rect(x, y, w, h);
    this.contentMask.fill(0xffffff);
    this.container.addChild(this.contentMask);

    this.contentContainer = new Container();
    this.contentContainer.mask = this.contentMask;
    this.container.addChild(this.contentContainer);

    const pad = 8;
    let cy = 0;

    if (ids.length === 0) {
      const empty = createStyledText({
        text: 'No cutscenes defined.',
        style: { fontSize: 14, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui },
      });
      empty.x = x + pad;
      empty.y = y + pad;
      this.contentContainer.addChild(empty);
      this.maxScrollY = 0;
      return;
    }

    for (const id of ids) {
      const row = this.makeListItem(id, x + pad, y + cy, w - pad * 2, ITEM_HEIGHT, () => {
        this.callbacks.playCutscene(id);
      });
      this.contentContainer.addChild(row);
      cy += ITEM_HEIGHT + 2;
    }

    const totalH = cy;
    this.maxScrollY = Math.max(0, totalH - h);
    this.applyScroll();
  }

  private buildMinigameList(x: number, y: number, w: number, h: number): void {
    const entries = this.callbacks.getMinigameEntries();

    this.contentMask = new Graphics();
    this.contentMask.rect(x, y, w, h);
    this.contentMask.fill(0xffffff);
    this.container.addChild(this.contentMask);

    this.contentContainer = new Container();
    this.contentContainer.mask = this.contentMask;
    this.container.addChild(this.contentContainer);

    const pad = 8;
    let cy = 0;

    if (entries.length === 0) {
      const empty = createStyledText({
        text: '未加载 water_minigames/index.json 或无条目。',
        style: { fontSize: 14, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui },
      });
      empty.x = x + pad;
      empty.y = y + pad;
      this.contentContainer.addChild(empty);
      this.maxScrollY = 0;
      return;
    }

    for (const entry of entries) {
      const prefix =
        entry.kind === 'sugarWheel' ? '[转盘] '
        : entry.kind === 'paperCraft' ? '[扎纸] '
        : entry.kind === 'objectExamine' ? '[检视] '
        : '[水域] ';
      const row = this.makeListItem(`${prefix}${entry.label}`, x + pad, y + cy, w - pad * 2, ITEM_HEIGHT, () => {
        this.callbacks.launchMinigame(entry);
      });
      this.contentContainer.addChild(row);
      cy += ITEM_HEIGHT + 2;
    }

    const totalH = cy;
    this.maxScrollY = Math.max(0, totalH - h);
    this.applyScroll();
  }

  private buildNarrativeList(x: number, y: number, w: number, h: number): void {
    const entries = this.callbacks.getNarrativeWarps();

    this.contentMask = new Graphics();
    this.contentMask.rect(x, y, w, h);
    this.contentMask.fill(0xffffff);
    this.container.addChild(this.contentMask);

    this.contentContainer = new Container();
    this.contentContainer.mask = this.contentMask;
    this.container.addChild(this.contentContainer);

    const pad = 8;
    let cy = 0;

    if (entries.length === 0) {
      const empty = createStyledText({
        text: '无叙事编排（缺 data/dev_narrative_warps.json）。',
        style: { fontSize: 14, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui },
      });
      empty.x = x + pad;
      empty.y = y + pad;
      this.contentContainer.addChild(empty);
      this.maxScrollY = 0;
      return;
    }

    for (const entry of entries) {
      // 预检有缺口的跳转点当场标出来（详情在 dev 错误面 / 控制台），别让人点进去才发现戏没铺到。
      const flaw = entry.issues?.length ?? 0;
      const label = flaw > 0 ? `⚠ ${entry.label}　缺口${flaw}` : entry.label;
      const row = this.makeListItem(label, x + pad, y + cy, w - pad * 2, ITEM_HEIGHT, () => {
        this.callbacks.enterNarrativeWarp(entry.id);
      });
      this.contentContainer.addChild(row);
      cy += ITEM_HEIGHT + 2;
    }

    const totalH = cy;
    this.maxScrollY = Math.max(0, totalH - h);
    this.applyScroll();
  }

  private buildSceneList(x: number, y: number, w: number, h: number): void {
    this.contentMask = new Graphics();
    this.contentMask.rect(x, y, w, h);
    this.contentMask.fill(0xffffff);
    this.container.addChild(this.contentMask);

    this.contentContainer = new Container();
    this.contentContainer.mask = this.contentMask;
    this.container.addChild(this.contentContainer);

    const pad = 8;
    const loading = createStyledText({
      text: '加载场景列表…',
      style: { fontSize: 14, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui },
    });
    loading.x = x + pad;
    loading.y = y + pad;
    this.contentContainer.addChild(loading);
    this.maxScrollY = 0;

    void (async () => {
      let entries: Array<{ id: string; name: string }>;
      try {
        entries = await this.callbacks.getScenes();
      } catch {
        entries = [];
      }
      if (!this._isOpen || this.section !== 'scene' || !this.contentContainer) return;

      const removed = this.contentContainer.removeChildren();
      for (const child of removed) child.destroy({ children: true });
      let cy = 0;

      if (entries.length === 0) {
        const empty = createStyledText({
          text: 'No scenes in list (check map_config / game_config).',
          style: { fontSize: 14, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui },
        });
        empty.x = x + pad;
        empty.y = y + pad;
        this.contentContainer.addChild(empty);
        this.maxScrollY = 0;
        return;
      }

      for (const { id, name } of entries) {
        const row = this.makeListItem(name, x + pad, y + cy, w - pad * 2, ITEM_HEIGHT, () => {
          this.callbacks.loadScene(id);
        });
        this.contentContainer.addChild(row);
        cy += ITEM_HEIGHT + 2;
      }

      const totalH = cy;
      this.maxScrollY = Math.max(0, totalH - h);
      this.applyScroll();
    })();
  }

  private makeListItem(
    text: string, x: number, y: number, w: number, h: number, onClick: () => void,
  ): Container {
    const item = new Container();

    const bg = new Graphics();
    bg.roundRect(0, 0, w, h, UITheme.panel.borderRadiusSmall);
    bg.fill({ color: UITheme.colors.rowBg, alpha: UITheme.alpha.rowBgLight });
    item.addChild(bg);

    const label = createStyledText({
      text,
      style: { fontSize: 14, fill: UITheme.colors.body, fontFamily: UITheme.fonts.ui },
    });
    label.x = 12;
    label.y = (h - label.height) / 2;
    item.addChild(label);

    const playIcon = createStyledText({
      text: '>>',
      style: { fontSize: 12, fill: UITheme.colors.subtle, fontFamily: UITheme.fonts.ui },
    });
    playIcon.x = w - playIcon.width - 12;
    playIcon.y = (h - playIcon.height) / 2;
    item.addChild(playIcon);

    item.x = x;
    item.y = y;
    item.eventMode = 'static';
    item.cursor = 'pointer';

    item.on('pointerover', () => {
      bg.clear();
      bg.roundRect(0, 0, w, h, UITheme.panel.borderRadiusSmall);
      bg.fill({ color: UITheme.colors.rowHover, alpha: UITheme.alpha.rowHover });
    });
    item.on('pointerout', () => {
      bg.clear();
      bg.roundRect(0, 0, w, h, UITheme.panel.borderRadiusSmall);
      bg.fill({ color: UITheme.colors.rowBg, alpha: UITheme.alpha.rowBgLight });
    });
    item.on('pointertap', onClick);

    const hitArea = new Graphics();
    hitArea.rect(0, 0, w, h);
    hitArea.fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
    item.addChildAt(hitArea, 0);

    return item;
  }

  private makeButton(
    text: string, x: number, y: number, w: number, h: number, onClick: () => void,
  ): Container {
    const btn = new Container();
    btn.x = x;
    btn.y = y;

    const bg = new Graphics();
    bg.roundRect(0, 0, w, h, UITheme.panel.borderRadiusSmall);
    bg.fill({ color: UITheme.colors.borderMid, alpha: 0.8 });
    btn.addChild(bg);

    const label = createStyledText({
      text,
      style: { fontSize: 13, fill: UITheme.colors.buttonText, fontFamily: UITheme.fonts.ui },
    });
    label.x = (w - label.width) / 2;
    label.y = (h - label.height) / 2;
    btn.addChild(label);

    btn.eventMode = 'static';
    btn.cursor = 'pointer';
    btn.on('pointerover', () => {
      bg.clear();
      bg.roundRect(0, 0, w, h, UITheme.panel.borderRadiusSmall);
      bg.fill({ color: UITheme.colors.borderActive, alpha: 0.9 });
    });
    btn.on('pointerout', () => {
      bg.clear();
      bg.roundRect(0, 0, w, h, UITheme.panel.borderRadiusSmall);
      bg.fill({ color: UITheme.colors.borderMid, alpha: 0.8 });
    });
    btn.on('pointertap', onClick);

    return btn;
  }

  private makeSectionTab(
    text: string, panelX: number, bodyY: number, active: boolean, onSelect: () => void,
  ): Container {
    const c = new Container();
    const h = TAB_H;
    const w = CATEGORY_WIDTH;

    const bg = new Graphics();
    bg.rect(0, 0, w, h);
    bg.fill({ color: active ? UITheme.colors.panelBg : UITheme.colors.panelBgAlt, alpha: active ? 1 : 0.5 });
    c.addChild(bg);

    const label = createStyledText({
      text,
      style: {
        fontSize: 14,
        fill: active ? UITheme.colors.title : UITheme.colors.subtle,
        fontFamily: UITheme.fonts.ui,
        fontWeight: active ? 'bold' : 'normal',
      },
    });
    label.x = 16;
    label.y = (h - label.height) / 2;
    c.addChild(label);

    c.x = panelX;
    c.y = bodyY;
    c.eventMode = 'static';
    c.cursor = 'pointer';
    c.on('pointertap', () => {
      if (!active) onSelect();
    });
    if (!active) {
      c.on('pointerover', () => {
        bg.clear();
        bg.rect(0, 0, w, h);
        bg.fill({ color: UITheme.colors.rowHover, alpha: 0.35 });
      });
      c.on('pointerout', () => {
        bg.clear();
        bg.rect(0, 0, w, h);
        bg.fill({ color: UITheme.colors.panelBgAlt, alpha: 0.5 });
      });
    }

    return c;
  }

  private onWheel(e: WheelEvent): void {
    if (!this._isOpen || !this.contentContainer) return;
    e.preventDefault();
    this.scrollY = Math.max(0, Math.min(this.maxScrollY, this.scrollY + (e.deltaY > 0 ? SCROLL_SPEED : -SCROLL_SPEED)));
    this.applyScroll();
  }

  private applyScroll(): void {
    if (!this.contentContainer) return;
    const items = this.contentContainer.children;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const baseY = (item as any).__baseY;
      if (baseY !== undefined) {
        item.y = baseY - this.scrollY;
      } else {
        (item as any).__baseY = item.y;
        item.y -= this.scrollY;
      }
    }
  }
}
