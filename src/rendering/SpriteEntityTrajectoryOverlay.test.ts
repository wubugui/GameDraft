/**
 * 轨迹叠加变换通道（`SpriteEntity.setTrajectoryOverlay` / `clearTrajectoryOverlay`）。
 *
 * 这里钉死三件"错了不报错、只是画面不对"的事：
 *
 * 1. **镜像 × 旋转不对易**。同样一个 `rotation=+0.3`，镜像在旋转**里面**（Player：
 *    `sprite.scale.x` 的符号）时视觉方向不变，镜像在旋转**外面**（Npc：外层容器的
 *    `scale.x`）时视觉方向整个反过来。约定取「世界方向恒定」——作者在画布上看到顺时针，
 *    游戏里朝左也必须是顺时针。用 Pixi **自己的**矩阵算头顶向量，不复述实现里的公式。
 * 2. **lit 世界仿射必须与真实显示变换一致**。lit quad 的世界坐标是 CPU 每帧喂的
 *    （见 character-lighting：不许从 screen 反推），喂错**画面位置照样是对的**，只有
 *    probe 采样位置错——最难查的那一类。这里独立按 Pixi 矩阵链算一遍去比。
 * 3. **生命周期对称**：清掉叠加层之后，一切逐位回到从未叠加过的状态。
 */
import { describe, expect, it } from 'vitest';
import {
  Container,
  Matrix,
  Mesh,
  Sprite,
  Texture,
  TextureSource,
  updateRenderGroupTransforms,
  type Shader,
} from 'pixi.js';

import { SpriteEntity, type LitShaderProvider } from './SpriteEntity';
import type { AnimationSetDef } from '../data/types';
import type { ResolvedSockets } from '../data/animationSockets';

// ————————————————————————— 固件 —————————————————————————

const CELL_W = 32;
const CELL_H = 48;
const WORLD_W = 100;
const WORLD_H = 150;
/** 无叠加、无透视时的基础帧缩放 */
const BASE_SX = WORLD_W / CELL_W;
const BASE_SY = WORLD_H / CELL_H;

function animDef(): AnimationSetDef {
  return {
    spritesheet: 'x.png',
    cols: 2,
    rows: 1,
    cellWidth: CELL_W,
    cellHeight: CELL_H,
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    states: { idle: { frames: [0], frameRate: 8, loop: true } },
  };
}

/** entityShade 的两行仿射（`LitSpriteQuad.setWorldTransform` 的落点） */
interface EntityShadeUniforms {
  uL2W0: Float32Array;
  uL2W1: Float32Array;
}

function fakeLitShader(): Shader & { __u: EntityShadeUniforms } {
  const u: EntityShadeUniforms = {
    uL2W0: new Float32Array([1, 0, 0]),
    uL2W1: new Float32Array([0, 1, 0]),
  };
  const sh = {
    resources: { entityShade: { uniforms: u } },
    __u: u,
  };
  return sh as unknown as Shader & { __u: EntityShadeUniforms };
}

function litProvider(): LitShaderProvider & { last: (Shader & { __u: EntityShadeUniforms }) | null } {
  const p = {
    last: null as (Shader & { __u: EntityShadeUniforms }) | null,
    create(): Shader {
      const sh = fakeLitShader();
      p.last = sh;
      return sh;
    },
    swapTextures(): void { /* 固件不换图集 */ },
    release(): void { /* 固件不回收 */ },
  };
  return p;
}

function makeEntity(opts: { lit?: boolean; sockets?: ResolvedSockets | null } = {}): {
  e: SpriteEntity;
  sprite: Sprite;
  mesh: Mesh | null;
  shade: EntityShadeUniforms | null;
} {
  const e = new SpriteEntity();
  const tex = new Texture({ source: new TextureSource({ width: CELL_W * 2, height: CELL_H }) });
  e.loadFromDef(tex, animDef(), opts.sockets ?? null);
  e.playAnimation('idle');
  let shade: EntityShadeUniforms | null = null;
  if (opts.lit) {
    const p = litProvider();
    e.enableBakedShading(p);
    shade = p.last?.__u ?? null;
  }
  const sprite = (e as unknown as { sprite: Sprite }).sprite;
  const mesh = (e.container.children.find((c) => c instanceof Mesh) as Mesh | undefined) ?? null;
  return { e, sprite, mesh, shade };
}

