/**
 * EventSystem 单测:假 DOM(画布 / document / window、假 Pointer/Mouse/Wheel/TouchEvent、可控的
 * getBoundingClientRect)上跑 engine2d 与 Pixi 8.17 的 EventSystem,喂同样的原生事件,
 * 比对派发序列、坐标换算、光标;另有 engine2d 的显式断言。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import 'pixi.js/events';
import { Container } from '../scene/Container';
import { Rectangle } from '../math/Rectangle';
import { Point } from '../math/Point';
import { Ticker } from '../ticker/Ticker';
import type { RendererEventSystem } from '../gpu/Renderer';
import { EventSystem } from './EventSystem';
import { EventsTicker } from './EventTicker';
import type { FederatedPointerEvent } from './FederatedPointerEvent';
import {
  DomDriver,
  FakeMouseEvent,
  FakePointerEvent,
  buildScene,
  createFakeDom,
  engine2dLib,
  makePixiLib,
  recordAll,
  type BuiltScene,
  type FakeDom,
  type NodeSpec,
  type SceneLib,
} from './eventsTestKit';

/* eslint-disable @typescript-eslint/no-explicit-any */

const pixiLib = makePixiLib(PIXI);
const LIBS: SceneLib[] = [engine2dLib, pixiLib];

interface DomOptions {
  /** 有没有 PointerEvent(没有就走 mouse / touch 监听) */
  pointer?: boolean;
  /** 有没有触摸('ontouchstart' in globalThis) */
  touch?: boolean;
}

class FakeTouchEvent {
  type: string;
  changedTouches: any[];
  touches: any[];
  target: unknown = null;
  altKey = false;
  ctrlKey = false;
  metaKey = false;
  shiftKey = false;
  cancelable = true;
  defaultPrevented = false;

