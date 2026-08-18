import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/EventBus';
import { GameLogManager } from './GameLogManager';
import type { GameLogEntry } from '../data/types';

/** 文案桩：把 `分区.键{参数}` 原样拼出来，断言时一眼看得出取的是哪条 strings */
function makeStrings() {
  return {
    get: (cat: string, key: string, vars?: Record<string, string | number>) => {
      const args = vars ? Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',') : '';
      return `${cat}.${key}(${args})`;
    },
  };
}

function makeLog() {
  const bus = new EventBus();
  const log = new GameLogManager(bus);
  log.init({ strings: makeStrings() } as never);
  return { bus, log };
}

const texts = (log: GameLogManager): string[] => log.getEntries().map((e) => e.text);
const channels = (log: GameLogManager): string[] => log.getEntries().map((e) => e.channel);

describe('GameLogManager 收录白名单', () => {
  it('六条通道各落一条，且带上可跳转目标', () => {
    const { bus, log } = makeLog();
    bus.emit('dialogue:line', { speaker: '王婆', text: '你个背时的' });
    bus.emit('item:acquired', { itemId: 'zhiqian', itemName: '纸钱', count: 2 });
    bus.emit('quest:accepted', { questId: 'q1', title: '寻狗' });
    bus.emit('clue:collected', { id: 'c1', title: '香粉味' });
    bus.emit('rule:acquired', { ruleId: 'r1', name: '莫回头' });
    bus.emit('archive:updated', { bookType: 'lore', entryId: 'l1', text: '见闻录新增：雾津' });

    expect(channels(log)).toEqual(['dialogue', 'item', 'quest', 'clue', 'rule', 'archive']);
    expect(log.getEntries().map((e) => e.link)).toEqual([
      undefined,
      { kind: 'item', id: 'zhiqian' },
      { kind: 'quest', id: 'q1' },
      { kind: 'clue', id: 'c1' },
      { kind: 'rule', id: 'r1' },
      { kind: 'archive', id: 'l1', bookType: 'lore' },
    ]);
    // 物品正文与右上入袋回执取同一条 strings（玩家要能把两处对上号）
    expect(texts(log)[1]).toBe('pickup.acquired(name=纸钱,count=2)');
    // 档案正文直接用事件带上来的那串（七种册子的映射表只在 ArchiveManager 一份）
    expect(texts(log)[5]).toBe('见闻录新增：雾津');
  });

  it('白名单之外的总线事件一律不记（日志不是事件总线的镜子）', () => {
    const { bus, log } = makeLog();
    bus.emit('flag:changed', { key: 'anything', value: true });
    bus.emit('scene:enter', { sceneId: 'teahouse' });
    bus.emit('quest:changed', { reason: 'accepted' });
    bus.emit('notification:show', { text: '随便一条木条', type: 'info' });
    expect(log.getEntries()).toEqual([]);
  });

  it('活计（repeatable）走另一套文案键', () => {
    const { bus, log } = makeLog();
    bus.emit('quest:accepted', { questId: 'j1', title: '背尸', repeatable: true });
    bus.emit('quest:completed', { questId: 'j1', title: '背尸', repeatable: true });
    expect(texts(log)).toEqual([
      'notifications.jobAccepted(title=背尸)',
      'notifications.jobCompleted(title=背尸)',
    ]);
  });

  it('hidden 线索不留字面（纯机制线索连线索簿都不进）', () => {
    const { bus, log } = makeLog();
    bus.emit('clue:collected', { id: 'secret', title: '不该露的', hidden: true });
    bus.emit('clue:collected', { id: 'open', title: '该露的' });
    expect(log.getEntries()).toHaveLength(1);
    expect(log.getEntries()[0].link).toEqual({ kind: 'clue', id: 'open' });
  });

  it('碎片提示不挂跳转（文案本就不报是哪条规矩，给跳转等于指出来）', () => {
    const { bus, log } = makeLog();
    bus.emit('rule:fragment', { fragmentId: 'f1', ruleId: 'r1' });
    expect(log.getEntries()).toHaveLength(1);
    expect(log.getEntries()[0].link).toBeUndefined();
  });

  it('堆叠已满（count<=0）不记——事件照发，但东西没进包', () => {
    const { bus, log } = makeLog();
    bus.emit('item:acquired', { itemId: 'x', itemName: '满的', count: 0 });
    expect(log.getEntries()).toEqual([]);
  });
});