/**
 * 头顶向量 (0,−1) 过线性部之后的 x 分量。
 * 屏幕坐标 y 向下：x 分量 > 0 = 头往右歪 = **顺时针**；< 0 = 逆时针。
 */
function headLeanX(m: Matrix): number {
  return m.c * -1;
}

/** 按父→子顺序把各节点的**局部**矩阵串成世界矩阵（用 Pixi 自己的 Matrix，不复述实现公式）。 */
function worldMatrixOf(nodes: Container[]): Matrix {
  const m = new Matrix();
  for (const n of nodes) {
    n.updateLocalTransform();
    m.append(n.localTransform);
  }
  return m;
}

/** 把 entityShade 的两行读成 Pixi Matrix 口径的 (a,b,c,d,tx,ty)。 */
function litMatrix(u: EntityShadeUniforms): Matrix {
  return new Matrix(u.uL2W0[0], u.uL2W1[0], u.uL2W0[1], u.uL2W1[1], u.uL2W0[2], u.uL2W1[2]);
}

function expectMatrixClose(got: Matrix, want: Matrix, digits = 5): void {
  expect(got.a).toBeCloseTo(want.a, digits);
  expect(got.b).toBeCloseTo(want.b, digits);
  expect(got.c).toBeCloseTo(want.c, digits);
  expect(got.d).toBeCloseTo(want.d, digits);
  expect(got.tx).toBeCloseTo(want.tx, digits);
  expect(got.ty).toBeCloseTo(want.ty, digits);
}

// ————————————————————————— 叠加缩放 —————————————————————————

describe('叠加缩放：乘在朝向符号 × 透视系数之上（单点闸 applySpriteScale）', () => {
  it('朝右：基础帧缩放 × 叠加量', () => {
    const { e, sprite } = makeEntity();
    e.setTrajectoryOverlay(0, 2, 0.5, 1);
    expect(sprite.scale.x).toBeCloseTo(BASE_SX * 2, 6);
    expect(sprite.scale.y).toBeCloseTo(BASE_SY * 0.5, 6);
  });

  it('朝左：镜像符号保住，只有幅值被叠加量放大', () => {
    const { e, sprite } = makeEntity();
    e.setDirection(-1, 0);
    e.setTrajectoryOverlay(0, 2, 0.5, 1);
    expect(sprite.scale.x).toBeCloseTo(-BASE_SX * 2, 6);
    expect(sprite.scale.y).toBeCloseTo(BASE_SY * 0.5, 6);
  });

  it('与透视系数相乘（远处的物件叠加缩放也跟着收）', () => {
    const { e, sprite } = makeEntity();
    e.setDepthScaleFactor(0.4);
    e.setTrajectoryOverlay(0, 3, 3, 1);
    expect(sprite.scale.x).toBeCloseTo(BASE_SX * 0.4 * 3, 6);
    expect(sprite.scale.y).toBeCloseTo(BASE_SY * 0.4 * 3, 6);
  });

  it('叠加期间换帧/换向不会把叠加量冲掉（applySpriteScale 是必经点）', () => {
    const { e, sprite } = makeEntity();
    e.setTrajectoryOverlay(0.2, 2, 2, 1);
    e.setDirection(-1, 0);
    e.playAnimation('idle', undefined, { holdFrame: 0 });
    expect(Math.abs(sprite.scale.x)).toBeCloseTo(BASE_SX * 2, 6);
    expect(sprite.rotation).toBeCloseTo(0.2, 6);
  });

  it('非有限值回落到恒等（不让 NaN 污染变换）', () => {
    const { e, sprite } = makeEntity();
    e.setTrajectoryOverlay(Number.NaN, Number.NaN, Number.POSITIVE_INFINITY, Number.NaN);
    expect(sprite.rotation).toBe(0);
    expect(sprite.scale.x).toBeCloseTo(BASE_SX, 6);
    expect(sprite.scale.y).toBeCloseTo(BASE_SY, 6);
    expect(e.container.alpha).toBe(1);
  });
});

// ————————————————————————— 镜像 × 旋转（本次最贵的一条）—————————————————————————

