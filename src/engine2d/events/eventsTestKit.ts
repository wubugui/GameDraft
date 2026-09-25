/**
 * 事件模块单测的公共件(只给 *.test.ts 用,运行时不引用):
 * - 场景描述 → 同一棵树分别用 engine2d 与 Pixi 搭出来(Pixi 的模块由测试文件传进来,本文件不引入 Pixi);
 * - 监听记录器:把每个节点收到的事件按「节点.监听键@阶段>目标」记成字符串,两边逐条比对;
 * - 假 DOM:画布 / document / window 的监听表、假的 Mouse/Pointer/WheelEvent、可控的 getBoundingClientRect。
 */
import { Container, type EventMode } from '../scene/Container';
import { Sprite } from '../sprite/Sprite';
import { Texture } from '../textures/Texture';
import { Rectangle } from '../math/Rectangle';
import { EventBoundary } from './EventBoundary';
import { FederatedPointerEvent } from './FederatedPointerEvent';
import { FederatedWheelEvent } from './FederatedWheelEvent';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ───────────────────────── 场景

/** 两个库的节点共有的那部分接口(测试里只用这些) */
export interface NodeLike {
  label: string | null;
  eventMode: string;
  cursor?: string | null;
  hitArea: unknown;
  interactiveChildren: boolean;
  visible: boolean;
  renderable: boolean;
  mask: unknown;
  parent: NodeLike | null;
  readonly children: readonly NodeLike[];
  x: number;
  y: number;
  rotation: number;
  scale: { set(x: number, y?: number): void };
  addChild(...c: NodeLike[]): unknown;
  removeChild(...c: NodeLike[]): unknown;
  on(type: string, fn: (...args: any[]) => void, ctx?: unknown): unknown;
  once(type: string, fn: (...args: any[]) => void, ctx?: unknown): unknown;
  addEventListener(type: string, fn: (e: any) => void, options?: boolean | AddEventListenerOptions): void;
  dispatchEvent(e: any): boolean;
}

/** EventBoundary 两边共有的那部分接口 */
export interface BoundaryLike {
  rootTarget: any;
  mapEvent(e: any): void;
  hitTest(x: number, y: number): NodeLike | null | undefined;
  dispatchEvent(e: any, type?: string): void;
  moveOnAll: boolean;
  enableGlobalMoveEvents: boolean;
  cursor: unknown;
}

/** 联邦指针 / 滚轮事件两边共有的那部分接口 */
export interface FederatedLike {
  type: string;
  pointerId: number;
  pointerType: string;
  button: number;
  buttons: number;
  isPrimary: boolean;
  width: number;
  height: number;
  pressure: number;
  tangentialPressure: number;
  tiltX: number;
  tiltY: number;
  twist: number;
  deltaX: number;
  deltaY: number;
  deltaZ: number;
  deltaMode: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isTrusted: boolean;
  detail: number;
  nativeEvent: any;
  global: { set(x: number, y?: number): void };
  screen: { set(x: number, y?: number): void };
  offset: { set(x: number, y?: number): void };
  client: { set(x: number, y?: number): void };
  movement: { set(x: number, y?: number): void };
  page: { set(x: number, y?: number): void };
  layer: { set(x: number, y?: number): void };
}

/** 库适配器:同一份场景描述在两个库里各搭一遍 */
export interface SceneLib {
  readonly name: 'engine2d' | 'pixi';
  /** 场景根(Pixi 那边是渲染组,才能在不渲染的情况下算世界变换) */
  root(): NodeLike;
  container(): NodeLike;
  /** w×h 的精灵(白纹理拉伸,命中按包围盒) */
  sprite(w: number, h: number, anchor?: number): NodeLike;
  rect(x: number, y: number, w: number, h: number): { contains(x: number, y: number): boolean };
  /** 让世界变换跟上当前的本地变换(Pixi 要等渲染才更新;engine2d 现算,空操作) */
  sync(root: NodeLike): void;
  boundary(root: NodeLike): BoundaryLike;
  pointerEvent(): FederatedLike;
  wheelEvent(): FederatedLike;
}