describe('GameLogManager 读档闸门', () => {
  it('restoring 期间一条都不记', () => {
    const { bus, log } = makeLog();
    log.setRestoring(true);
    bus.emit('quest:accepted', { questId: 'q1', title: '寻狗' });
    bus.emit('dialogue:line', { speaker: '甲', text: '喂' });
    bus.emit('archive:updated', { bookType: 'lore', entryId: 'l1', text: '重评出来的' });
    expect(log.getEntries()).toEqual([]);
    log.setRestoring(false);
    bus.emit('quest:accepted', { questId: 'q2', title: '别的' });
    expect(log.getEntries()).toHaveLength(1);
  });

  it('quest:accepted{restored} 再兜一道（恢复期补发的重放不是"现在发生了什么"）', () => {
    const { bus, log } = makeLog();
    bus.emit('quest:accepted', { questId: 'q1', title: '寻狗', restored: true });
    expect(log.getEntries()).toEqual([]);
  });
});

describe('GameLogManager 相邻合并', () => {
  it('连着拿同一件并成一条并计数，序号换新（否则躲过未读判据）', () => {
    const { bus, log } = makeLog();
    bus.emit('item:acquired', { itemId: 'zhiqian', itemName: '纸钱', count: 1 });
    const firstSeq = log.getEntries()[0].seq;
    bus.emit('item:acquired', { itemId: 'zhiqian', itemName: '纸钱', count: 2 });
    expect(log.getEntries()).toHaveLength(1);
    expect(log.getEntries()[0].count).toBe(3);
    expect(texts(log)[0]).toBe('pickup.acquired(name=纸钱,count=3)');
    expect(log.getEntries()[0].seq).toBeGreaterThan(firstSeq);
  });

  it('中间隔了别的事就不合并（那是两件事，硬并会把时间线揉乱）', () => {
    const { bus, log } = makeLog();
    bus.emit('item:acquired', { itemId: 'a', itemName: '甲', count: 1 });
    bus.emit('quest:accepted', { questId: 'q1', title: '寻狗' });
    bus.emit('item:acquired', { itemId: 'a', itemName: '甲', count: 1 });
    expect(log.getEntries()).toHaveLength(3);
  });

  it('不同物品不合并', () => {
    const { bus, log } = makeLog();
    bus.emit('item:acquired', { itemId: 'a', itemName: '甲', count: 1 });
    bus.emit('item:acquired', { itemId: 'b', itemName: '乙', count: 1 });
    expect(log.getEntries()).toHaveLength(2);
  });
});

describe('GameLogManager 对话段落抬头', () => {
  it('新一段写抬头；同一段里嵌套的 dialogue:start 不重复写', () => {
    const { bus, log } = makeLog();
    bus.emit('dialogue:start', { npcName: '王婆', source: 'graph' });
    bus.emit('dialogue:line', { speaker: '王婆', text: '一' });
    // 图对话里 playScriptedDialogue 会再发一次 start，说话人相同 → 不再写抬头
    bus.emit('dialogue:start', { npcName: '王婆', source: 'scripted' });
    bus.emit('dialogue:line', { speaker: '王婆', text: '二' });
    expect(log.getEntries().filter((e) => e.type === 'header')).toHaveLength(1);
    expect(texts(log)[0]).toBe('dialogueLog.sessionHeader(name=王婆)');
  });

  it('换了说话人补一条抬头', () => {
    const { bus, log } = makeLog();
    bus.emit('dialogue:start', { npcName: '王婆', source: 'graph' });
    bus.emit('dialogue:line', { speaker: '王婆', text: '一' });
    bus.emit('dialogue:start', { npcName: '瞎子李', source: 'graph' });
    bus.emit('dialogue:line', { speaker: '瞎子李', text: '二' });
    expect(log.getEntries().filter((e) => e.type === 'header')).toHaveLength(2);
  });

  it('隔了事件条之后重新写抬头（那是新一段对话的开头）', () => {
    const { bus, log } = makeLog();
    bus.emit('dialogue:start', { npcName: '王婆', source: 'graph' });
    bus.emit('dialogue:line', { speaker: '王婆', text: '一' });
    bus.emit('item:acquired', { itemId: 'a', itemName: '甲', count: 1 });
    bus.emit('dialogue:start', { npcName: '王婆', source: 'graph' });
    expect(log.getEntries().filter((e) => e.type === 'header')).toHaveLength(2);
  });

  it('无名说话人不写抬头（一条没有主语的分隔线只是噪音）', () => {
    const { bus, log } = makeLog();
    bus.emit('dialogue:start', { npcName: '   ', source: 'scripted' });
    expect(log.getEntries()).toEqual([]);
  });
});

