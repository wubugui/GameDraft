/**
 * UniformGroup → WGSL uniform 缓冲的字节布局与打包。**照 Pixi 8.17 `createUboElementsWGSL` + 同步函数的行为**
 * (运行时的 WGSL 结构体都是按这个布局写的,改了就对不上):
 *
 * - 成员按 UniformGroup 声明顺序排,每个按 WGSL 对齐取整;
 * - 数组(`size > 1`)每个元素占 `max(size, align)` 字节——注意这对 f32 / vec2 数组给出的是 4 / 8 字节跨度,
 *   而 WGSL 的 uniform 数组要求 16 字节跨度,所以 WGSL 侧要把这类数组声明成 vec4 数组再自己拆(配方卡有写);
 * - 总大小按 16 取整。
 */
export type UniformType =
  | 'f32' | 'i32' | 'u32'
  | 'vec2<f32>' | 'vec3<f32>' | 'vec4<f32>'
  | 'vec2<i32>' | 'vec3<i32>' | 'vec4<i32>'
  | 'vec2<u32>' | 'vec3<u32>' | 'vec4<u32>'
  | 'mat2x2<f32>' | 'mat3x3<f32>' | 'mat4x4<f32>'
  | 'mat3x2<f32>' | 'mat4x2<f32>' | 'mat2x3<f32>' | 'mat4x3<f32>' | 'mat2x4<f32>' | 'mat3x4<f32>';

export const WGSL_ALIGN_SIZE_DATA: Record<string, { align: number; size: number }> = {
  i32: { align: 4, size: 4 },
  u32: { align: 4, size: 4 },
  f32: { align: 4, size: 4 },
  f16: { align: 2, size: 2 },
  'vec2<i32>': { align: 8, size: 8 },
  'vec2<u32>': { align: 8, size: 8 },
  'vec2<f32>': { align: 8, size: 8 },
  'vec2<f16>': { align: 4, size: 4 },
  'vec3<i32>': { align: 16, size: 12 },
  'vec3<u32>': { align: 16, size: 12 },
  'vec3<f32>': { align: 16, size: 12 },
  'vec3<f16>': { align: 8, size: 6 },
  'vec4<i32>': { align: 16, size: 16 },
  'vec4<u32>': { align: 16, size: 16 },
  'vec4<f32>': { align: 16, size: 16 },
  'vec4<f16>': { align: 8, size: 8 },
  'mat2x2<f32>': { align: 8, size: 16 },
  'mat2x2<f16>': { align: 4, size: 8 },
  'mat3x2<f32>': { align: 8, size: 24 },
  'mat3x2<f16>': { align: 4, size: 12 },
  'mat4x2<f32>': { align: 8, size: 32 },
  'mat4x2<f16>': { align: 4, size: 16 },
  'mat2x3<f32>': { align: 16, size: 32 },
  'mat2x3<f16>': { align: 8, size: 16 },
  'mat3x3<f32>': { align: 16, size: 48 },
  'mat3x3<f16>': { align: 8, size: 24 },
  'mat4x3<f32>': { align: 16, size: 64 },
  'mat4x3<f16>': { align: 8, size: 32 },
  'mat2x4<f32>': { align: 16, size: 32 },
  'mat2x4<f16>': { align: 8, size: 16 },
  'mat3x4<f32>': { align: 16, size: 48 },
  'mat3x4<f16>': { align: 8, size: 24 },
  'mat4x4<f32>': { align: 16, size: 64 },
  'mat4x4<f16>': { align: 8, size: 32 },
};

export interface UboElement {
  name: string;
  type: string;
  size: number;
  /** 字节偏移 */
  offset: number;
  /** 占用字节数 */
  byteSize: number;
}

export interface UboLayout {
  elements: UboElement[];
  /** 总字节数(16 对齐) */
  size: number;
}

export function createUboLayout(uniforms: ReadonlyArray<{ name: string; type: string; size: number }>): UboLayout {
  let offset = 0;
  const elements: UboElement[] = [];
  for (const u of uniforms) {
    const info = WGSL_ALIGN_SIZE_DATA[u.type];
    if (!info) throw new Error(`[engine2d] uniform 缓冲:不支持的类型 ${u.type}(${u.name})`);
    let size = info.size;
    if (u.size > 1) size = Math.max(size, info.align) * u.size;
    offset = Math.ceil(offset / info.align) * info.align;
    elements.push({ name: u.name, type: u.type, size: u.size, offset, byteSize: size });
    offset += size;
  }
  return { elements, size: Math.ceil(offset / 16) * 16 };
}

