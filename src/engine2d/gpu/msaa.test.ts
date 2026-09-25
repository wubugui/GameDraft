/**
 * 抗锯齿(MSAA,空后端,不需要 GPU):照 Pixi,目标纹理源 antialias ⇒ 画进同尺寸 ×4 多重采样颜色、pass 结束 resolve 回纹理;
 * 画布跟渲染器的 antialias 选项。管线采样数与目标一致(空后端 setPipeline 会校验);中途补模板不另起一张多重采样颜色;
 * 不能 resolve 的格式照常单采样;纹理释放时多重采样附件一起放。
 */
import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import type { RhiTextureDesc } from '../../rendering/rhi';
import { Container } from '../scene/Container';
import { Sprite } from '../sprite/Sprite';
import { Graphics } from '../graphics/Graphics';
import { Texture } from '../textures/Texture';
import { RenderTexture } from '../textures/RenderTexture';
import { WebGPURenderer } from './WebGPURenderer';

function setup(antialias = false, canvasSize = 0) {
  const rhi = new NullRhiDevice();
  const canvas = { width: canvasSize, height: canvasSize, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8, antialias });
  const createTexture = vi.spyOn(rhi, 'createTexture');
  const msaaTextures = () => createTexture.mock.calls.map((c) => c[1] as RhiTextureDesc).filter((d) => (d.sampleCount ?? 1) > 1);
  const passes = () => rhi.log.filter((l) => l.startsWith('begin render'));
  return { rhi, renderer, msaaTextures, passes };
}

const last = (a: string[]): string | undefined => a[a.length - 1];

function scene(): Container {
  const root = new Container();
  root.addChild(new Sprite(Texture.WHITE));
  return root;
}

describe('抗锯齿(MSAA)', () => {
  it('antialias 的渲染纹理:画进 ×4 多重采样颜色,pass 结束 resolve 回纹理本身', () => {
    const { renderer, msaaTextures, passes } = setup();
    const rt = RenderTexture.create({ width: 8, height: 8, antialias: true });
    rt.source.label = 'aa-rt';
    renderer.render({ container: scene(), target: rt });
    const ms = msaaTextures();
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ width: 8, height: 8, format: 'bgra8unorm', sampleCount: 4 });
    expect(last(passes())).toMatch(/-> aa-rt 目标 MSAA×4 \[clear\] resolve→aa-rt$/);
    renderer.destroy();
  });

  it('不开 antialias 的渲染纹理照旧单采样,不建多重采样纹理', () => {
    const { renderer, msaaTextures, passes } = setup(true);
    const rt = RenderTexture.create({ width: 8, height: 8 });
    renderer.render({ container: scene(), target: rt });
    expect(msaaTextures()).toHaveLength(0);
    expect(last(passes())).not.toContain('resolve');
    renderer.destroy();
  });

  it('不能 resolve 的格式(32 位浮点)即便 antialias 也单采样画', () => {
    const { renderer, msaaTextures, passes } = setup();
    const rt = RenderTexture.create({ width: 8, height: 8, antialias: true, format: 'rgba32float' });
    renderer.render({ container: scene(), target: rt });
    expect(msaaTextures()).toHaveLength(0);
    expect(last(passes())).not.toContain('resolve');
    renderer.destroy();
  });

  it('画布:渲染器 antialias ⇒ 多重采样画布目标,resolve 到这一帧的画布', () => {
    const { renderer, passes } = setup(true, 8);
    renderer.render({ container: scene() });
    expect(last(passes())).toMatch(/-> 画布后备缓冲 MSAA×4 \[clear\] resolve→画布$/);
    renderer.destroy();

    const plain = setup(false, 8);
    plain.renderer.render({ container: scene() });
    expect(last(plain.passes())).toMatch(/-> 画布后备缓冲 \[clear\]$/);
    plain.renderer.destroy();
  });

  it('遮罩中途补模板:带模板的多重采样目标沿用同一张多重采样颜色,以 load 重开', () => {
    const { renderer, msaaTextures, passes } = setup();
    const rt = RenderTexture.create({ width: 8, height: 8, antialias: true });
    rt.source.label = 'aa-mask';
    const root = scene();
    const masked = root.addChild(new Sprite(Texture.WHITE));
    const mask = root.addChild(new Graphics().rect(0, 0, 4, 4).fill(0xffffff));
    masked.mask = mask;
    renderer.render({ container: root, target: rt });
    const ms = msaaTextures();
    // 一张多重采样颜色 + 一张同采样数的模板
    expect(ms.map((d) => d.format)).toEqual(['bgra8unorm', 'depth24plus-stencil8']);
    const p = passes();
    expect(p.some((l) => /-> aa-mask 目标\+模板 MSAA×4 \[load\] resolve→aa-mask$/.test(l))).toBe(true);
    renderer.destroy();
  });

  it('纹理释放 ⇒ 多重采样附件与目标一起放', () => {
    const { rhi, renderer } = setup();
    const rt = RenderTexture.create({ width: 8, height: 8, antialias: true });
    rt.source.label = 'aa-free';
    renderer.render({ container: scene(), target: rt });
    rt.destroy(true);
    const released = rhi.log.filter((l) => l.startsWith('release') && l.includes('aa-free'));
    expect(released).toEqual(expect.arrayContaining([
      'release target aa-free 目标 MSAA×4',
      'release texture aa-free MSAA×4',
    ]));
    renderer.destroy();
  });
});