describe('GameLogManager 分桶配额', () => {
  it('对话洪水冲不掉事件条（两桶各自 FIFO）', () => {
    const { bus, log } = makeLog();
    bus.emit('quest:accepted', { questId: 'q1', title: '最早的事件' });
    for (let i = 0; i < 260; i++) {
      bus.emit('dialogue:line', { speaker: '甲', text: `第${i}句` });
    }
    const all = log.getEntries();
    expect(all.filter((e) => e.channel === 'dialogue')).toHaveLength(200);
    // 事件条还在，且仍是表头那一条
    const events = all.filter((e) => e.channel !== 'dialogue');
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('notifications.questAccepted(title=最早的事件)');
    // 被丢掉的是最老的对话
    expect(all.some((e) => e.text === '第0句')).toBe(false);
    expect(all.some((e) => e.text === '第259句')).toBe(true);
  });

  it('事件条超配额时丢自己最老的一条，对话不受影响', () => {
    const { bus, log } = makeLog();
    bus.emit('dialogue:line', { speaker: '甲', text: '留着的台词' });
    for (let i = 0; i < 120; i++) {
      bus.emit('quest:accepted', { questId: `q${i}`, title: `任务${i}` });
    }
    const all = log.getEntries();
    expect(all.filter((e) => e.channel !== 'dialogue')).toHaveLength(100);
    expect(all.some((e) => e.text === '留着的台词')).toBe(true);
    expect(all.some((e) => e.text.includes('任务0)'))).toBe(false);
  });
});

describe('GameLogManager 未读游标', () => {
  it('对话行不计未读（每句都算的话红点永远亮着）', () => {
    const { bus, log } = makeLog();
    bus.emit('dialogue:line', { speaker: '甲', text: '一' });
    expect(log.unreadCount()).toBe(0);
    bus.emit('quest:accepted', { questId: 'q1', title: '寻狗' });
    expect(log.unreadCount()).toBe(1);
  });

  it('markAllSeen 清零；此后再来一条又变未读', () => {
    const { bus, log } = makeLog();
    bus.emit('quest:accepted', { questId: 'q1', title: '寻狗' });
    log.markAllSeen();
    expect(log.unreadCount()).toBe(0);
    bus.emit('clue:collected', { id: 'c1', title: '香粉味' });
    expect(log.unreadCount()).toBe(1);
  });

  it('翻过日志后再捡同一件东西（走合并路径）仍算未读', () => {
    const { bus, log } = makeLog();
    bus.emit('item:acquired', { itemId: 'a', itemName: '甲', count: 1 });
    log.markAllSeen();
    expect(log.unreadCount()).toBe(0);
    bus.emit('item:acquired', { itemId: 'a', itemName: '甲', count: 1 });
    expect(log.unreadCount()).toBe(1);
  });
});

