import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from './backends/null/NullRhiDevice';
import { RhiReleaseQueue } from './RhiResourceScope';
import { RhiBufferUsage, RhiError, RhiTextureUsage } from './types';

/**
 * 资源所有权。钉三条"违反了不报错、只在很久以后炸"的性质:
 * 1. 作用域销毁把名下资源、子作用域一个不落地带走(切场景不漏贴图);
 * 2. 资源销毁后立即失效,再用当场报 destroyed-resource(不留给图形 API 报看不懂的错);
 * 3. 录制期间销毁的资源,底层句柄等这一批命令提交后才释放(录到一半的命令还引用着它)。
 */
describe('RhiResourceScope', () => {
  const tex = (label: string) => ({ label, width: 4, height: 4, format: 'rgba8unorm' as const, usage: RhiTextureUsage.SAMPLED });

  it('销毁作用域:先子作用域,再本作用域资源按创建逆序', () => {
    const dev = new NullRhiDevice();
    const scene = dev.createScope('场景');
    const lights = scene.createChild('灯');
    scene.createTexture(tex('背景'));
    scene.createTexture(tex('深度'));
    lights.createBuffer({ label: '灯表', size: 64, usage: RhiBufferUsage.UNIFORM });
    dev.log.length = 0;

    scene.destroy();

    expect(dev.log).toEqual(['release buffer 灯表', 'release texture 深度', 'release texture 背景']);
    expect(scene.destroyed).toBe(true);
    expect(lights.destroyed).toBe(true);
    expect(dev.rootScope.childCount).toBe(0);
  });

  it('销毁幂等;销毁后不能再在它下面建资源', () => {
    const dev = new NullRhiDevice();
    const scope = dev.createScope('临时');
    scope.createTexture(tex('a'));
    scope.destroy();
    scope.destroy();
    expect(() => scope.createTexture(tex('b'))).toThrow(RhiError);
    expect(() => scope.createChild('子')).toThrow(/已销毁/);
  });

  it('资源自行销毁后从作用域摘掉,作用域销毁时不会二次释放', () => {
    const dev = new NullRhiDevice();
    const scope = dev.createScope('场景');
    const t = scope.createTexture(tex('贴图'));
    t.destroy();
    expect(scope.resourceCount).toBe(0);
    dev.log.length = 0;
    scope.destroy();
    expect(dev.log).toEqual([]);
  });

  it('用已销毁的资源当场报 destroyed-resource', () => {
    const dev = new NullRhiDevice();
    const b = dev.rootScope.createBuffer({ label: '顶点', size: 16, usage: RhiBufferUsage.VERTEX | RhiBufferUsage.COPY_DST });
    b.destroy();
    let err: unknown;
    try {
      dev.writeBuffer(b, new Float32Array(4));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RhiError);
    expect((err as RhiError).code).toBe('destroyed-resource');
  });

  it('录制期间销毁:立即失效,句柄在提交后才释放', () => {
    const dev = new NullRhiDevice();
    const t = dev.rootScope.createTexture(tex('贴图'));
    dev.log.length = 0;
    const ok = dev.submit('批', () => {
      t.destroy();
      expect(t.destroyed).toBe(true);
      expect(dev.pendingReleases).toBe(1);
      expect(dev.log).toEqual([]);
    });
    expect(ok).toBe(true);
    expect(dev.pendingReleases).toBe(0);
    expect(dev.log).toEqual(['submit 批', 'release texture 贴图']);
  });

  it('画布后备缓冲不能单独销毁', () => {
    const dev = new NullRhiDevice();
    let thrown: unknown;
    const ok = dev.runFrame((f) => {
      try {
        f.swapchain.destroy();
      } catch (e) {
        thrown = e;
      }
    });
    expect(ok).toBe(true);
    expect(String(thrown)).toMatch(/不能单独销毁/);
  });
});

describe('RhiReleaseQueue', () => {
  it('嵌套录制只在最外层结束时释放;释放出错交给回调,不中断其他释放', () => {
    const errors: unknown[] = [];
    const q = new RhiReleaseQueue((e) => errors.push(e));
    const done: string[] = [];
    q.beginRecording();
    q.beginRecording();
    q.defer(() => done.push('a'));
    q.defer(() => {
      throw new Error('坏句柄');
    });
    q.defer(() => done.push('c'));
    q.endRecording();
    expect(done).toEqual([]);
    q.endRecording();
    expect(done).toEqual(['a', 'c']);
    expect(errors).toHaveLength(1);
  });

  it('不在录制中立即释放', () => {
    const q = new RhiReleaseQueue(() => {});
    let n = 0;
    q.defer(() => n++);
    expect(n).toBe(1);
  });
});

describe('帧录制', () => {
  it('录制中抛异常:这一帧作废、上报,下一帧照常', () => {
    const dev = new NullRhiDevice();
    const errors: RhiError[] = [];
    dev.onDiagnostic((e) => errors.push(e));
    const bad = dev.runFrame(() => {
      throw new Error('上层画错了');
    });
    const good = dev.runFrame(() => {});
    expect(bad).toBe(false);
    expect(good).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('上层画错了');
  });

  it('pass 没 end 就提交:作废并报 invalid-usage', () => {
    const dev = new NullRhiDevice();
    const errors: RhiError[] = [];
    dev.onDiagnostic((e) => errors.push(e));
    const ok = dev.runFrame((f) => {
      f.commands.beginRenderPass({ label: '忘了收尾', target: f.swapchain });
    });
    expect(ok).toBe(false);
    expect(errors[0].code).toBe('invalid-usage');
  });

  it('本批已引用的缓冲,录制期间不许再写(两后端写入时机不同)', () => {
    const dev = new NullRhiDevice();
    const src = dev.rootScope.createBuffer({ label: '源', size: 16, usage: RhiBufferUsage.COPY_SRC | RhiBufferUsage.COPY_DST });
    const dst = dev.rootScope.createBuffer({ label: '目标', size: 16, usage: RhiBufferUsage.COPY_DST });
    const errors: RhiError[] = [];
    dev.onDiagnostic((e) => errors.push(e));
    dev.writeBuffer(src, new Uint32Array([1, 2, 3, 4]));
    const ok = dev.submit('批', (c) => {
      c.copyBufferToBuffer(src, 0, dst, 0, 16);
      dev.writeBuffer(src, new Uint32Array([9, 9, 9, 9]));
    });
    expect(ok).toBe(false);
    expect(errors[0].message).toContain('录制期间不能再写');
    // 提交之后再写没问题
    expect(() => dev.writeBuffer(src, new Uint32Array([5, 6, 7, 8]))).not.toThrow();
  });
});