/** engine2d 的适配器 */
export const engine2dLib: SceneLib = {
  name: 'engine2d',
  root: () => new Container() as unknown as NodeLike,
  container: () => new Container() as unknown as NodeLike,
  sprite(w, h, anchor) {
    const s = new Sprite(Texture.WHITE);
    s.width = w;
    s.height = h;
    if (anchor !== undefined) s.anchor.set(anchor);
    return s as unknown as NodeLike;
  },
  rect: (x, y, w, h) => new Rectangle(x, y, w, h),
  sync: () => {},
  boundary: (root) => new EventBoundary(root as unknown as Container) as unknown as BoundaryLike,
  pointerEvent: () => new FederatedPointerEvent(null!) as unknown as FederatedLike,
  wheelEvent: () => new FederatedWheelEvent(null!) as unknown as FederatedLike,
};

/** Pixi 的适配器(Pixi 模块由测试文件传入,本文件不引入 Pixi) */
export function makePixiLib(PIXI: any): SceneLib {
  return {
    name: 'pixi',
    root: () => new PIXI.Container({ isRenderGroup: true }),
    container: () => new PIXI.Container(),
    sprite(w, h, anchor) {
      const s = new PIXI.Sprite(PIXI.Texture.WHITE);
      s.width = w;
      s.height = h;
      if (anchor !== undefined) s.anchor.set(anchor);
      return s;
    },
    rect: (x, y, w, h) => new PIXI.Rectangle(x, y, w, h),
    sync: (root) => PIXI.updateRenderGroupTransforms((root as any).renderGroup, true),
    boundary: (root) => new PIXI.EventBoundary(root),
    pointerEvent: () => new PIXI.FederatedPointerEvent(null),
    wheelEvent: () => new PIXI.FederatedWheelEvent(null),
  };
}

export interface NodeSpec {
  label: string;
  /** 精灵尺寸;不给就是纯容器 */
  sprite?: [number, number];
  anchor?: number;
  x?: number;
  y?: number;
  scale?: number | [number, number];
  rotation?: number;
  eventMode?: EventMode;
  hitArea?: [number, number, number, number];
  interactiveChildren?: boolean;
  visible?: boolean;
  renderable?: boolean;
  cursor?: string;
  /** 用树里某个节点(按 label)做本节点的遮罩 */
  mask?: string;
  children?: NodeSpec[];
}

export interface BuiltScene {
  root: NodeLike;
  nodes: Map<string, NodeLike>;
  get(label: string): NodeLike;
}

export function buildScene(lib: SceneLib, spec: NodeSpec): BuiltScene {
  const nodes = new Map<string, NodeLike>();
  const masks: Array<[NodeLike, string]> = [];

  const make = (s: NodeSpec, isRoot: boolean): NodeLike => {
    const n = isRoot ? lib.root() : s.sprite ? lib.sprite(s.sprite[0], s.sprite[1], s.anchor) : lib.container();
    n.label = s.label;
    if (s.x !== undefined) n.x = s.x;
    if (s.y !== undefined) n.y = s.y;
    if (s.scale !== undefined) typeof s.scale === 'number' ? n.scale.set(s.scale, s.scale) : n.scale.set(s.scale[0], s.scale[1]);
    if (s.rotation !== undefined) n.rotation = s.rotation;
    n.eventMode = s.eventMode ?? 'passive';
    if (s.hitArea) n.hitArea = lib.rect(...s.hitArea);
    if (s.interactiveChildren !== undefined) n.interactiveChildren = s.interactiveChildren;
    if (s.visible !== undefined) n.visible = s.visible;
    if (s.renderable !== undefined) n.renderable = s.renderable;
    if (s.cursor !== undefined) n.cursor = s.cursor;
    if (s.mask) masks.push([n, s.mask]);
    nodes.set(s.label, n);
    for (const c of s.children ?? []) n.addChild(make(c, false));
    return n;
  };

  const root = make(spec, true);
  for (const [n, m] of masks) n.mask = nodes.get(m);
  lib.sync(root);

  return {
    root,
    nodes,
    get(label: string): NodeLike {
      const n = nodes.get(label);
      if (!n) throw new Error(`no node ${label}`);
      return n;
    },
  };
}