  constructor(type: string, init: { changedTouches: any[]; touches?: any[]; target?: unknown }) {
    this.type = type;
    this.changedTouches = init.changedTouches;
    this.touches = init.touches ?? [];
    this.target = init.target ?? null;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  composedPath(): unknown[] {
    return this.target ? [this.target] : [];
  }
}

function installDom(opts: DomOptions = {}): FakeDom {
  const dom = createFakeDom(1600, 1200);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('addEventListener', dom.window.addEventListener.bind(dom.window));
  vi.stubGlobal('removeEventListener', dom.window.removeEventListener.bind(dom.window));
  vi.stubGlobal('MouseEvent', FakeMouseEvent);
  vi.stubGlobal('PointerEvent', opts.pointer === false ? undefined : FakePointerEvent);
  if (opts.touch) {
    vi.stubGlobal('ontouchstart', null);
    vi.stubGlobal('TouchEvent', FakeTouchEvent);
  }
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  return dom;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 画布:1600×1200 像素、分辨率 2(screen 800×600),CSS 显示成 400×300 放在 (10, 20) */
const RES = 2;
const RECT = { left: 10, top: 20, width: 400, height: 300 };
/** 世界坐标 → 客户区坐标 */
const cx = (gx: number): number => gx / 2 + RECT.left;
const cy = (gy: number): number => gy / 2 + RECT.top;

const SCENE: NodeSpec = {
  label: 'stage',
  children: [
    { label: 'bg', sprite: [800, 600], eventMode: 'static' },
    {
      label: 'panel', x: 100, y: 100, eventMode: 'static', hitArea: [0, 0, 300, 200], cursor: 'pointer',
      children: [
        { label: 'btnA', sprite: [100, 50], x: 10, y: 10, eventMode: 'static', cursor: 'grab' },
        { label: 'btnB', sprite: [100, 50], x: 150, y: 10, eventMode: 'static', cursor: 'fancy' },
        { label: 'btnC', sprite: [100, 50], x: 150, y: 100, eventMode: 'static', cursor: 'styled' },
      ],
    },
    { label: 'dyn', sprite: [50, 50], x: 300, y: 300, eventMode: 'dynamic' },
  ],
};

let clock = performance.now() + 1e7;

interface DomRun {
  lib: SceneLib;
  scene: BuiltScene;
  dom: FakeDom;
  events: any;
  driver: DomDriver;
  log: string[];
  /** 驱动该库的 Ticker.system 走一帧(100ms) */
  tick(): void;
}

interface RunOptions extends DomOptions {
  record?: 'all' | 'plain' | 'none';
  spec?: NodeSpec;
  resolution?: number;
  rect?: typeof RECT;
  eventSystemOptions?: Record<string, unknown>;
}

/** 两个库各跑一遍,断言记录逐条相同,返回 engine2d 的记录 */
function runDomBoth(scenario: (r: DomRun) => void, opts: RunOptions = {}): string[] {
  const logs: Record<string, string[]> = {};
  for (const lib of LIBS) {
    const dom = installDom(opts);
    Object.assign(dom.canvas.rect, opts.rect ?? RECT);
    const scene = buildScene(lib, opts.spec ?? SCENE);
    const renderer = { canvas: dom.canvas, resolution: opts.resolution ?? RES, lastObjectRendered: scene.root };
    const events = lib.name === 'pixi' ? new PIXI.EventSystem(renderer as any) : new EventSystem(renderer as any);
    events.init(opts.eventSystemOptions ?? {});
    const log: string[] = [];
    if ((opts.record ?? 'plain') !== 'none') recordAll(scene, log, undefined, opts.record === 'all');
    const ticker = lib.name === 'pixi' ? PIXI.Ticker.system : Ticker.system;
    const driver = new DomDriver(dom, () => lib.sync(scene.root));
    try {
      scenario({ lib, scene, dom, events, driver, log, tick: () => ticker.update((clock += 100)) });
    } finally {
      events.destroy();
      vi.unstubAllGlobals();
    }
    logs[lib.name] = log;
  }
  expect(logs.engine2d).toEqual(logs.pixi);
  return logs.engine2d;
}

function plain(log: string[]): string[] {
  return log.filter((s) => !/capture@|^[^.]+\.global/.test(s));
}

describe('EventSystem 坐标换算', () => {
  const cases: Array<{ res: number; rect: typeof RECT; connected: boolean }> = [
    { res: 1, rect: { left: 0, top: 0, width: 1600, height: 1200 }, connected: true },
    { res: 2, rect: RECT, connected: true },
    { res: 1.5, rect: { left: -33.5, top: 7.25, width: 1234, height: 777 }, connected: true },
    { res: 2, rect: RECT, connected: false },
  ];

  it('mapPositionToPoint 与 Pixi 相同(分辨率 ≠ 1、CSS 缩放、偏移、未挂到文档)', () => {
    for (const c of cases) {
      const out: Record<string, number[]> = {};
      for (const lib of LIBS) {
        const dom = installDom();
        Object.assign(dom.canvas.rect, c.rect);
        dom.canvas.isConnected = c.connected;
        const renderer = { canvas: dom.canvas, resolution: c.res, lastObjectRendered: null };
        const events = lib.name === 'pixi' ? new PIXI.EventSystem(renderer as any) : new EventSystem(renderer as any);
        events.init({});
        const vals: number[] = [];
        for (const [x, y] of [[0, 0], [10, 20], [110, 95], [411.5, 318.25], [-5, 1000]]) {
          const p = new Point();
          events.mapPositionToPoint(p, x, y);
          vals.push(p.x, p.y);
        }
        out[lib.name] = vals;
        events.destroy();
        vi.unstubAllGlobals();
      }
      expect(out.engine2d).toEqual(out.pixi);
    }
  });

  it('具体数值:CSS 缩小一半 + 分辨率 2 → 客户区位移 ×2', () => {
    const dom = installDom();
    Object.assign(dom.canvas.rect, RECT);
    const events = new EventSystem({ canvas: dom.canvas as never, resolution: RES, lastObjectRendered: null });
    events.init();
    const p = new Point();
    events.mapPositionToPoint(p, 110, 95);
    expect([p.x, p.y]).toEqual([200, 150]);
    events.resolutionChange(1);
    events.mapPositionToPoint(p, 110, 95);
    expect([p.x, p.y]).toEqual([400, 300]);
    dom.canvas.isConnected = false;
    events.mapPositionToPoint(p, 110, 95);
    expect([p.x, p.y]).toEqual([110, 95]);
    events.destroy();
  });

  it('联邦事件带上 global / screen / client', () => {
    runDomBoth(({ driver, scene, log }) => {
      scene.get('btnA').on('pointerdown', (e: any) => {
        log.push(`g ${e.global.x},${e.global.y} s ${e.screen.x},${e.screen.y} c ${e.client.x},${e.client.y} x ${e.x},${e.y}`);
      });
      driver.down(cx(120), cy(130));
    }, { record: 'none' });
  });
});

describe('EventSystem 端到端(与 Pixi 逐条比对)', () => {
  it('悬停 / 点击 / 拖出画布松开 / 滚轮 / 离开画布,含光标变化', () => {
    const log = runDomBoth(({ driver, dom, log }) => {
      const cursor = (): void => {
        log.push(`cursor=${dom.canvas.style.cursor}`);
      };
      driver.over(cx(50), cy(50));
      cursor();
      driver.move(cx(50), cy(50));
      cursor();
      driver.move(cx(120), cy(120));
      cursor();
      driver.down(cx(120), cy(120));
      driver.up(cx(120), cy(120));
      cursor();
      driver.move(cx(390), cy(290));
      cursor();
      driver.down(cx(120), cy(120));
      driver.move(cx(900), cy(700));
      driver.up(cx(900), cy(700), {}, true);
      cursor();
      driver.wheel(cx(260), cy(120), 42);
      driver.leave(cx(900), cy(700));
      cursor();
    });
    const step = plain(log);
    expect(step).toContain('btnA.pointertap@target>btnA (120,120) d1');
    expect(step).toContain('btnA.pointerupoutside@none>undefined (900,700)');
    expect(step).toContain('panel.pointerupoutside@none>undefined (900,700)');
    expect(step).toContain('btnB.wheel@target>btnB (260,120) dy42');
    expect(step.filter((s) => s.startsWith('cursor='))).toEqual([
      'cursor=inherit', // pointerover 不是鼠标移动:cursor 取目标的(bg 无)→ default → inherit
      'cursor=inherit',
      'cursor=grab', // cursorStyles 里没有的字符串直接当 CSS
      'cursor=grab',
      'cursor=pointer', // panel 的 hitArea 空白处
      'cursor=inherit',
      'cursor=inherit',
    ]);
  });

  it('cursorStyles:字符串 / 函数 / 样式对象', () => {
    const log = runDomBoth(({ driver, dom, events, log }) => {
      events.cursorStyles.fancy = (mode: string) => log.push(`fn(${mode})`);
      events.cursorStyles.styled = { cursor: 'wait', outline: '1px solid red' };
      events.cursorStyles.grab = 'move';
      driver.move(cx(120), cy(120));
      log.push(`cursor=${dom.canvas.style.cursor}`);
      driver.move(cx(260), cy(120));
      driver.move(cx(261), cy(121)); // 模式没变:函数不再调
      driver.move(cx(260), cy(210));
      log.push(`cursor=${dom.canvas.style.cursor} outline=${dom.canvas.style.outline}`);
      events.setCursor(null);
      log.push(`cursor=${dom.canvas.style.cursor}`);
    }, { record: 'none' });
    expect(log).toEqual(['cursor=move', 'fn(fancy)', 'cursor=wait outline=1px solid red', 'cursor=inherit']);
  });

  it('features 开关', () => {
    const log = runDomBoth(({ driver, events, log }) => {
      events.features.click = false;
      driver.down(cx(120), cy(120));
      driver.up(cx(120), cy(120));
      events.features.click = true;
      events.features.move = false;
      driver.move(cx(260), cy(120));
      events.features.move = true;
      events.features.globalMove = false;
      log.push(`global=${events.rootBoundary.enableGlobalMoveEvents}`);
      driver.move(cx(260), cy(120));
      events.features.wheel = false;
      driver.wheel(cx(260), cy(120), 5);
    }, { record: 'all' });
    expect(log.some((s) => /\.(pointerdown|pointerup|wheel|global)/.test(s))).toBe(false);
    expect(log).toContain('global=false');
    expect(log).toContain('btnB.pointerover@target>btnB (260,120)');
  });

  it('init 选项:eventFeatures / eventMode', () => {
    runDomBoth(({ driver, events, log }) => {
      log.push(`global=${events.rootBoundary.enableGlobalMoveEvents} wheel=${events.features.wheel} mode=${events.constructor.defaultEventMode}`);
      driver.move(cx(120), cy(120));
    }, { record: 'all', eventSystemOptions: { eventFeatures: { globalMove: false, wheel: false }, eventMode: 'static' } });
  });

  it('没有 PointerEvent:走 mouse 监听,规范化出指针字段并 preventDefault', () => {
    const log = runDomBoth(({ driver, scene, log }) => {
      scene.get('btnA').on('pointerdown', (e: any) => {
        log.push(`${e.pointerType} id${e.pointerId} primary=${e.isPrimary} w${e.width} p${e.pressure} native=${e.nativeEvent.type}`);
      });
      const down = driver.mouse('mousedown', cx(120), cy(120), { buttons: 1 });
      log.push(`prevented=${down.defaultPrevented}`);
      driver.mouse('mousemove', cx(125), cy(125), {}, 'document');
      driver.mouse('mouseup', cx(125), cy(125), {}, 'window');
      driver.mouse('mouseout', cx(125), cy(125));
    }, { pointer: false, record: 'plain' });
    expect(log).toContain('mouse id1 primary=true w1 p0.5 native=mousedown');
    expect(log).toContain('prevented=true');
    expect(log).toContain('btnA.pointertap@target>btnA (125,125) d1');
    expect(log).toContain('btnA.pointerleave@target>btnA (125,125)');
  });

  it('autoPreventDefault=false 时不取消规范化事件', () => {
    runDomBoth(({ driver, events, log }) => {
      events.autoPreventDefault = false;
      const down = driver.mouse('mousedown', cx(120), cy(120), { buttons: 1 });
      log.push(`prevented=${down.defaultPrevented}`);
    }, { pointer: false, record: 'none' });
  });

  it('没有 PointerEvent 但有触摸:touchstart / touchmove / touchend,每个 changedTouch 一个指针', () => {
    const log = runDomBoth(({ dom, lib, scene, log }) => {
      const touch = (id: number, gx: number, gy: number): any => ({
        identifier: id, clientX: cx(gx), clientY: cy(gy), pageX: cx(gx), pageY: cy(gy), radiusX: 3, radiusY: 4, force: 0.8,
      });
      scene.get('panel').on('touchstart', (e: any) => {
        log.push(`${e.pointerType} id${e.pointerId} primary=${e.isPrimary} ${e.width}x${e.height} p${e.pressure}`);
      });
      const send = (target: 'canvas', type: string, changed: any[], touches: any[]): void => {
        lib.sync(scene.root);
        dom[target].dispatchEvent(new FakeTouchEvent(type, { changedTouches: changed, touches, target: dom.canvas }));
      };
      const t1 = touch(5, 120, 120);
      const t2 = touch(6, 260, 120);
      send('canvas', 'touchstart', [t1], [t1]);
      send('canvas', 'touchstart', [t2], [t1, t2]);
      send('canvas', 'touchmove', [touch(5, 125, 125)], [t1, t2]);
      send('canvas', 'touchend', [touch(5, 125, 125), touch(6, 900, 700)], []);
    }, { pointer: false, touch: true, record: 'plain' });
    expect(log).toContain('touch id5 primary=true 3x4 p0.8');
    expect(log).toContain('touch id6 primary=false 3x4 p0.8');
    expect(log).toContain('btnA.tap@target>btnA (125,125) d1');
    expect(log).toContain('btnB.touchendoutside@none>undefined (900,700)');
  });

  it('EventsTicker:指针不动、dynamic 物体移到指针下,补发的 pointermove 触发 over', () => {
    const log = runDomBoth(({ driver, scene, lib, tick, log }) => {
      driver.move(cx(100), cy(100));
      const dyn = scene.get('dyn');
      dyn.x = 80;
      dyn.y = 80;
      lib.sync(scene.root);
      log.push('--moved');
      tick();
      tick(); // 第一次到点:刚移动过,只清标记
      log.push('--consumed');
      tick();
      tick(); // 第二次到点:补发
      log.push('--done');
    });
    const i = log.indexOf('--consumed');
    expect(log.indexOf('--moved') + 1).toBe(i);
    const after = plain(log.slice(i));
    expect(after).toContain('dyn.pointerover@target>dyn (100,100)');
    expect(after).toContain('panel.pointerout@target>panel (100,100)');
  });

  it('只有 static 节点时不补发', () => {
    const log = runDomBoth(({ driver, scene, lib, tick, log }) => {
      driver.move(cx(100), cy(100));
      const a = scene.get('btnA');
      a.x = -20;
      a.y = -20;
      lib.sync(scene.root);
      for (let i = 0; i < 6; i++) tick();
      log.push('--end');
    }, { spec: { ...SCENE, children: SCENE.children!.filter((c) => c.label !== 'dyn') } });
    expect(plain(log).filter((s) => s.startsWith('btnA.pointerover'))).toEqual([]);
  });
});

describe('EventSystem 生命周期', () => {
  it('init 挂上监听与 ticker;destroy / setTargetElement(null) 全部摘掉', () => {
    const dom = installDom();
    const before = Ticker.system.count;
    const events = new EventSystem({ canvas: dom.canvas as never, resolution: 1, lastObjectRendered: null });
    expect(dom.canvas.listenerCount()).toBe(0);
    // 满足渲染器上的最小接口(编译期检查)
    const asRendererEvents: RendererEventSystem = events;
    expect(asRendererEvents.resolution).toBe(1);
    events.init();
    expect(events.domElement).toBe(dom.canvas);
    expect(dom.canvas.listenerCount('pointerdown')).toBe(1);
    expect(dom.canvas.listenerCount('pointerover')).toBe(1);
    expect(dom.canvas.listenerCount('pointerleave')).toBe(1);
    expect(dom.canvas.listenerCount('wheel')).toBe(1);
    expect(dom.document.listenerCount('pointermove')).toBe(1);
    expect(dom.window.listenerCount('pointerup')).toBe(1);
    expect(dom.canvas.style.touchAction).toBe('none');
    expect(Ticker.system.count).toBe(before + 1);

    const other = createFakeDom().canvas;
    events.setTargetElement(other as never);
    expect(dom.canvas.listenerCount()).toBe(0);
    expect(dom.canvas.style.touchAction).toBe('');
    expect(other.listenerCount()).toBe(4);
    expect(Ticker.system.count).toBe(before + 1);

    events.destroy();
    expect(other.listenerCount()).toBe(0);
    expect(dom.document.listenerCount()).toBe(0);
    expect(dom.window.listenerCount()).toBe(0);
    expect(Ticker.system.count).toBe(before);
    expect(events.domElement).toBe(null);
    expect(EventsTicker.domElement).toBe(null);
  });

  it('还没渲染过(lastObjectRendered 为空)时事件安静丢弃,光标回默认', () => {
    const dom = installDom();
    const events = new EventSystem({ canvas: dom.canvas as never, resolution: 1, lastObjectRendered: null });
    events.init();
    const driver = new DomDriver(dom, () => {});
    expect(() => {
      driver.move(10, 10);
      driver.down(10, 10);
      driver.up(10, 10);
      driver.wheel(10, 10, 1);
    }).not.toThrow();
    expect(dom.canvas.style.cursor).toBe('inherit');
    events.destroy();
  });

  it('pointer 反映最近一次指针状态;rootTarget 取渲染器最近渲染的对象', () => {
    const dom = installDom();
    const root = new Container({ eventMode: 'static', hitArea: new Rectangle(0, 0, 100, 100) });
    const renderer = { canvas: dom.canvas as never, resolution: 1, lastObjectRendered: null as Container | null };
    const events = new EventSystem(renderer);
    events.init();
    const got: FederatedPointerEvent[] = [];
    root.on('pointerdown', (e: FederatedPointerEvent) => got.push(e));
    const driver = new DomDriver(dom, () => {});
    driver.down(50, 60);
    expect(got).toHaveLength(0);
    renderer.lastObjectRendered = root;
    driver.down(50, 60, { pointerId: 3, pointerType: 'pen', button: 0 });
    expect(got).toHaveLength(1);
    expect(events.rootBoundary.rootTarget).toBe(root);
    expect(events.pointer.global.x).toBe(50);
    expect(events.pointer.global.y).toBe(60);
    expect(events.pointer.pointerId).toBe(3);
    expect(events.pointer.pointerType).toBe('pen');
    events.destroy();
  });
});
