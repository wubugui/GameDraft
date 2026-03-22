import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';

/** 可注册的 debug 区块内容：纯文本或带操作按钮 */
export type DebugSectionContent =
  | string
  | { text: string; actions?: { label: string; fn: () => void }[] };

/** 用于外部注册 debug 区块的 API */
export interface IDebugPanelAPI {
  /** 注册或更新一个区块，getter 在面板打开/刷新时调用 */
  addSection(id: string, getter: () => DebugSectionContent): void;
  /** 移除区块 */
  removeSection(id: string): void;
  /** 追加日志（显示在日志区域） */
  log(message: string): void;
  /** 清空日志 */
  clearLogs(): void;
  /** 刷新面板内容（若已打开） */
  refresh(): void;
}

const PANEL_W = 480;
const PANEL_H_MAX = 560;
const PADDING = 16;
const SECTION_GAP = 12;
const LOG_MAX_LINES = 50;
const FONT_SIZE = 12;
const WRAP_WIDTH = PANEL_W - PADDING * 2 - 20;

export class DebugPanelUI implements IDebugPanelAPI {
  private renderer: Renderer;
  private systemInfoProvider?: () => { fps?: number; sceneId?: string; state?: string };
  private sections = new Map<string, () => DebugSectionContent>();
  private logLines: string[] = [];
  private container: Container | null = null;
  private _isOpen = false;

  constructor(
    renderer: Renderer,
    systemInfoProvider?: () => { fps?: number; sceneId?: string; state?: string },
  ) {
    this.renderer = renderer;
    this.systemInfoProvider = systemInfoProvider;
  }

  setSystemInfoProvider(provider: () => { fps?: number; sceneId?: string; state?: string }): void {
    this.systemInfoProvider = provider;
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.build();
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.destroyUI();
  }

  addSection(id: string, getter: () => DebugSectionContent): void {
    this.sections.set(id, getter);
    if (this._isOpen) this.build();
  }

  removeSection(id: string): void {
    this.sections.delete(id);
    if (this._isOpen) this.build();
  }

  log(message: string): void {
    this.logLines.push(message);
    if (this.logLines.length > LOG_MAX_LINES) this.logLines.shift();
    if (this._isOpen) this.build();
  }

  clearLogs(): void {
    this.logLines = [];
    if (this._isOpen) this.build();
  }

  refresh(): void {
    if (this._isOpen) this.build();
  }

  private destroyUI(): void {
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }

