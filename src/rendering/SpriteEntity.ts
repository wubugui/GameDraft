import { BlurFilter, Container, Sprite, Texture, Rectangle, type Shader, type TextureSource } from 'pixi.js';
import type {
  AnimationPlaybackParams,
  AnimationSetDef,
  AnimationStateDef,
  SocketAtlasFingerprint,
  SocketFramePose,
  SocketSetDef,
} from '../data/types';
import {
  fingerprintOfAnim,
  socketPoseToLocal,
  type ResolvedSockets,
  type SocketLocalPose,
} from '../data/animationSockets';

/**
 * 挂在某个挂点上的东西。**资源加载与销毁归调用方**，SpriteEntity 只负责逐帧摆位。
 *
 * 两档用法（与 2026-08-03 拍板一致）：
 * - **静态图**：`view` 是一张 Sprite，位置/角度/前后全由挂点标注驱动——刀随手挥、
 *   灯笼随身晃，这一档不需要任何额外时钟。
 * - **挂点驱动帧号**：再给 `frameTextures`，挂点标注里的 `frame` 选第几张。
 *   火苗能烧，但**不引入第二个时钟**，因此没有与角色动画锁相的问题。
 */
export interface SocketAttachment {
  /** 显示对象；带 frameTextures 时必须是 Sprite */
  view: Container;
  /** 挂点驱动帧号用的纹理表；不给就是纯静态图 */
  frameTextures?: Texture[];
  /** 是否随角色镜像左右翻（缺省 true）。带文字的挂件应显式给 false */
  mirrorWithHost?: boolean;
  /** 挂件自身基础缩放，乘在透视系数上；缺省 1 */
  scale?: number;
  /**
   * 挂件贴图上的**支点**（0..1，图片左上为原点），挂点对准的就是这一点。
   * 缺省 0.5/0.5＝图心。刀剑要给刀柄（如 0.5/0.92），否则会绕图心转、看着像在半空打旋。
   * 镜像时支点跟着一起翻（scale.x 取负），所以刀柄还是刀柄。
   */
  anchorX?: number;
  anchorY?: number;
  /**
   * 挂件自身的旋转偏置（度），加在挂点标注的角度之上。
   * 用来补图片本身的朝向——比如剑在 PNG 里是竖着画的，挂到横握的手上就得偏 -90。
   * 与挂点角度同样在镜像时取反。
   */
  rotationOffsetDeg?: number;
  /**
   * 是否吃角色同一套逐像素光照（缺省 true）。
   * 挂件没有法线图集，走 `nrm=null` 的平面法线兜底——光色/光向/环境照常吃，只是没有形体明暗。
   * 自发光的东西（灯笼火苗、符纸微光）应显式给 false，否则会被环境压暗。
   */
  lit?: boolean;
  /** 内部：上一帧的前后档，仅在翻转时才重排子节点 */
  lastFront?: boolean;
  /** 内部：挂件的光照 mesh（与 view 同变换的兄弟节点；view 此时只当变换载体） */
  litQuad?: LitSpriteQuad | null;
  litShader?: Shader | null;
  litSrc?: TextureSource | null;
}
import { LitSpriteQuad } from './CharacterLitSprite';

/**
 * 烘焙照明的 shader 供给方(CharacterLightingSystem 经 Game 注入):
 * SpriteEntity 只管几何同步,shader 的建/换图集/回收都归照明系统。
 */
export interface LitShaderProvider {
  create(colorTex: TextureSource, sheetUrl: string | null): Shader | null;
  swapTextures(shader: Shader, colorTex: TextureSource, sheetUrl: string | null): void;
  release(shader: Shader): void;
}

