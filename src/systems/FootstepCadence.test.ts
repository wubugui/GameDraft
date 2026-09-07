import { describe, expect, it } from 'vitest';

import { FootstepSystem, type FootstepEmitter, type FootstepSystemDeps } from './FootstepSystem';
import type { AudioPlaybackHandle, FootstepConfig, TransientSfxOptions } from '../data/types';
import { DEFAULT_SPATIAL_PARAMS, cameraListener, planarResolver } from '../utils/audioSpace';

/**
 * 「声音绑帧」与「脚步节奏」是**两件事**，这份测试把它们分开钉死。
 *
 * - **绑定**：声音只在触地帧响。与 `frameRate` / `playbackSpeed` / `referenceSpeed`
 *   **完全无关** —— 无论动画放多快多慢，响的那一下永远落在触地帧上。
 * - **节奏**：触地帧多久到一次 = `触地帧间隔 ÷ 有效帧率`，
 *   而 `有效帧率 = frameRate × playbackSpeed`。所以**每秒响几步**必然随播放速率变，
 *   这是算术不是 bug。
 *
 * 混淆这两件事会得出错误结论。本文件用**真实的 `player_anim` 参数**跑出数字。
 *
 * ## 数据出处（`public/resources/runtime/animation/player_anim/anim.json`）
 *
 * | 片段 | 帧数 | frameRate | referenceSpeed | 触地帧 |
 * |---|---|---|---|---|
 * | walk | 16 | 8  | 50 | [3, 11] |
 * | run  | 16 | 12 | **无**（⇒ 倍率恒 1，不跟移动速度）| [5, 13] |
 *
 * ⚠ run 没有 `referenceSpeed` 是**动画侧的现状，不归本模块管**。
 * 本文件只证明音频侧做对了：**响的那一下永远落在触地帧上**。
 * 动画每秒走几个循环是动画的事，音频忠实跟随、不去纠正它。
 *
 * 触地帧住在动画包的 `sockets.json.contactSlots`（图集槽位），在动画浏览页看图逐帧标；
 * `tools/animation_pipeline/contact_frames.py` 能从原画量贴地像素给出建议值。
 * walk 的 [3,11] 经逐帧看图确认，run 的 [5,13] 由腾空期（贴地像素恰为 0）唯一确定。
 *
 * 移动速度：`Player.ts` 的 `DEFAULT_PLAYER_WALK_SPEED = 100` / `RUN_SPEED = 180`。
 * 倍率：`SpriteEntity.applyLocomotionSpeed` = `clamp(speed / referenceSpeed, 0.5, 2)`；
 * 未声明 `referenceSpeed` 时**恒 1**。
 */

const WALK = { frames: 16, fps: 8, ref: 50 as number | null, contacts: [3, 11], speed: 100 };
/** run 没有 `referenceSpeed`（动画侧现状）⇒ 倍率恒 1 ⇒ 恒 12fps。 */
const RUN = { frames: 16, fps: 12, ref: null as number | null, contacts: [5, 13], speed: 180 };

const RATE_MIN = 0.5;
const RATE_MAX = 2;

/** 与 `SpriteEntity.applyLocomotionSpeed` 同式。 */
function locomotionRate(speed: number, ref: number | null): number {
  if (ref === null || !(ref > 0) || !(speed > 0)) return 1;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, speed / ref));
}

/**
 * 按 `SpriteEntity.update` 的推进方式走帧：
 * `frameDuration = 1 / (fps × playbackSpeed)`，`while (frameTimer >= frameDuration)` 逐帧推进。
 */
class ClipEmitter implements FootstepEmitter {
  readonly id = 'player';
  frame = 0;
  private timer = 0;
  private readonly frameDuration: number;
  constructor(
    private readonly def: { frames: number; fps: number; ref: number | null; speed: number },
  ) {
    this.frameDuration = 1 / (def.fps * locomotionRate(def.speed, def.ref));
  }
  advance(dt: number): void {
    this.timer += dt;
    while (this.timer >= this.frameDuration) {
      this.timer -= this.frameDuration;
      this.frame = (this.frame + 1) % this.def.frames;
    }
  }
  effectiveFps(): number { return 1 / this.frameDuration; }
  getContactX() { return 500; }
  getContactY() { return 500; }
  getClip() { return 'walk'; }
  getFrameIndex() { return this.frame; }
  getFrameCount() { return this.def.frames; }
  /** 模拟 sockets.json 的落脚帧标注（真机上是图集槽位，这里直接按片段帧下标给）。 */
  isContactFrame(f: number) { return this.contacts.includes(f); }
  isVisible() { return true; }
  contacts: number[] = [];
}

