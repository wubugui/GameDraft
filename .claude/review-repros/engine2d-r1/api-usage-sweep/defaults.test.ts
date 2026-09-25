import { describe, it } from 'vitest';
import * as P from 'pixi.js';
import * as E from '../../../../src/engine2d';

const containerProps = ['alpha','visible','renderable','eventMode','cursor','hitArea','interactiveChildren','cullable','cullableChildren','cullArea','sortableChildren','sortDirty','zIndex','x','y','rotation','angle','label','tint','blendMode','mask','filters','boundsArea','isRenderGroup','culled','interactive','measurable','includeInBuild','width','height'];
function val(o: any, k: string) {
  try { const v = o[k]; if (v && typeof v === 'object') { if ('x' in v && 'y' in v && Object.keys(v).length < 10) return `{${v.x},${v.y}}`; if (Array.isArray(v)) return `[${v.length}]`; return v.constructor?.name ?? 'obj'; } return v; } catch (e) { return 'THROW:' + (e as Error).message; }
}
function cmp(name: string, p: any, e: any, props: string[]) {
  const diffs: string[] = [];
  for (const k of props) {
    const a = val(p, k), b = val(e, k);
    if (String(a) !== String(b)) diffs.push(`${k}: pixi=${String(a)} e2d=${String(b)}`);
  }
  console.log(`== ${name}: ${diffs.length ? '\n  ' + diffs.join('\n  ') : 'same'}`);
}
P.DOMAdapter.set({ ...P.BrowserAdapter, createCanvas: () => ({ width: 1, height: 1, getContext: () => null, style: {} }) as any } as any);
import '../../../../node_modules/pixi.js/lib/events/init.mjs';
describe('defaults', () => {
  it('compare', () => {
    cmp('Container', new P.Container(), new E.Container(), [...containerProps, 'scale','pivot','skew','position','origin']);
    cmp('Sprite', new P.Sprite(), new E.Sprite(), [...containerProps, 'anchor','roundPixels','texture']);
    cmp('Graphics', new P.Graphics(), new E.Graphics(), [...containerProps, 'roundPixels']);
    cmp('TextureStyle', new P.TextureStyle(), new E.TextureStyle(), ['addressModeU','addressModeV','addressModeW','magFilter','minFilter','mipmapFilter','lodMinClamp','lodMaxClamp','compare','maxAnisotropy','scaleMode','addressMode']);
    cmp('TextureSource', new P.TextureSource(), new E.TextureSource(), ['width','height','pixelWidth','pixelHeight','resolution','format','alphaMode','mipLevelCount','autoGenerateMipmaps','antialias','autoGarbageCollect','isPowerOfTwo','scaleMode','addressMode','label','uploadMethodId']);
    const pbuf = new P.BufferImageSource({ resource: new Uint8Array(4), width: 1, height: 1 });
    const ebuf = new E.BufferImageSource({ resource: new Uint8Array(4), width: 1, height: 1 });
    cmp('BufferImageSource u8', pbuf, ebuf, ['format','alphaMode','uploadMethodId','autoGarbageCollect','scaleMode']);
    const pbf = new P.BufferImageSource({ resource: new Float32Array(4), width: 1, height: 1 });
    const ebf = new E.BufferImageSource({ resource: new Float32Array(4), width: 1, height: 1 });
    cmp('BufferImageSource f32', pbf, ebf, ['format','alphaMode']);
    const prt = P.RenderTexture.create({ width: 10, height: 10 });
    const ert = E.RenderTexture.create({ width: 10, height: 10 });
    cmp('RenderTexture.source', prt.source, ert.source, ['width','height','pixelWidth','pixelHeight','resolution','format','alphaMode','antialias','autoGarbageCollect','scaleMode','addressMode','uploadMethodId']);
    cmp('Texture.WHITE.source', P.Texture.WHITE.source, E.Texture.WHITE.source, ['width','height','format','alphaMode','scaleMode','addressMode','uploadMethodId']);
    cmp('Texture.EMPTY', P.Texture.EMPTY, E.Texture.EMPTY, ['width','height']);
    cmp('Texture.EMPTY.source', P.Texture.EMPTY.source, E.Texture.EMPTY.source, ['width','height','format','alphaMode','uploadMethodId','resource']);
    cmp('Ticker', new P.Ticker(), new E.Ticker(), ['autoStart','deltaTime','deltaMS','elapsedMS','lastTime','speed','started','minFPS','maxFPS','count']);
    cmp('BlurFilter', new P.BlurFilter(), new E.BlurFilter(), ['strength','quality','padding','resolution','antialias','blendMode','enabled','clipToViewport','repeatEdgePixels']);
    cmp('BlurFilter opts', new P.BlurFilter({strength:1,quality:2,kernelSize:9,legacy:true,resolution:'inherit'} as any), new E.BlurFilter({strength:1,quality:2,kernelSize:9,legacy:true,resolution:'inherit'}), ['strength','quality','padding','resolution','antialias']);
    cmp('ColorMatrixFilter', new P.ColorMatrixFilter(), new E.ColorMatrixFilter(), ['alpha','padding','resolution','antialias','blendMode','enabled','clipToViewport','matrix']);
    cmp('TextStyle', new P.TextStyle(), new E.TextStyle(), ['align','breakWords','dropShadow','fill','fontFamily','fontSize','fontStyle','fontVariant','fontWeight','leading','letterSpacing','lineHeight','padding','stroke','textBaseline','trim','whiteSpace','wordWrap','wordWrapWidth']);
    const pt = new P.Text({ text: 'hi' }); const et = new E.Text({ text: 'hi' });
    cmp('Text', pt, et, [...containerProps.filter(k=>k!=='width'&&k!=='height'), 'anchor','resolution','roundPixels','text']);
    cmp('Rectangle', new P.Rectangle(), new E.Rectangle(), ['x','y','width','height','type','left','right']);
    cmp('Circle', new P.Circle(), new E.Circle(), ['x','y','radius','type']);
    cmp('Matrix', new P.Matrix(), new E.Matrix(), ['a','b','c','d','tx','ty']);
    const pns = new P.NineSliceSprite({ texture: P.Texture.WHITE, leftWidth: 1, topHeight: 1 } as any);
    const ens = new E.NineSliceSprite({ texture: E.Texture.WHITE, leftWidth: 1, topHeight: 1 } as any);
    cmp('NineSliceSprite', pns, ens, [...containerProps, 'leftWidth','rightWidth','topHeight','bottomHeight','anchor','roundPixels','originalWidth','originalHeight']);
    const pg = new P.MeshGeometry({ positions: new Float32Array([0,0,1,0,1,1]), uvs: new Float32Array([0,0,1,0,1,1]), indices: new Uint32Array([0,1,2]) });
    const eg = new E.MeshGeometry({ positions: new Float32Array([0,0,1,0,1,1]), uvs: new Float32Array([0,0,1,0,1,1]), indices: new Uint32Array([0,1,2]) });
    cmp('MeshGeometry', pg, eg, ['topology','batchMode','instanceCount']);
    const pm = new P.Mesh({ geometry: pg }); const em = new E.Mesh({ geometry: eg });
    cmp('Mesh', pm, em, [...containerProps, 'roundPixels','texture','batched','shader','state']);
    const pmp = new P.MeshPlane({ texture: P.Texture.WHITE, verticesX: 3, verticesY: 3 }); const emp = new E.MeshPlane({ texture: E.Texture.WHITE, verticesX: 3, verticesY: 3 });
    cmp('MeshPlane', pmp, emp, [...containerProps, 'autoResize','roundPixels']);
    cmp('MeshPlane.geometry', pmp.geometry, emp.geometry, ['verticesX','verticesY','width','height','topology']);
    const pb = new P.Buffer({ data: new Float32Array(4), usage: P.BufferUsage.VERTEX }); const eb = new E.Buffer({ data: new Float32Array(4), usage: E.BufferUsage.VERTEX });
    cmp('Buffer', pb, eb, ['usage','shrinkToFit','label','static']);
    cmp('BufferUsage', P.BufferUsage, E.BufferUsage, ['VERTEX','INDEX','UNIFORM','STORAGE','COPY_DST','COPY_SRC','MAP_READ']);
    cmp('UPDATE_PRIORITY', P.UPDATE_PRIORITY, E.UPDATE_PRIORITY, ['INTERACTION','HIGH','NORMAL','LOW','UTILITY']);
    const pu = new P.UniformGroup({ a: { value: 1, type: 'f32' } }); const eu = new E.UniformGroup({ a: { value: 1, type: 'f32' } });
    cmp('UniformGroup', pu, eu, ['isStatic','ubo','isUniformGroup']);
  });
});
