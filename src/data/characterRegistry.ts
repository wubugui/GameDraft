import type { CharacterDef, GameConfig, NpcDef, ResolvedAvatar } from './types';

/** id -> CharacterDef 的查表形态。 */
export type CharacterRegistry = Record<string, CharacterDef>;

/**
 * 未迁移工程的合成角色 id：`game_config.playerAvatar` 就地合成一条匿名角色时用它。
 * 构造性防撞（`__` 前后缀），不会与人写的 characterId 撞名。
 */
export const LEGACY_PLAYER_CHARACTER_ID = '__legacy_player__';

/** 玩家动画包的历史缺省值。与 Game.setupPlayer / resetPlayerAvatarFromAction 同一常量。 */
export const DEFAULT_PLAYER_ANIM_MANIFEST = '/resources/runtime/animation/player_anim/anim.json';

export function buildCharacterRegistry(chars: CharacterDef[] | undefined): CharacterRegistry {
  const out: CharacterRegistry = {};
  for (const c of chars ?? []) {
    const id = c?.id?.trim();
    if (id) out[id] = c;
  }
  return out;
}

/**
 * 把角色注册表默认值并入 NpcDef：NpcDef 自带字段优先，缺省从引用的角色补
 * name / animFile / portraitSlug / dialogueGraphId+Entry。
 * 无 characterId 或悬空引用则原样返回（校验器另报，运行时不崩）。
 */
export function applyCharacterDefaults(def: NpcDef, registry: CharacterRegistry): NpcDef {
  const cid = def.characterId?.trim();
  if (!cid) return def;
  const ch = registry[cid];
  if (!ch) return def;
  const out: NpcDef = { ...def };
  if (!out.name && ch.name) out.name = ch.name;
  if (!out.animFile && ch.animFile) out.animFile = ch.animFile;
  if (!out.portraitSlug && ch.portraitSlug) out.portraitSlug = ch.portraitSlug;

  /**
   * 对话图与入口**成对继承**，不能各自 own-first。
   *
   * entry 是"某张图内部的节点名"，只在它所属的那张图里有意义。若摆放覆盖了
   * `dialogueGraphId`（这场戏走另一张图）却把角色的 `dialogueGraphEntry` 继承过来，
   * 那个入口名会被套到一张根本没有它的图上——运行时按图内 `entry` 回落或直接落空，
   * 表现为"这个人这场戏说错了话"，且没有任何报错。故：**图是自己的，就一个都不继承**。
   *
   * 反过来"图继承、entry 就地覆盖"是合法的（同一张共用图里换个入口），照常 own-first。
   */
  if (!out.dialogueGraphId?.trim() && ch.dialogueGraphId) {
    out.dialogueGraphId = ch.dialogueGraphId;
    if (!out.dialogueGraphEntry?.trim() && ch.dialogueGraphEntry) {
      out.dialogueGraphEntry = ch.dialogueGraphEntry;
    }
  }
  return out;
}

/**
 * 从 animFile 的 anim.json URL 取动画包目录名，作为对话头像立绘集的**默认**。
 * 与生产管线约定「立绘集目录名多数==动画包目录名」一致；缺省即由此推导，无需逐 NPC 配 portraitSlug。
 */
export function portraitSlugFromAnimFile(animFile: string | undefined | null): string | null {
  if (!animFile) return null;
  const m = /\/animation\/([^/]+)\/anim\.json/.exec(animFile);
  return m ? m[1] : null;
}

/** 该角色是否可被玩家接管（判据只有一条：有没有 `avatar` 段）。 */
export function isControllableCharacter(def: CharacterDef | undefined | null): boolean {
  return !!def?.avatar;
}

/**
 * 把 `game_config.playerAvatar` 就地合成一条匿名可控角色。
 *
 * **这是未迁移工程的唯一入口，必须与旧 `setupPlayer` 的读法逐字段等价**：
 * animManifest 空串/缺省都回落到历史默认包；stateMap / idle / portraitSlug 原样透传
 * （portraitSlug 缺省仍由消费侧按包目录名推导，此处不提前推导，保持"缺省"语义）。
 */
export function legacyPlayerCharacter(cfg: GameConfig | undefined | null): CharacterDef {
  const pa = cfg?.playerAvatar;
  return {
    id: LEGACY_PLAYER_CHARACTER_ID,
    animFile: pa?.animManifest?.trim() || DEFAULT_PLAYER_ANIM_MANIFEST,
    portraitSlug: pa?.portraitSlug,
    avatar: {
      stateMap: pa?.stateMap,
      idle: pa?.idle,
    },
  };
}

/**
 * 解析某角色在某装扮下**实际生效**的化身三元组（动画包 / 状态映射 / 立绘集）。
 *
 * 合并顺序：装扮覆盖 > 角色本体。装扮只声明它要改的部分，未声明的字段沿用角色本体
 * ——这正是"背尸包只改 idle/walk/run，脸和名字不变"这类换装的表达方式。
 *
 * @param outfit 装扮名；空/未登记 = 常态（不报错，由 validator 在构建期查悬垂引用）
 */
export function resolveAvatar(
  def: CharacterDef | undefined | null,
  outfit?: string | null,
): ResolvedAvatar | null {
  if (!def?.avatar) return null;
  const key = outfit?.trim();
  const o = key ? def.avatar.outfits?.[key] : undefined;

  const ownAnim = def.animFile?.trim() || undefined;
  const outfitAnim = o?.animFile?.trim() || undefined;
  /**
   * 装扮**换了包**时不继承角色本体的立绘集——立绘跟"当前生效的装扮"走，缺省由消费侧
   * 按新包目录名推导（`portraitSlugFromAnimFile`）。这是现行 `setPlayerAvatar` 的语义：
   * 不传 portraitSlug 换包 ⇒ 头像跟着换（扛尸时用扛尸立绘）。
   * 若此处回落到本体 slug，扛着尸体说话会用常态立绘——语义正好反掉。
   */
  const changedBundle = !!outfitAnim && outfitAnim !== ownAnim;
  const inheritedSlug = changedBundle ? undefined : def.portraitSlug?.trim() || undefined;

  return {
    // 不再兜底到玩家默认包：任何角色漏填 animFile 都会静默套上关二狗的动画与立绘
    // （同屏两个关二狗），比缺件更难查。缺件由 validator 在构建期拦，运行时留 undefined。
    animFile: outfitAnim || ownAnim,
    // 装扮给了 stateMap 就整份取代（不是逐键合并）——半份映射会让未覆盖的动词
    // 意外沿用常态片段，换装后播出错误动作，比"没这个动词"更难查。
    stateMap: o?.stateMap ?? def.avatar.stateMap,
    portraitSlug: o?.portraitSlug?.trim() || inheritedSlug,
    idle: def.avatar.idle,
  };
}
