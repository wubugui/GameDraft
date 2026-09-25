import { uid } from '../utils/uid';

export interface ProgramSource {
  source: string;
  entryPoint?: string;
}

export interface GpuProgramOptions {
  name?: string;
  vertex: ProgramSource;
  fragment?: ProgramSource;
  /** 旧 Pixi 选项,忽略 */
  [key: string]: unknown;
}

/** WGSL 里声明的一个资源绑定 */
export interface ProgramBinding {
  group: number;
  binding: number;
  name: string;
  /** var<uniform> */
  isUniform: boolean;
  /** 类型文字(结构体名 / texture_2d<f32> / sampler …) */
  type: string;
}

export interface ProgramStruct {
  name: string;
  members: Record<string, string>;
}

export interface ProgramAttribute {
  name: string;
  location: number;
  /** WGSL 类型,如 vec2<f32> */
  type: string;
}

const cache = new Map<string, GpuProgram>();

/**
 * WGSL 程序(照 Pixi `GpuProgram`):顶点 / 片元源(可以是同一份),各自的入口名。
 * 绑定一律按 WGSL 变量名(uniform 结构体变量名、纹理名、采样器名),与 @group / @binding 编号无关。
 */
export class GpuProgram {
  readonly uid = uid('program');
  readonly vertex: ProgramSource;
  readonly fragment?: ProgramSource;
  readonly name?: string;
  /** 合并后的模块源(顶点与片元同源时只有一份) */
  readonly source: string;
  readonly vertexEntry: string;
  readonly fragmentEntry: string;
  private _attributes: ProgramAttribute[] | null = null;
  private _bindings: ProgramBinding[] | null = null;
  private _structs: ProgramStruct[] | null = null;

  constructor(options: GpuProgramOptions) {
    this.vertex = options.vertex;
    this.fragment = options.fragment;
    this.name = options.name;
    const vs = options.vertex.source;
    const fs = options.fragment?.source ?? vs;
    this.vertexEntry = options.vertex.entryPoint ?? findEntry(vs, 'vertex') ?? 'main';
    this.fragmentEntry = options.fragment?.entryPoint ?? findEntry(fs, 'fragment') ?? 'main';
    if (vs === fs) this.source = vs;
    else this.source = mergeModules(vs, fs, this.vertexEntry, this.fragmentEntry);
  }

  /** 顶点入口的 `@location(n) 名字: 类型` 参数 */
  get attributes(): ProgramAttribute[] {
    return (this._attributes ??= extractAttributes(this.vertex.source, this.vertexEntry));
  }

  /** 模块里声明的全部资源绑定(按名字绑定时用来校验 / 诊断) */
  get bindings(): ProgramBinding[] {
    return (this._bindings ??= extractBindings(this.source));
  }

  /** 与 Pixi 同形的 `structsAndGroups`(测试 / 诊断用):绑定表 + 被绑定引用到的结构体(成员名 → 类型串) */
  get structsAndGroups(): { groups: ProgramBinding[]; structs: ProgramStruct[] } {
    const groups = this.bindings;
    const structs = (this._structs ??= extractStructs(this.source)).filter((st) => groups.some((g) => g.type === st.name));
    return { groups, structs };
  }

  /** 着色器是否声明了 `globalUniforms`(渲染核心据此提供;与 Pixi 字段同名) */
  get autoAssignGlobalUniforms(): boolean {
    return this.bindings.some((b) => b.name === 'globalUniforms');
  }

  get autoAssignLocalUniforms(): boolean {
    return this.bindings.some((b) => b.name === 'localUniforms');
  }

  destroy(): void {}

  static from(options: GpuProgramOptions): GpuProgram {
    const key = `${options.vertex.source}:${options.fragment?.source}:${options.vertex.entryPoint}:${options.fragment?.entryPoint}`;
    let p = cache.get(key);
    if (!p) {
      p = new GpuProgram(options);
      cache.set(key, p);
    }
    return p;
  }
}

