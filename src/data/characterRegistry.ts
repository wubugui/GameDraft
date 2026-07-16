import type { CharacterDef, NpcDef } from './types';

/** id -> CharacterDef 的查表形态。 */
export type CharacterRegistry = Record<string, CharacterDef>;

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
 * name / animFile / portraitSlug。无 characterId 或悬空引用则原样返回（校验器另报，运行时不崩）。
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
