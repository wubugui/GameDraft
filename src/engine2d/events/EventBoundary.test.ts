/**
 * EventBoundary 单测:同一棵场景树在 engine2d 与 Pixi 8.17 里各搭一遍,喂同样的根事件,
 * 比对命中结果与完整派发序列(含 capture 键与阶段);另有针对 engine2d 的显式断言。
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import 'pixi.js/events';
import { Container } from '../scene/Container';
import { Rectangle } from '../math/Rectangle';
import { EventBoundary } from './EventBoundary';
import { EventsTicker } from './EventTicker';
import { FederatedEvent } from './FederatedEvent';
import { FederatedPointerEvent } from './FederatedPointerEvent';
import {
  BoundaryDriver,
  buildScene,
  engine2dLib,
  makePixiLib,
  recordAll,
  type BuiltScene,
  type NodeSpec,
  type SceneLib,
} from './eventsTestKit';

const pixiLib = makePixiLib(PIXI);
const LIBS: SceneLib[] = [engine2dLib, pixiLib];

/* eslint-disable @typescript-eslint/no-explicit-any */

const SCENE: NodeSpec = {
  label: 'stage',
  children: [
    { label: 'bg', sprite: [800, 600], eventMode: 'static' },
    {
      label: 'panel', x: 100, y: 100, eventMode: 'static', hitArea: [0, 0, 300, 200], cursor: 'pointer',
      children: [
        { label: 'btnA', sprite: [100, 50], x: 10, y: 10, eventMode: 'static', cursor: 'grab' },
        {
          label: 'btnB', sprite: [100, 50], x: 150, y: 10, eventMode: 'static',
          children: [{ label: 'icon', sprite: [20, 20], x: 5, y: 5, eventMode: 'auto' }],
        },
        { label: 'deco', sprite: [280, 20], x: 10, y: 150, eventMode: 'none' },
        { label: 'passiveSprite', sprite: [50, 30], x: 10, y: 100, eventMode: 'passive' },
      ],
    },
    {
      label: 'group', x: 500, y: 100,
      children: [
        { label: 'g1', sprite: [50, 50], eventMode: 'static' },
        { label: 'g2', sprite: [50, 50], x: 60, eventMode: 'dynamic' },
        { label: 'gAuto', sprite: [50, 50], x: 120, eventMode: 'auto' },
      ],
    },
    { label: 'rot', x: 300, y: 400, rotation: Math.PI / 4, scale: [2, 1], eventMode: 'static', hitArea: [-20, -10, 40, 20] },
    {
      label: 'noKids', x: 500, y: 300, eventMode: 'static', interactiveChildren: false, hitArea: [0, 0, 100, 100],
      children: [{ label: 'nk1', sprite: [50, 50], eventMode: 'static' }],
    },
    {
      label: 'passiveNoKids', x: 620, y: 200, interactiveChildren: false,
      children: [{ label: 'pnk1', sprite: [40, 40], eventMode: 'static' }],
    },
    { label: 'hidden', sprite: [50, 50], x: 650, y: 300, eventMode: 'static', visible: false },
    { label: 'unrender', sprite: [50, 50], x: 710, y: 300, eventMode: 'static', renderable: false },
    {
      label: 'masked', x: 100, y: 450, eventMode: 'static', mask: 'maskShape',
      children: [{ label: 'mk1', sprite: [200, 100], eventMode: 'static' }],
    },
    { label: 'maskShape', sprite: [50, 50], x: 100, y: 450 },
    { label: 'anchored', sprite: [60, 60], anchor: 0.5, x: 700, y: 500, eventMode: 'static' },
    {
      label: 'noneBox', x: 300, y: 520, eventMode: 'none',
      children: [{ label: 'noneKid', sprite: [40, 40], eventMode: 'static' }],
    },
  ],
};

interface Run {
  lib: SceneLib;
  scene: BuiltScene;
  driver: BoundaryDriver;
  log: string[];
}

type Scenario = (r: Run) => void;

/** 记录方式:all = 全部类型含 capture;plain = 不含 capture;none = 不挂记录器(只看场景自己写的记录) */
type RecordMode = 'all' | 'plain' | 'none';