/** 归一化夹取（挂件支点等 0..1 参数） */
function clamp01(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** 步速匹配倍率夹取范围：帧动画循环被拉出此区间会明显难看（步频与素材脱节） */
export const LOCOMOTION_RATE_MIN = 0.5;
export const LOCOMOTION_RATE_MAX = 2;

/** 显式播放倍率的合法区间（防 0/负数/极端值把 update 帧步进循环拖垮）。
 *  导出给需要**反算实际播放时长**的调用方（PlayerActionSystem 的变速姿态片段）——
 *  手抄一份会在这两个数改动时静默算错时长。 */
export const PLAYBACK_SPEED_MIN = 0.1;
export const PLAYBACK_SPEED_MAX = 10;

function normalizePlaybackSpeed(raw: unknown): number {
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.min(PLAYBACK_SPEED_MAX, Math.max(PLAYBACK_SPEED_MIN, v));
}

/**
 * 反推图集格内**内容底部留白**（格像素）：打包器给每格上下各留同样的 pad，
 * 故 `pad = (格高 - 全图集最高帧内容高) / 2`。缺 `atlasFrames`/数据非法时返回 null。
 */
function computeContentBottomPadPx(animDef: AnimationSetDef, cellH: number): number | null {
  const boxes = animDef.atlasFrames;
  if (!Array.isArray(boxes) || boxes.length === 0) return null;
  if (!Number.isFinite(cellH) || cellH <= 0) return null;
  let maxContentH = 0;
  for (const box of boxes) {
    const h = box?.contentHeight;
    if (typeof h === 'number' && Number.isFinite(h) && h > maxContentH) maxContentH = h;
  }
  if (maxContentH <= 0) return null;
  return Math.max(0, (cellH - maxContentH) / 2);
}
import {
  blurStrengthFromPixelDensityK,
  computePixelDensityK,
  createPixelDensityBlurFilter,
  type TexelsPerWorld,
} from './EntityPixelDensityMatch';

/**
 * 精灵实体
 *
 * 坐标系统（与 Camera View-Projection 管线一致）：
 * - container.x/y = worldX/Y（纯世界坐标）
 * - sprite.scale = worldSize / framePixelSize（图集帧 → 世界尺寸映射）
 * - worldContainer 的 scale 统一处理 Projection 缩放
 */
export class SpriteEntity {
  public container: Container;
  public x: number = 0;
  public y: number = 0;

  private sprite: Sprite;
  private baseTexture: Texture | null = null;
  private animDef: AnimationSetDef | null = null;
  private frames: Map<string, Texture[]> = new Map();
  private facingX: 1 | -1 = 1;

  /** 当前朝向（供调试快照只读）。 */
  get facingDirection(): 'left' | 'right' {
    return this.facingX < 0 ? 'left' : 'right';
  }

  /**
   * 烘焙着色驱动:图集源 + 网格(运行时法线图集生成)+ 当前帧归一化 uv rect + 镜像。
   * 无图集(未 loadFromDef)返回 null,滤镜回退平面法线。
   */
  getShadingFrameInfo(): {
    source: TextureSource;
    /** 图集完整 URL；法线图集按 `<图集名>.normal.png` 由此寻址（离线烘焙产物） */
    sheetUrl: string | null;
    cols: number;
    rows: number;
    rect: [number, number, number, number];
    flipX: boolean;
  } | null {
    if (!this.baseTexture || !this.animDef) return null;
    const src = this.baseTexture.source;
    const w = src.width, h = src.height;
    if (!w || !h) return null;
    const fr = this.sprite.texture.frame;
    return {
      source: src,
      sheetUrl: this.animDef.resolvedSheetUrl ?? null,
      cols: this.animDef.cols,
      rows: this.animDef.rows,
      rect: [fr.x / w, fr.y / h, fr.width / w, fr.height / h],
      flipX: this.facingX < 0,
    };
  }

  private worldWidth: number = 0;
  private worldHeight: number = 0;

  /**
   * 图集格内**内容底部留白**（格像素）：打包时每帧可见内容底边对齐、格内上下各留 pad
   * （tools/video_to_atlas/atlas_core.py `pack_frames_native_equal_cells`）。pad 未入 anim.json，
   * 由 `cellH - 最高帧 contentHeight` 反推。无 `atlasFrames` 时为 null——此时内容框未知，
   * 气泡等消费方回落到格子 quad 口径。
   */
  private contentBottomPadPx: number | null = null;

  /**
   * 场景透视缩放系数（近大远小，纯派生态不入档）：由移动驱动方按脚底 y 求值写入。
   * 单点闸：乘进帧缩放与 getWorldSize，从尺寸派生的消费方（阴影/气泡/密度匹配）自动跟随。
   */
  private depthScaleFactor: number = 1;

  private currentState: string = '';
  private currentFrames: Texture[] = [];
  private currentFrameDef: AnimationStateDef | null = null;
  /** 本次播放的有效循环标志：动作层 playback.loop 覆盖优先，否则取状态定义 frameDef.loop。 */
  private effectiveLoop: boolean = false;
  private frameIndex: number = 0;
  private frameTimer: number = 0;
  private playing: boolean = false;
  private onCompleteCallback: (() => void) | null = null;
  /** 播放倍率（显式参数或步速匹配写入；playAnimation 切状态时重置为 1） */
  private playbackSpeed: number = 1;
  /** true = 反向步进（末帧→首帧） */
  private playbackReverse: boolean = false;
  /** 非循环片段完成后自动切换的状态名（按默认参数播放） */
  private pendingThenState: string | null = null;
  /** 逻辑状态名（如 idle）-> anim.json 中的 states 键；未配置则同名 */
  private logicalToClip: Map<string, string> = new Map();

  /** 仅显示：与背景像素密度对齐的低通（内层 Sprite，不影响外层深度滤镜） */
  private pixelDensityBlur: BlurFilter | null = null;
  private pixelDensityMatchActive = false;
  /** 模糊滤镜当前是否挂在 sprite.filters 上：Pixi 8 的 filters setter 每次赋值都 slice+freeze+重建 FilterEffect，只允许在启用/禁用边界切换时增删 */
  private pixelDensityBlurMounted = false;

  /** 挂点集（stale 时置 null，等于没有挂点） */
  private socketSet: SocketSetDef | null = null;
  /** 已挂载的东西：挂点名 → 挂件；每帧按当前帧的位姿重摆 */
  private attachments: Map<string, SocketAttachment> = new Map();

  constructor() {
    this.container = new Container();
    this.sprite = new Sprite();
    this.sprite.anchor.set(0.5, 1);
    this.container.addChild(this.sprite);
  }

  /**
   * 装载动画包。`sockets` 是可选的挂点 sidecar（`resolveSockets` 的结果）——
   * 指纹对不上（stale）时按"没有挂点"处理：宁可不挂，也不照漂移的槽位号挂错位置。
   */
  loadFromDef(texture: Texture, animDef: AnimationSetDef, sockets?: ResolvedSockets | null): void {
    this.disposeFrameTextures();
    this.setSockets(sockets ?? null);
    this.baseTexture = texture;
    this.animDef = animDef;
    this.worldWidth = animDef.worldWidth;
    this.worldHeight = animDef.worldHeight;

    const cols = animDef.cols;
    const rows = animDef.rows;
    const strideW =
      typeof animDef.cellWidth === 'number' && animDef.cellWidth > 0
        ? animDef.cellWidth
        : texture.width / cols;
    const strideH =
      typeof animDef.cellHeight === 'number' && animDef.cellHeight > 0
        ? animDef.cellHeight
        : texture.height / rows;

    for (const [stateName, stateDef] of Object.entries(animDef.states)) {
      const textures: Texture[] = [];
      for (const frameIdx of stateDef.frames) {
        const col = frameIdx % cols;
        const row = Math.floor(frameIdx / cols);
        const box = animDef.atlasFrames?.[frameIdx];
        const rw = box && box.width > 0 ? box.width : strideW;
        const rh = box && box.height > 0 ? box.height : strideH;
        const rect = new Rectangle(col * strideW, row * strideH, rw, rh);
        const frameTex = new Texture({ source: texture.source, frame: rect });
        textures.push(frameTex);
      }
      this.frames.set(stateName, textures);
    }

    this.contentBottomPadPx = computeContentBottomPadPx(animDef, strideH);

    this.applySpriteScale();
    this.refreshLitQuad();   // 换图集(玩家换装/NPC 重载动画):mesh 的 color+normal 源跟随
  }

  private disposeFrameTextures(): void {
    this.contentBottomPadPx = null;
    this.sprite.texture = Texture.EMPTY;
    for (const textures of this.frames.values()) {
      for (const t of textures) {
        // 子纹理与图集共享 Assets 管理的 TextureSource，不可 destroy(true) 否则会拆掉整张贴图
        t.destroy(false);
      }
    }
    this.frames.clear();
    this.currentFrames = [];
    this.currentFrameDef = null;
    this.effectiveLoop = false;
    this.frameIndex = 0;
    this.frameTimer = 0;
    this.playing = false;
    this.onCompleteCallback = null;
    this.playbackSpeed = 1;
    this.playbackReverse = false;
    this.pendingThenState = null;
    this.currentState = '';
  }

  /** 释放帧子纹理与 Pixi 子节点（不销毁传入 loadFromDef 的图集基纹理） */
  destroy(): void {
    this.detachAllSockets();
    this.socketSet = null;
    this.disableBakedShading();
    this.clearPixelDensityBlur();
    this.disposeFrameTextures();
    this.baseTexture = null;
    this.animDef = null;
    this.logicalToClip.clear();
    this.container.destroy({ children: true });
  }

  // ------------------------------------------------- 烘焙照明:sprite 网格着色(2026-07-25)
  // 与 sprite 同 quad 的 Mesh 子节点,color 与 normal 用**顶点自带的同一套图集 UV** 采样;
  // 镜像/脚点/世界坐标全部来自几何。没有任何逐帧 CPU 驱动 —— filter 反推 UV 的事故面
  // (驱动缺席 → 全身采边缘列 → 通体单色/左右变色/闪烁)在结构上不存在。
  private litQuad: LitSpriteQuad | null = null;
  private litShader: Shader | null = null;
  private litProvider: LitShaderProvider | null = null;
  private litColorSrc: TextureSource | null = null;

  /** 开启网格着色(baked 场景;非 baked 或无图集时安静保持旧管线)。可重入:重复调用只刷新。 */
  enableBakedShading(provider: LitShaderProvider): void {
    this.litProvider = provider;
    this.refreshLitQuad();
    // 挂件跟着一起进光照管线，否则会出现"角色被照亮、手里的刀是平光"
    for (const at of this.attachments.values()) this.refreshAttachmentLit(at);
    this.syncAttachments();
  }

  /**
   * 丢掉现有 shader，向供给方重新要一次（2026-08-20，统一光影用）。
   *
   * 为什么需要：实体的 shader 是**建实体那一刻**向供给方要的。场景光影载荷晚于
   * 实体装载才就绪时（进场景的正常顺序就是如此），已经在场的角色手里握着的是
   * 旧路径的 shader —— 场景变了角色没变。这里把它们推到新路径上。
   *
   * 供给方仍然可能返回 null（新旧两条都不可用），那就安静回到无着色的旧管线。
   */
  refreshBakedShading(): void {
    if (!this.litProvider) return;
    if (this.litQuad) { this.litQuad.destroy(); this.litQuad = null; }
    if (this.litShader) this.litProvider.release(this.litShader);
    this.litShader = null;
    this.litColorSrc = null;
    this.sprite.renderable = true;
    this.refreshLitQuad();
    for (const at of this.attachments.values()) {
      this.disposeAttachmentLit(at);
      this.refreshAttachmentLit(at);
    }
    this.syncAttachments();
  }

  disableBakedShading(): void {
    for (const at of this.attachments.values()) {
      this.disposeAttachmentLit(at);
      at.view.renderable = true;
    }
    if (this.litQuad) { this.litQuad.destroy(); this.litQuad = null; }
    if (this.litShader && this.litProvider) this.litProvider.release(this.litShader);
    this.litShader = null;
    this.litColorSrc = null;
    this.litProvider = null;
    this.sprite.renderable = true;
  }

  /** 建/重建 mesh(atlas 就绪后才有意义;loadFromDef 后与 enable 时各调一次)。 */
  private refreshLitQuad(): void {
    const provider = this.litProvider;
    if (!provider || !this.baseTexture || !this.animDef) return;
    const src = this.baseTexture.source;
    if (!this.litShader) {
      const sh = provider.create(src, this.animDef.resolvedSheetUrl ?? null);
      if (!sh) return;                     // 场景无载荷:保持旧管线
      this.litShader = sh;
      this.litColorSrc = src;
      this.litQuad = new LitSpriteQuad(sh);
      // ⚠ 挂到 container 而非 sprite:Pixi v8 的 Sprite 子节点**不渲染**(实测恒红调试
      // shader 挂 sprite 下零像素、挂 Container 下立刻显示)。sprite 的变换(scale 含
      // facingX 镜像、视觉抬升 y)由 syncLitQuad 复制 —— 同步点都在换帧/换向路径上。
      this.container.addChild(this.litQuad.mesh);
      // mesh 是追加到末尾的：已挂着的 front 挂件会被它盖住，重排一次纠正回来
      this.reorderAttachments();
      this.sprite.renderable = false;      // color 由 mesh 画(同 quad 同 UV),原精灵只当变换载体
    } else if (this.litColorSrc !== src) { // 运行时换图集(背尸/道士/setEntityField)
      provider.swapTextures(this.litShader, src, this.animDef.resolvedSheetUrl ?? null);
      this.litColorSrc = src;
    }
    this.syncLitQuad();
  }

  /** 换帧几何同步:由 applySpriteScale(所有换帧/换向/抬升路径的必经点)调用。 */
  private syncLitQuad(): void {
    if (!this.litQuad) return;
    const { frameW, frameH } = this.getCurrentFramePixelSize();
    this.litQuad.sync(this.sprite.texture, frameW, frameH, this.sprite.anchor.x, this.sprite.anchor.y);
    // mesh 与 sprite 是兄弟节点(见 refreshLitQuad 注释),变换逐项复制:
    // scale 带 facingX 符号(镜像 → 行列式变负 → 着色器翻 n.x),y 带视觉抬升。
    const m = this.litQuad.mesh;
    m.position.set(this.sprite.x, this.sprite.y);
    m.scale.set(this.sprite.scale.x, this.sprite.scale.y);
    this.syncLitQuadWorld();
  }

  /**
   * 喂 lit mesh 的 local→sceneWorld 仿射(世界坐标唯一真相源,滤镜/镜头免疫)。
   * container.x/y 就是场景世界坐标(本类契约),container.scale 参与(诊断的 quad 放大)。
   * 换帧(syncLitQuad)与走动(syncPosition)都要调——走动只动 container.x/y。
   */
  // ---- 外层实体容器(Npc.container)的场景世界仿射 ----
  // 本类的老契约是「container.x/y 就是场景世界坐标」:Player 成立;**Npc 不成立**——
  // Npc 把 sprite.container 挂在自己 container 下(local 恒 0,0),场景世界在外层。
  // 2026-09-01 实测:漏了这层,全部 NPC 的 lit quad 都拿 (0,0) 当世界坐标去采 probe,
  // E 采到场景左上角外 → 素色浮在画面上(赌坊门卫黑影);静态 NPC 永不换帧,连暴露的机会都没有。
  private litParentX = 0; private litParentY = 0;
  private litParentSX = 1; private litParentSY = 1; private litParentRot = 0;

  /** 外层容器(实体级)世界仿射。Npc 在位置/缩放/旋转任一变化处推;Player 不用(恒等)。 */
  setLitParentTransform(x: number, y: number, sx: number, sy: number, rot: number): void {
    this.litParentX = x; this.litParentY = y;
    this.litParentSX = sx; this.litParentSY = sy; this.litParentRot = rot;
    this.syncLitQuadWorld();
  }

  private syncLitQuadWorld(): void {
    if (!this.litQuad) return;
    // 组合外层与本容器:平移过外层线性部。rot 传外层旋转(对角缩放与 R 在 rot=0 时
    // 对易,实体旋转是罕见装饰字段,lit 采样取近似可接受;镜像符号经 det 正确传导)。
    const pr = this.litParentRot;
    const cos = Math.cos(pr), sin = Math.sin(pr);
    const cx = this.litParentX + this.litParentSX * (cos * this.container.x - sin * this.container.y);
    const cy = this.litParentY + this.litParentSY * (sin * this.container.x + cos * this.container.y);
    this.litQuad.setWorldTransform(
      cx, cy,
      this.litParentSX * this.container.scale.x, this.litParentSY * this.container.scale.y,
      this.sprite.x, this.sprite.y,
      this.sprite.scale.x, this.sprite.scale.y, pr);
  }

  /**
   * 配置逻辑状态到图集 states 键的映射（玩家化身等）。未出现在 map 中的逻辑名仍按原名解析。
   */
  setLogicalStateMap(map: Record<string, string> | undefined): void {
    this.logicalToClip.clear();
    if (!map) return;
    for (const [logical, clip] of Object.entries(map)) {
      if (logical && clip) this.logicalToClip.set(logical, clip);
    }
  }

  private resolveClip(stateName: string): string {
    return this.logicalToClip.get(stateName) ?? stateName;
  }

  /** 当前片段按有效帧率播完一遍的时长（秒）；无片段或帧率非法时回落 0。 */
  getCurrentClipDurationSec(): number {
    const n = this.currentFrames.length;
    if (n <= 0 || !this.currentFrameDef) return 0;
    const fpsRaw = Number(this.currentFrameDef.frameRate);
    const fps = Number.isFinite(fpsRaw) && fpsRaw > 0 ? fpsRaw : 8;
    const speed = this.playbackSpeed > 0 ? this.playbackSpeed : 1;
    return n / (fps * speed);
  }

  /**
   * 该逻辑状态名当前能否播出实际片段（经 stateMap 解析后在图集里存在且有帧）。
   * 玩家身体动词据此判定「本装扮下这个动词可不可用」——解析不到 = 该动词禁用。
   */
  hasLogicalState(stateName: string): boolean {
    const name = stateName.trim();
    if (!name) return false;
    const clip = this.resolveClip(name);
    if (!this.animDef?.states?.[clip]) return false;
    const frames = this.frames.get(clip);
    return !!frames && frames.length > 0;
  }

  /**
   * 播放状态。`playback` 缺省时与旧签名行为完全一致（同状态播放中重入为幂等 no-op——
   * Player.update 每帧调用依赖此路径）；显式携带 `playback` 时总是按新参数重启片段，
   * 语义可预期（内容侧动作是一次性触发，不走每帧路径）。
   */
  playAnimation(stateName: string, onComplete?: () => void, playback?: AnimationPlaybackParams): void {
    const clip = this.resolveClip(stateName);
    if (!playback && this.currentState === clip && this.playing) return;

    const frameDef = this.animDef?.states[clip];
    const textures = this.frames.get(clip);
    if (!frameDef || !textures || textures.length === 0) return;

    this.currentState = clip;
    this.currentFrames = textures;
    this.currentFrameDef = frameDef;
    // 有效循环标志：动作层 playback.loop（显式 true/false）覆盖状态定义，缺省沿用 frameDef.loop
    this.effectiveLoop = playback?.loop ?? frameDef.loop;
    this.frameTimer = 0;
    this.onCompleteCallback = onComplete ?? null;
    this.playbackSpeed = playback?.speed !== undefined ? normalizePlaybackSpeed(playback.speed) : 1;
    this.playbackReverse = playback?.reverse === true;
    const thenState = playback?.thenState?.trim();
    this.pendingThenState = thenState || null;

    const hold = playback?.holdFrame;
    const start = playback?.startFrame;
    if (typeof hold === 'number' && Number.isFinite(hold)) {
      const n = textures.length;
      this.frameIndex = ((Math.trunc(hold) % n) + n) % n;
      this.playing = false;
      this.pendingThenState = null;
    } else if (typeof start === 'number' && Number.isFinite(start)) {
      // 起播帧（去同步错相）：正/反向都从此帧开始步进
      const n = textures.length;
      this.frameIndex = ((Math.trunc(start) % n) + n) % n;
      this.playing = true;
    } else {
      this.frameIndex = this.playbackReverse ? textures.length - 1 : 0;
      this.playing = true;
    }
    this.sprite.texture = textures[this.frameIndex];
    // 帧框尺寸可能逐帧不同（atlasFrames），起播/定格帧非 0 时须立刻按所示帧重算缩放
    this.applySpriteScale();
  }

  setDirection(dx: number, _dy: number): void {
    if (dx > 0) this.facingX = 1;
    else if (dx < 0) this.facingX = -1;
    this.applySpriteScale();
  }

  update(dt: number): void {
    if (!this.playing || !this.currentFrameDef || this.currentFrames.length <= 1) {
      this.syncPosition();
      return;
    }

    this.frameTimer += dt;
    const fpsRaw = Number(this.currentFrameDef.frameRate);
    const fps = Number.isFinite(fpsRaw) && fpsRaw > 0 ? fpsRaw : 8;
    const frameDuration = 1 / (fps * this.playbackSpeed);

    while (this.frameTimer >= frameDuration) {
      this.frameTimer -= frameDuration;
      this.frameIndex += this.playbackReverse ? -1 : 1;

      if (this.frameIndex < 0 || this.frameIndex >= this.currentFrames.length) {
        if (this.effectiveLoop) {
          this.frameIndex = this.playbackReverse ? this.currentFrames.length - 1 : 0;
        } else {
          this.frameIndex = this.playbackReverse ? 0 : this.currentFrames.length - 1;
          this.playing = false;
          this.onCompleteCallback?.();
          const next = this.pendingThenState;
          this.pendingThenState = null;
          if (next) this.playAnimation(next);
          break;
        }
      }
    }

    this.sprite.texture = this.currentFrames[this.frameIndex];
    this.applySpriteScale();
    this.syncPosition();
  }

  private syncPosition(): void {
    this.container.x = this.x;
    this.container.y = this.y;
    this.syncLitQuadWorld();
  }

  getCurrentState(): string {
    return this.currentState;
  }

  /** 当前状态可播放帧数（供预览工具做时间轴/逐帧）。 */
  getFrameCount(): number {
    return this.currentFrames.length;
  }

  /** 当前显示的帧下标（0 基，指向当前状态的 frames 序列）。 */
  getFrameIndex(): number {
    return this.frameIndex;
  }

  /** 跨运行壳视觉门禁：只读导出当前动画游标与帧裁切，不参与游戏逻辑。 */
  getDebugVisualState(): Record<string, unknown> {
    const frame = this.sprite.texture?.frame;
    return {
      state: this.currentState,
      frameIndex: this.frameIndex,
      frameTimer: this.frameTimer,
      playing: this.playing,
      /** 跳跃弧线视觉抬升（内层 sprite.y，负=离地上升，0=着地）——仅调试只读，供无头验证断言弧线。 */
      visualLiftY: this.sprite.y,
      facing: this.facingDirection,
      worldWidth: this.worldWidth,
      worldHeight: this.worldHeight,
      depthScaleFactor: this.depthScaleFactor,
      frame: frame ? { x: frame.x, y: frame.y, width: frame.width, height: frame.height } : null,
      pixelDensityMatchActive: this.pixelDensityMatchActive,
    };
  }

  /**
   * 步速匹配：当前状态声明了 referenceSpeed 时，按实际移动速度缩放播放倍率（夹取
   * LOCOMOTION_RATE_MIN..MAX 防丑）；未声明或速度非法时回到 1 倍速。移动驱动方每帧调用，
   * 只改倍率不重启片段。
   */
  applyLocomotionSpeed(worldSpeed: number): void {
    const ref = Number(this.currentFrameDef?.referenceSpeed);
    if (!Number.isFinite(ref) || ref <= 0 || !Number.isFinite(worldSpeed) || worldSpeed <= 0) {
      this.playbackSpeed = 1;
      return;
    }
    this.playbackSpeed = Math.min(
      LOCOMOTION_RATE_MAX,
      Math.max(LOCOMOTION_RATE_MIN, worldSpeed / ref),
    );
  }

  /** 固定时钟门禁起点：保留当前动画状态/播放标志，只归零游标与余量（反向播放起点为末帧）。 */
  resetAnimationClock(): void {
    this.frameIndex = this.playbackReverse ? Math.max(0, this.currentFrames.length - 1) : 0;
    this.frameTimer = 0;
    if (this.currentFrames.length > 0) {
      this.sprite.texture = this.currentFrames[this.frameIndex];
      this.applySpriteScale();
    }
  }

  /** 直接定位到某一帧并显示（供预览工具 scrub/逐帧）；不改变 playing 标志，越界自动夹取。 */
  setFrameIndex(index: number): void {
    if (this.currentFrames.length === 0) return;
    const n = this.currentFrames.length;
    const i = ((Math.trunc(index) % n) + n) % n;
    this.frameIndex = i;
    this.frameTimer = 0;
    this.sprite.texture = this.currentFrames[i];
    this.applySpriteScale();
    this.syncPosition();
  }

  /**
   * 视觉垂直抬升（容器局部 px，负=向上）：只偏移画出来的精灵（内层 anchor=脚底），
   * **不动** container 原点(脚点)。跳跃弧线用——脚点/阴影/深度排序/透视仍锚在地面，
   * 只有画面里的角色被抬起。缺省 0，落地须显式复位 0。透视一致由调用方(实体)
   * 按各自 depthScaleFactor 预乘后传入（远处跳起视觉高度按比例收缩）。
   * applySpriteScale 只写 scale、syncPosition 只写 container.x/y，均不触 sprite.y，故此偏移不会被覆盖。
   */
  setVisualLiftY(px: number): void {
    this.sprite.y = Number.isFinite(px) ? px : 0;
    this.syncLitQuad();   // mesh 跟随视觉抬升(跳跃弧线)
    this.syncAttachments();   // 挂件同抬:跳跃时刀不能留在地面高度
  }

  /** 暂停 / 恢复帧推进（供预览工具）。恢复时若已到非循环终点帧则回到起点帧（反向播放的终点是首帧）。 */
  setPlaying(playing: boolean): void {
    if (playing && !this.playing && this.currentFrames.length > 0) {
      if (!this.effectiveLoop) {
        const atEnd = this.playbackReverse
          ? this.frameIndex <= 0
          : this.frameIndex >= this.currentFrames.length - 1;
        if (atEnd) {
          this.frameIndex = this.playbackReverse ? this.currentFrames.length - 1 : 0;
        }
      }
    }
    this.playing = playing && this.currentFrames.length > 0;
  }

  /** anim.json 中定义的全部状态名。 */
  getStateNames(): string[] {
    return this.animDef ? Object.keys(this.animDef.states) : [];
  }

  /** **有效**世界尺寸（× 透视缩放系数）；阴影/气泡/密度匹配等派生消费方经此自动跟随 */
  /**
   * 内层精灵的世界包围盒 —— 法线 local UV 换算用(见 CharacterShadingFilter 的 uSpriteRect)。
   * 实体容器里若还有名字标签等兄弟节点,容器包围盒会比精灵大,必须靠它换算。
   */
  getSpriteWorldBounds(): { x: number; y: number; width: number; height: number } | null {
    if (!this.sprite) return null;
    const b = this.sprite.getBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }

  getWorldSize(): { width: number; height: number } {
    return {
      width: this.worldWidth * this.depthScaleFactor,
      height: this.worldHeight * this.depthScaleFactor,
    };
  }

  /**
   * 当前帧**可见内容**的世界框（容器局部单位，已含透视系数与跳跃视觉抬升；不含实例 scale——
   * 那是实体层的事，与 `getWorldSize()` 同口径由调用方乘）。
   *
   * 为什么不能用 `getWorldSize()` 当头顶锚：那是**整张图集的格子**尺寸，per-atlas 恒定，
   * 覆盖的是最高帧；蹲/躺/跑这些矮帧上方全是透明留白（实测最矮帧只占格高 16%~25%），
   * 拿格子顶边挂气泡会飘出角色一大截。
   *
   * @returns `bottomGap` = 内容底边高于脚点的距离（含视觉抬升）；无 `atlasFrames` 等数据缺失时 null。
   */
  getContentBoxLocal(): { width: number; height: number; bottomGap: number } | null {
    const pad = this.contentBottomPadPx;
    if (pad === null || !this.animDef) return null;
    const box = this.currentFrameContentBoxPx();
    if (!box) return null;
    const { frameW, frameH } = this.getCurrentFramePixelSize();
    if (!(frameW > 0) || !(frameH > 0)) return null;
    // 与 applySpriteScale 同一口径（那里带 facingX 符号，这里取绝对值——尺寸无方向）
    const scaleX = (this.worldWidth * this.depthScaleFactor) / frameW;
    const scaleY = (this.worldHeight * this.depthScaleFactor) / frameH;
    return {
      width: box.w * scaleX,
      height: box.h * scaleY,
      // sprite.y 为跳跃弧线的视觉抬升（负=离地），减去它内容框才跟着精灵一起升
      bottomGap: pad * scaleY - this.sprite.y,
    };
  }

  // ———————————————————————— 挂点（sockets）————————————————————————

  /** 换包时替换挂点集；stale（图集指纹对不上）一律按"没有挂点"处理。 */
  setSockets(resolved: ResolvedSockets | null): void {
    if (resolved?.stale) {
      console.warn(
        'SpriteEntity: sockets.json 与当前图集指纹不符（重导出过？），本包挂点全部忽略——请回编辑器重标',
      );
    }
    this.socketSet = resolved && !resolved.stale ? resolved.set : null;
    // 换包后旧挂点大概率不存在了：先藏起来，下一次 syncAttachments 再决定去留
    for (const at of this.attachments.values()) at.view.visible = false;
  }

  /** 只读：本包有哪些挂点（编辑器/调试用）。 */
  listSocketNames(): string[] {
    return this.socketSet ? Object.keys(this.socketSet.sockets) : [];
  }

  /** 调试用：当前挂点集（F2 注入临时挂点时要在它之上叠加，不能整份替换）。 */
  debugSocketSet(): SocketSetDef | null {
    return this.socketSet;
  }

  /** 调试用：当前显示帧对应的图集槽位。 */
  debugCurrentAtlasSlot(): number | null {
    return this.currentAtlasSlot();
  }

  /** 调试用：本图集的槽位总数（F2 临时挂点要覆盖全部槽位）。 */
  debugAtlasSlotCount(): number {
    return this.animDef?.atlasFrames?.length ?? 0;
  }

  /** 调试用：本图集的挂点指纹（F2 注入临时挂点时用，保证 stale 判定必然通过）。 */
  debugAtlasFingerprint(): SocketAtlasFingerprint {
    return this.animDef
      ? fingerprintOfAnim(this.animDef)
      : { cols: 0, rows: 0, slotCount: 0 };
  }

  /** 当前显示帧对应的图集槽位（挂点表按槽位索引）。无状态时 null。 */
  private currentAtlasSlot(): number | null {
    const seq = this.currentFrameDef?.frames;
    if (!seq || seq.length === 0) return null;
    return seq[this.frameIndex % seq.length] ?? null;
  }

  /** 当前帧上该挂点的原始标注（格内归一化）；没标返回 null。 */
  getSocketPoseRaw(name: string): SocketFramePose | null {
    const sock = this.socketSet?.sockets[name];
    if (!sock) return null;
    const slot = this.currentAtlasSlot();
    if (slot === null) return null;
    return sock.poses[String(slot)] ?? null;
  }

  /**
   * 当前帧上该挂点的**容器局部**位姿：
   * - `x/y` 已穿过 帧格归一化 → 世界尺寸 → 透视系数 → 镜像 → 跳跃视觉抬升；
   * - `angleDeg` 朝左时取反（镜像后顺时针变逆时针）；
   * - `scale` 是透视系数（挂件应随远近一起缩）；
   * - `facing` 供挂件决定自己要不要跟着翻。
   *
   * 与 `getAuthoredBubbleAnchorLocalY` 同一套换算口径（那条是本方法的一维特例）。
   */
  getSocketPose(name: string): SocketLocalPose | null {
    const raw = this.getSocketPoseRaw(name);
    if (!raw) return null;
    // 换算走 data/animationSockets 的共用实现：编辑器画布用同一处，
    // 免得"编辑器里对齐了、游戏里差半个身位"。
    return socketPoseToLocal(raw, {
      worldWidth: this.worldWidth,
      worldHeight: this.worldHeight,
      depthScale: this.depthScaleFactor,
      facing: this.facingX,
      visualLiftY: this.sprite.y,
    });
  }

  /**
   * 往挂点上挂东西。挂件作为**容器子节点**，因此天然继承实体位置、跟角色一起被
   * 场景深度遮挡（滤镜挂在容器上）；前后由子节点顺序决定（见 reorderAttachments）。
   * 同名挂点重复挂 = 先卸旧的。挂件的资源加载与销毁归调用方，本类只管摆位。
   */
  attachToSocket(name: string, attachment: SocketAttachment): void {
    this.detachFromSocket(name);
    this.attachments.set(name, attachment);
    this.container.addChild(attachment.view);
    this.refreshAttachmentLit(attachment);
    this.syncAttachments();
  }

  /**
   * 给挂件建（或拆）它自己的光照 mesh，让它和角色吃同一套逐像素着色。
   * 不这么做的话挂件就是一张平光贴图，在压暗的场景里明显"贴上去"。
   *
   * 挂件没有法线图集 → `create(src, null)` 走 `nrm=null` 的平面法线兜底：
   * 光色/光向/环境全都照吃，只是少了形体明暗——对道具这个量级够用。
   */
  private refreshAttachmentLit(at: SocketAttachment): void {
    const wantLit = at.lit !== false && this.litProvider !== null;
    const tex = (at.view as Sprite).texture as Texture | undefined;
    if (!wantLit || !tex?.source) {
      this.disposeAttachmentLit(at);
      at.view.renderable = true;
      return;
    }
    if (at.litQuad && at.litSrc === tex.source) return;   // 同源短路
    this.disposeAttachmentLit(at);
    const sh = this.litProvider!.create(tex.source, null);
    if (!sh) { at.view.renderable = true; return; }       // 场景无载荷：保持平光
    at.litShader = sh;
    at.litSrc = tex.source;
    at.litQuad = new LitSpriteQuad(sh);
    this.container.addChild(at.litQuad.mesh);
    at.view.renderable = false;   // 与角色同构：view 只当变换载体，mesh 出图
    // addChild 是**追加到末尾**＝跳到最前。而本函数是换纹理源时才走到（多帧挂件的
    // images 来自不同 PNG），那条路上 front 没变、syncAttachments 不会置 needSort，
    // 于是身后的挂件会就此永久卡在身前。宿主自己的 refreshLitQuad 早有这道纠正，
    // 挂件这条当初漏了。
    this.reorderAttachments();
  }

  private disposeAttachmentLit(at: SocketAttachment): void {
    if (at.litQuad) { at.litQuad.destroy(); at.litQuad = null; }
    if (at.litShader && this.litProvider) this.litProvider.release(at.litShader);
    at.litShader = null;
    at.litSrc = null;
  }

  /** 卸下挂件并从容器摘除（**不** destroy——挂件的生命周期归调用方）。 */
  detachFromSocket(name: string): void {
    const at = this.attachments.get(name);
    if (!at) return;
    this.attachments.delete(name);
    this.disposeAttachmentLit(at);
    at.view.renderable = true;
    if (at.view.parent === this.container) this.container.removeChild(at.view);
  }

  /** 卸下全部挂件（换场景/销毁前）。 */
  detachAllSockets(): void {
    for (const name of [...this.attachments.keys()]) this.detachFromSocket(name);
  }

  /** 只读：当前挂了哪些挂点（调试快照用）。 */
  listAttachedSockets(): string[] {
    return [...this.attachments.keys()];
  }

  /**
   * 每帧把挂件摆到当前帧的挂点位姿上。由 `update` 与所有换帧路径调用。
   *
   * 挂点在当前帧没有标注 → 挂件**隐藏**（既不乱摆也不卸下）：像"刀在鞘里那几帧
   * 手上没东西"，标注缺席就是它该消失的意思，玩家不会看到道具跳到原点。
   */
  private syncAttachments(): void {
    if (this.attachments.size === 0) return;
    let needSort = false;
    for (const [name, at] of this.attachments) {
      const pose = this.getSocketPose(name);
      if (!pose) {
        at.view.visible = false;
        if (at.litQuad) at.litQuad.mesh.visible = false;
        continue;
      }
      at.view.visible = true;
      at.view.x = pose.x;
      at.view.y = pose.y;
      // 支点：挂点对准贴图上的这一点（刀柄而不是图心）
      const ax = clamp01(at.anchorX ?? 0.5);
      const ay = clamp01(at.anchorY ?? 0.5);
      const sprite = at.view as Sprite;
      if (sprite.anchor && (sprite.anchor.x !== ax || sprite.anchor.y !== ay)) {
        sprite.anchor.set(ax, ay);
      }
      const base = at.scale ?? 1;
      const mirror = at.mirrorWithHost === false ? 1 : pose.facing;
      at.view.scale.set(base * pose.scale * mirror, base * pose.scale);
      // 旋转 = 挂点标注角度 + 挂件自身偏置；偏置同样跟着镜像取反，否则朝左时道具会反着歪
      const offset = (at.rotationOffsetDeg ?? 0) * pose.facing;
      at.view.rotation = ((pose.angleDeg + offset) * Math.PI) / 180;
      // 第二档：挂点驱动帧号——挂件是一张小序列图时用标注里的帧号选纹理，
      // 不引入第二个时钟（所以也没有锁相问题）。
      if (at.frameTextures && at.frameTextures.length > 0 && pose.frame !== null) {
        const n = at.frameTextures.length;
        const idx = ((pose.frame % n) + n) % n;
        const tex = at.frameTextures[idx];
        const target = at.view as Sprite;
        if (tex && target.texture !== tex) target.texture = tex;
      }
      // 换了纹理就要换 shader（shader 绑的是那张 color 贴图）
      this.refreshAttachmentLit(at);
      this.syncAttachmentLit(at);
      if (at.lastFront !== pose.front) {
        at.lastFront = pose.front;
        needSort = true;
      }
    }
    if (needSort) this.reorderAttachments();
  }

  /** 把挂件 view 的变换逐项复制给它的光照 mesh（两者是兄弟，见 refreshAttachmentLit）。 */
  private syncAttachmentLit(at: SocketAttachment): void {
    const q = at.litQuad;
    if (!q) return;
    const view = at.view as Sprite;
    const tex = view.texture;
    if (!tex) return;
    q.sync(tex, tex.frame.width, tex.frame.height, view.anchor.x, view.anchor.y);
    const m = q.mesh;
    m.visible = view.visible;
    m.position.set(view.x, view.y);
    m.scale.set(view.scale.x, view.scale.y);
    m.rotation = view.rotation;
    // 与 syncLitQuadWorld 同一套外层合成 —— 裸用 container.x 在 Npc 上就是 (0,0)
    const pr = this.litParentRot;
    const cos = Math.cos(pr), sin = Math.sin(pr);
    const cx = this.litParentX + this.litParentSX * (cos * this.container.x - sin * this.container.y);
    const cy = this.litParentY + this.litParentSY * (sin * this.container.x + cos * this.container.y);
    q.setWorldTransform(
      cx, cy,
      this.litParentSX * this.container.scale.x, this.litParentSY * this.container.scale.y,
      view.x, view.y, view.scale.x, view.scale.y, view.rotation + pr);
  }

  /**
   * 前后：`front` 的挂件排到最后（画在身前），其余插到最前（画在身后）。
   * 角色本体是 `sprite` 与 `litQuad.mesh` 两个兄弟（启用光照时 sprite 只当变换载体、
   * mesh 出图），所以"身后"必须插在**两者之前**，不能夹在中间。
   */
  private reorderAttachments(): void {
    for (const at of this.attachments.values()) {
      // view 与它的光照 mesh 是一对，前后要一起挪（view 不出图但顺序仍要一致）
      for (const node of [at.view, at.litQuad?.mesh]) {
        if (!node || node.parent !== this.container) continue;
        if (at.lastFront) this.container.setChildIndex(node, this.container.children.length - 1);
        else this.container.setChildIndex(node, 0);
      }
    }
  }
  /**
   * 当前状态**授权**的头顶锚（容器局部 y，脚点 0、向上为负；已含透视系数与视觉抬升）。
   * 来自 anim.json `states[*].bubbleAnchor`（格高归一化比例）；没授权返回 null，调用方走内容框自动档。
   *
   * 存在的理由：内容框顶 ≠ 头顶——举枪、扛尸、打伞这些状态，自动锚会挂到道具尖上。
   */
  getAuthoredBubbleAnchorLocalY(): number | null {
    const raw = this.currentFrameDef?.bubbleAnchor;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
    return this.sprite.y - raw * this.worldHeight * this.depthScaleFactor;
  }

  /** 当前显示帧在 `atlasFrames` 中登记的内容包围盒（格像素）；无登记/非法返回 null。 */
  private currentFrameContentBoxPx(): { w: number; h: number } | null {
    const boxes = this.animDef?.atlasFrames;
    const seq = this.currentFrameDef?.frames;
    if (!boxes || boxes.length === 0 || !seq || seq.length === 0) return null;
    const box = boxes[seq[this.frameIndex % seq.length]];
    const w = box?.contentWidth;
    const h = box?.contentHeight;
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) return null;
    if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return null;
    return { w, h };
  }

  /** 透视缩放系数（近大远小）；非法/≤0 回落 1。变化时立即重投帧缩放。 */
  setDepthScaleFactor(f: number): void {
    const v = Number.isFinite(f) && f > 0 ? f : 1;
    if (v === this.depthScaleFactor) return;
    this.depthScaleFactor = v;
    this.applySpriteScale();
  }

  getDepthScaleFactor(): number {
    return this.depthScaleFactor;
  }

  /** 当前显示帧纹理（供投影阴影复用剪影）；未加载时返回 null */
  getDisplayTexture(): Texture | null {
    const t = this.sprite.texture;
    return t && t !== Texture.EMPTY ? t : null;
  }

  /**
   * 是否参与「实体与背景像素密度匹配」。关时移除内层密度滤镜。
   */
  setPixelDensityMatchActive(active: boolean): void {
    if (this.pixelDensityMatchActive === active) return;
    this.pixelDensityMatchActive = active;
    this.sprite.roundPixels = active;
    if (!active) {
      this.clearPixelDensityBlur();
    }
  }

  getPixelDensityMatchActive(): boolean {
    return this.pixelDensityMatchActive;
  }

  /**
   * 按当前帧与背景 dBg 更新内层 Sprite 的模糊强度；需在每帧或切帧后调用。
   * @param dBg 背景 texels/world；为 null 或功能关闭时由调用方先 setActive(false)
   * @param strengthScale 强度倍率（配置 / 调试）
   */
  applyPixelDensityMatch(dBg: TexelsPerWorld | null, strengthScale = 1): void {
    if (!this.pixelDensityMatchActive) return;
    if (!dBg || !this.baseTexture || !this.animDef) {
      this.clearPixelDensityBlur();
      return;
    }
    const { frameW, frameH } = this.getCurrentFramePixelSize();
    // 透视缩小后有效世界尺寸变小 → k 变大 → 低通更强，随深度自适应
    const k = computePixelDensityK(
      frameW,
      frameH,
      this.worldWidth * this.depthScaleFactor,
      this.worldHeight * this.depthScaleFactor,
      dBg,
    );
    const strength = blurStrengthFromPixelDensityK(k, strengthScale);
    if (strength <= 0) {
      this.unmountPixelDensityBlur();
      return;
    }
    if (!this.pixelDensityBlur) {
      this.pixelDensityBlur = createPixelDensityBlurFilter(strength);
    } else {
      this.pixelDensityBlur.strength = strength;
    }
    if (!this.pixelDensityBlurMounted) {
      this.sprite.filters = [this.pixelDensityBlur];
      this.pixelDensityBlurMounted = true;
    }
  }

  /** 从 sprite.filters 摘除（保留滤镜实例复用，强度回升时免重建） */
  private unmountPixelDensityBlur(): void {
    if (!this.pixelDensityBlurMounted) return;
    this.sprite.filters = [];
    this.pixelDensityBlurMounted = false;
  }

  private clearPixelDensityBlur(): void {
    this.unmountPixelDensityBlur();
    if (this.pixelDensityBlur) {
      this.pixelDensityBlur.destroy();
      this.pixelDensityBlur = null;
    }
  }

  private getCurrentFramePixelSize(): { frameW: number; frameH: number } {
    const tex = this.baseTexture;
    const def = this.animDef;
    if (!tex || !def) {
      return { frameW: 1, frameH: 1 };
    }
    const strideW =
      typeof def.cellWidth === 'number' && def.cellWidth > 0
        ? def.cellWidth
        : tex.width / def.cols;
    const strideH =
      typeof def.cellHeight === 'number' && def.cellHeight > 0
        ? def.cellHeight
        : tex.height / def.rows;
    let frameW = strideW;
    let frameH = strideH;
    if (this.currentFrameDef && def.atlasFrames && def.atlasFrames.length > 0) {
      const seq = this.currentFrameDef.frames;
      const slot = seq[this.frameIndex % seq.length];
      const box = def.atlasFrames[slot];
      if (box && box.width > 0 && box.height > 0) {
        frameW = box.width;
        frameH = box.height;
      }
    }
    return { frameW, frameH };
  }

  private applySpriteScale(): void {
    const tex = this.baseTexture;
    const def = this.animDef;
    if (!tex || !def) {
      this.sprite.scale.set(this.facingX, 1);
      return;
    }
    const { frameW, frameH } = this.getCurrentFramePixelSize();

    this.sprite.scale.set(
      (this.worldWidth * this.depthScaleFactor / frameW) * this.facingX,
      (this.worldHeight * this.depthScaleFactor) / frameH,
    );
    this.syncLitQuad();   // 所有换帧/换向/透视缩放路径的必经点:mesh 顶点+UV 跟随
    this.syncAttachments();   // 挂点位姿同源:换帧/换向/透视一变,挂件当场跟上
  }
}
