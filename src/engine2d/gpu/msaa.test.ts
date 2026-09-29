/**
 * 抗锯齿(MSAA,空后端,不需要 GPU):照 Pixi,目标纹理源 antialias ⇒ 画进同尺寸 ×4 多重采样颜色、pass 结束 resolve 回纹理;
 * 画布跟渲染器的 antialias 选项。管线采样数与目标一致(空后端 setPipeline 会校验);中途补模板不另起一张多重采样颜色;
 * 不能 resolve 的格式照常单采样;纹理释放时多重采样附件一起放。
 */
import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import type { RhiCommandList, RhiFrame, RhiRenderPassDesc, RhiTextureDesc } from '../../rendering/rhi';
import { Container } from '../scene/Container';
import { Sprite } from '../sprite/Sprite';
import { Graphics } from '../graphics/Graphics';
import { Texture } from '../textures/Texture';
import { RenderTexture } from '../textures/RenderTexture';
import { BufferImageSource } from '../textures/TextureSource';
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
  it('一次性抓帧才逐 Draw 结束 Pass；续段 load 颜色、深度、模板并保留 MSAA resolve', () => {
    const { rhi, renderer, passes } = setup();
    const ordinarySubmit = rhi.submit.bind(rhi);
    const captured: RhiRenderPassDesc[] = [];
    const capture = vi.spyOn(rhi, 'submit').mockImplementation((label, record) => ordinarySubmit(label, (commands) => {
      const wrapped = Object.create(commands) as RhiCommandList & { frameDebugCaptureActive: boolean };
      wrapped.frameDebugCaptureActive = true;
      wrapped.beginRenderPass = (desc) => {
        captured.push(desc);
        return commands.beginRenderPass(desc);
      };
      record(wrapped);
    }));

    const root = new Container();
    for (let i = 0; i < 20; i++) {
      const source = new BufferImageSource({ resource: new Uint8Array(4 * 4 * 4).fill(i), width: 4, height: 4, label: `draw-step-${i}` });
      root.addChild(new Sprite(new Texture({ source })));
    }
    const rt = RenderTexture.create({ width: 8, height: 8, antialias: true });
    rt.source.label = 'debug-rt';
    renderer.render({ container: root, target: rt });
    expect(captured.map((p) => p.label)).toEqual([
      'offscreen / debug-rt / begin / frame-debug draw 1/2',
      'offscreen / debug-rt / begin / frame-debug draw 2/2',
    ]);
    expect(captured.map((p) => p.colorOps?.[0].load)).toEqual(['clear', 'load']);
    expect(captured.map((p) => p.depthOp?.load)).toEqual(['clear', 'load']);
    expect(captured.map((p) => p.stencilOp?.load)).toEqual(['clear', 'load']);
    expect(captured[0].target).toBe(captured[1].target);
    expect(captured[0].target.sampleCount).toBe(4);
    expect(passes()).toHaveLength(2);
    expect(passes().every((p) => p.includes('resolve→debug-rt'))).toBe(true);
    capture.mockRestore();
    renderer.render({ container: root, target: rt });
    expect(passes()).toHaveLength(3);
    expect(last(passes())).not.toContain('frame-debug draw');
    renderer.destroy();
  });

  it('逐 Draw 分段穿过模板遮罩时，续段保持模板并重设非零参考值', () => {
    const { rhi, renderer } = setup();
    const ordinarySubmit = rhi.submit.bind(rhi);
    const captured: Array<{ desc: RhiRenderPassDesc; references: number[] }> = [];
    vi.spyOn(rhi, 'submit').mockImplementation((label, record) => ordinarySubmit(label, (commands) => {
      const wrapped = Object.create(commands) as RhiCommandList & { frameDebugCaptureActive: boolean };
      wrapped.frameDebugCaptureActive = true;
      wrapped.beginRenderPass = (desc) => {
        const pass = commands.beginRenderPass(desc);
        const item = { desc, references: [] as number[] };
        captured.push(item);
        const observed = Object.create(pass) as typeof pass;
        observed.setStencilReference = (value) => {
          item.references.push(value);
          pass.setStencilReference(value);
        };
        return observed;
      };
      record(wrapped);
    }));

    const root = new Container();
    const masked = root.addChild(new Container());
    const mask = root.addChild(new Graphics().rect(0, 0, 8, 8).fill(0xffffff));
    masked.mask = mask;
    for (let i = 0; i < 20; i++) {
      const source = new BufferImageSource({ resource: new Uint8Array(4 * 4 * 4).fill(i), width: 4, height: 4, label: `masked-${i}` });
      masked.addChild(new Sprite(new Texture({ source })));
    }
    renderer.render({ container: root, target: RenderTexture.create({ width: 8, height: 8, antialias: true }) });
    const groups = new Map<string, typeof captured>();
    for (const pass of captured) {
      const match = pass.desc.label.match(/^(.*) \/ frame-debug draw (\d+)\/(\d+)$/);
      if (!match) continue;
      const members = groups.get(match[1]) ?? [];
      members.push(pass);
      groups.set(match[1], members);
    }
    const stencilGroup = [...groups.values()].find((passes) => passes.length > 1 && passes.some((p) => p.references.some((ref) => ref > 0)));
    expect(stencilGroup).toBeDefined();
    expect(stencilGroup!.every((p) => p.desc.target.depthFormat === 'depth24plus-stencil8')).toBe(true);
    expect(stencilGroup!.slice(1).every((p) => p.desc.stencilOp?.load === 'load' && p.desc.depthOp?.load === 'load')).toBe(true);
    expect(stencilGroup!.some((p, i) => i > 0 && p.references.some((ref) => ref > 0))).toBe(true);
    renderer.destroy();
  });

  it('只有清屏、没有 Draw 的逻辑 Pass 仍执行一次且保留原标签', () => {
    const { rhi, renderer, passes } = setup();
    const ordinarySubmit = rhi.submit.bind(rhi);
    vi.spyOn(rhi, 'submit').mockImplementation((label, record) => ordinarySubmit(label, (commands) => {
      const wrapped = Object.create(commands) as RhiCommandList & { frameDebugCaptureActive: boolean };
      wrapped.frameDebugCaptureActive = true;
      record(wrapped);
    }));
    const rt = RenderTexture.create({ width: 8, height: 8 });
    rt.source.label = 'empty-debug';
    renderer.render({ container: new Container(), target: rt, clear: true });
    expect(passes()).toHaveLength(1);
    expect(passes()[0]).toContain('offscreen / empty-debug / begin');
    expect(passes()[0]).not.toContain('frame-debug draw');
    expect(rhi.log.filter((line) => line.startsWith('draw '))).toHaveLength(0);
    renderer.destroy();
  });

  it('画布抓帧时单 Draw 的上屏 Pass 也带 Draw 标签；下一帧恢复原标签', () => {
    const { rhi, renderer, passes } = setup(false, 8);
    const ordinaryRunFrame = rhi.runFrame.bind(rhi);
    const capture = vi.spyOn(rhi, 'runFrame').mockImplementation((record) => ordinaryRunFrame((frame) => {
      const commands = Object.create(frame.commands) as RhiCommandList & { frameDebugCaptureActive: boolean };
      commands.frameDebugCaptureActive = true;
      record({ ...frame, commands } as RhiFrame);
    }));
    renderer.render({ container: scene() });
    expect(passes()).toEqual([
      'begin render canvas / 画布 / begin / frame-debug draw 1/1 -> engine2d 画布中间纹理 目标 [clear]',
      'begin render canvas / 画布 / 翻转上屏 / frame-debug draw 1/1 -> 画布后备缓冲 [clear]',
    ]);
    capture.mockRestore();
    renderer.render({ container: scene() });
    expect(passes().slice(2).every((pass) => !pass.includes('frame-debug draw'))).toBe(true);
    renderer.destroy();
  });
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

  it('画布:渲染器 antialias ⇒ 多重采样画进画布中间纹理并 resolve 回它,帧末翻转上屏(单采样)', () => {
    const { renderer, passes } = setup(true, 8);
    renderer.render({ container: scene() });
    expect(passes()).toEqual([
      'begin render canvas / 画布 / begin -> engine2d 画布中间纹理 目标 MSAA×4 [clear] resolve→engine2d 画布中间纹理',
      'begin render canvas / 画布 / 翻转上屏 -> 画布后备缓冲 [clear]',
    ]);
    renderer.destroy();

    const plain = setup(false, 8);
    plain.renderer.render({ container: scene() });
    expect(plain.passes()).toEqual([
      'begin render canvas / 画布 / begin -> engine2d 画布中间纹理 目标 [clear]',
      'begin render canvas / 画布 / 翻转上屏 -> 画布后备缓冲 [clear]',
    ]);
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
