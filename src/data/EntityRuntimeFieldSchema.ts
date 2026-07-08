import type { HotspotDef, HotspotDisplayImage, NpcDef } from './types';
import runtimeFieldSchemaJson from './runtime_field_schema.json';

export type SceneEntityKind = 'npc' | 'hotspot';
export type RuntimeFieldKind = 'string' | 'number' | 'boolean' | 'object';
export type RuntimeFieldPicker =
  | 'plain'
  | 'animationManifest'
  | 'animationState'
  | 'imagePath'
  | 'hotspotDisplayImage'
  | 'portraitSlug';
export type RuntimeFieldApply =
  | 'position'
  | 'visibility'
  | 'reloadAnimation'
  | 'playAnimation'
  | 'patrol'
  | 'reloadHotspotDisplayImage'
  /** 无需立即应用：写回 def 即生效（如 portraitSlug，下一句对话行自然读到） */
  | 'none';

export type RuntimeFieldValue = string | number | boolean | HotspotDisplayImage | null;

export interface RuntimeFieldDescriptor {
  kind: RuntimeFieldKind;
  persistent: boolean;
  picker: RuntimeFieldPicker;
  apply: RuntimeFieldApply;
  label: string;
}

const RuntimeFieldSchemas = runtimeFieldSchemaJson as Record<SceneEntityKind, Record<string, RuntimeFieldDescriptor>>;

export const NpcDefSchema = RuntimeFieldSchemas.npc;

export const HotspotDefSchema = RuntimeFieldSchemas.hotspot;

export type NpcRuntimeFieldName = keyof typeof NpcDefSchema;
export type HotspotRuntimeFieldName = keyof typeof HotspotDefSchema;

export function runtimeFieldSchemaFor(kind: SceneEntityKind): Record<string, RuntimeFieldDescriptor> {
  return kind === 'npc' ? NpcDefSchema : HotspotDefSchema;
}

export function getRuntimeFieldDescriptor(
  kind: SceneEntityKind,
  fieldName: string,
): RuntimeFieldDescriptor | null {
  return runtimeFieldSchemaFor(kind)[fieldName] ?? null;
}

export function isPersistentRuntimeField(kind: SceneEntityKind, fieldName: string): boolean {
  return getRuntimeFieldDescriptor(kind, fieldName)?.persistent === true;
}

export function persistentRuntimeFieldNames(kind: SceneEntityKind): string[] {
  return Object.entries(runtimeFieldSchemaFor(kind))
    .filter(([, desc]) => desc.persistent)
    .map(([name]) => name);
}

export function coerceRuntimeFieldValue(
  kind: SceneEntityKind,
  fieldName: string,
  raw: unknown,
): { ok: true; value: RuntimeFieldValue; descriptor: RuntimeFieldDescriptor } | { ok: false; error: string } {
  const descriptor = getRuntimeFieldDescriptor(kind, fieldName);
  if (!descriptor || !descriptor.persistent) {
    return { ok: false, error: `${kind}.${fieldName} 不是可存档运行时字段` };
  }
  if (raw === null) {
    return { ok: true, value: null, descriptor };
  }
  switch (descriptor.kind) {
    case 'string': {
      const value = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
      if (!value) return { ok: false, error: `${kind}.${fieldName} 需要非空字符串` };
      return { ok: true, value, descriptor };
    }
    case 'number': {
      const value = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(value)) return { ok: false, error: `${kind}.${fieldName} 需要有限数值` };
      return { ok: true, value, descriptor };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw, descriptor };
      if (typeof raw === 'number') return { ok: true, value: raw !== 0, descriptor };
      const s = String(raw ?? '').trim().toLowerCase();
      if (s === 'true' || s === '1') return { ok: true, value: true, descriptor };
      if (s === 'false' || s === '0') return { ok: true, value: false, descriptor };
      return { ok: false, error: `${kind}.${fieldName} 需要布尔值` };
    }
    case 'object': {
      if (fieldName === 'displayImage') {
        if (!isHotspotDisplayImage(raw)) {
          return { ok: false, error: 'hotspot.displayImage 需要 image/worldWidth/worldHeight' };
        }
        return { ok: true, value: raw, descriptor };
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: `${kind}.${fieldName} 需要对象` };
      }
      return { ok: true, value: raw as RuntimeFieldValue, descriptor };
    }
  }
}

export function isHotspotDisplayImage(raw: unknown): raw is HotspotDisplayImage {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const v = raw as Partial<HotspotDisplayImage>;
  return (
    typeof v.image === 'string' &&
    v.image.trim().length > 0 &&
    typeof v.worldWidth === 'number' &&
    Number.isFinite(v.worldWidth) &&
    v.worldWidth > 0 &&
    typeof v.worldHeight === 'number' &&
    Number.isFinite(v.worldHeight) &&
    v.worldHeight > 0
  );
}

export function applyNpcRuntimeOverride(base: NpcDef, override: Record<string, RuntimeFieldValue> | undefined): NpcDef {
  if (!override) return base;
  const out: NpcDef = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === null) {
      delete (out as unknown as Record<string, unknown>)[key];
      continue;
    }
    const desc = getRuntimeFieldDescriptor('npc', key);
    if (!desc?.persistent) continue;
    if (key === 'x' || key === 'y') {
      if (typeof value === 'number') (out as unknown as Record<string, unknown>)[key] = value;
    } else if (key === 'animFile' || key === 'initialAnimState' || key === 'portraitSlug') {
      if (typeof value === 'string') (out as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

export function applyHotspotRuntimeOverride(
  base: HotspotDef,
  override: Record<string, RuntimeFieldValue> | undefined,
): HotspotDef {
  if (!override) return base;
  const out: HotspotDef = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === null) {
      delete (out as unknown as Record<string, unknown>)[key];
      continue;
    }
    const desc = getRuntimeFieldDescriptor('hotspot', key);
    if (!desc?.persistent) continue;
    if (key === 'x' || key === 'y') {
      if (typeof value === 'number') (out as unknown as Record<string, unknown>)[key] = value;
    } else if (key === 'displayImage' && isHotspotDisplayImage(value)) {
      out.displayImage = value;
    }
  }
  return out;
}
