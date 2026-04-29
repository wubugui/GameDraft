import { Container, Graphics, Text } from 'pixi.js';
import type { EmoteBubbleOffsetOpts, IEmoteBubbleAnchor, IGameSystem, GameContext } from '../data/types';
import { Hotspot } from '../entities/Hotspot';

interface ActiveBubble {
  bubble: Container;
  parent: Container;
  remainingMs: number;
}

/**
 * 热点整块容器可能 `spriteSort: back` 排到最底，气泡单挂 entityLayer。
 * quad 直接来自 Hotspot 的世界数据：展示图为底中锚点，x/y/worldWidth/worldHeight 已定义完整世界四边形。
 * 不走 getBounds / toGlobal / toLocal，避免屏幕空间与 entityLayer 世界空间混用。
 */
const EMOTE_BUBBLE_Z_BASE = 30_000_000;
/** 气泡底边落在 quad 顶边之上（世界单位近似，与 NPC headGap 同量级） */
const QUAD_ABOVE_GAP = 8;

export class EmoteBubbleManager implements IGameSystem {
  private activeBubbles: ActiveBubble[] = [];
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  /** 与 SceneManager 放入 NPC/热点的层一致；不设则热点气泡仍挂在热点容器下 */
  private entityAttachLayer: Container | null = null;
  /** F2 调试面板 */
  private debugPanelLog: ((message: string) => void) | null = null;

  /**
   * 由 Game 在 renderer.init() 之后设置；供热点气泡挂靠世界实体层。
   */
  setEntityAttachLayer(layer: Container | null): void {
    this.entityAttachLayer = layer;
  }

  /** F2 调试面板「日志」路由（与 ActionRegistry 同源）。 */
  setDebugPanelLog(fn: ((message: string) => void) | null): void {
    this.debugPanelLog = fn;
  }

  private dbg(message: string): void {
    this.debugPanelLog?.(`[EmoteBubble] ${message}`);
  }

  init(_ctx: GameContext): void {}
  serialize(): object { return {}; }
  deserialize(_data: object): void { this.cleanup(); }

  show(
    anchor: IEmoteBubbleAnchor,
    emote: string,
    durationMs: number = 1500,
    opts?: EmoteBubbleOffsetOpts,
  ): void {
    const displayObj = anchor.getDisplayObject() as Container;

    this.dbg(
      `show 开始 anchor=${anchor.constructor?.name ?? '?'} emoteLen=${emote.length} ` +
        `entityAttachLayer=${this.entityAttachLayer ? 'ok' : '(null)'}`,
    );
    this.dbg(
      `  displayObj parent=${displayObj.parent ? 'yes' : 'no'} visible=${displayObj.visible} ` +
        `renderable=${(displayObj as { renderable?: boolean }).renderable ?? '?'} alpha=${displayObj.alpha} ` +
        `y=${Number.isFinite(displayObj.y) ? displayObj.y.toFixed(1) : String(displayObj.y)}`,
    );

    const bubble = new Container();

    const txt = new Text({
      text: emote,
      style: { fontSize: 20, fill: 0x222222, fontFamily: 'sans-serif', fontWeight: 'bold' },
    });

    const padX = 8;
    const padY = 4;
    const bw = txt.width + padX * 2;
    const bh = txt.height + padY * 2;

    const bg = new Graphics();
    bg.roundRect(0, 0, bw, bh, 6);
    bg.fill({ color: 0xffffff, alpha: 0.95 });
    bg.stroke({ color: 0x888888, width: 1 });
    bubble.addChild(bg);

    txt.x = padX;
    txt.y = padY;
    bubble.addChild(txt);

    const ox = opts?.anchorOffsetX ?? 0;
    const oy = opts?.anchorOffsetY ?? 0;
    const anchorY = anchor.getEmoteBubbleAnchorLocalY() + oy;
    const bubbleLocalLeft = -bw / 2 + ox;
    const bubbleLocalTop = anchorY - bh;

    let attachParent: Container = displayObj;
    let bx = bubbleLocalLeft;
    let by = bubbleLocalTop;

    if (this.entityAttachLayer !== null && anchor instanceof Hotspot) {
      attachParent = this.entityAttachLayer;
      (bubble as Container & { entitySortBand?: 'front' }).entitySortBand = 'front';
      const quad = anchor.getEmoteWorldQuad();
      bx = quad.left + quad.width / 2 - bw / 2 + ox;
      by = quad.top - QUAD_ABOVE_GAP - bh + oy;
      this.dbg(
        `  热点 worldQuad→entityLayer ` +
          `quad xywh=(${quad.left.toFixed(1)},${quad.top.toFixed(1)}) ${quad.width.toFixed(1)}×${quad.height.toFixed(1)} ` +
          `bubble=(${bx.toFixed(1)},${by.toFixed(1)}) band=front`,
      );
    } else if (anchor instanceof Hotspot && this.entityAttachLayer === null) {
      this.dbg('  警告: Hotspot 但 entityAttachLayer 未设置，气泡仅在热点容器内（易被遮挡）');
    }

    bubble.x = bx;
    bubble.y = by;
    attachParent.addChild(bubble);
    if (attachParent.sortableChildren) {
      attachParent.sortChildren();
    }
    this.dbg(
      `  已 addChild: 父=${attachParent === this.entityAttachLayer ? 'entityLayer' : 'anchor本地'} ` +
        `bubble.xy=(${bx.toFixed(1)},${by.toFixed(1)}) bw×bh=${bw.toFixed(0)}×${bh.toFixed(0)} ` +
        `bubble.visible=${bubble.visible} bubble.renderable=${(bubble as { renderable?: boolean }).renderable ?? '?'} durMs=${durationMs}`,
    );
    this.activeBubbles.push({ bubble, parent: attachParent, remainingMs: durationMs });
  }

  showAndWait(
    anchor: IEmoteBubbleAnchor,
    emote: string,
    durationMs: number = 1500,
    opts?: EmoteBubbleOffsetOpts,
  ): Promise<void> {
    this.show(anchor, emote, durationMs, opts);
    return new Promise(resolve => {
      const id = setTimeout(() => {
        this.pendingTimers.delete(id);
        resolve();
      }, durationMs);
      this.pendingTimers.add(id);
    });
  }

  update(dt: number): void {
    for (let i = this.activeBubbles.length - 1; i >= 0; i--) {
      const entry = this.activeBubbles[i];
      entry.remainingMs -= dt * 1000;
      if (entry.remainingMs <= 0) {
        this.removeBubble(entry);
        this.activeBubbles.splice(i, 1);
      }
    }
  }

  private removeBubble(entry: ActiveBubble): void {
    if (entry.bubble.parent) {
      entry.bubble.parent.removeChild(entry.bubble);
    }
    entry.bubble.destroy({ children: true });
  }

  cleanup(): void {
    for (const id of this.pendingTimers) clearTimeout(id);
    this.pendingTimers.clear();
    for (const entry of this.activeBubbles) {
      this.removeBubble(entry);
    }
    this.activeBubbles.length = 0;
  }

  destroy(): void {
    this.cleanup();
  }
}