function findEntry(wgsl: string, stage: 'vertex' | 'fragment'): string | undefined {
  return new RegExp(`@${stage}\\s+fn\\s+([A-Za-z_][A-Za-z0-9_]*)`).exec(wgsl)?.[1];
}

function extractAttributes(src: string, entry: string): ProgramAttribute[] {
  const head = new RegExp(`fn\\s+${entry}\\s*\\(`).exec(src);
  if (!head) return [];
  // 参数表里有 @location(0) 之类的括号,按括号深度找配对的右括号
  let depth = 1;
  let i = head.index + head[0].length;
  const start = i;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') depth--;
  }
  const params = src.slice(start, i - 1);
  const out: ProgramAttribute[] = [];
  const re = /@location\s*\(\s*(\d+)\s*\)\s*(?:@interpolate\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_<>]+)/g;
  let a: RegExpExecArray | null;
  while ((a = re.exec(params))) out.push({ location: Number(a[1]), name: a[2], type: a[3] });
  return out;
}

/** 照 Pixi extractStructAndGroups 的结构体解析(成员类型按 `[\w<>]+` 取,数组类型只到第一个逗号前) */
function extractStructs(src: string): ProgramStruct[] {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const out: ProgramStruct[] = [];
  const re = /struct\s+(\w+)\s*{([^}]+)}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const members: Record<string, string> = {};
    for (const mm of m[2].matchAll(/(\w+)\s*:\s*([\w<>]+)/g)) members[mm[1]] = mm[2];
    out.push({ name: m[1], members });
  }
  return out;
}

function extractBindings(src: string): ProgramBinding[] {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const out: ProgramBinding[] = [];
  const re = /@group\s*\(\s*(\d+)\s*\)\s*@binding\s*\(\s*(\d+)\s*\)\s*var\s*(<[^>]*>)?\s*([A-Za-z_]\w*)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    out.push({
      group: Number(m[1]),
      binding: Number(m[2]),
      name: m[4],
      isUniform: !!m[3] && /uniform/.test(m[3]),
      type: m[5].trim(),
    });
  }
  return out;
}

/**
 * 顶点与片元是两份不同的 WGSL:拼成一个模块。两份里重名的顶层声明(结构体、绑定、函数)只保留一份
 * ——Pixi 的做法是同一套 group/binding 声明两份里都写,拼起来会重复定义。按「声明头」去重。
 */
function mergeModules(vs: string, fs: string, vEntry: string, fEntry: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of [vs, fs]) {
    for (const decl of splitTopLevel(src)) {
      const key = declKey(decl);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      out.push(decl);
    }
  }
  void vEntry;
  void fEntry;
  return out.join('\n');
}

/** 按顶层花括号 / 分号把 WGSL 切成声明 */
function splitTopLevel(src: string): string[] {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const decls: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < noComments.length; i++) {
    const c = noComments[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        let j = i + 1;
        while (j < noComments.length && /[\s;]/.test(noComments[j])) {
          if (noComments[j] === ';') {
            j++;
            break;
          }
          j++;
        }
        decls.push(noComments.slice(start, j).trim());
        start = j;
        i = j - 1;
      }
    } else if (c === ';' && depth === 0) {
      decls.push(noComments.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  const tail = noComments.slice(start).trim();
  if (tail) decls.push(tail);
  return decls.filter(Boolean);
}

function declKey(decl: string): string | null {
  let m = /^struct\s+([A-Za-z_]\w*)/.exec(decl);
  if (m) return `struct:${m[1]}`;
  m = /var\s*(?:<[^>]*>)?\s*([A-Za-z_]\w*)\s*:/.exec(decl);
  if (m && /^(@group|var|@binding)/.test(decl)) return `var:${m[1]}`;
  m = /^(?:@\w+(?:\([^)]*\))?\s+)*fn\s+([A-Za-z_]\w*)/.exec(decl);
  if (m) return `fn:${m[1]}`;
  m = /^(?:const|override|alias)\s+([A-Za-z_]\w*)/.exec(decl);
  if (m) return `const:${m[1]}`;
  return null;
}
