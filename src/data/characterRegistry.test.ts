import {
  DEFAULT_PLAYER_ANIM_MANIFEST,
  LEGACY_PLAYER_CHARACTER_ID,
  applyCharacterDefaults,
  buildCharacterRegistry,
  isControllableCharacter,
  legacyPlayerCharacter,
  resolveAvatar,
} from './characterRegistry';
import type { CharacterDef, GameConfig, NpcDef } from './types';

const baseConfig = (over: Partial<GameConfig> = {}): GameConfig => ({
  initialScene: 's',
  initialQuest: 'q',
  fallbackScene: 's',
  ...over,
});

describe('isControllableCharacter', () => {
  it('判据只有一条：有没有 avatar 段', () => {
    expect(isControllableCharacter({ id: 'a' })).toBe(false);
    expect(isControllableCharacter({ id: 'a', animFile: '/x/anim.json' })).toBe(false);
    expect(isControllableCharacter({ id: 'a', avatar: {} })).toBe(true);
    expect(isControllableCharacter(undefined)).toBe(false);
    expect(isControllableCharacter(null)).toBe(false);
  });
});

describe('legacyPlayerCharacter（未迁移工程的兼容路径）', () => {
  it('playerAvatar 整块缺省时回落到历史默认动画包', () => {
    const c = legacyPlayerCharacter(baseConfig());
    expect(c.id).toBe(LEGACY_PLAYER_CHARACTER_ID);
    expect(c.animFile).toBe(DEFAULT_PLAYER_ANIM_MANIFEST);
    expect(c.portraitSlug).toBeUndefined();
    expect(isControllableCharacter(c)).toBe(true);
  });

  it('animManifest 为空串/纯空白时同样回落（与旧 setupPlayer 的 trim() || 默认 逐字等价）', () => {
    expect(legacyPlayerCharacter(baseConfig({ playerAvatar: { animManifest: '' } })).animFile)
      .toBe(DEFAULT_PLAYER_ANIM_MANIFEST);
    expect(legacyPlayerCharacter(baseConfig({ playerAvatar: { animManifest: '   ' } })).animFile)
      .toBe(DEFAULT_PLAYER_ANIM_MANIFEST);
  });

  it('stateMap / idle / portraitSlug 原样透传，不提前推导 portraitSlug', () => {
    const idle = { enabled: true, entries: [{ animState: 'yawn' }] };
    const c = legacyPlayerCharacter(baseConfig({
      playerAvatar: {
        animManifest: '/resources/runtime/animation/player_carry_corpse_anim/anim.json',
        stateMap: { idle: 'carry_idle' },
        idle,
      },
    }));
    expect(c.animFile).toBe('/resources/runtime/animation/player_carry_corpse_anim/anim.json');
    expect(c.avatar?.stateMap).toEqual({ idle: 'carry_idle' });
    expect(c.avatar?.idle).toBe(idle);
    // 缺省即缺省——推导是消费侧的事，这里提前推导会把"跟随装扮"的语义写死
    expect(c.portraitSlug).toBeUndefined();
  });

  it('config 本身为空也不炸（开局早期/测试桩）', () => {
    expect(legacyPlayerCharacter(undefined).animFile).toBe(DEFAULT_PLAYER_ANIM_MANIFEST);
    expect(legacyPlayerCharacter(null).animFile).toBe(DEFAULT_PLAYER_ANIM_MANIFEST);
  });
});