type Value = ArrayLike<number> | number | { x: number; y: number } | { x: number; y: number; width: number; height: number }
  | { red: number; green: number; blue: number; alpha: number } | { a: number; toArray(transpose?: boolean): ArrayLike<number> };

function isInt(type: string): boolean {
  return type === 'i32' || type.endsWith('<i32>');
}

function isUint(type: string): boolean {
  return type === 'u32' || type.endsWith('<u32>');
}

/** 把一组 uniform 值按布局写进 f32 / i32 / u32 视图(起点 `base` 以 4 字节为单位) */
export function packUbo(
  layout: UboLayout,
  values: Record<string, unknown>,
  f32: Float32Array,
  i32: Int32Array,
  u32: Uint32Array,
  base: number,
): void {
  for (const el of layout.elements) {
    const v = values[el.name] as Value;
    const o = base + el.offset / 4;
    const view: Float32Array | Int32Array | Uint32Array = isInt(el.type) ? i32 : isUint(el.type) ? u32 : f32;
    if (el.size > 1) {
      // 数组:每元素复制 size/4 个分量,再跳过对齐余量
      const { size, align } = WGSL_ALIGN_SIZE_DATA[el.type];
      const comps = size / 4;
      const stride = Math.max(size, align) / 4;
      const arr = v as ArrayLike<number>;
      if (el.type.startsWith('mat')) {
        // 矩阵数组:逐元素按单个矩阵规则写
        for (let e = 0; e < el.size; e++) writeSingle(el.type, sliceOf(arr, e * matComponents(el.type), matComponents(el.type)), view, o + e * stride);
        continue;
      }
      for (let e = 0, t = 0; e < el.size; e++) {
        for (let j = 0; j < comps; j++) view[o + e * stride + j] = (arr[t++] as number) ?? 0;
      }
      continue;
    }
    writeSingle(el.type, v, view, o);
  }
}

function matComponents(type: string): number {
  const m = /^mat(\d)x(\d)/.exec(type)!;
  return Number(m[1]) * Number(m[2]);
}

function sliceOf(arr: ArrayLike<number>, start: number, len: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push(arr[start + i]);
  return out;
}

function writeSingle(type: string, v: Value, view: Float32Array | Int32Array | Uint32Array, o: number): void {
  if (typeof v === 'number') {
    view[o] = v;
    return;
  }
  if (v == null) return;
  const obj = v as Record<string, unknown>;
  if (type === 'mat3x3<f32>' && obj.a !== undefined && typeof obj.toArray === 'function') {
    const m = (obj.toArray as (t: boolean) => ArrayLike<number>)(true);
    view[o] = m[0]; view[o + 1] = m[1]; view[o + 2] = m[2];
    view[o + 4] = m[3]; view[o + 5] = m[4]; view[o + 6] = m[5];
    view[o + 8] = m[6]; view[o + 9] = m[7]; view[o + 10] = m[8];
    return;
  }
  if (type === 'vec4<f32>' && obj.width !== undefined) {
    view[o] = obj.x as number; view[o + 1] = obj.y as number; view[o + 2] = obj.width as number; view[o + 3] = obj.height as number;
    return;
  }
  if (type === 'vec2<f32>' && obj.x !== undefined) {
    view[o] = obj.x as number; view[o + 1] = obj.y as number;
    return;
  }
  if ((type === 'vec4<f32>' || type === 'vec3<f32>') && obj.red !== undefined) {
    view[o] = obj.red as number; view[o + 1] = obj.green as number; view[o + 2] = obj.blue as number;
    if (type === 'vec4<f32>') view[o + 3] = obj.alpha as number;
    return;
  }
  const a = v as ArrayLike<number>;
  switch (type) {
    case 'mat2x2<f32>':
      view[o] = a[0]; view[o + 1] = a[1]; view[o + 2] = a[2]; view[o + 3] = a[3];
      return;
    case 'mat3x3<f32>':
      view[o] = a[0]; view[o + 1] = a[1]; view[o + 2] = a[2];
      view[o + 4] = a[3]; view[o + 5] = a[4]; view[o + 6] = a[5];
      view[o + 8] = a[6]; view[o + 9] = a[7]; view[o + 10] = a[8];
      return;
    case 'mat4x4<f32>':
      for (let i = 0; i < 16; i++) view[o + i] = a[i];
      return;
    default: {
      const m = /^mat(\d)x(\d)/.exec(type);
      if (m) {
        const col = Number(m[1]);
        const total = col * Number(m[2]);
        for (let i = 0; i < total; i++) view[o + ((i / col) | 0) * 4 + (i % col)] = a[i];
        return;
      }
      const n = type.startsWith('vec') ? Number(type[3]) : 1;
      for (let i = 0; i < n; i++) view[o + i] = a[i];
    }
  }
}