describe('GameLogManager 存档', () => {
  it('存读一轮不丢条目与游标', () => {
    const { bus, log } = makeLog();
    bus.emit('quest:accepted', { questId: 'q1', title: '寻狗' });
    bus.emit('dialogue:line', { speaker: '甲', text: '一' });
    log.markAllSeen();
    bus.emit('clue:collected', { id: 'c1', title: '香粉味' });
    const saved = JSON.parse(JSON.stringify(log.serialize()));

    const { log: fresh } = makeLog();
    fresh.deserialize(saved);
    expect(texts(fresh)).toEqual(texts(log));
    expect(fresh.unreadCount()).toBe(1);
  });

  it('读档端同样夹配额（改过的档不能把任意长的表灌回来）', () => {
    const { log } = makeLog();
    const entries: GameLogEntry[] = [];
    for (let i = 0; i < 400; i++) {
      entries.push({ seq: i + 1, channel: 'dialogue', type: 'line', text: `第${i}句` });
    }
    for (let i = 0; i < 400; i++) {
      entries.push({ seq: 401 + i, channel: 'quest', type: 'event', text: `事件${i}` });
    }
    log.deserialize({ entries, nextSeq: 801, lastSeenSeq: 0 });
    const all = log.getEntries();
    expect(all.filter((e) => e.channel === 'dialogue')).toHaveLength(200);
    expect(all.filter((e) => e.channel !== 'dialogue')).toHaveLength(100);
  });

  it('旧桶（dialogueLog）迁进来仍是一份能翻的对话记录，且一律算已读', () => {
    const { log } = makeLog();
    log.migrateLegacyDialogueLog({
      entries: [
        { type: 'line', speaker: '王婆', text: '旧台词' },
        { type: 'choice', text: '旧选项' },
      ],
    });
    expect(texts(log)).toEqual(['旧台词', '旧选项']);
    expect(channels(log)).toEqual(['dialogue', 'dialogue']);
    expect(log.getEntries().map((e) => e.type)).toEqual(['line', 'choice']);
    // 老档里那些对话玩家当时就读过了，升级完不该顶着一个红点
    expect(log.unreadCount()).toBe(0);
  });

  it('坏档条目（缺 text）被滤掉而不是灌进来', () => {
    const { log } = makeLog();
    log.deserialize({ entries: [{ seq: 1, channel: 'quest', type: 'event' } as never, null as never] });
    expect(log.getEntries()).toEqual([]);
  });
});

describe('GameLogManager 变更广播', () => {
  it('落条与合并都发 gameLog:changed（面板开着时靠它跟新内容）', () => {
    const { bus, log } = makeLog();
    let n = 0;
    bus.on('gameLog:changed', () => { n++; });
    bus.emit('item:acquired', { itemId: 'a', itemName: '甲', count: 1 });
    expect(n).toBe(1);
    bus.emit('item:acquired', { itemId: 'a', itemName: '甲', count: 1 }); // 走合并路径
    expect(n).toBe(2);
    expect(log.getEntries()).toHaveLength(1);
  });

  it('被闸门挡下的事件不发广播（读档重放不该惊动面板）', () => {
    const { bus, log } = makeLog();
    let n = 0;
    bus.on('gameLog:changed', () => { n++; });
    log.setRestoring(true);
    bus.emit('item:acquired', { itemId: 'a', itemName: '甲', count: 1 });
    bus.emit('quest:accepted', { questId: 'q1', title: '寻狗' });
    expect(n).toBe(0);
    expect(log.getEntries()).toEqual([]);
  });
});

describe('GameLogManager 生命周期', () => {
  it('destroy 摘干净监听（destroy 后总线上的事件不再落条）', () => {
    const { bus, log } = makeLog();
    bus.emit('quest:accepted', { questId: 'q1', title: '寻狗' });
    expect(log.getEntries()).toHaveLength(1);
    log.destroy();
    bus.emit('quest:accepted', { questId: 'q2', title: '别的' });
    expect(log.getEntries()).toEqual([]);
  });

  it('时刻戳由注入方给（不注入就不带，面板据此不分组）', () => {
    const { bus, log } = makeLog();
    log.setStampProvider(() => ({ day: 3, phase: '黄昏' }));
    bus.emit('quest:accepted', { questId: 'q1', title: '寻狗' });
    expect(log.getEntries()[0].stamp).toEqual({ day: 3, phase: '黄昏' });
  });
});
