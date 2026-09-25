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
  const m = new RegExp(`fn\\s+${entry}\\s*\\(([^)]*)\\)`, 's').exec(src);
  if (!m) return [];
  const out: ProgramAttribute[] = [];
  const re = /@location\s*\(\s*(\d+)\s*\)\s*(?:@interpolate\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_<>]+)/g;
  let a: RegExpExecArray | null;
  while ((a = re.exec(m[1]))) out.push({ location: Number(a[1]), name: a[2], type: a[3] });
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
