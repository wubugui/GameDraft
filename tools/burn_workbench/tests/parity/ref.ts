/** Independent old-tool GPU oracle: frozen master BurnGL + GLSL (legacy-source.json).
 * Full old-tool/new-tool A/B remains a separate gate. No production module imports these fixtures.
 */
// @ts-expect-error frozen plain JS oracle has no declaration file
import { BurnGL } from './legacyBurnGL.js';
import shadeSource from './legacyBurnShade.glsl?raw';
import { burnEntityPlacement, burnPlacementFrame, burnUvToScene } from '@src/systems/burn/burnGeometry';
import { createPerspectiveScaleResolver } from '@src/utils/perspectiveScale';
import type { BurnShadeParams } from '@src/rendering/burn/burnShadeParams';
import type { BurnHotspotInput } from '../../gpu/burnView';

interface RefInput {
  css: [number, number]; dpr: number;
  cam: { k: number; ox: number; oy: number };
  bg: { url: string; w: number; h: number } | null;
  perspective: Record<string, unknown> | null;
  items: Array<{ kind: 'hotspot' | 'frame'; url: string; def: BurnHotspotInput['def']; screen: number[][] | null;
    burn: null | { gridW: number; gridH: number; field: string; params: BurnShadeParams } }>;
}
function bytes(s: string): Uint8Array { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
function base64(data: Uint8Array): string {
  let s = '';
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}
async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image(); image.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = reject; image.src = url; });
  return image;
}

async function renderRef(input: RefInput) {
  const canvas = document.createElement('canvas'); document.body.appendChild(canvas);
  const legacy = new BurnGL(canvas);
  if (!legacy.ok || !legacy.compile(shadeSource.split('//__BURN_SHADE_BEGIN__')[1].split('//__BURN_SHADE_END__')[0])) {
    canvas.remove(); throw new Error(`Legacy tool oracle failed: ${legacy.err}`);
  }
  const gl: WebGL2RenderingContext = legacy.gl;
  try {
    legacy.resize(...input.css, input.dpr);
    const textures = await Promise.all(input.items.map((it) => loadImage(it.url)));
    const bg = input.bg ? await loadImage(input.bg.url) : null;
    legacy.begin();
    const screen = (p: { x: number; y: number }) => [p.x * input.cam.k + input.cam.ox, p.y * input.cam.k + input.cam.oy];
    if (bg && input.bg) legacy.quad([
      screen({ x: 0, y: 0 }), screen({ x: input.bg.w, y: 0 }),
      screen({ x: input.bg.w, y: input.bg.h }), screen({ x: 0, y: input.bg.h }),
    ], bg, null, 1);
    const perspective = input.perspective ? createPerspectiveScaleResolver(input.perspective as never) : null;
    input.items.forEach((it, i) => {
      let corners = it.screen;
      if (it.kind === 'hotspot') {
        const d = it.def;
        const frame = burnPlacementFrame(burnEntityPlacement(d,
          { width: d.displayImage.worldWidth, height: d.displayImage.worldHeight }, {
            depthScale: d.perspectiveScaleEnabled ? perspective?.scaleAt(d.x, d.y) ?? 1 : 1,
            flipX: d.displayImage.facing === 'left',
          }));
        corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => screen(burnUvToScene(frame, u, v)));
      }
      if (!corners) throw new Error('Missing frame corners');
      const b = it.burn;
      const burn = b ? { field: legacy.fieldOf(String(i), { encodeTexture: (_key: string, dst: Uint8Array) => dst.set(bytes(b.field)) },
        String(i), b.gridW, b.gridH), params: b.params } : null;
      legacy.quad(corners, textures[i], burn, 1);
    });
    const w = canvas.width, h = canvas.height;
    const bottomUp = new Uint8Array(w * h * 4), data = new Uint8Array(bottomUp.length);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp);
    for (let y = 0; y < h; y++) data.set(bottomUp.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4);
    return { w, h, pixels: base64(data), context: gl.getContextAttributes(), renderer: gl.getParameter(gl.RENDERER) };
  } finally {
    legacy.dropFields(new Set()); legacy.dropImages(new Set());
    gl.deleteBuffer(legacy.buf); gl.deleteVertexArray(legacy.vao); gl.deleteProgram(legacy.prog);
    gl.getExtension('WEBGL_lose_context')?.loseContext(); canvas.remove();
  }
}
(window as unknown as { __renderRef: typeof renderRef; __refReady: boolean }).__renderRef = renderRef;
(window as unknown as { __refReady: boolean }).__refReady = true;