// ───────────────────────── 记录器

export const RECORDED_TYPES = [
  'pointerdown', 'pointerup', 'pointerupoutside', 'pointermove', 'pointerover', 'pointerout',
  'pointerenter', 'pointerleave', 'pointertap', 'pointercancel',
  'mousedown', 'mouseup', 'mouseupoutside', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave',
  'click', 'rightclick', 'rightdown', 'rightup', 'rightupoutside',
  'touchstart', 'touchend', 'touchendoutside', 'touchmove', 'tap',
  'wheel', 'globalpointermove', 'globalmousemove', 'globaltouchmove',
] as const;

const PHASE = ['none', 'capture', 'target', 'bubble'];

function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** 一条记录:`节点.监听键@阶段>目标 (gx,gy)`,click 族另记 detail,wheel 另记 deltaY */
export function describeEvent(node: string, key: string, e: any): string {
  const target = e.target?.label ?? String(e.target);
  let s = `${node}.${key}@${PHASE[e.eventPhase] ?? e.eventPhase}>${target} (${fmt(e.global.x)},${fmt(e.global.y)})`;
  if (/click|tap/.test(key)) s += ` d${e.detail}`;
  if (key.startsWith('wheel')) s += ` dy${e.deltaY}`;
  return s;
}

/** 给场景里每个节点挂上所有类型(含 capture)的记录监听 */
export function recordAll(scene: BuiltScene, log: string[], types: readonly string[] = RECORDED_TYPES, withCapture = true): void {
  for (const [label, node] of scene.nodes) {
    for (const t of types) {
      node.on(t, (e: any) => log.push(describeEvent(label, t, e)));
      if (withCapture && !t.startsWith('global')) node.on(`${t}capture`, (e: any) => log.push(describeEvent(label, `${t}capture`, e)));
    }
  }
}

// ───────────────────────── 直接喂 EventBoundary 的驱动(照 EventSystem._bootstrapEvent 填根事件)

export interface PointerInit {
  button?: number;
  buttons?: number;
  pointerType?: string;
  pointerId?: number;
}

export class BoundaryDriver {
  constructor(
    readonly lib: SceneLib,
    readonly scene: BuiltScene,
    readonly boundary: BoundaryLike,
  ) {}

  private _root(type: string, x: number, y: number, init: PointerInit = {}): FederatedLike {
    const e = this.lib.pointerEvent();
    e.nativeEvent = { type, clientX: x, clientY: y };
    e.pointerId = init.pointerId ?? 1;
    e.width = 1;
    e.height = 1;
    e.isPrimary = true;
    e.pointerType = init.pointerType ?? 'mouse';
    e.pressure = 0.5;
    e.tangentialPressure = 0;
    e.tiltX = 0;
    e.tiltY = 0;
    e.twist = 0;
    e.isTrusted = true;
    e.type = type;
    e.altKey = false;
    e.ctrlKey = false;
    e.metaKey = false;
    e.shiftKey = false;
    e.button = init.button ?? 0;
    e.buttons = init.buttons ?? 0;
    e.client.set(x, y);
    e.movement.set(0, 0);
    e.page.set(x, y);
    e.screen.set(x, y);
    e.global.set(x, y);
    e.offset.set(x, y);
    return e;
  }

  private _map(e: FederatedLike): void {
    this.lib.sync(this.scene.root);
    this.boundary.mapEvent(e);
  }

