/**
 * 一次 render() 的 uniform 数据暂存:每个绘制用到的 uniform 按 256 字节对齐追加在这里,录制前一次写进 GPU。
 * 同一次 render 里值不会再变(onRender 回调都在收集之前跑完),所以按对象去重是安全的。
 */
export const UNIFORM_ALIGN = 256;

export class Arena {
  private buf = new ArrayBuffer(64 * 1024);
  f32 = new Float32Array(this.buf);
  i32 = new Int32Array(this.buf);
  u32 = new Uint32Array(this.buf);
  size = 0;

  reset(): void {
    this.size = 0;
  }

  /** 预留 `bytes` 字节,返回字节偏移(256 对齐),内容清零 */
  alloc(bytes: number): number {
    const offset = Math.ceil(this.size / UNIFORM_ALIGN) * UNIFORM_ALIGN;
    const end = offset + Math.max(16, Math.ceil(bytes / 16) * 16);
    if (end > this.buf.byteLength) this.grow(end);
    new Uint8Array(this.buf, offset, end - offset).fill(0);
    this.size = end;
    return offset;
  }

  get bytes(): Uint8Array {
    return new Uint8Array(this.buf, 0, Math.ceil(this.size / 4) * 4);
  }

  private grow(min: number): void {
    let n = this.buf.byteLength;
    while (n < min) n *= 2;
    const next = new ArrayBuffer(n);
    new Uint8Array(next).set(new Uint8Array(this.buf));
    this.buf = next;
    this.f32 = new Float32Array(next);
    this.i32 = new Int32Array(next);
    this.u32 = new Uint32Array(next);
  }
}