describe('镜像 × 旋转：叠加旋转的**世界方向恒定**', () => {
  const ROT = 0.3;

  it('不镜像：正的叠加旋转 = 屏幕顺时针（约定本身）', () => {
    const { e } = makeEntity();
    e.setTrajectoryOverlay(ROT, 1, 1, 1);
    const sprite = (e as unknown as { sprite: Sprite }).sprite;
    expect(headLeanX(worldMatrixOf([e.container, sprite]))).toBeGreaterThan(0);
  });

  it('镜像在旋转**里面**（Player 口径：sprite.scale.x 符号）→ 视觉方向不变，本类不补偿', () => {
    const { e } = makeEntity();
    e.setDirection(-1, 0);
    e.setTrajectoryOverlay(ROT, 1, 1, 1);
    const sprite = (e as unknown as { sprite: Sprite }).sprite;
    // 局部矩阵是 R·S，R 在外 —— 镜像不反转视觉旋转方向
    expect(sprite.rotation).toBeCloseTo(ROT, 6);
    expect(headLeanX(worldMatrixOf([e.container, sprite]))).toBeGreaterThan(0);
  });

  it('镜像在旋转**外面**（Npc 口径：外层容器 scale.x）→ 必须靠 outerMirrorX 取反', () => {
    const outer = new Container();
    outer.scale.set(-1, 1);
    const { e } = makeEntity();
    outer.addChild(e.container);
    e.setTrajectoryOverlay(ROT, 1, 1, 1, -1);
    const sprite = (e as unknown as { sprite: Sprite }).sprite;
    // 存下来的是**补偿后**的局部旋转
    expect(sprite.rotation).toBeCloseTo(-ROT, 6);
    expect(e.getTrajectoryOverlay().rotRad).toBeCloseTo(-ROT, 6);
    // 视觉上仍是顺时针（世界方向恒定）
    expect(headLeanX(worldMatrixOf([outer, e.container, sprite]))).toBeGreaterThan(0);
  });

  it('负向控制：外层镜像下**忘了**传 outerMirrorX，视觉旋转就会反过来（这正是要防的 bug）', () => {
    const outer = new Container();
    outer.scale.set(-1, 1);
    const { e } = makeEntity();
    outer.addChild(e.container);
    e.setTrajectoryOverlay(ROT, 1, 1, 1); // 漏传
    const sprite = (e as unknown as { sprite: Sprite }).sprite;
    expect(headLeanX(worldMatrixOf([outer, e.container, sprite]))).toBeLessThan(0);
  });

  it('两条口径同 ROT 时视觉倾斜量**相等**（Player 与 Npc 不许有肉眼可见的差别）', () => {
    const a = makeEntity();
    a.e.setDirection(-1, 0);
    a.e.setTrajectoryOverlay(ROT, 1, 1, 1);
    const outer = new Container();
    outer.scale.set(-1, 1);
    const b = makeEntity();
    outer.addChild(b.e.container);
    b.e.setTrajectoryOverlay(ROT, 1, 1, 1, -1);
    const ma = worldMatrixOf([a.e.container, a.sprite]);
    const mb = worldMatrixOf([outer, b.e.container, b.sprite]);
    // 归一化掉幅值，只比方向
    const angA = Math.atan2(-ma.d, ma.c);
    const angB = Math.atan2(-mb.d, mb.c);
    expect(angA).toBeCloseTo(angB, 6);
  });
});

// ————————————————————————— lit 世界仿射 —————————————————————————