  move(x: number, y: number, init?: PointerInit): void {
    this._map(this._root('pointermove', x, y, init));
  }

  down(x: number, y: number, init?: PointerInit): void {
    this._map(this._root('pointerdown', x, y, { buttons: 1, ...init }));
  }

  up(x: number, y: number, init?: PointerInit): void {
    this._map(this._root('pointerup', x, y, init));
  }

  upOutside(x: number, y: number, init?: PointerInit): void {
    this._map(this._root('pointerupoutside', x, y, init));
  }

  over(x: number, y: number, init?: PointerInit): void {
    this._map(this._root('pointerover', x, y, init));
  }

  out(x: number, y: number, init?: PointerInit): void {
    this._map(this._root('pointerout', x, y, init));
  }

  wheel(x: number, y: number, deltaY: number): void {
    const e = this.lib.wheelEvent();
    e.nativeEvent = { type: 'wheel', clientX: x, clientY: y };
    e.type = 'wheel';
    e.isTrusted = true;
    e.altKey = false;
    e.ctrlKey = false;
    e.metaKey = false;
    e.shiftKey = false;
    e.button = 0;
    e.buttons = 0;
    e.client.set(x, y);
    e.movement.set(0, 0);
    e.page.set(x, y);
    e.deltaX = 0;
    e.deltaY = deltaY;
    e.deltaZ = 0;
    e.deltaMode = 0;
    e.screen.set(x, y);
    e.global.set(x, y);
    e.offset.set(x, y);
    this._map(e);
  }

  click(x: number, y: number, init?: PointerInit): void {
    this.down(x, y, init);
    this.up(x, y, init);
  }
}

// ───────────────────────── 假 DOM

type Listener = { fn: (e: any) => void; capture: boolean };

export class FakeEventTarget {
  private readonly _listeners = new Map<string, Listener[]>();

  addEventListener(type: string, fn: (e: any) => void, options?: boolean | AddEventListenerOptions): void {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    const list = this._listeners.get(type) ?? [];
    if (list.some((l) => l.fn === fn && l.capture === capture)) return;
    list.push({ fn, capture });
    this._listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (e: any) => void, options?: boolean | EventListenerOptions): void {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    const list = this._listeners.get(type);
    if (!list) return;
    const kept = list.filter((l) => !(l.fn === fn && l.capture === capture));
    if (kept.length) this._listeners.set(type, kept);
    else this._listeners.delete(type);
  }

  dispatchEvent(e: any): boolean {
    if (e.target === undefined || e.target === null) e.target = this;
    for (const l of (this._listeners.get(e.type) ?? []).slice()) l.fn.call(this, e);
    return true;
  }

  listenerCount(type?: string): number {
    if (type) return this._listeners.get(type)?.length ?? 0;
    let n = 0;
    for (const l of this._listeners.values()) n += l.length;
    return n;
  }
}

export class FakeCanvas extends FakeEventTarget {
  width: number;
  height: number;
  readonly style: Record<string, string> = {};
  isConnected = true;
  rect = { left: 0, top: 0, width: 0, height: 0 };

  constructor(width: number, height: number) {
    super();
    this.width = width;
    this.height = height;
    this.rect.width = width;
    this.rect.height = height;
  }

  getBoundingClientRect(): { x: number; y: number; left: number; top: number; width: number; height: number; right: number; bottom: number } {
    const r = this.rect;
    return { x: r.left, y: r.top, left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height };
  }
}

const MOUSE_DEFAULTS = {
  clientX: 0, clientY: 0, button: 0, buttons: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
  movementX: 0, movementY: 0, pageX: 0, pageY: 0, isTrusted: true, srcElement: null, cancelable: true,
};

