import {
  ANIMAL_REPLY_INTENTS,
  DEFAULT_TUNING,
  HUMAN_REPLY_INTENTS,
  LINE_SLOTS,
  type WorldBrainActKind,
  type WorldBrainAnimRole,
  type WorldBrainConfig,
  type WorldBrainPersonDef,
  type WorldBrainTuning,
} from './types';
import { StreetGraph } from './streetGraph';

export const HUMAN_ACTS: readonly WorldBrainActKind[] = [
  'carry_on', 'go', 'go_home', 'run_shelter', 'face_player', 'approach_player', 'avoid_player',
  'follow_player', 'watch_event', 'gawk_event', 'cower', 'drop_flat', 'startle', 'flee', 'leave',
  'approach_person',
];

export const ANIMAL_ACTS: readonly WorldBrainActKind[] = [
  'carry_on', 'go', 'go_home', 'run_shelter', 'approach_player', 'avoid_player', 'follow_player',
  'watch_event', 'flee', 'startle',
];

const ALL_ACTS = new Set<WorldBrainActKind>([
  ...HUMAN_ACTS, ...ANIMAL_ACTS, 'bark', 'peck', 'flap', 'honk', 'charge_player', 'stretch', 'arch',
]);

/** 人的通用动画名（本仓库人物动画包都带这六个片段） */
export const HUMAN_ANIMS: Record<'idle' | 'walk' | 'run' | 'jump' | 'crouch' | 'lie', string> = {
  idle: 'idle',
  walk: 'slow_walk',
  run: 'run',
  jump: 'jump',
  crouch: 'crouch',
  lie: 'lie_down',
};

export interface ResolvedPerson extends WorldBrainPersonDef {
  kind: 'human' | 'animal';
  acts: WorldBrainActKind[];
  anims: Partial<Record<WorldBrainAnimRole, string>>;
  walkSpeed: number;
  runSpeed: number;
  says: string[];
  lines: Record<string, string[]>;
  replies: Record<string, string[]>;
  relations: { npcId: string; text: string }[];
  actText: Partial<Record<WorldBrainActKind, string>>;
  /** 发道具的职责（见 WorldBrainPersonDef.handOut）；没有为空表 */
  handOut: { item: string; count: number; upTo: number }[];
}

export interface ResolvedWorldBrainConfig {
  sceneId: string;
  setting: string;
  /** 显著度题用的一句话街面（见 WorldBrainConfig.brief；缺省 setting 前 40 字） */
  brief: string;
  player: { label: string; identity: string };
  graph: StreetGraph;
  people: ResolvedPerson[];
  lineCategories: Record<string, string>;
  genericLines: Record<string, string[]>;
  genericReplies: Record<string, string[]>;
  /** 平常话的类别（见 WorldBrainConfig.ambientCategories） */
  ambientCategories: string[];
  /** 音效 id → 街上的人听来是啥（见 WorldBrainConfig.soundWords） */
  soundWords: Record<string, string>;
  tuning: WorldBrainTuning;
}

const KNOWN_SLOTS = new Set<string>(LINE_SLOTS);

/** 句子里写了不认识的槽位（多半是手误）：那句永远填不上、永远说不出来，且不报错 */
function checkSlots(owner: string, map: Record<string, string[]>, warnings: string[]): void {
  for (const [cat, list] of Object.entries(map)) {
    for (const line of list) {
      for (const m of line.matchAll(/\{(\w+)\}/g)) {
        if (!KNOWN_SLOTS.has(m[1])) warnings.push(`${owner} / ${cat} 的「${line}」里有不认识的槽位 {${m[1]}}，这句永远说不出来`);
      }
    }
  }
}

/** 回话意图不认识（手误）：那一组句子永远用不上 */
function checkIntents(owner: string, map: Record<string, string[]>, allowed: readonly string[], warnings: string[]): void {
  for (const k of Object.keys(map)) {
    if (!allowed.includes(k)) warnings.push(`${owner} 的回话里有不认识的意图 "${k}"（可用：${allowed.join(' / ')}），已忽略`);
  }
}

export interface ConfigParseResult {
  config: ResolvedWorldBrainConfig | null;
  errors: string[];
  warnings: string[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str).filter(Boolean) : [];
}

function linesMap(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
    const items = strList(list);
    if (items.length) out[k] = items;
  }
  return out;
}

/**
 * 读一份世界脑配置。**错误 = 整份不用**（世界脑在该场景不启用）；警告 = 跳过那一项继续。
 * 运行时容错、开发期响（调用方把 errors/warnings 打到控制台与调试面板）。
 */