describe('lit 世界仿射与真实显示变换一致', () => {
  /** 外层实体容器的仿射（litParentRot=0 的常规情形：Npc 的 def.rotation 是罕见装饰字段） */
  const parent = { x: 640, y: 480, sx: -1.5, sy: 1.5 };

  function pushParent(e: SpriteEntity): void {
    e.setLitParentTransform(parent.x, parent.y, parent.sx, parent.sy, 0);
  }

  /** 独立算一遍世界仿射：外层对角仿射 ∘ 本容器局部 ∘ mesh 局部（全部走 Pixi 的 Matrix） */
  function expectedWorld(e: SpriteEntity, mesh: Mesh): Matrix {
    const outer = new Matrix(parent.sx, 0, 0, parent.sy, parent.x, parent.y);
    e.container.updateLocalTransform();
    mesh.updateLocalTransform();
    return outer.append(e.container.localTransform).append(mesh.localTransform);
  }

  it('回归护栏：**没有**叠加量时与 2026-09-01 修好的那套逐位一致', () => {
    const { e, mesh, shade } = makeEntity({ lit: true });
    expect(mesh && shade).toBeTruthy();
    pushParent(e);
    e.x = 12;
    e.y = 34;
    e.update(0);
    expectMatrixClose(litMatrix(shade!), expectedWorld(e, mesh!));
  });

  it('叠加旋转 + 非均匀缩放后仍然一致（朝右）', () => {
    const { e, mesh, shade } = makeEntity({ lit: true });
    pushParent(e);
    e.x = 12;
    e.y = 34;
    e.setVisualLiftY(-20);
    e.setTrajectoryOverlay(0.4, 1.7, 0.6, 1);
    expectMatrixClose(litMatrix(shade!), expectedWorld(e, mesh!));
  });

  it('叠加旋转 + 内层镜像后仍然一致（朝左）', () => {
    const { e, mesh, shade } = makeEntity({ lit: true });
    pushParent(e);
    e.setDirection(-1, 0);
    e.x = -7;
    e.y = 300;
    e.setTrajectoryOverlay(-0.9, 1.2, 2.3, 1);
    expectMatrixClose(litMatrix(shade!), expectedWorld(e, mesh!));
  });

  it('mesh 自己也要转起来 —— 只喂仿射不转 mesh = 采样在转、画面不转', () => {
    const { e, mesh } = makeEntity({ lit: true });
    e.setTrajectoryOverlay(0.4, 1, 1, 1);
    expect(mesh!.rotation).toBeCloseTo(0.4, 6);
    e.clearTrajectoryOverlay();
    expect(mesh!.rotation).toBe(0);
  });

  it('走动（只动 container.x/y）时仿射跟着走', () => {
    const { e, mesh, shade } = makeEntity({ lit: true });
    pushParent(e);
    e.setTrajectoryOverlay(0.25, 1.4, 1.4, 1);
    e.x = 100;
    e.y = 200;
    e.update(0);
    expectMatrixClose(litMatrix(shade!), expectedWorld(e, mesh!));
  });
});

// ————————————————————————— 透明度 —————————————————————————

describe('透明度：写共同父容器，sprite 与 lit mesh 一起淡', () => {
  it('写在 container 上并夹进 0..1', () => {
    const { e } = makeEntity();
    e.setTrajectoryOverlay(0, 1, 1, 0.3);
    expect(e.container.alpha).toBeCloseTo(0.3, 6);
    e.setTrajectoryOverlay(0, 1, 1, 5);
    expect(e.container.alpha).toBe(1);
    e.setTrajectoryOverlay(0, 1, 1, -2);
    expect(e.container.alpha).toBe(0);
  });

  it('实测传导：容器 alpha → lit mesh 的 groupAlpha/groupColorAlpha（= 着色器里的 uColor）', () => {
    // CharacterLitSprite 的 VERT 写 `vColor = uColor`、FRAG 末尾 `* vColor`，
    // 而 uColor 由 Pixi 的 MeshPipe 从 mesh.groupColorAlpha 填。所以只要 groupAlpha 到位，
    // lit 路径就不需要单独设 mesh.alpha —— 这条断言就是那个"实测"。
    const root = new Container();
    root.enableRenderGroup();
    const { e, sprite, mesh } = makeEntity({ lit: true });
    root.addChild(e.container);
    e.setTrajectoryOverlay(0, 1, 1, 0.25);
    updateRenderGroupTransforms(root.renderGroup, true);
    expect(mesh!.groupAlpha).toBeCloseTo(0.25, 6);
    expect(sprite.groupAlpha).toBeCloseTo(0.25, 6);
    // 高位字节就是 alpha（Pixi 按 `alpha*255 | 0` 截断）：0.25 → 63 = 0x3f
    expect(mesh!.groupColorAlpha >>> 24).toBe((0.25 * 255) | 0);
  });
});

// ————————————————————————— 挂件跟随 —————————————————————————

const SOCKETS: ResolvedSockets = {
  stale: false,
  set: {
    schemaVersion: 1,
    atlas: { cols: 2, rows: 1, slotCount: 2 },
    sockets: { hand: { poses: { '0': { x: 1, y: 0.5, angle: 10, front: true } } } },
  },
};

