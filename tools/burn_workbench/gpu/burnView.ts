/** BurnGL-compatible workbench preview. Simulation, frame geometry and burn math remain shared.
 * The legacy tool samples straight-alpha artwork and applies material + glow in ONE pass.
 * Game filters use screen coordinates / intermediate targets and are not this tool's pixel oracle.
 */
import { Container, type Texture } from '../../../src/engine2d';
import type { HotspotDisplayImage } from '../../../src/data/types';
import type { BurnShadeParams } from '../../../src/rendering/burn/burnShadeParams';
import { burnEntityPlacement, burnPlacementFrame, type BurnFrame } from '../../../src/systems/burn/burnGeometry';
import type { PerspectiveScaleResolver } from '../../../src/utils/perspectiveScale';
import { BurnPreviewQuad } from './burnPreview';
export { loadPreviewTexture } from './burnPreview';

/** 一个实例的燃烧输入（没点 = 整个传 null：与游戏一样，只在"烧过"时挂燃烧着色） */
export interface BurnFieldInput {
  gridW: number;
  gridH: number;
  /** 字节来源的身份（换了模拟 = 换了来源）与代号（同一来源里字节变了就换）：两样都没变就不重编码 */
  source: object;
  gen: number;
  /** 把燃烧场编码进 `dst`（RGBA8，gridW × gridH）——就是模拟的 `encodeTexture` */
  encode(dst: Uint8Array): void;
  params: BurnShadeParams;
}

/** 热点实例：def 的摆放字段（x / y / scale / rotation / anchor / 透视开关）+ 展示图（模板图与真实尺寸 wu） */
export interface BurnHotspotInput {
  key: string;
  kind: 'hotspot';
  def: {
    id: string;
    x: number;
    y: number;
    scale?: number;
    rotation?: number;
    anchor?: { x?: number; y?: number } | null;
    perspectiveScaleEnabled?: boolean;
    displayImage: HotspotDisplayImage;
  };
  texture: Texture;
  /** 场景透视（热点只有 `perspectiveScaleEnabled === true` 才吃，`Hotspot.setPerspectiveScale` 自己判） */
  perspective?: PerspectiveScaleResolver | null;
  burn: BurnFieldInput | null;
}

/** 按实例帧平贴的实例（NPC：游戏里走角色受光网格，工作台只平贴） */
export interface BurnFrameInput {
  key: string;
  kind: 'frame';
  frame: BurnFrame;
  texture: Texture;
  burn: BurnFieldInput | null;
}

export type BurnInstanceInput = BurnHotspotInput | BurnFrameInput;

interface View { texture: Texture; frame: BurnFrame; quad: BurnPreviewQuad }

export class BurnStage {
  readonly root = new Container();
  // Quad vertices are already CSS screen coordinates, as in the old BurnGL.quad.
  readonly world = new Container();
  private background: View | null = null;
  private readonly views = new Map<string, View>();
  private camera = { x: 0, y: 0, scale: 1 };
  private screen = { width: 1, height: 1 };

  constructor() {
    this.root.label = 'burn-workbench-root';
    this.world.label = 'burn-workbench-screen-quads';
    this.root.addChild(this.world);
  }

  setCamera(scale: number, x: number, y: number): void { this.camera = { x, y, scale }; }
  setScreen(width: number, height: number): void { this.screen = { width, height }; }

  setBackground(texture: Texture | null, width = 0, height = 0): void {
    if (!texture || !(width > 0) || !(height > 0)) {
      this.background?.quad.destroy();
      this.background = null;
      return;
    }
    const frame = { ox: 0, oy: 0, ux: width, uy: 0, vx: 0, vy: height, footX: 0, footY: height };
    if (this.background?.texture !== texture) {
      this.background?.quad.destroy();
      this.background = { texture, frame, quad: new BurnPreviewQuad(texture) };
    }
    this.background!.frame = frame;
  }

  sync(instances: readonly BurnInstanceInput[], _nowMs: number): void {
    const want = new Set(instances.map((i) => i.key));
    for (const key of this.views.keys()) if (!want.has(key)) this.drop(key);
    const order: Container[] = [];
    if (this.background) {
      this.place(this.background, null);
      order.push(this.background.quad.mesh);
    }
    for (const inst of instances) {
      let view = this.views.get(inst.key);
      if (view?.texture !== inst.texture) {
        this.drop(inst.key);
        view = { texture: inst.texture, frame: frameOfInput(inst), quad: new BurnPreviewQuad(inst.texture) };
        this.views.set(inst.key, view);
      }
      view!.frame = frameOfInput(inst);
      this.place(view!, inst.burn);
      order.push(view!.quad.mesh);
    }
    order.forEach((node, i) => {
      if (node.parent !== this.world) this.world.addChildAt(node, i);
      else if (this.world.getChildIndex(node) !== i) this.world.setChildIndex(node, i);
    });
  }

  retain(keep: (key: string) => boolean): void {
    for (const key of this.views.keys()) if (!keep(key)) this.drop(key);
  }
  forgetTexture(texture: Texture | null): void {
    if (!texture) return;
    if (this.background?.texture === texture) this.setBackground(null);
    for (const [key, view] of this.views) if (view.texture === texture) this.drop(key);
  }
  frameOf(key: string): BurnFrame | null { return this.views.get(key)?.frame ?? null; }
  burning(key: string): boolean { return this.views.get(key)?.quad.burning ?? false; }
  keys(): string[] { return [...this.views.keys()]; }
  destroy(): void {
    for (const key of this.views.keys()) this.drop(key);
    this.setBackground(null);
    this.root.destroy({ children: true });
  }
  private place(view: View, burn: BurnFieldInput | null): void {
    view.quad.place(view.frame, this.camera, this.screen);
    view.quad.setBurn(burn);
  }
  private drop(key: string): void {
    this.views.get(key)?.quad.destroy();
    this.views.delete(key);
  }
}

function frameOfInput(inst: BurnInstanceInput): BurnFrame {
  if (inst.kind === 'frame') return inst.frame;
  const def = inst.def;
  // Same pure placement functions as the legacy viewer's P.sc.items; no Sprite/filter transforms.
  return burnPlacementFrame(burnEntityPlacement(def,
    { width: def.displayImage.worldWidth, height: def.displayImage.worldHeight }, {
      depthScale: def.perspectiveScaleEnabled === true ? inst.perspective?.scaleAt(def.x, def.y) ?? 1 : 1,
      flipX: def.displayImage.facing === 'left',
    }));
}

export function artHotspotDef(image: string, width: number, height: number): BurnHotspotInput['def'] {
  return { id: '__template__', x: width / 2, y: height, displayImage: { image, worldWidth: width, worldHeight: height } };
}
