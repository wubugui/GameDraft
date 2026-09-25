/**
 * 层级(照 Unity):世界矩阵缓存、激活、组件生命期、场景根、Transform API。
 * 世界矩阵缓存必须与「沿父链现乘」逐位相同(Pixi 的乘法顺序),否则渲染 / 命中 / toGlobal 会与之前不一致。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Container } from './Container';
import { Component } from './Component';
import { PlayerLoop } from './PlayerLoop';
import { Matrix } from '../math/Matrix';
import { Rectangle } from '../math/Rectangle';
import { EventBoundary } from '../events/EventBoundary';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import { WebGPURenderer } from '../gpu/WebGPURenderer';
import { Sprite } from '../sprite/Sprite';
import { Texture } from '../textures/Texture';
import { RenderTexture } from '../textures/RenderTexture';

afterEach(() => PlayerLoop.shared.reset());

/** 参照实现:自顶向下 append(与改动前的 getGlobalTransform 相同) */
function freshWorld(c: Container): Matrix {
  const chain: Container[] = [];
  for (let n: Container | null = c; n; n = n.parent) chain.push(n);
  const m = new Matrix();
  for (let i = chain.length - 1; i >= 0; i--) {
    chain[i].updateLocalTransform();
    m.append(chain[i].localTransform);
  }
  return m;
}

function same(a: Matrix, b: Matrix): boolean {
  return a.a === b.a && a.b === b.b && a.c === b.c && a.d === b.d && a.tx === b.tx && a.ty === b.ty;
}

