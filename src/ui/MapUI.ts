import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { MapNodeDef } from '../data/types';
import { resolveAssetPath } from '../core/assetPath';

const PANEL_W = 600;
const PANEL_H = 450;
const NODE_R = 14;

export class MapUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private container: Container | null = null;
  private _isOpen = false;
  private nodes: MapNodeDef[] = [];
  private currentSceneId: string = '';

  constructor(renderer: Renderer, eventBus: EventBus, flagStore: FlagStore) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.flagStore = flagStore;
  }

  async loadConfig(): Promise<void> {
    try {
      const resp = await fetch(resolveAssetPath('/assets/data/map_config.json'));
      this.nodes = await resp.json();
    } catch { /* no map config yet */ }
  }

  setCurrentScene(sceneId: string): void {
    this.currentSceneId = sceneId;
  }

  get isOpen(): boolean { return this._isOpen; }

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

  private build(): void {
    this.destroyUI();
    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const px = (sw - PANEL_W) / 2;
    const py = (sh - PANEL_H) / 2;

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: 0x000000, alpha: 0.5 });
    this.container.addChild(overlay);

    const bg = new Graphics();
    bg.roundRect(px, py, PANEL_W, PANEL_H, 8);
    bg.fill({ color: 0x1a1a2e, alpha: 0.95 });
    bg.roundRect(px, py, PANEL_W, PANEL_H, 8);
    bg.stroke({ color: 0x444466, width: 1 });
    this.container.addChild(bg);

    const title = new Text({
      text: '渝都卫城区图',
      style: { fontSize: 18, fill: 0xffcc88, fontFamily: 'serif', fontWeight: 'bold' },
    });
    title.x = px + 20;
    title.y = py + 12;
    this.container.addChild(title);

    const hint = new Text({
      text: '按 M 关闭',
      style: { fontSize: 11, fill: 0x555566, fontFamily: 'sans-serif' },
    });
    hint.x = px + PANEL_W - 80;
    hint.y = py + PANEL_H - 24;
    this.container.addChild(hint);

    if (this.nodes.length === 0) {
      const empty = new Text({
        text: '(地图数据暂未配置)',
        style: { fontSize: 13, fill: 0x555566, fontFamily: 'sans-serif' },
      });
      empty.x = px + (PANEL_W - empty.width) / 2;
      empty.y = py + PANEL_H / 2;
      this.container.addChild(empty);
    }

    for (const node of this.nodes) {
      const unlocked = this.flagStore.checkConditions(node.unlockConditions);
      const isCurrent = node.sceneId === this.currentSceneId;

      const nx = px + 50 + node.x;
      const ny = py + 60 + node.y;

      const circle = new Graphics();
      circle.circle(nx, ny, NODE_R);

      if (isCurrent) {
        circle.fill(0xffcc44);
        circle.circle(nx, ny, NODE_R);
        circle.stroke({ color: 0xffee88, width: 2 });
      } else if (unlocked) {
        circle.fill(0x557799);
        circle.circle(nx, ny, NODE_R);
        circle.stroke({ color: 0x6688aa, width: 1 });
      } else {
        circle.fill({ color: 0x333344, alpha: 0.5 });
      }

      if (unlocked && !isCurrent) {
        circle.eventMode = 'static';
        circle.cursor = 'pointer';
        circle.on('pointerdown', () => {
          this.close();
          this.eventBus.emit('map:travel', { sceneId: node.sceneId });
        });
      }
      this.container.addChild(circle);

      const label = new Text({
        text: unlocked ? node.name : '???',
        style: {
          fontSize: 11,
          fill: isCurrent ? 0xffee88 : (unlocked ? 0xaabbcc : 0x444455),
          fontFamily: 'sans-serif',
        },
      });
      label.x = nx - label.width / 2;
      label.y = ny + NODE_R + 4;
      this.container.addChild(label);
    }

    this.renderer.uiLayer.addChild(this.container);
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
