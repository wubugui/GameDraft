import { Container, Graphics, Text } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { ISaveDataProvider, IAudioSettingsProvider } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';

type MenuMode = 'main' | 'pause' | 'save' | 'load' | 'settings';

const PANEL_W = 400;
const BTN_H = 44;
const BTN_GAP = 8;

export class MenuUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private saveData: ISaveDataProvider;
  private audioSettings: IAudioSettingsProvider;
  private strings: StringsProvider;
  private container: Container | null = null;
  private _isOpen = false;
  private mode: MenuMode = 'main';
  private previousMode: MenuMode = 'main';

  constructor(
    renderer: Renderer,
    eventBus: EventBus,
    saveData: ISaveDataProvider,
    audioSettings: IAudioSettingsProvider,
    strings: StringsProvider,
  ) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.saveData = saveData;
    this.audioSettings = audioSettings;
    this.strings = strings;
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
    bg.fill(UITheme.colors.mainMenuBg);
    this.container.addChild(bg);

    const gameName = new Text({
      text: this.strings.get('menu', 'gameTitle'),
      style: { fontSize: 48, fill: UITheme.colors.title, fontFamily: UITheme.fonts.display, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: sw - 40 },
    });
    gameName.x = (sw - gameName.width) / 2;
    gameName.y = sh * 0.2;
    this.container.addChild(gameName);

    const subtitle = new Text({
      text: this.strings.get('menu', 'gameSubtitle'),
      style: { fontSize: 20, fill: UITheme.colors.section, fontFamily: UITheme.fonts.display, wordWrap: true, breakWords: true, wordWrapWidth: sw - 40 },
    });
    subtitle.x = (sw - subtitle.width) / 2;
    subtitle.y = sh * 0.2 + 60;
    this.container.addChild(subtitle);

    const buttons: { label: string; action: () => void }[] = [
      { label: this.strings.get('menu', 'newGame'), action: () => this.eventBus.emit('menu:newGame', {}) },
    ];

    if (this.saveData.hasAnySave()) {
      buttons.push({ label: this.strings.get('menu', 'continueGame'), action: () => { this.previousMode = this.mode; this.mode = 'load'; this.build(); } });
    }
    buttons.push({ label: this.strings.get('menu', 'settings'), action: () => { this.previousMode = this.mode; this.mode = 'settings'; this.build(); } });

    this.buildButtonColumn(buttons, sw, sh * 0.5);
    this.renderer.uiLayer.addChild(this.container);
  }

  private buildPauseMenu(): void {
    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlayDark });
    this.container.addChild(overlay);

    const title = new Text({
      text: this.strings.get('menu', 'pause'),
      style: { fontSize: 24, fill: UITheme.colors.title, fontFamily: UITheme.fonts.display, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: sw - 40 },
    });
    title.x = (sw - title.width) / 2;
    title.y = sh * 0.2;
    this.container.addChild(title);

    const buttons: { label: string; action: () => void }[] = [
      { label: this.strings.get('menu', 'resume'), action: () => this.close() },
      { label: this.strings.get('menu', 'save'), action: () => { this.previousMode = this.mode; this.mode = 'save'; this.build(); } },
      { label: this.strings.get('menu', 'load'), action: () => { this.previousMode = this.mode; this.mode = 'load'; this.build(); } },
      { label: this.strings.get('menu', 'settings'), action: () => { this.previousMode = this.mode; this.mode = 'settings'; this.build(); } },
      { label: this.strings.get('menu', 'returnToMain'), action: () => { this.close(); this.eventBus.emit('menu:returnToMain', {}); } },
    ];

    this.buildButtonColumn(buttons, sw, sh * 0.35);
    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);
  }

  private buildSaveLoadPanel(action: 'save' | 'load'): void {
    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const px = (sw - PANEL_W) / 2;
    const py = (sh - 300) / 2;

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlayDark });
    this.container.addChild(overlay);

    const bg = new Graphics();
    bg.roundRect(px, py, PANEL_W, 300, UITheme.panel.borderRadius);
    bg.fill({ color: UITheme.colors.panelBg, alpha: UITheme.alpha.panelBg });
    bg.roundRect(px, py, PANEL_W, 300, UITheme.panel.borderRadius);
    bg.stroke({ color: UITheme.colors.panelBorder, width: 1 });
    this.container.addChild(bg);

    const title = new Text({
      text: action === 'save' ? this.strings.get('menu', 'save') : this.strings.get('menu', 'load'),
      style: { fontSize: 18, fill: UITheme.colors.title, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: PANEL_W - 80 },
    });
    title.x = px + 20;
    title.y = py + 14;
    this.container.addChild(title);

    for (let i = 0; i < 3; i++) {
      const meta = this.saveData.getSlotMeta(i);
      const slotY = py + 56 + i * 70;

      const slotBg = new Graphics();
      slotBg.roundRect(px + 16, slotY, PANEL_W - 32, 60, UITheme.panel.borderRadiusSmall);
      slotBg.fill({ color: UITheme.colors.rowBg, alpha: UITheme.alpha.slotBg });
      slotBg.roundRect(px + 16, slotY, PANEL_W - 32, 60, UITheme.panel.borderRadiusSmall);
      slotBg.stroke({ color: UITheme.colors.borderSubtle, width: 1 });
      this.container.addChild(slotBg);

      if (meta) {
        const date = new Date(meta.timestamp);
        const dateStr = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
        const playMin = Math.floor(meta.playTimeMs / 60000);

        const info = new Text({
          text: this.strings.get('menu', 'slotInfo', { slot: String(i + 1), scene: meta.sceneName, day: String(meta.dayNumber), date: dateStr, minutes: String(playMin) }),
          style: { fontSize: 12, fill: UITheme.colors.subtle, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: PANEL_W - 60 },
        });
        info.x = px + 28;
        info.y = slotY + 20;
        this.container.addChild(info);
      } else {
        const empty = new Text({
          text: this.strings.get('menu', 'slotEmpty', { slot: i + 1 }),
          style: { fontSize: 12, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: PANEL_W - 60 },
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
            this.eventBus.emit('notification:show', {
              text: this.strings.get('menu', 'saveSlot', { slot: i + 1 }),
              type: 'info',
            });
            this.build();
          } else {
            this.saveData.load(i).then(() => {
              this.close();
              this.eventBus.emit('notification:show', {
                text: this.strings.get('menu', 'loadSlot', { slot: i + 1 }),
                type: 'info',
              });
            });
          }
        });
      }
    }

    const backBtn = new Text({
      text: this.strings.get('menu', 'back'),
      style: { fontSize: 13, fill: UITheme.colors.link, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 60 },
    });
    backBtn.x = px + PANEL_W - 60;
    backBtn.y = py + 14;
    backBtn.eventMode = 'static';
    backBtn.cursor = 'pointer';
    backBtn.on('pointerdown', () => {
      this.mode = this.previousMode;
      this.build();
    });
    this.container.addChild(backBtn);

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);
  }

  private buildSettings(): void {
    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const px = (sw - PANEL_W) / 2;
    const py = (sh - 280) / 2;

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlayDark });
    this.container.addChild(overlay);

    const bg = new Graphics();
    bg.roundRect(px, py, PANEL_W, 280, UITheme.panel.borderRadius);
    bg.fill({ color: UITheme.colors.panelBg, alpha: UITheme.alpha.panelBg });
    bg.roundRect(px, py, PANEL_W, 280, UITheme.panel.borderRadius);
    bg.stroke({ color: UITheme.colors.panelBorder, width: 1 });
    this.container.addChild(bg);

    const title = new Text({
      text: this.strings.get('menu', 'settings'),
      style: { fontSize: 18, fill: UITheme.colors.title, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: PANEL_W - 80 },
    });
    title.x = px + 20;
    title.y = py + 14;
    this.container.addChild(title);

    const channels: { label: string; channel: 'bgm' | 'sfx' | 'ambient' }[] = [
      { label: this.strings.get('menu', 'bgm'), channel: 'bgm' },
      { label: this.strings.get('menu', 'sfx'), channel: 'sfx' },
      { label: this.strings.get('menu', 'ambient'), channel: 'ambient' },
    ];

    channels.forEach(({ label, channel }, idx) => {
      const cy = py + 60 + idx * 60;
      const labelT = new Text({
        text: label,
        style: { fontSize: 13, fill: UITheme.colors.subtle, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 100 },
      });
      labelT.x = px + 20;
      labelT.y = cy;
      this.container!.addChild(labelT);

      const vol = this.audioSettings.getVolume(channel);
      this.drawSlider(px + 130, cy, 200, vol, (v) => {
        this.audioSettings.setVolume(channel, v);
      });
    });

    const backBtn = new Text({
      text: this.strings.get('menu', 'back'),
      style: { fontSize: 13, fill: UITheme.colors.link, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 60 },
    });
    backBtn.x = px + PANEL_W - 60;
    backBtn.y = py + 14;
    backBtn.eventMode = 'static';
    backBtn.cursor = 'pointer';
    backBtn.on('pointerdown', () => { this.mode = this.previousMode; this.build(); });
    this.container.addChild(backBtn);

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);
  }

  private drawSlider(x: number, y: number, width: number, value: number, onChange: (v: number) => void): void {
    const track = new Graphics();
    track.roundRect(x, y + 6, width, 6, 3);
    track.fill(UITheme.colors.sliderTrack);
    this.container!.addChild(track);

    const fill = new Graphics();
    const drawFill = (v: number) => {
      fill.clear();
      fill.roundRect(x, y + 6, width * v, 6, 3);
      fill.fill(UITheme.colors.sliderFill);
    };
    drawFill(value);
    this.container!.addChild(fill);

    const handle = new Graphics();
    const drawHandle = (v: number) => {
      handle.clear();
      handle.circle(x + width * v, y + 9, 8);
      handle.fill(UITheme.colors.sliderHandle);
    };
    drawHandle(value);
    this.container!.addChild(handle);

    const pct = new Text({
      text: `${Math.round(value * 100)}%`,
      style: { fontSize: 12, fill: UITheme.colors.section, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 50 },
    });
    pct.x = x + width + 10;
    pct.y = y;
    this.container!.addChild(pct);

    let dragging = false;
    const updateValue = (globalX: number) => {
      const v = Math.max(0, Math.min(1, (globalX - x) / width));
      onChange(v);
      drawFill(v);
      drawHandle(v);
      pct.text = `${Math.round(v * 100)}%`;
    };

    const onMove = (e: PointerEvent) => { if (dragging) updateValue(e.clientX); };
    const onUp = () => {
      dragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    track.eventMode = 'static';
    track.cursor = 'pointer';
    handle.eventMode = 'static';
    handle.cursor = 'pointer';

    const startDrag = (e: any) => {
      dragging = true;
      updateValue(e.globalX);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
    track.on('pointerdown', startDrag);
    handle.on('pointerdown', startDrag);
  }

  private buildButtonColumn(buttons: { label: string; action: () => void }[], sw: number, startY: number): void {
    buttons.forEach((btn, i) => {
      const by = startY + i * (BTN_H + BTN_GAP);
      const bx = (sw - 200) / 2;

      const hoverBg = new Graphics();
      hoverBg.roundRect(bx, by, 200, BTN_H, UITheme.panel.borderRadiusMed);
      hoverBg.fill({ color: UITheme.colors.rowHover, alpha: UITheme.alpha.rowBg });
      hoverBg.roundRect(bx, by, 200, BTN_H, UITheme.panel.borderRadiusMed);
      hoverBg.stroke({ color: UITheme.colors.panelBorder, width: 1 });
      hoverBg.visible = false;
      this.container!.addChild(hoverBg);

      const bg = new Graphics();
      bg.roundRect(bx, by, 200, BTN_H, UITheme.panel.borderRadiusMed);
      bg.fill({ color: UITheme.colors.rowBg, alpha: UITheme.alpha.rowBg });
      bg.roundRect(bx, by, 200, BTN_H, UITheme.panel.borderRadiusMed);
      bg.stroke({ color: UITheme.colors.panelBorder, width: 1 });
      bg.eventMode = 'static';
      bg.cursor = 'pointer';
      bg.on('pointerdown', btn.action);
      bg.on('pointerover', () => { hoverBg.visible = true; bg.visible = false; });
      bg.on('pointerout', () => { hoverBg.visible = false; bg.visible = true; });
      this.container!.addChild(bg);

      const t = new Text({
        text: btn.label,
        style: { fontSize: 15, fill: UITheme.colors.buttonText, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 190 },
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
