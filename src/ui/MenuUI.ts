import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { ISaveDataProvider, IAudioSettingsProvider } from '../data/types';

type MenuMode = 'main' | 'pause' | 'save' | 'load' | 'settings';

const PANEL_W = 400;
const BTN_H = 44;
const BTN_GAP = 8;

export class MenuUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private saveData: ISaveDataProvider;
  private audioSettings: IAudioSettingsProvider;
  private container: Container | null = null;
  private _isOpen = false;
  private mode: MenuMode = 'main';

  constructor(
    renderer: Renderer,
    eventBus: EventBus,
    saveData: ISaveDataProvider,
    audioSettings: IAudioSettingsProvider,
  ) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.saveData = saveData;
    this.audioSettings = audioSettings;
  }

  get isOpen(): boolean { return this._isOpen; }

  open(): void { this.openPauseMenu(); }

  openMainMenu(): void {
    this._isOpen = true;
    this.mode = 'main';
    this.build();
  }

  openPauseMenu(): void {
    this._isOpen = true;
    this.mode = 'pause';
    this.build();
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.destroyUI();
  }

  private build(): void {
    this.destroyUI();
    switch (this.mode) {
      case 'main': this.buildMainMenu(); break;
      case 'pause': this.buildPauseMenu(); break;
      case 'save': this.buildSaveLoadPanel('save'); break;
      case 'load': this.buildSaveLoadPanel('load'); break;
      case 'settings': this.buildSettings(); break;
    }
  }

  private buildMainMenu(): void {
    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;

    const bg = new Graphics();
    bg.rect(0, 0, sw, sh);
    bg.fill(0x0a0a14);
    this.container.addChild(bg);

    const gameName = new Text({
      text: '渝都卫',
      style: { fontSize: 48, fill: 0xffcc88, fontFamily: 'serif', fontWeight: 'bold' },
    });
    gameName.x = (sw - gameName.width) / 2;
    gameName.y = sh * 0.2;
    this.container.addChild(gameName);

    const subtitle = new Text({
      text: '旧梦惊尘',
      style: { fontSize: 20, fill: 0x888899, fontFamily: 'serif' },
    });
    subtitle.x = (sw - subtitle.width) / 2;
    subtitle.y = sh * 0.2 + 60;
    this.container.addChild(subtitle);

    const buttons: { label: string; action: () => void }[] = [
      { label: '新游戏', action: () => this.eventBus.emit('menu:newGame', {}) },
    ];

    if (this.saveData.hasAnySave()) {
      buttons.push({ label: '继续游戏', action: () => { this.mode = 'load'; this.build(); } });
    }
    buttons.push({ label: '设置', action: () => { this.mode = 'settings'; this.build(); } });

    this.buildButtonColumn(buttons, sw, sh * 0.5);
    this.renderer.uiLayer.addChild(this.container);
  }

  private buildPauseMenu(): void {
    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: 0x000000, alpha: 0.6 });
    this.container.addChild(overlay);

    const title = new Text({
      text: '暂停',
      style: { fontSize: 24, fill: 0xffcc88, fontFamily: 'serif', fontWeight: 'bold' },
    });
    title.x = (sw - title.width) / 2;
    title.y = sh * 0.2;
    this.container.addChild(title);

    const buttons: { label: string; action: () => void }[] = [
      { label: '继续', action: () => this.close() },
      { label: '存档', action: () => { this.mode = 'save'; this.build(); } },
      { label: '读档', action: () => { this.mode = 'load'; this.build(); } },
      { label: '设置', action: () => { this.mode = 'settings'; this.build(); } },
      { label: '返回主菜单', action: () => { this.close(); this.eventBus.emit('menu:returnToMain', {}); } },
    ];

    this.buildButtonColumn(buttons, sw, sh * 0.35);
    this.renderer.uiLayer.addChild(this.container);
  }

  private buildSaveLoadPanel(action: 'save' | 'load'): void {
    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const px = (sw - PANEL_W) / 2;
    const py = (sh - 300) / 2;

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: 0x000000, alpha: 0.6 });
    this.container.addChild(overlay);

    const bg = new Graphics();
    bg.roundRect(px, py, PANEL_W, 300, 8);
    bg.fill({ color: 0x111122, alpha: 0.95 });
    bg.roundRect(px, py, PANEL_W, 300, 8);
    bg.stroke({ color: 0x444466, width: 1 });
    this.container.addChild(bg);

    const title = new Text({
      text: action === 'save' ? '存档' : '读档',
      style: { fontSize: 18, fill: 0xffcc88, fontFamily: 'sans-serif', fontWeight: 'bold' },
    });
    title.x = px + 20;
    title.y = py + 14;
    this.container.addChild(title);

    for (let i = 0; i < 3; i++) {
      const meta = this.saveData.getSlotMeta(i);
      const slotY = py + 56 + i * 70;

      const slotBg = new Graphics();
      slotBg.roundRect(px + 16, slotY, PANEL_W - 32, 60, 4);
      slotBg.fill({ color: 0x222233, alpha: 0.7 });
      slotBg.roundRect(px + 16, slotY, PANEL_W - 32, 60, 4);
      slotBg.stroke({ color: 0x333344, width: 1 });
      this.container.addChild(slotBg);

      if (meta) {
        const date = new Date(meta.timestamp);
        const dateStr = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
        const playMin = Math.floor(meta.playTimeMs / 60000);

        const info = new Text({
          text: `槽位 ${i + 1}: ${meta.sceneName}  第${meta.dayNumber}天  ${dateStr}  ${playMin}分钟`,
          style: { fontSize: 12, fill: 0xaaaacc, fontFamily: 'sans-serif' },
        });
        info.x = px + 28;
        info.y = slotY + 20;
        this.container.addChild(info);
      } else {
        const empty = new Text({
          text: `槽位 ${i + 1}: (空)`,
          style: { fontSize: 12, fill: 0x555566, fontFamily: 'sans-serif' },
        });
        empty.x = px + 28;
        empty.y = slotY + 20;
        this.container.addChild(empty);
      }

      const canClick = action === 'save' || (action === 'load' && meta !== null);
      if (canClick) {
        slotBg.eventMode = 'static';
        slotBg.cursor = 'pointer';
        slotBg.on('pointerdown', () => {
          if (action === 'save') {
            this.saveData.save(i);
            this.eventBus.emit('notification:show', { text: `存档到槽位 ${i + 1}`, type: 'info' });
            this.build();
          } else {
            this.saveData.load(i).then(() => {
              this.close();
              this.eventBus.emit('notification:show', { text: `读取槽位 ${i + 1}`, type: 'info' });
            });
          }
        });
      }
    }

    const backBtn = new Text({
      text: '[返回]',
      style: { fontSize: 13, fill: 0x8888aa, fontFamily: 'sans-serif' },
    });
    backBtn.x = px + PANEL_W - 60;
    backBtn.y = py + 14;
    backBtn.eventMode = 'static';
    backBtn.cursor = 'pointer';
    backBtn.on('pointerdown', () => {
      this.mode = this.mode === 'save' ? 'pause' : (this.saveData.hasAnySave() ? 'main' : 'pause');
      this.build();
    });
    this.container.addChild(backBtn);

    this.renderer.uiLayer.addChild(this.container);
  }

  private buildSettings(): void {
    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const px = (sw - PANEL_W) / 2;
    const py = (sh - 280) / 2;

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: 0x000000, alpha: 0.6 });
    this.container.addChild(overlay);

    const bg = new Graphics();
    bg.roundRect(px, py, PANEL_W, 280, 8);
    bg.fill({ color: 0x111122, alpha: 0.95 });
    bg.roundRect(px, py, PANEL_W, 280, 8);
    bg.stroke({ color: 0x444466, width: 1 });
    this.container.addChild(bg);

    const title = new Text({
      text: '设置',
      style: { fontSize: 18, fill: 0xffcc88, fontFamily: 'sans-serif', fontWeight: 'bold' },
    });
    title.x = px + 20;
    title.y = py + 14;
    this.container.addChild(title);

    const channels: { label: string; channel: 'bgm' | 'sfx' | 'ambient' }[] = [
      { label: '背景音乐', channel: 'bgm' },
      { label: '音效', channel: 'sfx' },
      { label: '环境音', channel: 'ambient' },
    ];

    channels.forEach(({ label, channel }, idx) => {
      const cy = py + 60 + idx * 60;
      const labelT = new Text({
        text: label,
        style: { fontSize: 13, fill: 0xaaaacc, fontFamily: 'sans-serif' },
      });
      labelT.x = px + 20;
      labelT.y = cy;
      this.container!.addChild(labelT);

      const vol = this.audioSettings.getVolume(channel);
      this.drawSlider(px + 130, cy, 200, vol, (v) => {
        this.audioSettings.setVolume(channel, v);
      });

      const pct = new Text({
        text: `${Math.round(vol * 100)}%`,
        style: { fontSize: 12, fill: 0x888899, fontFamily: 'sans-serif' },
      });
      pct.x = px + 340;
      pct.y = cy;
      this.container!.addChild(pct);
    });

    const backBtn = new Text({
      text: '[返回]',
      style: { fontSize: 13, fill: 0x8888aa, fontFamily: 'sans-serif' },
    });
    backBtn.x = px + PANEL_W - 60;
    backBtn.y = py + 14;
    backBtn.eventMode = 'static';
    backBtn.cursor = 'pointer';
    backBtn.on('pointerdown', () => { this.mode = 'pause'; this.build(); });
    this.container.addChild(backBtn);

    this.renderer.uiLayer.addChild(this.container);
  }

  private drawSlider(x: number, y: number, width: number, value: number, onChange: (v: number) => void): void {
    const track = new Graphics();
    track.roundRect(x, y + 6, width, 6, 3);
    track.fill(0x333344);
    this.container!.addChild(track);

    const fill = new Graphics();
    fill.roundRect(x, y + 6, width * value, 6, 3);
    fill.fill(0x5588cc);
    this.container!.addChild(fill);

    const handle = new Graphics();
    handle.circle(x + width * value, y + 9, 8);
    handle.fill(0x88aacc);
    this.container!.addChild(handle);

    track.eventMode = 'static';
    track.cursor = 'pointer';
    track.on('pointerdown', (e) => {
      const localX = e.globalX - x;
      const v = Math.max(0, Math.min(1, localX / width));
      onChange(v);
      this.build();
    });
  }

  private buildButtonColumn(buttons: { label: string; action: () => void }[], sw: number, startY: number): void {
    buttons.forEach((btn, i) => {
      const by = startY + i * (BTN_H + BTN_GAP);
      const bx = (sw - 200) / 2;

      const bg = new Graphics();
      bg.roundRect(bx, by, 200, BTN_H, 6);
      bg.fill({ color: 0x222233, alpha: 0.8 });
      bg.roundRect(bx, by, 200, BTN_H, 6);
      bg.stroke({ color: 0x444466, width: 1 });
      bg.eventMode = 'static';
      bg.cursor = 'pointer';
      bg.on('pointerdown', btn.action);
      bg.on('pointerover', () => { bg.alpha = 0.8; });
      bg.on('pointerout', () => { bg.alpha = 1; });
      this.container!.addChild(bg);

      const t = new Text({
        text: btn.label,
        style: { fontSize: 15, fill: 0xccccdd, fontFamily: 'sans-serif' },
      });
      t.x = bx + (200 - t.width) / 2;
      t.y = by + (BTN_H - t.height) / 2;
      t.eventMode = 'none';
      this.container!.addChild(t);
    });
  }

  private destroyUI(): void {
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }

  destroy(): void {
    this.destroyUI();
  }
}