  private build(): void {
    this.destroyUI();
    this.container = new Container();

    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const panelW = Math.min(PANEL_W, sw - 40);
    const wrapWidth = panelW - PADDING * 2 - 20;

    let cy = 0;

    const addText = (text: string, color: number, bold = false) => {
      const t = new Text({
        text,
        style: {
          fontSize: FONT_SIZE,
          fill: color,
          fontFamily: 'monospace',
          fontWeight: bold ? 'bold' : 'normal',
          wordWrap: true,
          wordWrapWidth: wrapWidth,
        },
      });
      t.x = 0;
      t.y = cy;
      return t;
    };

    const content = new Container();

    // 系统信息
    if (this.systemInfoProvider) {
      const info = this.systemInfoProvider();
      const lines: string[] = [];
      if (info.fps != null) lines.push(`FPS: ${Math.round(info.fps)}`);
      if (info.sceneId) lines.push(`Scene: ${info.sceneId}`);
      if (info.state) lines.push(`State: ${info.state}`);
      if (lines.length > 0) {
        const sysLabel = addText('-- System --', 0x8888aa, true);
        content.addChild(sysLabel);
        cy += 18;
        for (const line of lines) {
          const txt = addText(line, 0xaaaacc);
          txt.y = cy;
          content.addChild(txt);
          cy += 16;
        }
        cy += SECTION_GAP;
      }
    }

    // 自定义区块
    for (const [id, getter] of this.sections) {
      try {
        const data = getter();
        const text = typeof data === 'string' ? data : data.text;
        const actions = typeof data === 'string' ? undefined : data.actions;

        const label = addText(`-- ${id} --`, 0x8888aa, true);
        label.y = cy;
        content.addChild(label);
        cy += 18;

        const lines = text.split('\n');
        for (const line of lines) {
          const txt = addText(line, 0xccccdd);
          txt.y = cy;
          content.addChild(txt);
          cy += 16;
        }

        if (actions && actions.length > 0) {
          cy += 4;
          let btnX = 0;
          for (const a of actions) {
            const btn = new Graphics();
            const btnW = Math.min(120, a.label.length * 8 + 16);
            btn.roundRect(0, 0, btnW, 22, 4);
            btn.fill({ color: 0x333355, alpha: 0.9 });
            btn.roundRect(0, 0, btnW, 22, 4);
            btn.stroke({ color: 0x556677, width: 1 });
            btn.x = btnX;
            btn.y = cy;
            btn.eventMode = 'static';
            btn.cursor = 'pointer';
            btn.on('pointerdown', () => {
              try {
                a.fn();
                this.refresh();
              } catch (e) {
                this.log(`Error: ${String(e)}`);
              }
            });
            content.addChild(btn);

            const btnTxt = new Text({
              text: a.label,
              style: { fontSize: 11, fill: 0xaaaacc, fontFamily: 'sans-serif' },
            });
            btnTxt.x = btnX + (btnW - btnTxt.width) / 2;
            btnTxt.y = cy + 4;
            btnTxt.eventMode = 'none';
            content.addChild(btnTxt);

            btnX += btnW + 8;
          }
          cy += 28;
        }
        cy += SECTION_GAP;
      } catch (e) {
        const err = addText(`[${id} error: ${String(e)}]`, 0xff6666);
        err.y = cy;
        content.addChild(err);
        cy += 18 + SECTION_GAP;
      }
    }

    // 日志区
    const logLabel = addText('-- Log --', 0x8888aa, true);
    logLabel.y = cy;
    content.addChild(logLabel);
    cy += 18;

    const logText = this.logLines.slice(-20).join('\n') || '(empty)';
    const logTxt = new Text({
      text: logText,
      style: {
        fontSize: 11,
        fill: 0x778899,
        fontFamily: 'monospace',
        wordWrap: true,
        wordWrapWidth: wrapWidth,
      },
    });
    logTxt.x = 0;
    logTxt.y = cy;
    content.addChild(logTxt);
    cy += logTxt.height + 8;

    const clearLogBtn = new Graphics();
    clearLogBtn.roundRect(0, 0, 60, 20, 4);
    clearLogBtn.fill({ color: 0x442222, alpha: 0.8 });
    clearLogBtn.roundRect(0, 0, 60, 20, 4);
    clearLogBtn.stroke({ color: 0x664444, width: 1 });
    clearLogBtn.y = cy;
    clearLogBtn.eventMode = 'static';
    clearLogBtn.cursor = 'pointer';
    clearLogBtn.on('pointerdown', () => this.clearLogs());
    content.addChild(clearLogBtn);
    const clearTxt = new Text({
      text: 'Clear Log',
      style: { fontSize: 10, fill: 0xaa8888, fontFamily: 'sans-serif' },
    });
    clearTxt.x = 8;
    clearTxt.y = cy + 4;
    clearTxt.eventMode = 'none';
    content.addChild(clearTxt);
    cy += 32;

    const contentH = cy;
    const panelH = Math.min(contentH + 70, Math.min(PANEL_H_MAX, sh - 40));
    const px = (sw - panelW) / 2;
    const py = (sh - panelH) / 2;

    content.x = px + PADDING;
    content.y = py + 44;

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: 0x000000, alpha: 0.4 });
    this.container.addChild(overlay);

    const panel = new Graphics();
    panel.roundRect(px, py, panelW, panelH, 8);
    panel.fill({ color: 0x0d0d18, alpha: 0.98 });
    panel.roundRect(px, py, panelW, panelH, 8);
    panel.stroke({ color: 0x334466, width: 1 });
    this.container.addChild(panel);

    const title = new Text({
      text: 'Debug Panel',
      style: { fontSize: 16, fill: 0x88aacc, fontFamily: 'sans-serif', fontWeight: 'bold' },
    });
    title.x = px + PADDING;
    title.y = py + 8;
    this.container.addChild(title);

    const hint = new Text({
      text: 'F2 / ` \u5173\u95ed',
      style: { fontSize: 10, fill: 0x555566, fontFamily: 'sans-serif' },
    });
    hint.x = px + panelW - 70;
    hint.y = py + 10;
    this.container.addChild(hint);

    const contentMask = new Graphics();
    contentMask.rect(px + PADDING, py + 44, panelW - PADDING * 2, panelH - 60);
    contentMask.fill(0xffffff);
    this.container.addChild(contentMask);
    content.mask = contentMask;

    this.container.addChild(content);

    overlay.eventMode = 'static';
    overlay.on('pointerdown', (e) => e.stopPropagation());

    this.renderer.uiLayer.addChild(this.container);
  }

  destroy(): void {
    this.close();
    this.sections.clear();
    this.logLines = [];
  }
}
