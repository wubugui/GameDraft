/**
 * Independent WGSL uniform-address-space layout calculator + comparator vs engine2d createUboLayout.
 * Scratch review code (r2-sampler-ubo). Not part of the repo.
 */
import { createUboLayout, type UniformGroup } from '../../../../src/engine2d';

interface TypeInfo { align: number; size: number; kind: string; scalar: string; arrayStride?: number; count?: number; elem?: TypeInfo }

export interface WgslMember { name: string; type: string; offset: number; size: number; info: TypeInfo }
export interface WgslStruct { name: string; members: WgslMember[]; size: number; align: number }

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const roundUp = (k: number, n: number) => Math.ceil(n / k) * k;

export function parseStructs(src: string): Record<string, { name: string; rawMembers: { name: string; type: string; attrs: string }[] }> {
  const clean = stripComments(src);
  const out: Record<string, { name: string; rawMembers: { name: string; type: string; attrs: string }[] }> = {};
  const re = /struct\s+(\w+)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const body = m[2];
    // split on top-level commas (not inside <>)
    const parts: string[] = [];
    let depth = 0, cur = '';
    for (const ch of body) {
      if (ch === '<' || ch === '(') depth++;
      else if (ch === '>' || ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    const rawMembers: { name: string; type: string; attrs: string }[] = [];
    for (const p of parts) {
      const t = p.trim();
      if (!t) continue;
      const mm = /^((?:@\w+(?:\([^)]*\))?\s*)*)(\w+)\s*:\s*([\s\S]+)$/.exec(t);
      if (!mm) throw new Error(`cannot parse member '${t}' in struct ${m[1]}`);
      rawMembers.push({ attrs: mm[1].trim(), name: mm[2], type: mm[3].replace(/\s+/g, '') });
    }
    out[m[1]] = { name: m[1], rawMembers };
  }
  return out;
}

function typeInfo(type: string, structs: ReturnType<typeof parseStructs>, uniform = true, aliases: Record<string, string> = {}): TypeInfo {
  type = aliases[type] ?? type;
  const scal: Record<string, number> = { f32: 4, i32: 4, u32: 4, f16: 2, bool: 4 };
  if (type in scal) return { align: scal[type], size: scal[type], kind: 'scalar', scalar: type };
  let m = /^vec([234])(?:<(\w+)>|([fiuh]))$/.exec(type);
  if (m) {
    const n = Number(m[1]);
    const sc = m[2] ?? ({ f: 'f32', i: 'i32', u: 'u32', h: 'f16' } as Record<string, string>)[m[3]];
    const s = scal[sc];
    const align = n === 2 ? 2 * s : 4 * s;
    return { align, size: n * s, kind: 'vec' + n, scalar: sc };
  }
  m = /^mat([234])x([234])(?:<(\w+)>|([fh]))$/.exec(type);
  if (m) {
    const c = Number(m[1]), r = Number(m[2]);
    const sc = m[3] ?? (m[4] === 'f' ? 'f32' : 'f16');
    const col = typeInfo(`vec${r}<${sc}>`, structs, uniform);
    const stride = roundUp(col.align, col.size);
    return { align: col.align, size: c * stride, kind: `mat${c}x${r}`, scalar: sc };
  }
  m = /^array<(.+),(\w+)>$/.exec(type);
  if (m) {
    const elem = typeInfo(m[1], structs, uniform, aliases);
    const n = Number(m[2]);
    if (!Number.isFinite(n)) throw new Error(`array count not numeric: ${type}`);
    const stride = roundUp(elem.align, elem.size);
    const align = uniform ? roundUp(16, elem.align) : elem.align;
    return { align, size: n * stride, kind: 'array', scalar: elem.scalar, arrayStride: stride, count: n, elem };
  }
  if (structs[type]) {
    const st = layoutStruct(type, structs, uniform, aliases);
    return { align: st.align, size: st.size, kind: 'struct', scalar: 'struct' };
  }
  throw new Error(`unknown WGSL type ${type}`);
}