describe('resolveAvatar', () => {
  const guan: CharacterDef = {
    id: 'guan_ergou',
    name: '关二狗',
    animFile: '/resources/runtime/animation/player_anim/anim.json',
    portraitSlug: 'player',
    avatar: {
      stateMap: { idle: 'idle', walk: 'walk', kick: 'kick' },
      idle: { enabled: true },
      outfits: {
        carry_corpse: {
          animFile: '/resources/runtime/animation/player_carry_corpse_anim/anim.json',
          stateMap: { idle: 'carry_idle', walk: 'carry_walk', run: 'carry_heavy_walk' },
        },
        // 只换状态映射、不换包的纯状态换装
        limping: { stateMap: { walk: 'limp' } },
      },
    },
  };

  it('不可控角色返回 null', () => {
    expect(resolveAvatar({ id: 'npc', animFile: '/x/anim.json' })).toBeNull();
    expect(resolveAvatar(undefined)).toBeNull();
  });

  it('常态：取角色本体的包/映射/立绘', () => {
    expect(resolveAvatar(guan)).toEqual({
      animFile: '/resources/runtime/animation/player_anim/anim.json',
      stateMap: { idle: 'idle', walk: 'walk', kick: 'kick' },
      portraitSlug: 'player',
      idle: { enabled: true },
    });
  });

  it('装扮覆盖包与映射', () => {
    const r = resolveAvatar(guan, 'carry_corpse')!;
    expect(r.animFile).toBe('/resources/runtime/animation/player_carry_corpse_anim/anim.json');
    expect(r.stateMap).toEqual({ idle: 'carry_idle', walk: 'carry_walk', run: 'carry_heavy_walk' });
  });

  it('装扮换了包又没指定立绘 → portraitSlug 必须留空，交由消费侧按新包推导', () => {
    // 语义锚点：现行 setPlayerAvatar 不传 portraitSlug 换包时，头像跟着新包走
    //（扛尸时用扛尸立绘）。这里若继承本体的 'player'，扛着尸体说话会用常态立绘——反了。
    expect(resolveAvatar(guan, 'carry_corpse')!.portraitSlug).toBeUndefined();
  });

  it('装扮显式指定了立绘就用它', () => {
    const withSlug: CharacterDef = {
      ...guan,
      avatar: {
        ...guan.avatar,
        outfits: { masked: { animFile: '/resources/runtime/animation/x_anim/anim.json', portraitSlug: 'masked_face' } },
      },
    };
    expect(resolveAvatar(withSlug, 'masked')!.portraitSlug).toBe('masked_face');
  });

  it('装扮没换包时才继承本体立绘（纯状态换装不该丢脸）', () => {
    const r = resolveAvatar(guan, 'limping')!;
    expect(r.portraitSlug).toBe('player');
  });

  it('装扮的 animFile 与本体逐字相同时视为没换包，仍继承本体立绘', () => {
    const same: CharacterDef = {
      ...guan,
      avatar: {
        ...guan.avatar,
        outfits: { same_bundle: { animFile: '  /resources/runtime/animation/player_anim/anim.json  ' } },
      },
    };
    expect(resolveAvatar(same, 'same_bundle')!.portraitSlug).toBe('player');
  });

  it('装扮的 animFile 为空串/空白时回落本体包，且不算换包', () => {
    const blank: CharacterDef = {
      ...guan,
      avatar: { ...guan.avatar, outfits: { blank: { animFile: '   ', stateMap: { walk: 'w2' } } } },
    };
    const r = resolveAvatar(blank, 'blank')!;
    expect(r.animFile).toBe('/resources/runtime/animation/player_anim/anim.json');
    expect(r.portraitSlug).toBe('player');
  });

  it('stateMap 是整份取代而不是逐键合并', () => {
    const r = resolveAvatar(guan, 'carry_corpse')!;
    // 常态里有 kick，背尸装扮的映射里没有 —— 必须是"没有"，不能被常态的 kick 补上，
    // 否则扛着尸体还能踢（且播的是常态片段）
    expect(r.stateMap).not.toHaveProperty('kick');
  });

  it('只换映射的装扮沿用角色本体的动画包', () => {
    const r = resolveAvatar(guan, 'limping')!;
    expect(r.animFile).toBe('/resources/runtime/animation/player_anim/anim.json');
    expect(r.stateMap).toEqual({ walk: 'limp' });
  });

  it('未登记/空白装扮名一律按常态解析，不抛异常', () => {
    const normal = resolveAvatar(guan);
    expect(resolveAvatar(guan, 'no_such_outfit')).toEqual(normal);
    expect(resolveAvatar(guan, '')).toEqual(normal);
    expect(resolveAvatar(guan, '   ')).toEqual(normal);
    expect(resolveAvatar(guan, null)).toEqual(normal);
  });

  it('角色漏填 animFile 时留 undefined，绝不兜底成主角的包', () => {
    // 兜底到 player_anim 会让漏填的配角顶着关二狗的动画和立绘上场（同屏两个关二狗），
    // 且无任何告警——比缺件难查得多。缺件由 validator 在构建期拦。
    const r = resolveAvatar({ id: 'axiu', avatar: { stateMap: { walk: 'walk' } } })!;
    expect(r.animFile).toBeUndefined();
    expect(r.animFile).not.toBe(DEFAULT_PLAYER_ANIM_MANIFEST);
    expect(r.portraitSlug).toBeUndefined();
  });

  it('待机节目单跟角色走，不随装扮变', () => {
    expect(resolveAvatar(guan, 'carry_corpse')!.idle).toEqual({ enabled: true });
  });
});

