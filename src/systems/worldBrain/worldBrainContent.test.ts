/**
 * 世界脑内容护栏：真读仓库里的配置、场景与动画包，锁住"配出来的东西运行时真的用得上"。
 * 这几样错了运行时一律**不报错**——只是那个人永远不动 / 不说话 / 播不出动作。
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildMenu,
  buildPerOptionQuestions,
  buildPersonQuestions,
  buildPersonState,
  estimateHeadTokens,
  estimateTokens,
  HEAD_TOKEN_BUDGET,
} from './jevProtocol';
import { buildReplyOptions, buildSayOptions, NO_SLOTS, type ReplyContext } from './speech';
import { parseWorldBrainConfig } from './worldBrainConfig';

const ROOT = resolve(__dirname, '../../..');
const SCENE_ID = 'jev_街巷';
const cfgRaw = JSON.parse(readFileSync(resolve(ROOT, `public/assets/data/world_brain/${SCENE_ID}.json`), 'utf-8'));
const scene = JSON.parse(readFileSync(resolve(ROOT, `public/assets/scenes/${SCENE_ID}.json`), 'utf-8')) as {
  id: string;
  npcs: { id: string; animFile?: string; patrol?: unknown; dialogueGraphId?: string; x: number; y: number }[];
  hotspots: unknown[];
  zones: unknown[];
  worldWidth: number;
  worldHeight: number;
  wind?: { speed?: number };
};
const animResources = resolve(ROOT, 'public/resources/runtime/animation');
const haveAnimResources = existsSync(animResources);

describe(`世界脑配置 ${SCENE_ID}`, () => {
  const parsed = parseWorldBrainConfig(cfgRaw, SCENE_ID);

  it('零错误零警告', () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.config).not.toBeNull();
  });

  it('路网连成一片、地点都在世界范围内', () => {
    const g = parsed.config!.graph;
    expect(g.isConnected()).toBe(true);
    for (const p of g.places) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(scene.worldWidth);
      expect(p.y).toBeLessThanOrEqual(scene.worldHeight);
    }
    expect(g.places.some((p) => p.exit)).toBe(true);
    expect(g.places.some((p) => p.shelter)).toBe(true);
  });

  it('配置里的每个人场上都有，场上每个 NPC 都归世界脑管', () => {
    const npcIds = new Set(scene.npcs.map((n) => n.id));
    const people = parsed.config!.people.map((p) => p.npcId);
    for (const id of people) expect(npcIds.has(id), id).toBe(true);
    for (const id of npcIds) expect(people.includes(id), id).toBe(true);
  });

  it('每个人会说的每一类话都有句子（自己的或通用的）', () => {
    const cfg = parsed.config!;
    for (const p of cfg.people) {
      for (const cat of p.says) {
        const pool = p.lines[cat] ?? cfg.genericLines[cat] ?? [];
        expect(pool.length, `${p.label} / ${cat}`).toBeGreaterThan(0);
      }
    }
  });

  const allLines = (): string[] => {
    const cfg = parsed.config!;
    const all: string[] = [];
    for (const p of cfg.people) {
      for (const list of Object.values(p.lines)) all.push(...list);
      for (const list of Object.values(p.replies)) all.push(...list);
    }
    for (const list of Object.values(cfg.genericLines)) all.push(...list);
    for (const list of Object.values(cfg.genericReplies)) all.push(...list);
    return all;
  };

  it('台词与回话守渝都腔红线（您 / 俺 / 咱们 / 哩 / 莫得 / 巴适 / 瓜娃子 / 句末哇与啦）', () => {
    for (const line of allLines()) {
      expect(line, line).not.toMatch(/您|俺|咱们|哩|莫得|巴适|瓜娃子|哇[？?！!。]?$|啦[？?！!。]?$/);
    }
  });

  it('没有一句写死某一种事（雷、闪电……）：出了啥事一律走 {event} 槽位，由感知层填', () => {
    for (const line of allLines()) expect(line, line).not.toMatch(/雷|劈|闪电|霹雳/);
    for (const d of Object.values(parsed.config!.lineCategories)) expect(d, d).not.toMatch(/雷|劈|闪电/);
  });

  it('按 E 找谁都回得上话：平常时（没出事、没拿东西）每个人至少三种回法，出了事再多"摆那件事 / 怀疑你"', () => {
    const cfg = parsed.config!;
    const quiet: ReplyContext = {
      atOwnActivity: true, headingTo: null, eventText: null, eventByPlayer: false, playerOddity: null, slots: NO_SLOTS,
    };
    const stirred: ReplyContext = {
      ...quiet, eventText: '十字口那边出现了天雷', slots: { ...NO_SLOTS, event: '天雷', where: '十字口' },
    };
    for (const p of cfg.people) {
      const calm = buildReplyOptions(p, cfg, quiet);
      expect(Object.keys(calm).length, `${p.label} 平常时`).toBeGreaterThanOrEqual(p.kind === 'animal' ? 2 : 3);
      if (p.kind === 'human') {
        const hot = buildReplyOptions(p, cfg, stirred);
        expect(hot.about_event, `${p.label} 出了事`).toBeDefined();
        expect(hot.blame, `${p.label} 出了事`).toBeDefined();
      }
    }
  });

  it('每个人一发都装得进 Laya 的窗口：最坏情形下 state 不超预算、走位题不超约 256 token', () => {
    const cfg = parsed.config!;
    const events = Array.from({ length: 6 }, (_, i) => ({
      at: 10 + i, text: `关二狗在十字口拿出「雷符」用了（画着雷纹的黄符，掐诀掷出能引雷）第${i}`, salience: 0.9,
      spectacle: true, source: 't',
    }));
    const present = new Set(cfg.people.map((p) => p.npcId));
    for (const p of cfg.people) {
      const st = buildPersonState({
        config: cfg, now: 20, timeOfDay: '午时',
        player: { where: '十字口附近', gait: 'running', stillFor: 0, posture: '蹲下去了', holding: '提着点燃的纤藤火把' },
        events,
        person: {
          person: p, where: '去后坡土坝的路上', doing: '走到袍哥跟前，给袍哥递烟、赔笑脸', doingForSec: 40, playerDist: 150, x: 0, y: 0,
          seen: ['袍哥', '洗衣婆', '跑腿伙计'].map((label, i) => ({ label, x: 100 * (i + 1), y: 0, where: '十字口', doing: '站着', forSec: 60 })),
        },
        budget: cfg.tuning.stateTokenBudget,
      });
      expect(estimateTokens(st), `${p.label} state`).toBeLessThanOrEqual(cfg.tuning.stateTokenBudget);
      // 最坏情形：菜单最全（看得见玩家、有出事地点、人都在）＋被搭话的提示
      const menu = buildMenu({ person: p, config: cfg, atPlace: null, playerDist: 150, hasLocatedEvent: true, scary: true, present });
      const { questions } = buildPersonQuestions({ person: p, menu, say: null, note: '（关二狗刚刚走到跟前跟他搭话。）' }, cfg);
      expect(estimateHeadTokens(questions.act), `${p.label} 走位题`).toBeLessThanOrEqual(HEAD_TOKEN_BUDGET);
      // 菜单本身就该在预算内：兜底的"去掉次要选项"一个都不该动用
      if (questions.act.type === 'choice') {
        expect(Object.keys(questions.act.criteria).length, `${p.label} 菜单被裁了`).toBe(menu.length);
      }
    }
  });

  it('逐项是非（Laya）：最坏情形下每个人的每一道是非题都不超题目预算，打断 / 反应 / 日常 / 开腔 / 回话都问得出来', () => {
    const cfg = parsed.config!;
    const present = new Set(cfg.people.map((p) => p.npcId));
    const longEvent = '十字口那边，关二狗在十字口拿出「雷符」用了（画着雷纹的黄符，掐诀掷出能引雷）';
    const ctx: ReplyContext = {
      atOwnActivity: true, headingTo: '后坡土坝', eventText: longEvent, eventByPlayer: true,
      playerOddity: '提着点燃的纤藤火把、蹲下去了、在街上跑',
      slots: { event: '雷符', where: '十字口', dest: '后坡土坝', held: '纤藤火把' },
    };
    for (const p of cfg.people) {
      const menu = buildMenu({ person: p, config: cfg, atPlace: null, playerDist: 150, hasLocatedEvent: true, scary: true, present });
      const say = buildSayOptions(p, cfg, ctx.slots);
      const reply = buildReplyOptions(p, cfg, ctx);
      const { questions, refs } = buildPerOptionQuestions({ person: p, menu, withGate: true, withRoutine: true, say, reply });
      for (const [k, q] of Object.entries(questions)) {
        expect(estimateHeadTokens(q), `${p.label} ${k}：${q.instructions}`).toBeLessThanOrEqual(HEAD_TOKEN_BUDGET);
      }
      const roles = new Set([...refs.values()].map((r) => (r.what === 'po' ? r.role : r.what)));
      for (const role of ['gate', 'react', 'routine', 'reply']) expect(roles.has(role as never), `${p.label} 缺 ${role}`).toBe(true);
      // 不开腔不是一道题（没涨够就是不开腔）
      expect([...refs.values()].some((r) => r.what === 'po' && r.role === 'say' && r.key === 'silent')).toBe(false);
    }
  });

  it('发道具的职责：至少有一个人；要发的每一样道具表里都有；找他说话时回话只有"塞给你"且说得出那句', () => {
    const cfg = parsed.config!;
    const items = JSON.parse(readFileSync(resolve(ROOT, 'public/assets/data/items.json'), 'utf-8')) as { id: string; name: string }[];
    const byId = new Map(items.map((i) => [i.id, i]));
    const givers = cfg.people.filter((p) => p.handOut.length);
    expect(givers.length).toBeGreaterThan(0);
    for (const p of givers) {
      for (const h of p.handOut) expect(byId.has(h.item), `${p.label} 要发的 ${h.item}`).toBe(true);
      const opts = buildReplyOptions(p, cfg, {
        atOwnActivity: true, headingTo: null, eventText: null, eventByPlayer: false, playerOddity: null, slots: NO_SLOTS,
        handOut: p.handOut.map((h) => byId.get(h.item)!.name),
      });
      expect(Object.keys(opts), p.label).toEqual(['give']);
    }
  });

  it('显著度题的街面（brief）写了：短，且带上街坊怕啥信啥（不带这半句，Laya 把炸雷判成 0.2）', () => {
    const b = String(cfgRaw.brief ?? '');
    expect([...b].length).toBeGreaterThan(0);
    expect([...b].length).toBeLessThanOrEqual(40);
    expect(b).toMatch(/怕|信/);
  });

  it('平常话的类别（逐项是非下交给编排说的）都是声明过的说话类别，且至少有一个人会说', () => {
    const cfg = parsed.config!;
    expect(cfg.ambientCategories.length).toBeGreaterThan(0);
    for (const c of cfg.ambientCategories) {
      expect(cfg.lineCategories[c], c).toBeDefined();
      expect(cfg.people.some((p) => p.says.includes(c)), c).toBe(true);
    }
  });

  it.skipIf(!haveAnimResources)('每个人要用的动作片段在他的动画包里都有', () => {
    const cfg = parsed.config!;
    for (const p of cfg.people) {
      const npc = scene.npcs.find((n) => n.id === p.npcId)!;
      const file = resolve(ROOT, 'public' + String(npc.animFile));
      expect(existsSync(file), file).toBe(true);
      const states = Object.keys((JSON.parse(readFileSync(file, 'utf-8')) as { states: Record<string, unknown> }).states);
      for (const [role, name] of Object.entries(p.anims)) {
        expect(states.includes(name!), `${p.label} ${role}=${name}`).toBe(true);
      }
    }
  });
});

describe(`试验场景 ${SCENE_ID}`, () => {
  it('没有对话、没有热点和区域：不牵动任何剧情', () => {
    for (const n of scene.npcs) expect(n.dialogueGraphId, n.id).toBeUndefined();
    expect(scene.hotspots).toEqual([]);
    expect(scene.zones).toEqual([]);
  });

  it('关着世界脑时有人在巡逻（默认逻辑看得出来），且巡逻点都落在路网的街心点上', () => {
    const cfg = parseWorldBrainConfig(cfgRaw, SCENE_ID).config!;
    const patrolling = scene.npcs.filter((n) => n.patrol);
    expect(patrolling.length).toBeGreaterThan(0);
    for (const n of patrolling) {
      for (const pt of (n.patrol as { route: { x: number; y: number }[] }).route) {
        const near = cfg.graph.nearest(pt.x, pt.y)!;
        expect(Math.hypot(near.x - pt.x, near.y - pt.y), n.id).toBeLessThan(1);
      }
    }
  });

  it('有常风（雷符的阵风要求场景作者风速非零）', () => {
    expect(scene.wind?.speed ?? 0).toBeGreaterThan(0);
  });

  it('相机：zoom 归 1.0、原来的 0.87 挪进 pixelsPerUnit（有效投影不变），开透视跟随、基准点在出生点', () => {
    const s = scene as unknown as {
      camera: { zoom: number; pixelsPerUnit: number };
      spawnPoint: { x: number; y: number };
      perspectiveScale: { near: { x: number; y: number }; far: { x: number; y: number }; cameraFollow?: { refPos?: number } };
    };
    expect(s.camera.zoom).toBe(1);
    expect(s.camera.pixelsPerUnit * s.camera.zoom).toBeCloseTo(0.87, 6);
    const { near, far, cameraFollow } = s.perspectiveScale;
    expect(cameraFollow).toBeDefined();
    const ax = far.x - near.x;
    const ay = far.y - near.y;
    const t = ((s.spawnPoint.x - near.x) * ax + (s.spawnPoint.y - near.y) * ay) / (ax * ax + ay * ay);
    expect(cameraFollow!.refPos).toBeCloseTo(t, 3);
  });

  it('后街和东街之间有路（后坡土坝），不用绕前街', () => {
    const g = parseWorldBrainConfig(cfgRaw, SCENE_ID).config!.graph;
    const path = g.shortestPath('back_fork', 'east_north')!;
    expect(path).toContain('north_yard');
    expect(path).not.toContain('noodle');
  });
});