export function parseWorldBrainConfig(raw: unknown, sceneId: string): ConfigParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { config: null, errors: ['配置不是对象'], warnings };
  }
  const r = raw as Record<string, unknown>;
  const declared = str(r.sceneId);
  if (declared && declared !== sceneId) {
    errors.push(`sceneId 是 "${declared}"，但当前场景是 "${sceneId}"`);
  }

  const places = [];
  const placeIds = new Set<string>();
  for (const p of Array.isArray(r.places) ? r.places : []) {
    const o = (p ?? {}) as Record<string, unknown>;
    const id = str(o.id);
    const x = num(o.x);
    const y = num(o.y);
    if (!id || x === null || y === null) {
      warnings.push(`地点缺 id 或坐标，已跳过：${JSON.stringify(p)}`);
      continue;
    }
    if (placeIds.has(id)) {
      warnings.push(`地点 id 重复 "${id}"，后者跳过`);
      continue;
    }
    placeIds.add(id);
    places.push({
      id,
      name: str(o.name) || id,
      desc: str(o.desc) || undefined,
      x,
      y,
      capacity: num(o.capacity) ?? undefined,
      shelter: o.shelter === true,
      exit: o.exit === true,
    });
  }
  if (places.length === 0) errors.push('一个地点都没有');

  const links: [string, string][] = [];
  for (const l of Array.isArray(r.links) ? r.links : []) {
    if (!Array.isArray(l) || l.length !== 2) {
      warnings.push(`路的写法不对：${JSON.stringify(l)}`);
      continue;
    }
    const a = str(l[0]);
    const b = str(l[1]);
    if (!placeIds.has(a) || !placeIds.has(b)) {
      warnings.push(`路连到了不存在的地点：${a} — ${b}`);
      continue;
    }
    links.push([a, b]);
  }
  const graph = new StreetGraph(places, links);
  if (places.length > 1 && !graph.isConnected()) {
    warnings.push('路网没有连成一片：有的地方走不过去');
  }

  const lineCategories: Record<string, string> = {};
  if (r.lineCategories && typeof r.lineCategories === 'object') {
    for (const [k, v] of Object.entries(r.lineCategories as Record<string, unknown>)) {
      const d = str(v);
      if (k.trim() && d) lineCategories[k.trim()] = d;
    }
  }
  const genericLines = linesMap(r.genericLines);
  checkSlots('通用台词', genericLines, warnings);
  const genericReplies = linesMap(r.genericReplies);
  checkSlots('通用回话', genericReplies, warnings);
  checkIntents('通用回话', genericReplies, HUMAN_REPLY_INTENTS, warnings);
  for (const k of Object.keys(genericReplies)) {
    if (!(HUMAN_REPLY_INTENTS as readonly string[]).includes(k)) delete genericReplies[k];
  }

  const people: ResolvedPerson[] = [];
  const npcIds = new Set<string>();
  const labels = new Set<string>();
  for (const p of Array.isArray(r.people) ? r.people : []) {
    const o = (p ?? {}) as Record<string, unknown>;
    const npcId = str(o.npcId);
    const label = str(o.label);
    if (!npcId || !label) {
      warnings.push(`人缺 npcId 或 label，已跳过：${JSON.stringify(p).slice(0, 120)}`);
      continue;
    }
    if (npcIds.has(npcId)) {
      warnings.push(`npcId 重复 "${npcId}"，后者跳过`);
      continue;
    }
    if (labels.has(label)) {
      warnings.push(`称呼重复 "${label}"：Jev 分不清是哪个，后者跳过`);
      continue;
    }
    const kind = o.kind === 'animal' ? 'animal' : 'human';
    const home = str(o.home);
    if (!placeIds.has(home)) {
      warnings.push(`"${label}" 的 home "${home}" 不是已知地点，已跳过此人`);
      continue;
    }
    const haunts = strList(o.haunts).filter((h) => {
      if (placeIds.has(h)) return true;
      warnings.push(`"${label}" 的 haunts 里 "${h}" 不是已知地点，已忽略`);
      return false;
    });
    const rawActs = strList(o.acts) as WorldBrainActKind[];
    const acts = (rawActs.length ? rawActs : [...(kind === 'animal' ? ANIMAL_ACTS : HUMAN_ACTS)]).filter((a) => {
      if (ALL_ACTS.has(a)) return true;
      warnings.push(`"${label}" 的菜单里有不认识的事 "${a}"，已忽略`);
      return false;
    });
    if (!acts.includes('carry_on')) acts.unshift('carry_on');
    const anims: Partial<Record<WorldBrainAnimRole, string>> = kind === 'human' ? { ...HUMAN_ANIMS } : {
      idle: 'idle', walk: 'slow_walk', run: 'run',
    };
    if (o.anims && typeof o.anims === 'object') {
      for (const [k, v] of Object.entries(o.anims as Record<string, unknown>)) {
        const s = str(v);
        if (s) anims[k as WorldBrainAnimRole] = s;
      }
    }
    const says = kind === 'animal' ? [] : strList(o.says).filter((c) => {
      if (lineCategories[c]) return true;
      warnings.push(`"${label}" 的 says 里 "${c}" 不是已声明的说话类别，已忽略`);
      return false;
    });
    const relations: { npcId: string; text: string }[] = [];
    for (const rel of Array.isArray(o.relations) ? o.relations : []) {
      const ro = (rel ?? {}) as Record<string, unknown>;
      const rid = str(ro.npcId);
      const text = str(ro.text);
      if (rid && text) relations.push({ npcId: rid, text });
    }
    const actText: Partial<Record<WorldBrainActKind, string>> = {};
    if (o.actText && typeof o.actText === 'object') {
      for (const [k, v] of Object.entries(o.actText as Record<string, unknown>)) {
        const s = str(v);
        if (s) actText[k as WorldBrainActKind] = s;
      }
    }
    const lines = linesMap(o.lines);
    checkSlots(`"${label}" 的台词`, lines, warnings);
    const replies = linesMap(o.replies);
    const intents: readonly string[] = kind === 'animal' ? ANIMAL_REPLY_INTENTS : HUMAN_REPLY_INTENTS;
    checkSlots(`"${label}" 的回话`, replies, warnings);
    checkIntents(`"${label}"`, replies, intents, warnings);
    for (const k of Object.keys(replies)) if (!intents.includes(k)) delete replies[k];
    const handOut: ResolvedPerson['handOut'] = [];
    for (const h of Array.isArray(o.handOut) ? o.handOut : []) {
      const ho = (h ?? {}) as Record<string, unknown>;
      const item = str(ho.item);
      if (!item) {
        warnings.push(`"${label}" 的 handOut 有一项没写 item，已忽略`);
        continue;
      }
      const count = Math.max(1, Math.round(num(ho.count) ?? 1));
      handOut.push({ item, count, upTo: Math.max(1, Math.round(num(ho.upTo) ?? count)) });
    }
    if (handOut.length && kind === 'animal') {
      warnings.push(`"${label}" 是牲口，发不了道具（handOut 已忽略）`);
      handOut.length = 0;
    }
    npcIds.add(npcId);
    labels.add(label);
    people.push({
      npcId,
      label,
      identity: str(o.identity),
      temper: str(o.temper),
      activity: str(o.activity) || '做自己的事',
      kind,
      home,
      haunts,
      acts,
      actText,
      relations,
      anims,
      walkSpeed: num(o.walkSpeed) ?? (kind === 'animal' ? 55 : 62),
      runSpeed: num(o.runSpeed) ?? (kind === 'animal' ? 190 : 165),
      says,
      lines,
      replies,
      handOut,
    });
  }
  // 关系只认同一份配置里的人（否则 Jev 被问"走到某某跟前"时那个人根本不在）
  for (const p of people) {
    p.relations = p.relations.filter((rel) => {
      if (npcIds.has(rel.npcId) && rel.npcId !== p.npcId) return true;
      warnings.push(`"${p.label}" 的关系指向 "${rel.npcId}"，不在本配置的人里，已忽略`);
      return false;
    });
  }
  if (people.length === 0) errors.push('一个人都没有');
  if (r.perception !== undefined) {
    // 感知是通用机制（旁听动作执行器 / 粒子系统 / 领域事件），不再逐道具配说法
    warnings.push('perception 字段已废弃（街上的人看得见世界里发生的一切，不用逐个道具配），已忽略');
  }

  const ambientCategories = strList(r.ambientCategories).filter((c) => {
    if (lineCategories[c]) return true;
    warnings.push(`ambientCategories 里 "${c}" 不是已声明的说话类别，已忽略`);
    return false;
  });

  const soundWords: Record<string, string> = {};
  if (r.soundWords && typeof r.soundWords === 'object') {
    for (const [id, v] of Object.entries(r.soundWords as Record<string, unknown>)) {
      const w = str(v);
      if (w) soundWords[id] = w;
      else warnings.push(`soundWords 里 "${id}" 的说法是空的，已忽略`);
    }
  }

  const tuning: WorldBrainTuning = { ...DEFAULT_TUNING };
  if (r.tuning && typeof r.tuning === 'object') {
    for (const [k, v] of Object.entries(r.tuning as Record<string, unknown>)) {
      if (!(k in tuning)) continue;
      const key = k as keyof WorldBrainTuning;
      if (key === 'decisionMode') {
        if (v === 'auto' || v === 'choice' || v === 'perOption') tuning.decisionMode = v;
        else warnings.push(`tuning.decisionMode 只认 auto / choice / perOption（当前 ${JSON.stringify(v)}），按 auto`);
        continue;
      }
      if (Array.isArray(tuning[key])) {
        if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && x >= 0)) {
          (tuning as unknown as Record<string, unknown>)[key] = [Math.min(v[0], v[1]), Math.max(v[0], v[1])];
        }
      } else if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        (tuning as unknown as Record<string, unknown>)[key] = v;
      }
    }
  }

  const playerRaw = (r.player ?? {}) as Record<string, unknown>;
  const config: ResolvedWorldBrainConfig = {
    sceneId,
    setting: str(r.setting),
    brief: str(r.brief) || [...str(r.setting)].slice(0, 40).join(''),
    player: { label: str(playerRaw.label) || '玩家', identity: str(playerRaw.identity) },
    graph,
    people,
    lineCategories,
    genericLines,
    genericReplies,
    ambientCategories,
    soundWords,
    tuning,
  };
  return { config: errors.length ? null : config, errors, warnings };
}