/** 两个库各跑一遍,断言派发序列逐条相同,返回 engine2d 的记录 */
function runBoth(scenario: Scenario, record: RecordMode = 'all', spec: NodeSpec = SCENE): string[] {
  const logs: Record<string, string[]> = {};
  for (const lib of LIBS) {
    const scene = buildScene(lib, spec);
    const boundary = lib.boundary(scene.root);
    const log: string[] = [];
    if (record !== 'none') recordAll(scene, log, undefined, record === 'all');
    scenario({ lib, scene, driver: new BoundaryDriver(lib, scene, boundary), log });
    logs[lib.name] = log;
  }
  expect(logs.engine2d).toEqual(logs.pixi);
  return logs.engine2d;
}

/** 只看非 capture、非 global 的记录(显式断言用) */
function plain(log: string[]): string[] {
  return log.filter((s) => !/capture@|^[^.]+\.global/.test(s));
}

afterEach(() => {
  EventsTicker.pauseUpdate = true;
});

describe('EventBoundary 命中测试', () => {
  it('网格逐点与 Pixi 命中相同(eventMode 各档 / hitArea / interactiveChildren / 可见性 / 遮罩 / 旋转缩放 / 锚点)', () => {
    const results: Record<string, string[]> = {};
    for (const lib of LIBS) {
      const scene = buildScene(lib, SCENE);
      const boundary = lib.boundary(scene.root);
      const out: string[] = [];
      for (let y = -20; y <= 640; y += 7) {
        for (let x = -20; x <= 840; x += 9) {
          const hit = boundary.hitTest(x, y);
          out.push(`${x},${y}:${hit ? hit.label : String(hit)}`);
        }
      }
      results[lib.name] = out;
    }
    expect(results.engine2d.length).toBeGreaterThan(5000);
    expect(results.engine2d).toEqual(results.pixi);
  });

  it('各档 eventMode 与剪枝的具体命中', () => {
    const scene = buildScene(engine2dLib, SCENE);
    const b = engine2dLib.boundary(scene.root);
    const at = (x: number, y: number): string | null | undefined => {
      const hit = b.hitTest(x, y);
      return hit ? hit.label : (hit as null | undefined);
    };
    expect(at(120, 120)).toBe('btnA'); // static 精灵
    expect(at(258, 118)).toBe('btnB'); // auto 子节点在 static 父下:目标是父
    expect(at(120, 255)).toBe('panel'); // none 子节点被剪掉,落到父的 hitArea
    expect(at(120, 205)).toBe('panel'); // passive 精灵在 static 父下:目标是父
    expect(at(390, 290)).toBe('panel'); // hitArea 内的空白
    expect(at(410, 150)).toBe('bg'); // hitArea 外
    expect(at(510, 110)).toBe('g1');
    expect(at(570, 110)).toBe('g2'); // dynamic
    expect(at(630, 110)).toBe('bg'); // auto 在 passive 父下:不可命中
    expect(at(510, 310)).toBe('noKids'); // interactiveChildren=false:子节点不参与
    expect(at(630, 210)).toBe('bg'); // passive + interactiveChildren=false:整棵剪掉
    expect(at(660, 310)).toBe('bg'); // visible=false
    expect(at(720, 310)).toBe('bg'); // renderable=false
    expect(at(120, 470)).toBe('mk1'); // 遮罩内
    expect(at(200, 470)).toBe('bg'); // 遮罩外:整棵剪掉
    expect(at(680, 480)).toBe('anchored'); // 锚点 0.5
    expect(at(310, 530)).toBe('bg'); // none 父下的 static 子:整棵剪掉
    expect(at(900, 900)).toBeFalsy();
    // 旋转 45° + 横向 2 倍:本地 (15, 0) → 世界 (300 + 30cos45, 400 + 30sin45)
    const c = Math.SQRT1_2;
    expect(at(300 + 30 * c, 400 + 30 * c)).toBe('rot');
    expect(at(300 + 50 * c, 400 + 50 * c)).toBe('bg'); // 本地 x=25 在 hitArea(-20..20)外
  });

  it('路过(未被剪掉的)dynamic 节点会解除 EventsTicker 暂停,static 不会', () => {
    const root = new Container({ eventMode: 'passive' });
    const s = new Container({ eventMode: 'static', hitArea: new Rectangle(0, 0, 10, 10) });
    const d = new Container({ eventMode: 'dynamic', hitArea: new Rectangle(0, 0, 10, 10), x: 100 });
    root.addChild(s, d);
    const b = new EventBoundary(root);
    expect(b.hitTest(5, 5)).toBe(s);
    expect(EventsTicker.pauseUpdate).toBe(true);
    expect(b.hitTest(105, 5)).toBe(d);
    expect(EventsTicker.pauseUpdate).toBe(false);
    expect(b.hitTest(5, 5)).toBe(s);
    expect(EventsTicker.pauseUpdate).toBe(true);
  });

  it('命中测试跟随当前变换', () => {
    const root = new Container({ eventMode: 'passive' });
    const box = new Container({ eventMode: 'static', hitArea: new Rectangle(0, 0, 10, 10) });
    root.addChild(box);
    const b = new EventBoundary(root);
    expect(b.hitTest(5, 5)).toBe(box);
    box.x = 100;
    expect(b.hitTest(5, 5)).toBeFalsy();
    expect(b.hitTest(105, 5)).toBe(box);
  });
});