describe('挂件跟随叠加量（挂件与本体是兄弟，拿不到 sprite 的变换）', () => {
  function attach(e: SpriteEntity): Sprite {
    const view = new Sprite();
    e.attachToSocket('hand', { view });
    return view;
  }

  it('无叠加时逐位走旧口径', () => {
    const { e } = makeEntity({ sockets: SOCKETS });
    const v = attach(e);
    // socketPoseToLocal：x=(1-0.5)*100*1*1=50，y=(0.5-1)*150= -75，角度 10°
    expect(v.x).toBeCloseTo(50, 6);
    expect(v.y).toBeCloseTo(-75, 6);
    expect(v.rotation).toBeCloseTo((10 * Math.PI) / 180, 6);
  });

  it('叠加旋转把挂点位置**绕脚点**转过去，挂件自身也跟着转', () => {
    const { e } = makeEntity({ sockets: SOCKETS });
    const v = attach(e);
    const rot = 0.5;
    e.setTrajectoryOverlay(rot, 1, 1, 1);
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    expect(v.x).toBeCloseTo(50 * c - -75 * s, 5);
    expect(v.y).toBeCloseTo(50 * s + -75 * c, 5);
    expect(v.rotation).toBeCloseTo((10 * Math.PI) / 180 + rot, 6);
  });

  it('叠加缩放同步施加在挂点位置与挂件自身尺寸上', () => {
    const { e } = makeEntity({ sockets: SOCKETS });
    const v = attach(e);
    e.setTrajectoryOverlay(0, 2, 0.5, 1);
    expect(v.x).toBeCloseTo(100, 5);
    expect(v.y).toBeCloseTo(-37.5, 5);
    expect(v.scale.x).toBeCloseTo(2, 6);
    expect(v.scale.y).toBeCloseTo(0.5, 6);
  });
});

// ————————————————————————— 生命周期对称 —————————————————————————

describe('生命周期对称：清掉叠加层 = 从未叠加过', () => {
  it('位置 / 缩放 / 旋转 / 透明度 / lit 仿射全部逐位复原', () => {
    const { e, sprite, mesh, shade } = makeEntity({ lit: true });
    e.setLitParentTransform(100, 200, -2, 2, 0);
    e.setDirection(-1, 0);
    e.x = 33;
    e.y = 44;
    e.update(0);
    const before = {
      sx: sprite.scale.x,
      sy: sprite.scale.y,
      rot: sprite.rotation,
      alpha: e.container.alpha,
      meshRot: mesh!.rotation,
      lit: litMatrix(shade!).clone(),
    };

    e.setTrajectoryOverlay(0.7, 3, 0.2, 0.15, -1);
    expect(sprite.scale.x).not.toBeCloseTo(before.sx, 6);
    expect(e.container.alpha).not.toBe(before.alpha);

    e.clearTrajectoryOverlay();
    expect(sprite.scale.x).toBeCloseTo(before.sx, 10);
    expect(sprite.scale.y).toBeCloseTo(before.sy, 10);
    expect(sprite.rotation).toBe(before.rot);
    expect(e.container.alpha).toBe(before.alpha);
    expect(mesh!.rotation).toBe(before.meshRot);
    expectMatrixClose(litMatrix(shade!), before.lit, 10);
    expect(e.getTrajectoryOverlay()).toEqual({
      active: false, rotRad: 0, scaleX: 1, scaleY: 1, alpha: 1,
    });
  });

  it('挂件也复原', () => {
    const { e } = makeEntity({ sockets: SOCKETS });
    const view = new Sprite();
    e.attachToSocket('hand', { view });
    const before = { x: view.x, y: view.y, rot: view.rotation, sx: view.scale.x };
    e.setTrajectoryOverlay(1.1, 2, 2, 1);
    e.clearTrajectoryOverlay();
    expect(view.x).toBeCloseTo(before.x, 10);
    expect(view.y).toBeCloseTo(before.y, 10);
    expect(view.rotation).toBeCloseTo(before.rot, 10);
    expect(view.scale.x).toBeCloseTo(before.sx, 10);
  });

  it('重复 clear 幂等（没叠加过也不炸）', () => {
    const { e } = makeEntity();
    e.clearTrajectoryOverlay();
    e.clearTrajectoryOverlay();
    expect(e.getTrajectoryOverlay().active).toBe(false);
  });
});

// ————————————————————————— 立即落位 —————————————————————————

describe('syncPositionNow：写完姿态当帧生效（Player 的"晚一帧"）', () => {
  it('不调 update 也能把 x/y 落到容器上', () => {
    const { e } = makeEntity();
    e.x = 111;
    e.y = 222;
    expect(e.container.x).not.toBe(111);
    e.syncPositionNow();
    expect(e.container.x).toBe(111);
    expect(e.container.y).toBe(222);
  });
});
