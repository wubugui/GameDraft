import { Texture } from 'pixi.js';

/**
 * 鸟群 / 虫群的贴图：**运行时用 Canvas 2D 现画**，不依赖任何素材文件。
 *
 * 为什么不用图集：这套东西是氛围层的剪影（墨色小鸟、黑点小虫），画法几行就够，
 * 现画既省一套素材流水线，又能按扑翼相位出任意多帧。产物是普通 `Texture`，
 * 由 {@link SwarmTextureSet.destroy} 统一释放（资源有主）。
 *
 * 所有尺寸以"贴图像素"计，显示尺寸由调用方按世界单位缩放。
 */

export interface SwarmTextureSet {
  /** 扑翼帧：sin 波形一整周，0=展平 */
  birdFrames: Texture[];
  /** 鸟贴图的像素尺寸（用于换算世界缩放） */
  birdFrameWidth: number;
  birdFrameHeight: number;
  /** 虫：两帧（合翅 / 张翅）交替出"嗡嗡"感 */
  bugFrames: Texture[];
  bugFrameSize: number;
  /** 影子：径向渐变的软圆（挤成椭圆用） */
  shadow: Texture;
  shadowSize: number;
  destroy(): void;
}

export const BIRD_FLAP_FRAMES = 10;

/** 鸟的墨色（与气泡皮肤同一族的墨底，systems 层不 import UITheme） */
const INK = '#17130f';

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * 画一帧鸟：侧俯视的剪影——短身、两片弯翅。翅膀由 `lift`∈[-1,1] 决定：
 * +1 翅尖上扬到最高，−1 下压到最低，0 展平。身体一律朝右，镜像交给 sprite.scale.x。
 */
function drawBird(ctx: CanvasRenderingContext2D, w: number, h: number, lift: number): void {
  ctx.clearRect(0, 0, w, h);
  const cx = w * 0.5;
  const cy = h * 0.55;
  const span = w * 0.46;
  ctx.fillStyle = INK;
  ctx.strokeStyle = INK;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 身体：略向前倾的小梭形 + 头
  ctx.beginPath();
  ctx.ellipse(cx + w * 0.02, cy, w * 0.11, h * 0.12, -0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + w * 0.13, cy - h * 0.06, h * 0.075, 0, Math.PI * 2);
  ctx.fill();
  // 尾羽
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.08, cy - h * 0.02);
  ctx.lineTo(cx - w * 0.2, cy + h * 0.08);
  ctx.lineTo(cx - w * 0.18, cy - h * 0.05);
  ctx.closePath();
  ctx.fill();

  // 翅膀：从肩起一条弯曲的宽笔触到翅尖；上扬时翅尖抬高并向内收，下压时翅尖下沉外展
  const tipDy = -lift * h * 0.36;
  const tipDx = span * (1 - Math.abs(lift) * 0.18);
  const midDy = -lift * h * 0.1;
  ctx.lineWidth = Math.max(1.5, h * 0.11);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + side * w * 0.04, cy - h * 0.02);
    ctx.quadraticCurveTo(
      cx + side * tipDx * 0.5,
      cy + midDy - h * 0.06,
      cx + side * tipDx,
      cy + tipDy,
    );
    ctx.stroke();
    // 翅膀内侧填一块薄面，避免只剩一根线
    ctx.beginPath();
    ctx.moveTo(cx + side * w * 0.03, cy - h * 0.04);
    ctx.quadraticCurveTo(cx + side * tipDx * 0.5, cy + midDy - h * 0.06, cx + side * tipDx, cy + tipDy);
    ctx.quadraticCurveTo(cx + side * tipDx * 0.55, cy + midDy + h * 0.06, cx + side * w * 0.05, cy + h * 0.06);
    ctx.closePath();
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function drawBug(ctx: CanvasRenderingContext2D, s: number, wingsOpen: boolean): void {
  ctx.clearRect(0, 0, s, s);
  const c = s * 0.5;
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.ellipse(c, c, s * 0.2, s * 0.13, 0, 0, Math.PI * 2);
  ctx.fill();
  if (wingsOpen) {
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.ellipse(c - s * 0.13, c - s * 0.1, s * 0.16, s * 0.07, -0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(c + s * 0.13, c - s * 0.1, s * 0.16, s * 0.07, 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function drawShadow(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.clearRect(0, 0, s, s);
  const c = s * 0.5;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.28)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
}

/** 现画一整套贴图。需要 DOM（canvas）；无 DOM 环境（单测）不要调。 */
export function createSwarmTextures(): SwarmTextureSet {
  const bw = 96;
  const bh = 48;
  const birdFrames: Texture[] = [];
  for (let i = 0; i < BIRD_FLAP_FRAMES; i++) {
    const canvas = makeCanvas(bw, bh);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('swarmTextures: canvas 2d 不可用');
    const lift = Math.sin((i / BIRD_FLAP_FRAMES) * Math.PI * 2);
    drawBird(ctx, bw, bh, lift);
    birdFrames.push(Texture.from(canvas));
  }
  const bs = 16;
  const bugFrames: Texture[] = [];
  for (const open of [false, true]) {
    const canvas = makeCanvas(bs, bs);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('swarmTextures: canvas 2d 不可用');
    drawBug(ctx, bs, open);
    bugFrames.push(Texture.from(canvas));
  }
  const ss = 64;
  const sc = makeCanvas(ss, ss);
  const sctx = sc.getContext('2d');
  if (!sctx) throw new Error('swarmTextures: canvas 2d 不可用');
  drawShadow(sctx, ss);
  const shadow = Texture.from(sc);

  return {
    birdFrames,
    birdFrameWidth: bw,
    birdFrameHeight: bh,
    bugFrames,
    bugFrameSize: bs,
    shadow,
    shadowSize: ss,
    destroy() {
      for (const t of birdFrames) t.destroy(true);
      for (const t of bugFrames) t.destroy(true);
      shadow.destroy(true);
      birdFrames.length = 0;
      bugFrames.length = 0;
    },
  };
}
