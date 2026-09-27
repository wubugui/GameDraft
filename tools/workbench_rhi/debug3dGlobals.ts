/**
 * 3D 调试件不许改宿主页面的全局。luma.gl 依赖的 probe.gl 在模块求值时**无条件**写 `globalThis.probe`（它的调试句柄），
 * 会把页面自己的同名全局函数盖掉——声学工作台的「试听」就叫 `probe(id)`，装上 3D 调试件后一点试听就是
 * `probe is not a function`（2026-09-27 迁 RHI 时自检 S8 抓到）。
 *
 * 这个模块必须是 `debug3d.ts` 的**第一个** import（ES 模块按 import 顺序求值：它先记下页面原来的，RHI / luma 再求值，
 * `debug3d.ts` 本体最后调 `restorePageGlobals()` 放回去）。页面原来没有这个名字就不动（luma 的句柄留着，无害）。
 */
const GUARDED = ['probe'] as const;

const saved = new Map<string, PropertyDescriptor>();
for (const name of GUARDED) {
  const d = Object.getOwnPropertyDescriptor(globalThis, name);
  if (d) saved.set(name, d);
}

/** 把页面在 3D 调试件求值之前就有的那几个全局放回去（函数声明的全局属性不可配置但可写，直接赋值） */
export function restorePageGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  for (const [name, d] of saved) {
    if ('value' in d && g[name] !== d.value) g[name] = d.value;
  }
}