function run(def: { frames: number; fps: number; ref: number | null; speed: number; contacts: number[] },
  seconds = 6, tickHz = 60) {
  const cfg: FootstepConfig = {
    sets: { s: { sfx: { walk: 'a' } } },
    defaults: { gainDb: 0 },
  };
  const fired: Array<{ t: number; frame: number }> = [];
  let now = 0;
  const deps: FootstepSystemDeps = {
    playSfx(_id: string, _o: TransientSfxOptions): AudioPlaybackHandle | null {
      return { stop: () => {} };
    },
    getSpatialContext: () => ({
      resolver: planarResolver(),
      listener: cameraListener(planarResolver(), 500, 500, 600),
      params: DEFAULT_SPATIAL_PARAMS,
    }),
    resolveSetAt: () => 's',
    getConfig: () => cfg,
  };
  const sys = new FootstepSystem(deps);
  const e = new ClipEmitter(def);
  e.contacts = def.contacts;
  sys.registerEmitter(e);

  const dt = 1 / tickHz;
  let seen = 0;
  for (let i = 0; i < seconds * tickHz; i++) {
    now += dt;
    e.advance(dt);
    sys.update(dt);
    const rec = sys.getDebugOutputState().recent as Array<{ frame: number }>;
    if (rec.length !== seen) {
      for (let j = seen; j < rec.length; j++) fired.push({ t: now, frame: rec[j].frame });
      seen = rec.length;
    }
  }
  const gaps: number[] = [];
  for (let i = 1; i < fired.length; i++) gaps.push(fired[i].t - fired[i - 1].t);
  const avg = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  return { fired, avgGap: avg, fps: e.effectiveFps() };
}

describe('绑定：声音永远落在触地帧上，与播放速率无关', () => {
  it('walk：每一次发声的帧号都 ∈ [3, 11]', () => {
    const r = run(WALK);
    expect(r.fired.length).toBeGreaterThan(6);
    for (const f of r.fired) expect(WALK.contacts).toContain(f.frame);
  });

  it('run：每一次发声的帧号都 ∈ [5, 13]', () => {
    const r = run(RUN);
    expect(r.fired.length).toBeGreaterThan(6);
    for (const f of r.fired) expect(RUN.contacts).toContain(f.frame);
  });

  it('🔴 把播放速率改成 4 倍 / 0.25 倍，帧号仍然只落在触地帧上', () => {
    // 这条是本模块的核心承诺：**音频只跟帧，不跟时间、不跟速率**。
    // 动画侧怎么调（改 frameRate / 改 referenceSpeed / 过场里另设 playbackSpeed），
    // 音频都不需要跟着改任何东西。
    for (const ref of [45, 360]) {
      const r = run({ ...RUN, ref });
      expect(r.fired.length).toBeGreaterThan(2);
      for (const f of r.fired) expect(RUN.contacts).toContain(f.frame);
    }
  });
});

describe('节奏是动画的事：音频忠实跟随，不去纠正它', () => {
  it('walk 在 100 wu/s 下：ref=50 ⇒ 倍率顶到 2 ⇒ 16fps ⇒ 约 0.5 s/步', () => {
    const r = run(WALK);
    expect(r.fps).toBeCloseTo(16, 6);
    expect(r.avgGap).toBeCloseTo(0.5, 2);
  });

  it('run：没有 referenceSpeed ⇒ 恒 12fps ⇒ 约 0.667 s/步', () => {
    const r = run(RUN);
    expect(r.fps).toBeCloseTo(12, 6);
    expect(r.avgGap).toBeCloseTo(0.667, 2);
  });

  it('动画侧若哪天给 run 补了 referenceSpeed，音频这边零改动、节奏自动跟上', () => {
    // 不主张动画该怎么配，只证明「音频不需要为此改任何数据」。
    const withRef = run({ ...RUN, ref: 90 });
    expect(withRef.fps).toBeCloseTo(24, 6);
    expect(withRef.avgGap).toBeCloseTo(0.333, 2);
    for (const f of withRef.fired) expect(RUN.contacts).toContain(f.frame);
  });
});