export function layoutStruct(name: string, structs: ReturnType<typeof parseStructs>, uniform = true, aliases: Record<string, string> = {}): WgslStruct {
  const def = structs[name];
  if (!def) throw new Error(`no struct ${name}`);
  let offset = 0;
  let maxAlign = 1;
  const members: WgslMember[] = [];
  let prev: WgslMember | null = null;
  for (const rm of def.rawMembers) {
    const info = typeInfo(rm.type, structs, uniform, aliases);
    let align = info.align;
    let size = info.size;
    const a = /@align\((\d+)\)/.exec(rm.attrs);
    if (a) align = Number(a[1]);
    const sz = /@size\((\d+)\)/.exec(rm.attrs);
    if (sz) size = Number(sz[1]);
    if (uniform && prev && (prev.info.kind === 'struct')) offset = Math.max(offset, prev.offset + roundUp(16, prev.size));
    offset = roundUp(align, offset);
    const mem = { name: rm.name, type: rm.type, offset, size, info };
    members.push(mem);
    prev = mem;
    offset += size;
    maxAlign = Math.max(maxAlign, align);
  }
  const align = uniform ? roundUp(16, maxAlign) : maxAlign;
  return { name, members, size: roundUp(align, offset), align };
}

export interface Mismatch { kind: string; detail: string }

export function compareGroup(ug: UniformGroup, structName: string, src: string): { mismatches: Mismatch[]; table: string[] } {
  const structs = parseStructs(src);
  const aliases: Record<string, string> = {};
  for (const m of stripComments(src).matchAll(/alias\s+(\w+)\s*=\s*([^;]+);/g)) aliases[m[1]] = m[2].replace(/\s+/g, '');
  const st = layoutStruct(structName, structs, true, aliases);
  const js = ug.layout.elements;
  const mismatches: Mismatch[] = [];
  const table: string[] = [];
  const n = Math.max(js.length, st.members.length);
  for (let i = 0; i < n; i++) {
    const j = js[i];
    const w = st.members[i];
    const row = `${String(i).padStart(2)} JS ${j ? `${j.name}:${j.type}${j.size > 1 ? `[${j.size}]` : ''} @${j.offset}+${j.byteSize}` : '-'}  |  WGSL ${w ? `${w.name}:${w.type} @${w.offset}+${w.size}` : '-'}`;
    table.push(row);
    if (!j || !w) { mismatches.push({ kind: 'count', detail: row }); continue; }
    if (j.name !== w.name) mismatches.push({ kind: 'name', detail: row });
    if (j.offset !== w.offset) mismatches.push({ kind: 'offset', detail: row });
    // bytes the JS packer actually writes, and where
    const jsScalar = j.type.includes('i32') ? 'i32' : j.type.includes('u32') ? 'u32' : 'f32';
    const wScalar = w.info.scalar === 'bool' ? 'u32' : w.info.scalar;
    if (wScalar !== 'struct' && jsScalar !== wScalar) mismatches.push({ kind: 'scalar', detail: `${row} (JS writes ${jsScalar}, WGSL reads ${wScalar})` });
    // element stride for arrays
    if (j.size > 1) {
      const jsStride = j.byteSize / j.size;
      if (w.info.kind === 'array') {
        const jsElem = createUboLayout([{ name: 'x', type: j.type, size: 1 }]).elements[0].byteSize;
        // equivalent if WGSL array<vec4> packs JS f32/vec2 contiguous stream exactly
        const wBytes = w.size;
        if (jsStride !== w.info.arrayStride) {
          // allowed only if JS is a contiguous scalar stream reinterpreted as vec4 array covering same bytes
          const contiguous = jsStride === jsElem;
          if (!(contiguous && wBytes === j.byteSize)) mismatches.push({ kind: 'array-stride', detail: `${row} (JS stride ${jsStride}, WGSL stride ${w.info.arrayStride})` });
          else mismatches.push({ kind: 'info-reinterpret', detail: `${row} (JS ${j.type}[${j.size}] contiguous reinterpreted as ${w.type})` });
        }
        if (uniform16Violation(w)) mismatches.push({ kind: 'uniform-stride<16', detail: row });
      } else {
        mismatches.push({ kind: 'array-vs-nonarray', detail: row });
      }
    } else if (w.info.kind === 'array') {
      mismatches.push({ kind: 'nonarray-vs-array', detail: row });
    } else if (j.byteSize !== w.size) {
      mismatches.push({ kind: 'size', detail: row });
    }
  }
  const jsSize = ug.layout.size;
  if (jsSize < st.size) mismatches.push({ kind: 'total-size', detail: `JS buffer ${jsSize} < WGSL struct ${st.size}` });
  table.push(`   total JS ${jsSize} WGSL ${st.size}`);
  return { mismatches, table };
}

function uniform16Violation(w: WgslMember): boolean {
  return w.info.kind === 'array' && (w.info.arrayStride! % 16) !== 0;
}
