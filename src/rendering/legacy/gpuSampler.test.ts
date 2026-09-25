import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BindGroup, BufferImageSource } from 'pixi.js';
import { samplerOf } from './gpuSampler';

function source(scaleMode: 'nearest' | 'linear' = 'linear'): BufferImageSource {
  return new BufferImageSource({ resource: new Uint8Array(4), width: 1, height: 1, scaleMode });
}

/**
 * WGSL 采样器资源不许挂在纹理的生命期上。钉住的性质:纹理销毁后,同组里用 `samplerOf` 取的采样器不会让
 * BindGroup 自毁;而直接放 `source.style` 会(这正是要防的那条整局卡死路径,对照组证明它真实存在)。
 */
describe('samplerOf', () => {
  it('对照:直接放 source.style,纹理一销毁 BindGroup 就自毁', () => {
    const tex = source();
    const other = source();
    const group = new BindGroup({ 0: other, 1: tex.style });
    tex.destroy();
    expect(group.resources).toBeNull();
  });

  it('用 samplerOf:纹理销毁不连累 BindGroup,采样器本身也还活着', () => {
    const tex = source();
    const other = source();
    const sampler = samplerOf(tex);
    const group = new BindGroup({ 0: other, 1: sampler });
    tex.destroy();
    expect(group.resources).not.toBeNull();
    expect(sampler.destroyed).toBe(false);
  });

  it('按采样参数共享;参数不同是不同的实例;共享件销毁是空操作', () => {
    const a = samplerOf(source('linear'));
    const b = samplerOf(source('linear'));
    const c = samplerOf(source('nearest'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(c.magFilter).toBe('nearest');
    a.destroy();
    expect(a.destroyed).toBe(false);
    expect(samplerOf(source('linear'))).toBe(a);
  });
});

/** 递归列出 src 下的运行时 .ts(不含测试) */
function runtimeSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...runtimeSources(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('采样器资源纪律', () => {
  it('运行时代码里,`<名>Sampler` 资源一律经 samplerOf 取,不直接放 `.style`', () => {
    const bad: string[] = [];
    const pattern = /Sampler['"\]]*\s*[:=]\s*[^;,\n]*\.style\b/;
    for (const file of runtimeSources('src')) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (pattern.test(line)) bad.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