export class FakeMouseEvent {
  type: string;
  target: unknown = null;
  defaultPrevented = false;
  declare clientX: number;
  declare clientY: number;
  declare button: number;
  declare buttons: number;
  declare cancelable: boolean;

  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    Object.assign(this, MOUSE_DEFAULTS, init);
    this.type = type;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  composedPath(): unknown[] {
    return this.target ? [this.target] : [];
  }

  getModifierState(): boolean {
    return false;
  }
}

export class FakePointerEvent extends FakeMouseEvent {
  constructor(type: string, init: Record<string, unknown> = {}) {
    super(type, {
      pointerId: 1, pointerType: 'mouse', width: 1, height: 1, isPrimary: true, pressure: 0,
      tangentialPressure: 0, tiltX: 0, tiltY: 0, twist: 0, ...init,
    });
  }
}

export class FakeWheelEvent extends FakeMouseEvent {
  constructor(type: string, init: Record<string, unknown> = {}) {
    super(type, { deltaX: 0, deltaY: 0, deltaZ: 0, deltaMode: 0, ...init });
  }
}

/** 一套假浏览器环境(document / window / 事件类 / rAF);由测试用 vi.stubGlobal 装上 */
export interface FakeDom {
  document: FakeEventTarget;
  window: FakeEventTarget;
  canvas: FakeCanvas;
  other: FakeEventTarget;
}

export function createFakeDom(width = 800, height = 600): FakeDom {
  return { document: new FakeEventTarget(), window: new FakeEventTarget(), canvas: new FakeCanvas(width, height), other: new FakeEventTarget() };
}

/** 通过假 DOM 喂原生事件的驱动(pointermove 发到 document,pointerup 发到 window,其余发到画布) */
export class DomDriver {
  constructor(
    readonly dom: FakeDom,
    readonly sync: () => void,
  ) {}

  private _pointer(type: string, x: number, y: number, init: Record<string, unknown>, target: unknown): FakePointerEvent {
    return new FakePointerEvent(type, { clientX: x, clientY: y, pageX: x, pageY: y, ...init, target });
  }

  move(x: number, y: number, init: Record<string, unknown> = {}): FakePointerEvent {
    this.sync();
    const e = this._pointer('pointermove', x, y, init, this.dom.canvas);
    this.dom.document.dispatchEvent(e);
    return e;
  }

  down(x: number, y: number, init: Record<string, unknown> = {}): FakePointerEvent {
    this.sync();
    const e = this._pointer('pointerdown', x, y, { buttons: 1, ...init }, this.dom.canvas);
    this.dom.canvas.dispatchEvent(e);
    return e;
  }

  /** `outside` 为 true 时原生事件的目标不是画布(在画布外松开) */
  up(x: number, y: number, init: Record<string, unknown> = {}, outside = false): FakePointerEvent {
    this.sync();
    const e = this._pointer('pointerup', x, y, init, outside ? this.dom.other : this.dom.canvas);
    this.dom.window.dispatchEvent(e);
    return e;
  }

  over(x: number, y: number, init: Record<string, unknown> = {}): void {
    this.sync();
    this.dom.canvas.dispatchEvent(this._pointer('pointerover', x, y, init, this.dom.canvas));
  }

  leave(x: number, y: number, init: Record<string, unknown> = {}): void {
    this.sync();
    this.dom.canvas.dispatchEvent(this._pointer('pointerleave', x, y, init, this.dom.canvas));
  }

  wheel(x: number, y: number, deltaY: number): void {
    this.sync();
    this.dom.canvas.dispatchEvent(new FakeWheelEvent('wheel', { clientX: x, clientY: y, deltaY, target: this.dom.canvas }));
  }

  mouse(type: string, x: number, y: number, init: Record<string, unknown> = {}, where: 'canvas' | 'document' | 'window' = 'canvas'): FakeMouseEvent {
    this.sync();
    const e = new FakeMouseEvent(type, { clientX: x, clientY: y, pageX: x, pageY: y, ...init, target: this.dom.canvas });
    this.dom[where].dispatchEvent(e);
    return e;
  }
}
