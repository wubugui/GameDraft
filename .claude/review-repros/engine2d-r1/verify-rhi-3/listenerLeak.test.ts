import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { GpuTextures } from '../../../../src/engine2d/gpu/GpuTextures';
import { TextureSource } from '../../../../src/engine2d/textures/TextureSource';

describe('GpuTextures listener registration', () => {
  it('adds a destroy+unload listener pair per GPU texture (re)creation', () => {
    const rhi = new NullRhiDevice();
    const scope = (rhi as any).createScope ? (rhi as any).createScope('t') : rhi;
    const tex = new GpuTextures(rhi as any, scope as any);
    let releases = 0;
    tex.onRelease = () => { releases++; };
    const src = new TextureSource({ width: 8, height: 8 });
    const counts: string[] = [];
    tex.get(src, true);
    counts.push(`${src.listenerCount('unload')}/${src.listenerCount('destroy')}`);
    for (let i = 1; i <= 5; i++) {
      src.resize(8 + i, 8 + i); // new _resourceId
      tex.get(src, true);
      counts.push(`${src.listenerCount('unload')}/${src.listenerCount('destroy')}`);
    }
    for (let i = 0; i < 3; i++) {
      src.unload();
      tex.get(src, true);
      counts.push(`${src.listenerCount('unload')}/${src.listenerCount('destroy')}`);
    }
    // repeated get without change: no growth
    tex.get(src, true); tex.get(src, true);
    counts.push(`${src.listenerCount('unload')}/${src.listenerCount('destroy')}`);
    console.log('unload/destroy listener counts:', counts.join(' '));
    releases = 0;
    src.unload();
    console.log('release callbacks invoked by one unload:', releases, 'unload listeners:', src.listenerCount('unload'));
    src.destroy();
    console.log('after destroy listeners:', src.listenerCount('unload'), src.listenerCount('destroy'));
    expect(src.listenerCount('unload')).toBe(0);
  });
});
