/**
 * packUbo 与 Pixi 8.17 的 WGSL UBO 同步函数(createUboElementsWGSL + createUboSyncFunctionWGSL)逐字节一致。
 * 打包的类型信息改成按类型串查表缓存(热路径不再逐值跑正则)后,输出必须不变:同一组值连打两次也要一致。
 */
import { describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import { createUboLayout, packUbo } from './uboLayout';
import { Matrix } from '../math/Matrix';

type U = { name: string; type: string; size: number; value: unknown };

const UNIFORMS: U[] = [
  { name: 'uF', type: 'f32', size: 1, value: 1.25 },
  { name: 'uV2', type: 'vec2<f32>', size: 1, value: new Float32Array([2, 3]) },
  { name: 'uV3', type: 'vec3<f32>', size: 1, value: new Float32Array([4, 5, 6]) },
  { name: 'uV4', type: 'vec4<f32>', size: 1, value: new Float32Array([7, 8, 9, 10]) },
  { name: 'uI', type: 'i32', size: 1, value: -3 },
  { name: 'uI4', type: 'vec4<i32>', size: 1, value: new Int32Array([-1, 2, -3, 4]) },
  { name: 'uM2', type: 'mat2x2<f32>', size: 1, value: new Float32Array([1, 2, 3, 4]) },
  { name: 'uM3', type: 'mat3x3<f32>', size: 1, value: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) },
  { name: 'uM4', type: 'mat4x4<f32>', size: 1, value: new Float32Array(Array.from({ length: 16 }, (_, i) => i + 0.5)) },
  { name: 'uFA', type: 'f32', size: 4, value: new Float32Array([11, 12, 13, 14]) },
  { name: 'uV4A', type: 'vec4<f32>', size: 2, value: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]) },
];

function pixiBytes(uniforms: U[]): Uint8Array {
  const { uboElements, size } = PIXI.createUboElementsWGSL(uniforms.map((u) => ({ ...u })) as never);
  const sync = PIXI.createUboSyncFunctionWGSL(uboElements);
  const buf = new ArrayBuffer(size);
  const values = Object.fromEntries(uniforms.map((u) => [u.name, u.value]));
  sync(values as never, new Float32Array(buf), new Int32Array(buf), 0);
  return new Uint8Array(buf);
}

function ourBytes(uniforms: U[], times = 1): Uint8Array {
  const layout = createUboLayout(uniforms);
  const buf = new ArrayBuffer(layout.size);
  const values = Object.fromEntries(uniforms.map((u) => [u.name, u.value]));
  for (let i = 0; i < times; i++) packUbo(layout, values, new Float32Array(buf), new Int32Array(buf), new Uint32Array(buf), 0);
  return new Uint8Array(buf);
}

describe('packUbo 与 Pixi 的 WGSL UBO 同步逐字节一致', () => {
  it('各种标量 / 向量 / 矩阵 / 数组', () => {
    for (const u of UNIFORMS) expect([u.name, ...ourBytes([u])]).toEqual([u.name, ...pixiBytes([u])]);
    // (vec2 数组不在这里比:Pixi 的数组同步会越过数据读到 undefined,往结构体尾部的对齐填充里写 NaN,只差在填充字节)
    expect(ourBytes(UNIFORMS)).toEqual(pixiBytes(UNIFORMS));
  });

  it('同一布局反复打包(走缓存的类型信息)结果不变', () => {
    expect(ourBytes(UNIFORMS, 3)).toEqual(pixiBytes(UNIFORMS));
  });

  it('mat3x3 给 Matrix 对象:按转置写(同 Pixi 对 Matrix 的处理)', () => {
    const m = new Matrix(1, 2, 3, 4, 5, 6);
    const pm = new PIXI.Matrix(1, 2, 3, 4, 5, 6);
    const ours = ourBytes([{ name: 'uM', type: 'mat3x3<f32>', size: 1, value: m }]);
    const pixi = pixiBytes([{ name: 'uM', type: 'mat3x3<f32>', size: 1, value: pm }]);
    expect(ours).toEqual(pixi);
  });
});