describe('EventBoundary 派发序列(与 Pixi 逐条比对)', () => {
  it('悬停移动:over / enter / move / out / leave / global', () => {
    const log = runBoth(({ driver }) => {
      driver.move(50, 50);
      driver.move(120, 120);
      driver.move(125, 125);
      driver.move(270, 130);
      driver.move(258, 118);
      driver.move(390, 290);
      driver.move(900, 900);
    });
    // bg → btnA 这一步的非 capture 序列
    const step = plain(log);
    const i = step.indexOf('bg.pointerout@target>bg (120,120)');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(step.slice(i, i + 16)).toEqual([
      'bg.pointerout@target>bg (120,120)',
      'bg.mouseout@target>bg (120,120)',
      'bg.pointerleave@target>bg (120,120)',
      'bg.mouseleave@target>bg (120,120)',
      'btnA.pointerover@target>btnA (120,120)',
      'panel.pointerover@bubble>btnA (120,120)',
      'btnA.mouseover@target>btnA (120,120)',
      'panel.mouseover@bubble>btnA (120,120)',
      'btnA.pointerenter@target>btnA (120,120)',
      'btnA.mouseenter@target>btnA (120,120)',
      'panel.pointerenter@target>panel (120,120)',
      'panel.mouseenter@target>panel (120,120)',
      'btnA.pointermove@target>btnA (120,120)',
      'panel.pointermove@bubble>btnA (120,120)',
      'btnA.mousemove@target>btnA (120,120)',
      'panel.mousemove@bubble>btnA (120,120)',
    ]);
    // 移出画面:最后是 out / leave 链,再无 over
    expect(log.some((s) => s.startsWith('btnB.pointerleave@target') || s.startsWith('panel.pointerleave@target'))).toBe(true);
    // globalpointermove 发给了不在指针下的可交互节点
    expect(log.some((s) => s.startsWith('g1.globalpointermove@bubble>btnA (120,120)'))).toBe(true);
  });

  it('按下抬起:down / up / click / pointertap 与冒泡', () => {
    const log = runBoth(({ driver }) => {
      driver.move(120, 120);
      driver.click(120, 120);
    });
    const step = plain(log);
    const i = step.indexOf('btnA.pointerdown@target>btnA (120,120)');
    expect(step.slice(i)).toEqual([
      'btnA.pointerdown@target>btnA (120,120)',
      'panel.pointerdown@bubble>btnA (120,120)',
      'btnA.mousedown@target>btnA (120,120)',
      'panel.mousedown@bubble>btnA (120,120)',
      'btnA.pointerup@target>btnA (120,120)',
      'panel.pointerup@bubble>btnA (120,120)',
      'btnA.mouseup@target>btnA (120,120)',
      'panel.mouseup@bubble>btnA (120,120)',
      'btnA.click@target>btnA (120,120) d1',
      'panel.click@bubble>btnA (120,120) d1',
      'btnA.pointertap@target>btnA (120,120) d1',
      'panel.pointertap@bubble>btnA (120,120) d1',
    ]);
    // capture 阶段先于目标阶段
    const cap = log.indexOf('panel.pointerdowncapture@capture>btnA (120,120)');
    expect(cap).toBeGreaterThanOrEqual(0);
    expect(cap).toBeLessThan(log.indexOf('btnA.pointerdowncapture@target>btnA (120,120)'));
    expect(log.indexOf('btnA.pointerdowncapture@target>btnA (120,120)')).toBeLessThan(log.indexOf('btnA.pointerdown@target>btnA (120,120)'));
  });

  it('按在 A 松在 B:A 收 upoutside,点击落在公共祖先', () => {
    const log = runBoth(({ driver }) => {
      driver.down(120, 120);
      driver.move(270, 130);
      driver.up(270, 130);
    });
    const step = plain(log).filter((s) => /upoutside|click|tap/.test(s));
    expect(step).toEqual([
      'btnA.pointerupoutside@bubble>btnB (270,130)',
      'btnA.mouseupoutside@bubble>btnB (270,130)',
      'panel.click@target>panel (270,130) d1',
      'panel.pointertap@target>panel (270,130) d1',
    ]);
  });

  it('松在画布外:upoutside 从按下目标一路冒到根', () => {
    const log = runBoth(({ driver }) => {
      driver.down(120, 120);
      driver.upOutside(900, 900);
    });
    expect(plain(log).filter((s) => /upoutside/.test(s))).toEqual([
      // 事件目标是松开处的命中结果(画布外 = 没有)
      'btnA.pointerupoutside@none>undefined (900,900)',
      'btnA.mouseupoutside@none>undefined (900,900)',
      'panel.pointerupoutside@none>undefined (900,900)',
      'panel.mouseupoutside@none>undefined (900,900)',
    ]);
  });

  it('右键:rightdown / rightup / rightclick / pointertap', () => {
    const log = runBoth(({ driver }) => {
      driver.down(120, 120, { button: 2, buttons: 2 });
      driver.up(120, 120, { button: 2 });
      driver.down(120, 120, { button: 2, buttons: 2 });
      driver.move(270, 130);
      driver.up(270, 130, { button: 2 });
    });
    const step = plain(log).filter((s) => s.startsWith('btnA.') || s.startsWith('panel.'));
    expect(step).toContain('btnA.rightdown@target>btnA (120,120)');
    expect(step).toContain('btnA.rightup@target>btnA (120,120)');
    expect(step).toContain('btnA.rightclick@target>btnA (120,120) d1');
    expect(step).toContain('btnA.rightupoutside@bubble>btnB (270,130)');
    expect(step.some((s) => s.includes('.mousedown') || s.includes('.click@'))).toBe(false);
  });

  it('连击计数(200ms 内同目标递增,换目标重置)', () => {
    const log = runBoth(({ driver }) => {
      driver.click(120, 120);
      driver.click(120, 120);
      driver.click(120, 120);
      driver.click(270, 130);
    });
    expect(plain(log).filter((s) => /\.click@target/.test(s))).toEqual([
      'btnA.click@target>btnA (120,120) d1',
      'btnA.click@target>btnA (120,120) d2',
      'btnA.click@target>btnA (120,120) d3',
      'btnB.click@target>btnB (270,130) d1',
    ]);
  });

  it('触摸:touchstart / touchmove / touchend / tap,多指各自跟踪', () => {
    const log = runBoth(({ driver }) => {
      const t1 = { pointerType: 'touch', pointerId: 7 };
      const t2 = { pointerType: 'touch', pointerId: 8 };
      driver.down(120, 120, t1);
      driver.down(270, 130, t2);
      driver.move(125, 125, t1);
      driver.up(125, 125, t1);
      driver.up(900, 900, t2);
    });
    const step = plain(log);
    expect(step).toContain('btnA.touchstart@target>btnA (120,120)');
    expect(step).toContain('btnB.touchstart@target>btnB (270,130)');
    expect(step).toContain('btnA.touchmove@target>btnA (125,125)');
    expect(step).toContain('btnA.tap@target>btnA (125,125) d1');
    expect(step).toContain('btnB.touchendoutside@none>undefined (900,900)');
    expect(step.some((s) => s.includes('mousedown') || s.includes('.click@'))).toBe(false);
  });

  it('滚轮', () => {
    const log = runBoth(({ driver }) => {
      driver.wheel(120, 120, 53);
      driver.wheel(900, 900, -3);
    });
    expect(plain(log)).toEqual(['btnA.wheel@target>btnA (120,120) dy53', 'panel.wheel@bubble>btnA (120,120) dy53']);
  });

  it('画布边界的 over / out 映射', () => {
    const log = runBoth(({ driver }) => {
      driver.over(120, 120);
      driver.out(120, 120);
      driver.out(120, 120);
    });
    expect(plain(log)).toEqual([
      'btnA.pointerover@target>btnA (120,120)',
      'panel.pointerover@bubble>btnA (120,120)',
      'btnA.mouseover@target>btnA (120,120)',
      'panel.mouseover@bubble>btnA (120,120)',
      'btnA.pointerenter@target>btnA (120,120)',
      'btnA.mouseenter@target>btnA (120,120)',
      'panel.pointerenter@target>panel (120,120)',
      'panel.mouseenter@target>panel (120,120)',
      'btnA.pointerout@target>btnA (120,120)',
      'panel.pointerout@bubble>btnA (120,120)',
      'btnA.mouseout@target>btnA (120,120)',
      'panel.mouseout@bubble>btnA (120,120)',
      'btnA.pointerleave@target>btnA (120,120)',
      'btnA.mouseleave@target>btnA (120,120)',
      'panel.pointerleave@target>panel (120,120)',
      'panel.mouseleave@target>panel (120,120)',
    ]);
  });

  it('stopPropagation / stopImmediatePropagation', () => {
    const log = runBoth(({ driver, scene, log }) => {
      const a = scene.get('btnA');
      const b = scene.get('btnB');
      a.on('pointerdown', (e: any) => {
        log.push('A-stop');
        e.stopPropagation();
      });
      a.on('pointerdown', () => log.push('A-second'));
      b.on('pointerdown', (e: any) => {
        log.push('B-immediate');
        e.stopImmediatePropagation();
      });
      b.on('pointerdown', () => log.push('B-never'));
      driver.click(120, 120);
      driver.click(270, 130);
    });
    expect(log).toContain('A-stop');
    expect(log).toContain('A-second');
    expect(log).toContain('B-immediate');
    expect(log).not.toContain('B-never');
    // pointerdown 没冒到 panel,但随后单独分发的 mousedown 照常冒泡
    expect(log).not.toContain('panel.pointerdown@bubble>btnA (120,120)');
    expect(log).toContain('panel.mousedown@bubble>btnA (120,120)');
    expect(log).not.toContain('panel.pointerdown@bubble>btnB (270,130)');
  });

  it('capture 阶段 stopImmediatePropagation 后:单个监听者仍被调、多个则都不调(eventemitter3 行为)', () => {
    const log = runBoth(({ driver, scene, log }) => {
      const a = scene.get('btnA');
      const b = scene.get('btnB');
      for (const n of [a, b]) {
        n.on('pointerupcapture', (e: any) => {
          if (e.eventPhase === 2) e.stopImmediatePropagation();
        });
      }
      a.on('pointerup', () => log.push('A-single'));
      b.on('pointerup', () => log.push('B-first'));
      b.on('pointerup', () => log.push('B-second'));
      driver.click(120, 120);
      driver.click(270, 130);
    }, 'none');
    expect(log).toContain('A-single');
    expect(log).not.toContain('B-first');
    expect(log).not.toContain('B-second');
  });

  it('按下时把目标摘掉:pointerup / click 落到仍挂着的祖先', () => {
    const log = runBoth(({ driver, scene }) => {
      const a = scene.get('btnA');
      a.on('pointerdown', () => a.parent?.removeChild(a));
      driver.down(120, 120);
      driver.up(120, 120);
    });
    const step = plain(log).filter((s) => /pointerup|click/.test(s));
    expect(step).toEqual([
      'panel.pointerup@target>panel (120,120)',
      'panel.click@target>panel (120,120) d1',
    ]);
  });

  it('moveOnAll 与关掉全局移动事件', () => {
    runBoth(({ driver }) => {
      (driver.boundary as any).moveOnAll = true;
      driver.move(120, 120);
      driver.move(270, 130);
    });
    const log = runBoth(({ driver }) => {
      driver.boundary.enableGlobalMoveEvents = false;
      driver.move(120, 120);
      driver.move(570, 110);
    });
    expect(log.some((s) => s.includes('.global'))).toBe(false);
    expect(log).toContain('g2.pointerover@target>g2 (570,110)');
  });

  it('on<事件> 属性先于监听者被调用', () => {
    const log = runBoth(({ driver, scene, log }) => {
      const a = scene.get('btnA') as any;
      a.onpointerdown = function (this: any, e: any) {
        log.push(`prop:${this.label}:${e.type}`);
      };
      a.on('pointerdown', () => log.push('listener'));
      driver.click(120, 120);
    }, 'plain');
    expect(log.indexOf('prop:btnA:pointerdown')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('prop:btnA:pointerdown')).toBeLessThan(log.indexOf('listener'));
  });

  it('once / addEventListener({ capture, once })', () => {
    const log = runBoth(({ driver, scene, log }) => {
      const a = scene.get('btnA');
      const panel = scene.get('panel');
      a.once('pointerdown', () => log.push('once'));
      panel.addEventListener('pointerdown', () => log.push('panel-capture'), { capture: true });
      panel.addEventListener('pointerup', () => log.push('panel-up-once'), { once: true });
      a.addEventListener('pointerdown', { handleEvent: () => log.push('handle-object') } as any);
      driver.click(120, 120);
      driver.click(120, 120);
    }, 'plain');
    expect(log.filter((s) => s === 'once')).toHaveLength(1);
    expect(log.filter((s) => s === 'panel-up-once')).toHaveLength(1);
    expect(log.filter((s) => s === 'panel-capture')).toHaveLength(2);
    expect(log.filter((s) => s === 'handle-object')).toHaveLength(2);
    expect(log.indexOf('panel-capture')).toBeLessThan(log.indexOf('once'));
  });

  it('getLocalPosition 与 Pixi 相同(含旋转缩放)', () => {
    runBoth(({ driver, scene, log }) => {
      const rot = scene.get('rot');
      const a = scene.get('btnA');
      const c = Math.SQRT1_2;
      rot.on('pointerdown', (e: any) => {
        const p = e.getLocalPosition(rot);
        log.push(`rot-local ${p.x.toFixed(6)},${p.y.toFixed(6)}`);
        const q = e.getLocalPosition(a, undefined, { x: 130, y: 140 });
        log.push(`a-local ${q.x.toFixed(6)},${q.y.toFixed(6)}`);
      });
      driver.down(300 + 30 * c, 400 + 30 * c);
    }, 'plain');
  });

  it('Container.dispatchEvent 走所属边界分发自定义事件', () => {
    const root = new Container({ label: 'root', eventMode: 'static' });
    const child = new Container({ label: 'child', eventMode: 'static' });
    root.addChild(child);
    const b = new EventBoundary(root);
    const log: string[] = [];
    root.on('custom', (e: FederatedEvent) => log.push(`root@${e.eventPhase}>${(e.target as Container).label}`));
    child.on('custom', (e: FederatedEvent) => log.push(`child@${e.eventPhase}`));
    root.on('customcapture', (e: FederatedEvent) => log.push(`root-capture@${e.eventPhase}`));
    const e = new FederatedEvent(b);
    e.type = 'custom';
    expect(child.dispatchEvent(e)).toBe(true);
    expect(log).toEqual(['root-capture@1', 'child@2', 'root@3>child']);
    expect(() => child.dispatchEvent({} as never)).toThrow();
  });

  it('dispatch 发射器收到冒泡到根的事件;事件对象被回收复用', () => {
    const scene = buildScene(engine2dLib, SCENE);
    const boundary = new EventBoundary(scene.root as unknown as Container);
    const seen: string[] = [];
    const objs = new Set<unknown>();
    boundary.dispatch.on('pointerdown', (e: FederatedPointerEvent) => {
      seen.push(`${e.type}>${e.target.label}`);
      objs.add(e);
    });
    const driver = new BoundaryDriver(engine2dLib, scene, boundary as never);
    driver.down(120, 120);
    driver.down(270, 130);
    expect(seen).toEqual(['pointerdown>btnA', 'pointerdown>btnB']);
    expect(objs.size).toBe(1);
  });

  it('rootTarget 为空时什么都不做', () => {
    const b = new EventBoundary(null);
    const e = new FederatedPointerEvent(null!);
    e.type = 'pointerdown';
    expect(() => b.mapEvent(e)).not.toThrow();
  });
});