describe('兼容路径的真实消费组合：resolveAvatar(legacyPlayerCharacter(cfg))', () => {
  // P0 验收判据是"旧 playerAvatar 工程逐字段等价"，而运行时真正吃到的是这条组合链，
  // 不是 legacyPlayerCharacter 的裸输出。这里把整条链锁住。
  it('整块缺省 → 默认包 + 无映射 + 立绘留给推导', () => {
    const r = resolveAvatar(legacyPlayerCharacter(baseConfig()))!;
    expect(r.animFile).toBe(DEFAULT_PLAYER_ANIM_MANIFEST);
    expect(r.stateMap).toBeUndefined();
    expect(r.portraitSlug).toBeUndefined();
  });

  it('完整 playerAvatar → 逐字段透传', () => {
    const idle = { enabled: true, firstDelayMs: 9000 };
    const r = resolveAvatar(legacyPlayerCharacter(baseConfig({
      playerAvatar: {
        animManifest: '/resources/runtime/animation/player_carry_corpse_anim/anim.json',
        stateMap: { idle: 'carry_idle', walk: 'carry_walk' },
        portraitSlug: 'carry',
        idle,
      },
    })))!;
    expect(r.animFile).toBe('/resources/runtime/animation/player_carry_corpse_anim/anim.json');
    expect(r.stateMap).toEqual({ idle: 'carry_idle', walk: 'carry_walk' });
    expect(r.portraitSlug).toBe('carry');
    expect(r.idle).toEqual(idle);
  });

  it('合成角色没有 outfits，任何装扮名都按常态解析', () => {
    const c = legacyPlayerCharacter(baseConfig({ playerAvatar: { portraitSlug: 'player' } }));
    expect(resolveAvatar(c, 'carry_corpse')).toEqual(resolveAvatar(c));
  });
});

describe('applyCharacterDefaults：对话图与入口成对继承', () => {
  const reg = buildCharacterRegistry([{
    id: 'blind_li',
    name: '瞎子李',
    animFile: '/resources/runtime/animation/npc_blind_li_anim/anim.json',
    dialogueGraphId: '街头_瞎子李',
    dialogueGraphEntry: 'blind_li',
  }]);

  const npc = (over: Partial<NpcDef> = {}): NpcDef => ({
    id: 'n1', characterId: 'blind_li', name: '', x: 0, y: 0, interactionRange: 70, ...over,
  } as NpcDef);

  it('摆放什么都不写 → 图与入口一起继承', () => {
    const r = applyCharacterDefaults(npc(), reg);
    expect(r.dialogueGraphId).toBe('街头_瞎子李');
    expect(r.dialogueGraphEntry).toBe('blind_li');
    // 既有三字段照旧
    expect(r.name).toBe('瞎子李');
    expect(r.animFile).toContain('npc_blind_li_anim');
  });

  it('⭐ 摆放覆盖了图 → 角色的 entry **绝不**跟过来', () => {
    // 这是本对字段唯一的硬约束：entry 是"某张图内部的节点名"，套到另一张图上
    // 会静默落到错误/不存在的入口，表现为"这个人这场戏说错了话"且零报错。
    const r = applyCharacterDefaults(npc({ dialogueGraphId: '茶馆瞎子李' }), reg);
    expect(r.dialogueGraphId).toBe('茶馆瞎子李');
    expect(r.dialogueGraphEntry).toBeUndefined();
  });

  it('摆放覆盖了图且自带 entry → 两个都用自己的', () => {
    const r = applyCharacterDefaults(npc({ dialogueGraphId: '茶馆瞎子李', dialogueGraphEntry: 'tea' }), reg);
    expect(r.dialogueGraphId).toBe('茶馆瞎子李');
    expect(r.dialogueGraphEntry).toBe('tea');
  });

  it('图继承、entry 就地覆盖是合法的（同一张共用图换入口）', () => {
    const r = applyCharacterDefaults(npc({ dialogueGraphEntry: 'blind_li_night' }), reg);
    expect(r.dialogueGraphId).toBe('街头_瞎子李');
    expect(r.dialogueGraphEntry).toBe('blind_li_night');
  });

  it('空串/纯空白的就地图视同未写（不会顶掉继承，也不会漏继承 entry）', () => {
    const r = applyCharacterDefaults(npc({ dialogueGraphId: '   ' }), reg);
    expect(r.dialogueGraphId).toBe('街头_瞎子李');
    expect(r.dialogueGraphEntry).toBe('blind_li');
  });

  it('角色只有图没有 entry → 只继承图', () => {
    const r2 = buildCharacterRegistry([{ id: 'c', dialogueGraphId: 'g' }]);
    const r = applyCharacterDefaults(npc({ characterId: 'c' }), r2);
    expect(r.dialogueGraphId).toBe('g');
    expect(r.dialogueGraphEntry).toBeUndefined();
  });

  it('角色没配对话图 → 摆放原样，不凭空造字段', () => {
    const r2 = buildCharacterRegistry([{ id: 'c', name: 'X' }]);
    const r = applyCharacterDefaults(npc({ characterId: 'c' }), r2);
    expect('dialogueGraphId' in r).toBe(false);
    expect('dialogueGraphEntry' in r).toBe(false);
  });

  it('无 characterId / 悬垂引用 → 原样返回（空注册表 = no-op 的既有契约）', () => {
    const plain = npc({ characterId: undefined });
    expect(applyCharacterDefaults(plain, reg)).toBe(plain);
    const dangling = npc({ characterId: 'nobody' });
    expect(applyCharacterDefaults(dangling, reg)).toBe(dangling);
  });
});
