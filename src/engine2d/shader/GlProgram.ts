/**
 * GLSL 程序的占位(引擎只有 WebGPU,GLSL 不会被编译)。保留这个类只是让还带着 `gl:` 源的调用点照常构造;
 * 工具侧(工作台 / 预览)自己用它们的 GLSL,不经过这里。
 */
export interface GlProgramOptions {
  vertex: string;
  fragment: string;
  name?: string;
  [key: string]: unknown;
}

export class GlProgram {
  readonly vertex: string;
  readonly fragment: string;
  readonly name?: string;

  constructor(options: GlProgramOptions) {
    this.vertex = options.vertex;
    this.fragment = options.fragment;
    this.name = options.name;
  }

  destroy(): void {}

  static from(options: GlProgramOptions): GlProgram {
    return new GlProgram(options);
  }
}
