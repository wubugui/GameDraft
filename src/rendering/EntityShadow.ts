import 'pixi.js/mesh';
import { BlurFilter, Container, Mesh, MeshGeometry, Shader, Texture, type TextureSource } from 'pixi.js';
import type { ResolvedLightEnv } from './lightEnv';
import type { ShadowProjectionField } from './shadowField';
import type { ShadowSource, ShadowSceneContext, IEntityShadow } from './entityShadowTypes';

export type { ShadowSource, ShadowSceneContext } from './entityShadowTypes';

const DEG2RAD = Math.PI / 180;

// 纯平面投影:cast 单 quad,FRAG 做碰撞方向阻挡 + 前景深度 blend;contact 单 quad 仅压暗(uColEnabled/uOccEnabled=0)。
const VERT = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vUV;
out vec2 vWorld;
void main(void) {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vUV = aUV;
    vWorld = aPosition; // 平面投影:顶点即地面落点
}
`;

const FRAG = /* glsl */ `
in vec2 vUV;
in vec2 vWorld;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uDepthMap;
uniform sampler2D uCollisionMap;

uniform float uDarkness;
uniform vec3  uShadowColor;   // 全局阴影颜色(默认纯黑)
uniform float uColEnabled;
uniform float uOccEnabled;
// cast 剪影 UV:片元内从世界坐标反解平行四边形参数(uUvMode=1)。
// 曾走 aUV 顶点缓冲逐帧 update,GPU 端不生效(剪影被整张图集横扫成条纹,
// 2026-07-22 白底渲染实证);contact 的静态 UV(uUvMode=0)不受影响。
uniform float uUvMode;
// 全用标量:vec 型 uniform 在 Mesh 路径的就地突变曾出现不同步(标量实证可靠)
uniform float uShearX;     // 影子头端偏移(世界px)
uniform float uShearY;
uniform float uHalfW;      // 底边半宽
uniform float uU0;         // 剪影帧 uv:u0/v0=脚(底), u1/v1=头(顶)
uniform float uV0;
uniform float uU1;
uniform float uV1;
uniform vec2  uSceneSize;
uniform float uFootX;
uniform float uFootY;
uniform float uW2pX;
uniform float uW2pY;
uniform float uInvert;
uniform float uScale;
uniform float uOffset;
uniform float uFloorOffset;
uniform float uTolerance;
uniform float uOccBlend;
uniform sampler2D uGroundD;    // 行走面深度场（RG16，与角色遮挡同一份）
uniform float uGroundMin;      // 解码：d = min + (r*256+g)/65535 * (max-min)
uniform float uGroundMax;
uniform float uHasGroundTex;   // 0=无场 → 影子不做地面遮挡/碰撞裁切
uniform float uM_ppu;
uniform float uM_cx;
uniform float uM_cy;
uniform float uM_R00; uniform float uM_R01; uniform float uM_R02;
uniform float uM_R20; uniform float uM_R21; uniform float uM_R22;
uniform float uCol_xMin;
uniform float uCol_zMin;
uniform float uCol_cell;
uniform float uCol_gw;
uniform float uCol_gh;

/** 地面深度：逐像素取行走面场。影子落在地上，其深度必须与角色脚点同源——线性 floor
 *  模型会产生系统性标定偏移（2026-06-17 在 deferred 上踩过一次，2026-07-23 又在
 *  planar 与碰撞反投影上各踩一次），那条拟合直线已彻底废除。 */
float groundDepthAt(vec2 wp) {
    vec2 uv = vec2(wp.x / max(uSceneSize.x, 1e-3), wp.y / max(uSceneSize.y, 1e-3));
    vec4 g = texture(uGroundD, clamp(uv, 0.0, 1.0));
    float t = (g.r * 255.0 * 256.0 + g.g * 255.0) / 65535.0;
    return uGroundMin + t * (uGroundMax - uGroundMin);
}

bool isCollisionAt(vec2 wp) {
    float sx = wp.x * uW2pX;
    float sy = wp.y * uW2pY;
    float dFloor = groundDepthAt(wp);
    float px = (sx - uM_cx) / uM_ppu;
    float py = (uM_cy - sy) / uM_ppu;
    float cwx = uM_R00 * px + uM_R01 * py + uM_R02 * dFloor;
    float cwz = uM_R20 * px + uM_R21 * py + uM_R22 * dFloor;
    float gx = (cwx - uCol_xMin) / uCol_cell;
    float gz = (cwz - uCol_zMin) / uCol_cell;
    if (gx < 0.0 || gx >= uCol_gw || gz < 0.0 || gz >= uCol_gh) return false;
    return texture(uCollisionMap, vec2(gx / uCol_gw, gz / uCol_gh)).r > 0.5;
}