function close(a: { x: number; y: number }, b: { x: number; y: number }, eps = 1e-9): void {
  expect(Math.abs(a.x - b.x), `x ${a.x} vs ${b.x}`).toBeLessThan(eps);
  expect(Math.abs(a.y - b.y), `y ${a.y} vs ${b.y}`).toBeLessThan(eps);
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 记录生命期调用顺序的组件 */
class Probe extends Component {
  static log: string[] = [];
  constructor(public tag = 'p') {
    super();
  }
  awake(): void { Probe.log.push(`${this.tag}.awake`); }
  onEnable(): void { Probe.log.push(`${this.tag}.onEnable`); }
  start(): void { Probe.log.push(`${this.tag}.start`); }
  update(dt: number): void { Probe.log.push(`${this.tag}.update(${dt})`); }
  lateUpdate(): void { Probe.log.push(`${this.tag}.lateUpdate`); }
  onDisable(): void { Probe.log.push(`${this.tag}.onDisable`); }
  onDestroy(): void { Probe.log.push(`${this.tag}.onDestroy`); }
  onTransformParentChanged(): void { Probe.log.push(`${this.tag}.parentChanged`); }
  onTransformChildrenChanged(): void { Probe.log.push(`${this.tag}.childrenChanged`); }
}

function scene(): Container {
  const root = new Container({ label: 'scene' });
  root.isSceneRoot = true;
  return root;
}

describe('世界矩阵缓存', () => {
  it('随机树 + 随机改动 / 换父:缓存结果与沿父链现乘逐位相同', () => {
    const r = rng(7);
    const nodes: Container[] = [new Container()];
    for (let i = 0; i < 40; i++) {
      const c = new Container({ x: r() * 200 - 100, y: r() * 200 - 100, rotation: r() * 6, scale: { x: 0.5 + r(), y: r() < 0.2 ? -1 : 0.7 + r() } as never });
      if (r() < 0.3) c.pivot.set(r() * 10, r() * 10);
      if (r() < 0.2) c.skew.set(r() * 0.3, r() * 0.2);
      if (r() < 0.2) c.origin.set(r() * 5, r() * 5);
      nodes[Math.floor(r() * nodes.length)].addChild(c);
      nodes.push(c);
    }
    for (let step = 0; step < 300; step++) {
      const n = nodes[1 + Math.floor(r() * (nodes.length - 1))];
      const op = r();
      if (op < 0.3) n.x += r() * 10 - 5;
      else if (op < 0.45) n.rotation += r() - 0.5;
      else if (op < 0.55) n.scale.x *= 0.9 + r() * 0.2;
      else if (op < 0.65) n.alpha = r(); // 不影响矩阵
      else if (op < 0.8) {
        const p = nodes[Math.floor(r() * nodes.length)];
        if (p !== n && !p.isChildOf(n)) p.addChild(n);
      }
      const probe = nodes[Math.floor(r() * nodes.length)];
      expect(same(probe.worldTransform, freshWorld(probe)), `step ${step}`).toBe(true);
      // 另一个也看一眼(交错读取,缓存链路互相影响)
      const probe2 = nodes[Math.floor(r() * nodes.length)];
      expect(same(probe2.getGlobalTransform(new Matrix()), freshWorld(probe2))).toBe(true);
    }
  });

  it('只改 alpha 不让子孙的世界版本变;改位置会', () => {
    const a = new Container();
    const b = a.addChild(new Container({ x: 3 }));
    void b.worldTransform;
    const v0 = b._worldVersion;
    a.alpha = 0.5;
    void b.worldTransform;
    expect(b._worldVersion).toBe(v0);
    a.x = 10;
    void b.worldTransform;
    expect(b._worldVersion).toBe(v0 + 1);
  });

  it('hasChanged:初始 true;置 false 后祖先移动才再变 true', () => {
    const a = new Container();
    const b = a.addChild(new Container());
    expect(b.hasChanged).toBe(true);
    b.hasChanged = false;
    expect(b.hasChanged).toBe(false);
    a.alpha = 0.3;
    expect(b.hasChanged).toBe(false);
    a.y = 5;
    expect(b.hasChanged).toBe(true);
  });
});

describe('激活与组件生命期', () => {
  it('挂在场景里的激活节点:addComponent 立即 awake + onEnable;下一 tick start → update → lateUpdate', () => {
    Probe.log = [];
    const root = scene();
    const n = root.addChild(new Container());
    n.addComponent(new Probe('a'));
    expect(Probe.log).toEqual(['a.awake', 'a.onEnable']);
    PlayerLoop.shared.tick(0.5);
    PlayerLoop.shared.tick(0.25);
    expect(Probe.log).toEqual(['a.awake', 'a.onEnable', 'a.start', 'a.update(0.5)', 'a.lateUpdate', 'a.update(0.25)', 'a.lateUpdate']);
  });

  it('不在场景里的节点:组件不 awake;挂进场景才 awake + onEnable,摘下来 onDisable 且不再 update', () => {
    Probe.log = [];
    const root = scene();
    const n = new Container();
    const p = n.addComponent(new Probe('a'));
    expect(Probe.log).toEqual([]);
    expect(n.activeInHierarchy).toBe(false);
    root.addChild(n);
    expect(Probe.log).toEqual(['a.awake', 'a.onEnable', 'a.parentChanged']);
    PlayerLoop.shared.tick(1);
    root.removeChild(n);
    Probe.log = [];
    PlayerLoop.shared.tick(1);
    expect(Probe.log).toEqual([]);
    expect(p.isActiveAndEnabled).toBe(false);
  });

  it('在场景内两个父节点之间移动:只发 parentChanged,不发 onDisable / onEnable', () => {
    const root = scene();
    const a = root.addChild(new Container());
    const b = root.addChild(new Container());
    const n = a.addChild(new Container());
    n.addComponent(new Probe('n'));
    Probe.log = [];
    b.addChild(n);
    expect(Probe.log).toEqual(['n.parentChanged']);
    Probe.log = [];
    n.setParent(a);
    expect(Probe.log).toEqual(['n.parentChanged']);
  });

  it('setActive 沿子树传播(先序),activeSelf 与 activeInHierarchy 区分', () => {
    Probe.log = [];
    const root = scene();
    const a = root.addChild(new Container());
    const b = a.addChild(new Container());
    a.addComponent(new Probe('a'));
    b.addComponent(new Probe('b'));
    Probe.log = [];
    a.setActive(false);
    expect(Probe.log).toEqual(['a.onDisable', 'b.onDisable']);
    expect(b.activeSelf).toBe(true);
    expect(b.activeInHierarchy).toBe(false);
    b.setActive(false);
    Probe.log = [];
    a.setActive(true);
    expect(Probe.log).toEqual(['a.onEnable']); // b 自己关着
    b.setActive(true);
    expect(Probe.log).toEqual(['a.onEnable', 'b.onEnable']);
  });

  it('enabled 开关只动这一个组件;start 只在第一次启用后调一次', () => {
    Probe.log = [];
    const root = scene();
    const p = root.addChild(new Container()).addComponent(new Probe('a'));
    p.enabled = false;
    PlayerLoop.shared.tick(1);
    expect(Probe.log).toEqual(['a.awake', 'a.onEnable', 'a.onDisable']);
    p.enabled = true;
    PlayerLoop.shared.tick(1);
    p.enabled = false;
    p.enabled = true;
    PlayerLoop.shared.tick(1);
    expect(Probe.log.filter((l) => l === 'a.start')).toHaveLength(1);
    expect(Probe.log.filter((l) => l.startsWith('a.update'))).toHaveLength(2);
  });

  it('removeComponent / destroy:onDisable → onDestroy;没 awake 过的不发 onDestroy', () => {
    Probe.log = [];
    const root = scene();
    const n = root.addChild(new Container());
    const p = n.addComponent(new Probe('a'));
    p.destroy();
    expect(Probe.log).toEqual(['a.awake', 'a.onEnable', 'a.onDisable', 'a.onDestroy']);
    expect(p.gameObject).toBeNull();
    Probe.log = [];
    const off = new Container();
    off.addComponent(new Probe('b'));
    off.destroy();
    expect(Probe.log).toEqual([]);
    Probe.log = [];
    const m = root.addChild(new Container());
    m.addComponent(new Probe('c'));
    Probe.log = [];
    m.destroy();
    expect(Probe.log).toEqual(['c.onDisable', 'c.onDestroy']);
    expect(PlayerLoop.shared.liveCount).toBe(0);
  });

  it('update 里停用 / 移除别的组件:本 tick 不再调它;抛错的钩子被截住、不影响别人', () => {
    const root = scene();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: string[] = [];
    class Killer extends Component {
      victim!: Component;
      update(): void { calls.push('killer'); this.victim.enabled = false; }
    }
    class Victim extends Component {
      update(): void { calls.push('victim'); }
    }
    class Thrower extends Component {
      update(): void { throw new Error('boom'); }
    }
    const k = root.addChild(new Container()).addComponent(new Killer());
    root.addChild(new Container()).addComponent(new Thrower());
    k.victim = root.addChild(new Container()).addComponent(new Victim());
    PlayerLoop.shared.tick(1); // start
    expect(calls).toEqual(['killer']);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('isSceneRoot 开关:整棵子树的组件随之启停', () => {
    Probe.log = [];
    const root = new Container();
    root.addChild(new Container()).addComponent(new Probe('a'));
    expect(Probe.log).toEqual([]);
    root.isSceneRoot = true;
    expect(Probe.log).toEqual(['a.awake', 'a.onEnable']);
    root.isSceneRoot = false;
    expect(Probe.log).toEqual(['a.awake', 'a.onEnable', 'a.onDisable']);
  });

  it('getComponent 系列:按类型、先序、缺省跳过未激活', () => {
    class A extends Component {}
    class B extends A {}
    const root = scene();
    const x = root.addChild(new Container());
    const y = x.addChild(new Container());
    const b = y.addComponent(new B());
    expect(root.getComponentInChildren(A)).toBe(b);
    expect(y.getComponentInParent(B)).toBe(b);
    expect(root.getComponentsInChildren(A)).toEqual([b]);
    x.setActive(false);
    expect(root.getComponentInChildren(A)).toBeNull();
    expect(root.getComponentInChildren(A, true)).toBe(b);
    expect(y.getComponent(B)).toBe(b);
    expect(y.getComponent(class C extends Component {})).toBeNull();
    expect(root._subtreeComponents).toBe(1);
    root.removeChild(x);
    expect(root._subtreeComponents).toBe(0);
  });

  it('子节点增删 / 换序发 onTransformChildrenChanged', () => {
    Probe.log = [];
    const root = scene();
    const p = root.addChild(new Container());
    p.addComponent(new Probe('p'));
    Probe.log = [];
    const c1 = p.addChild(new Container());
    const c2 = p.addChild(new Container());
    c2.setAsFirstSibling();
    p.removeChild(c1);
    expect(Probe.log).toEqual(['p.childrenChanged', 'p.childrenChanged', 'p.childrenChanged', 'p.childrenChanged']);
  });
});

describe('Transform API', () => {
  it('setParent(worldPositionStays):世界变换不变,镜像仍是 scale.x < 0,pivot / origin 保留', () => {
    const a = new Container({ x: 40, y: -10, rotation: 0.7, scale: { x: 2, y: 1.5 } as never });
    const b = new Container({ x: -20, y: 30, rotation: -0.3, scale: { x: 0.5, y: 0.5 } as never });
    const n = a.addChild(new Container({ x: 5, y: 6, rotation: 0.2 }));
    n.scale.set(-1, 1);
    n.pivot.set(3, 4);
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: -7, y: 3 }];
    const before = pts.map((p) => n.toGlobal(p));
    n.setParent(b);
    pts.forEach((p, i) => close(n.toGlobal(p), before[i], 1e-9));
    expect(n.scale.x).toBeLessThan(0);
    expect(n.scale.y).toBeGreaterThan(0);
    expect([n.pivot.x, n.pivot.y]).toEqual([3, 4]);
    // 不保留世界:本地不变
    const local = [n.x, n.y, n.rotation];
    n.setParent(a, false);
    expect([n.x, n.y, n.rotation]).toEqual(local);
    // 挂到自己的子孙下 → 抛错
    const kid = n.addChild(new Container());
    expect(() => n.setParent(kid)).toThrow();
  });

  it('worldPosition / worldRotation 读写,lossyScale', () => {
    const a = new Container({ x: 100, y: 50, rotation: Math.PI / 2, scale: { x: 2, y: 2 } as never });
    const n = a.addChild(new Container({ x: 10, y: 0 }));
    close(n.worldPosition, { x: 100, y: 70 });
    n.worldPosition = { x: 0, y: 0 };
    close(n.worldPosition, { x: 0, y: 0 });
    expect(n.worldRotation).toBeCloseTo(Math.PI / 2, 12);
    n.worldRotation = 0;
    expect(n.worldRotation).toBeCloseTo(0, 12);
    close(n.worldPosition, { x: 0, y: 0 }, 1e-9); // 绕自己的世界位置转
    close(n.lossyScale, { x: 2, y: 2 }, 1e-12);
  });

  it('transformPoint / 向量 / 方向 与逆变换互逆;translate / rotate', () => {
    const a = new Container({ x: 7, y: -3, rotation: 0.4, scale: { x: 3, y: 0.5 } as never });
    const n = a.addChild(new Container({ x: 1, y: 2, rotation: -1.1 }));
    const p = { x: 4, y: -9 };
    close(n.inverseTransformPoint(n.transformPoint(p)), p);
    close(n.inverseTransformVector(n.transformVector(p)), p);
    close(n.inverseTransformDirection(n.transformDirection(p)), p);
    const d = n.transformDirection({ x: 1, y: 0 });
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(1, 12);
    const w0 = n.worldPosition;
    n.translate(5, 0, 'world');
    close(n.worldPosition, { x: w0.x + 5, y: w0.y });
    const w1 = n.worldPosition;
    n.translate(2, 0, 'self');
    const dir = n.transformDirection({ x: 2, y: 0 });
    close(n.worldPosition, { x: w1.x + dir.x, y: w1.y + dir.y }, 1e-9);
    const r = n.rotation;
    n.rotate(0.25);
    expect(n.rotation).toBeCloseTo(r + 0.25, 12);
  });

  it('find / hierarchyPath / 兄弟序号 / root / isChildOf / name', () => {
    const root = new Container({ label: 'root' });
    const a = root.addChild(new Container({ label: 'a' }));
    const b = a.addChild(new Container({ label: 'b' }));
    const c = a.addChild(new Container({ label: 'c' }));
    expect(root.find('a/b')).toBe(b);
    expect(b.find('../c')).toBe(c);
    expect(root.find('a/x')).toBeNull();
    expect(c.hierarchyPath).toBe('root/a/c');
    expect(c.siblingIndex).toBe(1);
    c.setAsFirstSibling();
    expect(a.children).toEqual([c, b]);
    b.siblingIndex = 0;
    expect(a.children).toEqual([b, c]);
    expect(b.root).toBe(root);
    expect(b.isChildOf(root)).toBe(true);
    expect(root.isChildOf(b)).toBe(false);
    b.name = 'bee';
    expect(b.label).toBe('bee');
    expect(a.childCount).toBe(2);
    expect(a.getChild(1)).toBe(c);
  });
});

describe('未激活的子树不画、不命中、不计包围盒', () => {
  it('渲染:未激活的精灵不出 draw', () => {
    const rhi = new NullRhiDevice();
    const renderer = new WebGPURenderer({ rhi, canvas: { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement, width: 8, height: 8 });
    const root = new Container();
    const holder = root.addChild(new Container());
    holder.addChild(new Sprite(Texture.WHITE));
    const rt = RenderTexture.create({ width: 8, height: 8 });
    const draws = () => rhi.log.filter((l) => l.startsWith('draw')).length;
    renderer.render({ container: root, target: rt });
    const on = draws();
    expect(on).toBeGreaterThan(0);
    holder.setActive(false);
    renderer.render({ container: root, target: rt });
    expect(draws()).toBe(on);
    holder.setActive(true);
    renderer.render({ container: root, target: rt });
    expect(draws()).toBeGreaterThan(on);
    renderer.destroy();
  });

  it('命中 / 包围盒', () => {
    const root = new Container({ eventMode: 'passive' });
    const s = root.addChild(new Container({ eventMode: 'static', hitArea: new Rectangle(0, 0, 10, 10) }));
    const g = root.addChild(new Sprite(Texture.WHITE));
    g.position.set(50, 50);
    const b = new EventBoundary(root);
    expect(b.hitTest(5, 5)).toBe(s);
    s.setActive(false);
    expect(b.hitTest(5, 5)).toBeFalsy();
    const withG = root.getBounds();
    expect(withG.width).toBeGreaterThan(0);
    g.setActive(false);
    expect(root.getBounds().width).toBe(0);
  });
});
