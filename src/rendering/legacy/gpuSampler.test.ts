import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BufferImageSource } from '../../engine2d';
import { samplerOf } from './gpuSampler';

function source(scaleMode: 'nearest' | 'linear' = 'linear'): BufferImageSource {
  return new BufferImageSource({ resource: new Uint8Array(4), width: 1, height: 1, scaleMode });
}

/** WGSL 采样器资源按采样参数共享、不挂在任何纹理的生命期上 */
describe('samplerOf', () => {
  it('纹理销毁后,从它取的共享采样器仍然可用', () => {
    const tex = source();
    const sampler = samplerOf(tex);
    tex.destroy();
    expect(sampler.destroyed).toBe(false);
    expect(sampler.magFilter).toBe('linear');
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
    // src/engine2d 是渲染核心自己:它把 `.style` 映射成按参数缓存的 GPU 采样器(GpuTextures.sampler),不在此纪律内
    for (const file of runtimeSources('src').filter((f) => !f.replace(/\\/g, '/').startsWith('src/engine2d/'))) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (pattern.test(line)) bad.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