void main(void) {
    vec2 uv = vUV;
    if (uUvMode > 0.5) {
        // 平行四边形反解:vWorld = foot + (s-0.5)·2hw·x̂ + t·off
        float offY = abs(uShearY) < 1e-3 ? (uShearY < 0.0 ? -1e-3 : 1e-3) : uShearY;
        float t = (vWorld.y - uFootY) / offY;
        float s = ((vWorld.x - uFootX) - uShearX * t) / max(uHalfW * 2.0, 1e-3) + 0.5;
        if (t < 0.0 || t > 1.0 || s < 0.0 || s > 1.0) { discard; }
        uv = vec2(mix(uU0, uU1, s), mix(uV0, uV1, t));
    }
    float sil = texture(uTexture, uv).a;
    if (sil < 0.01) { discard; }
    float a = sil * uDarkness;

    // 碰撞方向阻挡:从脚底沿投射方向 march,撞到碰撞格则其后整段裁掉
    if (uColEnabled > 0.5 && uHasGroundTex > 0.5) {
        vec2 foot = vec2(uFootX, uFootY);
        vec2 d = vWorld - foot;
        bool blocked = false;
        for (int i = 1; i <= 24; i++) {
            if (isCollisionAt(foot + d * (float(i) / 24.0))) { blocked = true; break; }
        }
        if (blocked) { discard; }
    }

    // 前景遮挡 blend:落点在前景几何之后 → 像角色一样按 occlusionBlendFactor 混合
    if (uOccEnabled > 0.5 && uHasGroundTex > 0.5) {
        vec2 dUV = vec2(vWorld.x / uSceneSize.x, vWorld.y / uSceneSize.y);
        if (dUV.x >= 0.0 && dUV.x <= 1.0 && dUV.y >= 0.0 && dUV.y <= 1.0) {
            vec4 ds = texture(uDepthMap, dUV);
            float rawD = (ds.r * 255.0 * 256.0 + ds.g * 255.0) / 65535.0;
            float dRaw = uInvert > 0.5 ? 1.0 - rawD : rawD;
            float sceneDepth = dRaw * uScale + uOffset;
            float shadowDepth = groundDepthAt(vWorld) + uFloorOffset;
            if (sceneDepth + uTolerance < shadowDepth) { a *= uOccBlend; }
        }
    }

    finalColor = vec4(uShadowColor, a);
}
`;

function f32(value: number) {
  return { value, type: 'f32' as const };
}

let contactTexture: Texture | null = null;
function getContactTexture(): Texture {
  if (contactTexture) return contactTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const r = size / 2;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  contactTexture = Texture.from(canvas);
  return contactTexture;
}

/** 用 context 构建 planar 阴影 shader(cast/contact 共用;contact 把 col/occ 关掉)。 */
function makePlanarShader(ctx: ShadowSceneContext | null, texSource: TextureSource, colOcc: boolean): Shader {
  const on = colOcc && !!ctx;
  return Shader.from({
    gl: { vertex: VERT, fragment: FRAG },
    resources: {
      shadowUniforms: {
        uDarkness: f32(0.4),
        uShadowColor: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },
        uColEnabled: f32(on && ctx!.collisionTexture ? 1 : 0),
        uOccEnabled: f32(on ? 1 : 0),
        uUvMode: f32(colOcc ? 1 : 0),   // cast=片元反解 UV;contact=静态 vUV
        uShearX: f32(0),
        uShearY: f32(1),
        uHalfW: f32(1),
        uU0: f32(0), uV0: f32(1), uU1: f32(1), uV1: f32(0),
        uSceneSize: { value: new Float32Array([ctx?.sceneW ?? 1, ctx?.sceneH ?? 1]), type: 'vec2<f32>' },
        uFootX: f32(0),
        uFootY: f32(0),
        uW2pX: f32(ctx?.worldToPixelX ?? 1),
        uW2pY: f32(ctx?.worldToPixelY ?? 1),
        uInvert: f32(ctx?.invert ?? 0),
        uScale: f32(ctx?.scale ?? 1),
        uOffset: f32(ctx?.offset ?? 0),
        uFloorOffset: f32(ctx?.floorOffset ?? 0),
        uTolerance: f32(ctx?.tolerance ?? 0),
        uOccBlend: f32(ctx?.occlusionBlendFactor ?? 0.28),
        uGroundMin: f32(ctx?.groundMin ?? 0),
        uGroundMax: f32(ctx?.groundMax ?? 1),
        uHasGroundTex: f32(ctx?.groundTexture ? 1 : 0),
        uM_ppu: f32(ctx?.ppu ?? 1),
        uM_cx: f32(ctx?.cx ?? 0),
        uM_cy: f32(ctx?.cy ?? 0),
        uM_R00: f32(ctx?.r00 ?? 0), uM_R01: f32(ctx?.r01 ?? 0), uM_R02: f32(ctx?.r02 ?? 0),
        uM_R20: f32(ctx?.r20 ?? 0), uM_R21: f32(ctx?.r21 ?? 0), uM_R22: f32(ctx?.r22 ?? 0),
        uCol_xMin: f32(ctx?.colXMin ?? 0),
        uCol_zMin: f32(ctx?.colZMin ?? 0),
        uCol_cell: f32(ctx?.colCellSize ?? 1),
        uCol_gw: f32(ctx?.colGridW ?? 0),
        uCol_gh: f32(ctx?.colGridH ?? 0),
      },
      uTexture: texSource,
      uDepthMap: ctx?.depthTexture?.source ?? Texture.WHITE.source,
      uCollisionMap: ctx?.collisionTexture?.source ?? Texture.WHITE.source,
      uGroundD: ctx?.groundTexture ?? Texture.WHITE.source,
    },
  });
}

function setU(shader: Shader, key: string, v: number): void {
  const grp = (shader.resources as Record<string, { uniforms?: Record<string, unknown>; update?: () => void }>)['shadowUniforms'];
  if (grp?.uniforms) {
    grp.uniforms[key] = v;
    // Mesh 路径的 UniformGroup 靠 dirtyId 同步:不 update() 突变永远到不了 GPU
    // (滤镜路径每帧强制同步无此坑;2026-07-22 剪影条纹实证)
    grp.update?.();
  }
}

/**
 * planar 模式:纯平面投影阴影 + 碰撞方向阻挡 + 前景遮挡 blend + 脚底接触斑。
 * 阴影/接触均在 shadowLayer(实体层之下)。被前景实体覆盖由 z-order 处理。
 */
export class PlanarEntityShadow implements IEntityShadow {
  private readonly ctx: ShadowSceneContext | null;
  private readonly castMesh: Mesh;
  private readonly castShader: Shader;
  private readonly castPositions: Float32Array;
  private readonly castUVs: Float32Array;
  private readonly castGeometry: MeshGeometry;
  private readonly contactMesh: Mesh;
  private readonly contactShader: Shader;
  private readonly contactPositions: Float32Array;
  private readonly contactGeometry: MeshGeometry;
  private blur: BlurFilter | null = null;
  private lastSoftness = -1;
  private boundSource: TextureSource | null = null;

  constructor(layer: Container, ctx?: ShadowSceneContext | null) {
    this.ctx = ctx ?? null;
    const quadIdx = () => new Uint32Array([0, 1, 2, 0, 2, 3]);

    this.castPositions = new Float32Array(8);
    this.castUVs = new Float32Array(8);
    this.castGeometry = new MeshGeometry({ positions: this.castPositions, uvs: this.castUVs, indices: quadIdx() });
    this.castShader = makePlanarShader(this.ctx, Texture.WHITE.source, true);
    this.castMesh = new Mesh({ geometry: this.castGeometry, shader: this.castShader, texture: Texture.WHITE }) as Mesh;
    this.castMesh.visible = false;
    layer.addChild(this.castMesh);

    this.contactPositions = new Float32Array(8);
    const contactUVs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    this.contactGeometry = new MeshGeometry({ positions: this.contactPositions, uvs: contactUVs, indices: quadIdx() });
    const ct = getContactTexture();
    this.contactShader = makePlanarShader(this.ctx, ct.source, false); // contact 不做碰撞/遮挡
    this.contactMesh = new Mesh({ geometry: this.contactGeometry, shader: this.contactShader, texture: ct }) as Mesh;
    this.contactMesh.visible = false;
    layer.addChild(this.contactMesh);
  }

  update(src: ShadowSource, env: ResolvedLightEnv, field?: ShadowProjectionField | null): void {
    const tex = src.getTexture();
    if (!tex || !src.isVisible() || !env.shadow.enabled) {
      this.castMesh.visible = false;
      this.contactMesh.visible = false;
      return;
    }

    const fx = src.getFootX();
    const fy = src.getFootY();
    const w = Math.max(1, src.getWorldWidth());
    const H = Math.max(1, src.getWorldHeight());

    // contact 椭圆 quad(0.55/0.26:帧宽多为透明边距,1.3 会出直径≈2×帧宽的巨晕)
    if (env.shadow.contact > 0 && env.shadow.contactSize > 0) {
      const cw = w * 0.55 * env.shadow.contactSize;
      const ch = w * 0.26 * env.shadow.contactSize;
      const cp = this.contactPositions;
      cp[0] = fx - cw / 2; cp[1] = fy - ch / 2;
      cp[2] = fx + cw / 2; cp[3] = fy - ch / 2;
      cp[4] = fx + cw / 2; cp[5] = fy + ch / 2;
      cp[6] = fx - cw / 2; cp[7] = fy + ch / 2;
      this.contactGeometry.getBuffer('aPosition').update();
      setU(this.contactShader, 'uDarkness', Math.min(1, env.shadow.contact));
      this.contactMesh.visible = true;
    } else {
      this.contactMesh.visible = false;
    }

    // cast 平面投影 quad
    if (env.shadow.darkness <= 0) {
      this.castMesh.visible = false;
      return;
    }
    this.castMesh.visible = true;

    const source = tex.source;
    if (source !== this.boundSource) {
      (this.castShader.resources as Record<string, unknown>)['uTexture'] = source;
      this.castMesh.texture = tex;
      this.boundSource = source;
    }

    const proj = field
      ? field.sample(fx, fy)
      : { angleRad: (env.key.azimuthDeg + 180) * DEG2RAD, length: env.shadow.length };
    const hw = Math.max(0.5, w * 0.5);
    const reach = H * proj.length;
    const offX = Math.cos(proj.angleRad) * reach;
    const offY = Math.sin(proj.angleRad) * reach;

    const fr = tex.frame;
    const sw = source.width || 1;
    const sh = source.height || 1;
    let u0 = fr.x / sw;
    let u1 = (fr.x + fr.width) / sw;
    if (src.getFacing() < 0) { const t = u0; u0 = u1; u1 = t; }
    const vTop = fr.y / sh;
    const vBot = (fr.y + fr.height) / sh;

    const p = this.castPositions;
    p[0] = fx - hw;        p[1] = fy;          // BL 脚
    p[2] = fx + hw;        p[3] = fy;          // BR 脚
    p[4] = fx + hw + offX; p[5] = fy + offY;   // TR 头
    p[6] = fx - hw + offX; p[7] = fy + offY;   // TL 头
    this.castGeometry.getBuffer('aPosition').update();

    setU(this.castShader, 'uDarkness', Math.max(0, Math.min(1, env.shadow.darkness)));
    setU(this.castShader, 'uFootX', fx);
    setU(this.castShader, 'uFootY', fy);
    // 剪影 UV 走片元反解(uUvMode=1);顶点 aUV 缓冲逐帧 update 在 GPU 端不生效
    setU(this.castShader, 'uShearX', offX);
    setU(this.castShader, 'uShearY', offY);
    setU(this.castShader, 'uHalfW', hw);
    setU(this.castShader, 'uU0', u0);
    setU(this.castShader, 'uV0', vBot);
    setU(this.castShader, 'uU1', u1);
    setU(this.castShader, 'uV1', vTop);

    const softness = env.shadow.softness;
    if (softness > 0) {
      const strength = Math.max(0.5, softness * 4);
      if (!this.blur) {
        this.blur = new BlurFilter({ strength, quality: 2 });
        this.castMesh.filters = [this.blur];
        this.lastSoftness = softness;
      } else if (Math.abs(softness - this.lastSoftness) > 1e-3) {
        this.blur.strength = strength;
        this.lastSoftness = softness;
      }
    } else if (this.blur) {
      this.castMesh.filters = [];
      this.blur.destroy();
      this.blur = null;
      this.lastSoftness = -1;
    }
  }

  /** 深度调参广播（contact shader 的 col/occ 恒关，深度参数无效，仅 cast 需要） */
  setDepthParams(tolerance: number, floorOffset: number, occlusionBlendFactor: number): void {
    setU(this.castShader, 'uTolerance', tolerance);
    setU(this.castShader, 'uFloorOffset', floorOffset);
    setU(this.castShader, 'uOccBlend', occlusionBlendFactor);
  }

  /** 全局阴影颜色(cast + contact 同色);逐帧由光源阴影系统广播。 */
  setShadowColor(c: [number, number, number]): void {
    for (const sh of [this.castShader, this.contactShader]) {
      const grp = (sh.resources as Record<string, { uniforms?: Record<string, unknown>; update?: () => void }>)['shadowUniforms'];
      if (grp?.uniforms) {
        const a = grp.uniforms['uShadowColor'] as Float32Array;
        a[0] = c[0]; a[1] = c[1]; a[2] = c[2];
        grp.update?.();
      }
    }
  }

  destroy(): void {
    if (this.blur) {
      this.blur.destroy();
      this.blur = null;
    }
    this.castMesh.destroy();
    this.castShader.destroy();
    this.castGeometry.destroy();
    this.contactMesh.destroy();
    this.contactShader.destroy();
    this.contactGeometry.destroy();
  }
}
