import { Container, Graphics, Text } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { Condition, ConditionExpr, MapNodeDef } from '../data/types';
import { resolveAssetPath } from '../core/assetPath';
import type { StringsProvider } from '../core/StringsProvider';
import type { ConditionEvalContext } from '../systems/graphDialogue/evaluateGraphCondition';
import { evaluateConditionExprList } from '../systems/graphDialogue/conditionEvalBridge';

const PANEL_W = 600;
const PANEL_H = 450;
const NODE_R = 14;

export class MapUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private strings: StringsProvider;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;
  private container: Container | null = null;
  private _isOpen = false;
  private nodes: MapNodeDef[] = [];
  private currentSceneId: string = '';
  private resolveDisplay: ((s: string) => string) | null = null;

  constructor(renderer: Renderer, eventBus: EventBus, flagStore: FlagStore, strings: StringsProvider) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.strings = strings;
  }

  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  setConditionEvalContextFactory(factory: (() => ConditionEvalContext) | null): void {
    this.conditionCtxFactory = factory;
  }

  private evalUnlock(conds: ConditionExpr[]): boolean {
    if (!conds.length) return true;
    const ctx = this.conditionCtxFactory?.();
    if (ctx) return evaluateConditionExprList(conds, ctx);
    return this.flagStore.checkConditions(conds as Condition[]);
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

  /** 地图配置里出现过的场景 id（去重），供开发模式列表等使用 */
  getConfiguredSceneIds(): string[] {
    const seen = new Set<string>();
    for (const n of this.nodes) {
      if (n.sceneId) seen.add(n.sceneId);
    }
    return Array.from(seen);
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
    overlay.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlay });
    this.container.addChild(overlay);

    const bg = new Graphics();
    bg.roundRect(px, py, PANEL_W, PANEL_H, UITheme.panel.borderRadius);
    bg.fill({ color: UITheme.colors.panelBgAlt, alpha: UITheme.alpha.panelBg });
    bg.roundRect(px, py, PANEL_W, PANEL_H, UITheme.panel.borderRadius);
    bg.stroke({ color: UITheme.colors.panelBorder, width: 1 });
    this.container.addChild(bg);

    const title = new Text({
      text: this.strings.get('map', 'title'),
      style: { fontSize: 18, fill: UITheme.colors.title, fontFamily: UITheme.fonts.display, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: 560 },
    });
    title.x = px + 20;
    title.y = py + 12;
    this.container.addChild(title);

    const hint = new Text({
      text: this.strings.get('map', 'closeHint'),
      style: { fontSize: 11, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 560 },
    });
    hint.x = px + PANEL_W - 80;
    hint.y = py + PANEL_H - 24;
    this.container.addChild(hint);

    if (this.nodes.length === 0) {
      const empty = new Text({
        text: this.strings.get('map', 'noData'),
        style: { fontSize: 13, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 560 },
      });
      empty.x = px + (PANEL_W - empty.width) / 2;
      empty.y = py + PANEL_H / 2;
      this.container.addChild(empty);
    }

    for (const node of this.nodes) {
      const unlocked = this.evalUnlock(node.unlockConditions);
      const isCurrent = node.sceneId === this.currentSceneId;

      const nx = px + 50 + node.x;
      const ny = py + 60 + node.y;

      const circle = new Graphics();
      circle.circle(nx, ny, NODE_R);

      if (isCurrent) {
        circle.fill(UITheme.colors.mapCurrent);
        circle.circle(nx, ny, NODE_R);
        circle.stroke({ color: UITheme.colors.mapCurrentBorder, width: 2 });
      } else if (unlocked) {
        circle.fill(UITheme.colors.mapUnlocked);
        circle.circle(nx, ny, NODE_R);
        circle.stroke({ color: UITheme.colors.mapUnlockedBorder, width: 1 });
      } else {
        circle.fill({ color: UITheme.colors.mapLocked, alpha: UITheme.alpha.overlay });
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

      const labelText = unlocked
        ? (this.resolveDisplay ? this.resolveDisplay(node.name) : node.name)
        : this.strings.get('map', 'locked');
      const label = new Text({
        text: labelText,
        style: {
          fontSize: 11,
          fill: isCurrent ? UITheme.colors.mapCurrentBorder : (unlocked ? UITheme.colors.mapUnlockedText : UITheme.colors.mapLockedText),
          fontFamily: UITheme.fonts.ui,
          wordWrap: true, breakWords: true,
          wordWrapWidth: 100,
        },
      });
      label.x = nx - label.width / 2;
      label.y = ny + NODE_R + 4;
      this.container.addChild(label);
    }

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);
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
