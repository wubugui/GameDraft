import 'pixi.js/mesh';
import { BlurFilter, Container, Mesh, MeshGeometry, Shader, Texture, type TextureSource } from 'pixi.js';
import type { ResolvedLightEnv } from './lightEnv';
import type { ShadowProjectionField } from './shadowField';
import { bodyFootprintOf, footprintOf, mirrorFootprint } from './footprintExtent';
import {
  CONTACT_AO_DIR_CONE_DEG_DEFAULT, CONTACT_AO_DIR_LENGTH_DEFAULT, CONTACT_AO_DIR_STRENGTH_DEFAULT,
  CONTACT_AO_SPREAD_DEFAULT, coneKFromDeg, resolveContactAo,
} from './contactAo';
import { CONTACT_AO_MIN_ELEVATION_DEG, MAX_CONTACT_AO_SOURCES } from './contactAoSources';
import {
  IDENTITY_SHADOW_SHAPE,
  type ShadowSource, type ShadowSceneContext, type IEntityShadow, type ShadowShapeParams, type ContactAoParams,
} from './entityShadowTypes';

export type { ShadowSource, ShadowSceneContext } from './entityShadowTypes';

const DEG2RAD = Math.PI / 180;

/**
 * 末端渐隐：从影长的这个位置开始，浓度向 `TIP_ALPHA` 收。
 *
 * 为什么要有：剪影是等比拉长的，头端会保留**清晰的头肩轮廓边**——大脑对那条边极其敏感，
 * 一眼就读成"一张人形贴纸躺在地上"。真实影子的远端半影最宽、本影最弱，本来就该化掉。
 */
const TIP_FADE_START = 0.4;
const TIP_ALPHA = 0.42;
/**
 * 半影随距离展宽：采样半径（占剪影帧尺寸的比例）从脚端 0 长到头端这个值。
 *
 * 脚端保持 0 是刻意的——接触点本来就该是锐的，而且 `env.shadow.softness` 驱动的那个
 * `BlurFilter` 已经在给全长一个由光源角尺寸决定的基础软度。这里只加"随距离变软"那一份，
 * 存量场景的接触端观感因此逐像素不变。
 */
const PENUMBRA_GROW = 0.06;

/**
 * 接触阴影（胶囊 AO，见 `CONTACT_FRAG` 头注释）的形状量。
 *
 * - `BAND`：从剪影最低的不透明行往上多高（占帧高）算"贴地的那一截"（脚、鞋、衣摆），它的宽度定胶囊半径
 *   （只在站立片段的帧上量、取中位数，按角色固定，见 footprintExtent.bodyFootprintOf）。
 *   12%：迈步姿势里后脚在画面上更高，6% 只包得住前脚（送葬队 13 人里 6 人实测如此）；
 *   多数图集在 10%~12% 之间宽度就不再涨，再往上开始把腿、衣摆算进去。
 * - `SEARCH`：从帧底往上最多找多高去寻那一行；再往上都没东西 = 这一帧不挨地，不画。
 *
 * 明暗、大小、晕开、方向 AO 的浓度 / 拖尾 / 锥角是**作者参数**（逐实体 `contactAo`，缺省见 `contactAo.ts`），
 * 不在这里。缺省值的来历：2026-09-24 在实测截图上离线复现本式、对比几档后定，再经真机复验收紧——
 * 近场 0.35 / 锥角约 51° / 拖尾 1.2 那一版真机上 13 人叠成一片暗雾、读成"火光被调暗"，已否。
 */
export const CONTACT_BAND = 0.12;
export const CONTACT_SEARCH = 0.35;
/**
 * "这像素看到的是不是地面"判断的渐变宽度（深度 q 单位）：场景深度比行走面近了容差以上开始淡，
 * 再近这么多才完全不画。一刀切会在深度图比原画宽的细遮挡物（灯杆、灯笼）旁挖出一圈、留硬锯齿边
 * （2026-09-24 真机：锣手脚边被挖掉一块，灯杆旁一道竖缝）。
 */
export const CONTACT_GROUND_FEATHER = 0.2;

// 纯平面投影:cast 单 quad,FRAG 做碰撞方向阻挡 + 前景深度 blend;contact 单 quad 走自己的 CONTACT_FRAG,只压暗。
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
in vec2 vWorld;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uDepthMap;
uniform sampler2D uCollisionMap;

uniform float uDarkness;
uniform vec3  uShadowColor;   // 全局阴影颜色(默认纯黑)
uniform float uColEnabled;
uniform float uOccEnabled;
// cast 剪影 UV:片元内从世界坐标反解平行四边形参数。
// 曾走 aUV 顶点缓冲逐帧 update,GPU 端不生效(剪影被整张图集横扫成条纹,
// 2026-07-22 白底渲染实证)。
// 全用标量:vec 型 uniform 在 Mesh 路径的就地突变曾出现不同步(标量实证可靠)
uniform float uShearX;     // 影子头端偏移(世界px)
uniform float uShearY;
uniform float uHalfW;      // 底边半宽
uniform float uSpreadTop;  // 头端半宽 ÷ 底边半宽:1=平行四边形, >1=梯形(点光散开)
uniform float uTipFadeStart; // 末端渐隐起点(t)
uniform float uTipAlpha;     // t=1 处的浓度系数
uniform float uPenGrow;      // 头端半影半径(占剪影帧尺寸比例);脚端恒 0
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

/** 取剪影 alpha。**必须 clamp 在当前帧框内**:越界会采到图集里相邻的帧——那正是
 *  2026-07-22「剪影被整张图集横扫成条纹」的复发路径。 */
float silAt(vec2 uv) {
    vec2 lo = vec2(min(uU0, uU1), min(uV0, uV1));
    vec2 hi = vec2(max(uU0, uU1), max(uV0, uV1));
    return texture(uTexture, clamp(uv, lo, hi)).a;
}

/** 45° 环上的对角分量。 */
const float RING_K = 0.7071;

/** 变半径半影:内圈 8 抽(权 1)+ 外圈 4 抽(权 .5)+ 中心(权 2),权和 12。
 *  半径给的是**帧内比例**,按帧跨度换成 uv,于是拉长方向糊得多、横向糊得少
 *  ——正是长影子该有的样子。r=0 直接短路。
 *
 *  ⚠ 抽样点必须手写展开、不能用常量数组:本工程的 Pixi 上下文是 WebGL1,
 *    源码里的 in / out / texture() 是 Pixi 反向转译过去的,数组构造式没有转译,
 *    写了会在 GLSL ES 1.00 下编译失败 → 整个影子 shader 起不来(2026-08-22 真机实证)。
 *  ⚠ 本段在 TS 模板字符串里,注释中一律不许出现反引号——会当场截断 GLSL 源。 */
float silSoft(vec2 uv, float r) {
    if (r < 1e-4) return silAt(uv);
    vec2 rad = r * vec2(abs(uU1 - uU0), abs(uV1 - uV0));
    float sum = silAt(uv) * 2.0
        + silAt(uv + vec2( rad.x, 0.0))
        + silAt(uv + vec2(-rad.x, 0.0))
        + silAt(uv + vec2( 0.0,  rad.y))
        + silAt(uv + vec2( 0.0, -rad.y))
        + silAt(uv + vec2( RING_K * rad.x,  RING_K * rad.y))
        + silAt(uv + vec2(-RING_K * rad.x,  RING_K * rad.y))
        + silAt(uv + vec2( RING_K * rad.x, -RING_K * rad.y))
        + silAt(uv + vec2(-RING_K * rad.x, -RING_K * rad.y));
    sum += 0.5 * (
          silAt(uv + vec2( 2.0 * rad.x, 0.0))
        + silAt(uv + vec2(-2.0 * rad.x, 0.0))
        + silAt(uv + vec2( 0.0,  2.0 * rad.y))
        + silAt(uv + vec2( 0.0, -2.0 * rad.y)));
    return sum / 12.0;
}

void main(void) {
    // 梯形反解:vWorld = foot + t·off + (s-0.5)·2·hw(t)·x̂,hw(t)=uHalfW·mix(1,uSpreadTop,t)。
    // 底边沿世界 x̂、头端只在 x̂ 上放大,所以 t 的解与 uSpreadTop 无关(仍是 y 的一次式)。
    float offY = abs(uShearY) < 1e-3 ? (uShearY < 0.0 ? -1e-3 : 1e-3) : uShearY;
    float t = (vWorld.y - uFootY) / offY;
    float halfAt = uHalfW * mix(1.0, uSpreadTop, clamp(t, 0.0, 1.0));
    float s = ((vWorld.x - uFootX) - uShearX * t) / max(halfAt * 2.0, 1e-3) + 0.5;
    if (t < 0.0 || t > 1.0 || s < 0.0 || s > 1.0) { discard; }
    vec2 uv = vec2(mix(uU0, uU1, s), mix(uV0, uV1, t));
    float sil = silSoft(uv, uPenGrow * t);
    if (sil < 0.01) { discard; }
    // 末端渐隐:远端本影本来就该弱下去,不渐隐就会看见清晰的头肩边(纸片感的第一来源)
    float a = sil * uDarkness * mix(1.0, uTipAlpha, smoothstep(uTipFadeStart, 1.0, t));

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

/**
 * 接触阴影 = **胶囊 AO**(制作人 2026-09-24 要的"带方向性的 AO,像 3D 里的胶囊体 AO")。
 *
 * 角色在 M-world 里近似成一根竖直胶囊:轴在剪影贴地那一截的中心、往镜头反方向退一个半径
 * (剪影最低那行是脚最靠镜头的前沿,身体轴线在它后面);半径 = 贴地那一截半宽 × 大小(作者参数 size),
 * 半宽与中心在站立片段上量、按角色固定(走 / 跑不跟步幅变);
 * 高 = 帧高换算成的世界高。地面每个片元先用行走面深度场还原成 M-world 坐标(wu,铁律 0),再算两部分:
 *
 * 1. 无方向:**胶囊**(与方向部分同一根:底端球心高 r、贴地只挨一点)对地面点的**余弦加权遮蔽**
 *    (推导,不是拟合;见 capsuleOmni)。贴地那一点正好 1(脚底最黑),往外平滑落下,所以「明暗」
 *    (作者参数 darkness)就是"脚边最暗处的浓度",不用再归一。
 *    ⚠ 2026-09-25 之前按**平底实心圆柱**算、贴身体表面归一到 1:柱下一整圈恒 1、柱边上断崖
 *    (asin 在 x=r 处斜率无穷),真机就是脚下一块没有渐变的黑饼(制作人)。与方向部分的胶囊也对不上。
 *    顶只到身高的「晕开」比例(作者参数 spread,缺省 0.25):这一层画在已经打好光的画面上,分不出环境光和灯光,
 *    全高的 1/x 长尾会把整片灯光压暗(13 人队伍离线实测);灯光那份由下面的方向部分去挡。
 * 2. 有方向(「方向 AO」开着才有,缺省开):从地面点沿"指向光"的方向发射线,看离胶囊多近(Quilez 胶囊软阴影,
 *    锥形半影,锥角越大越软),再沿影子方向在「拖尾长度」内淡出、乘「方向浓度」。射线上取两直线最近点
 *    + 正对胶囊底/腰/顶三点,遮挡取最大(只取最近点在光近头顶时画出一条横线,见 capsuleDirOcc)。
 *    光从哪几路来见 contactAoSources.ts(缺省:间接光一路 + 每盏实体灯各一路,各投各的影、按各自占
 *    地面照度的比例加权;灯位型逐像素朝灯)。方向来源选「跟阴影绑定」「场景主光」时只有一路。
 *
 *   浓度 = 在地面上 × 明暗 × (1 - (1 - 无方向)(1 - 有方向))
 *
 * 作者面与缺省见 contactAo.ts(制作人 2026-09-24:勾接触 AO 默认简单 AO,勾方向 AO 才启用方向部分,参数都可调)。
 *
 * ⚠ 本段注释在 TS 模板字符串之外;GLSL 源里不许出现反引号,不用数组构造式(WebGL1 转译)。
 */
const CONTACT_FRAG = /* glsl */ `
in vec2 vWorld;
out vec4 finalColor;

uniform float uDarkness;       // 明暗(作者参数,缺省跟随场景 shadow.contact)
uniform vec3  uShadowColor;
uniform float uFootX;          // 脚点(场景 px)
uniform float uFootY;
uniform float uAxisOffX;       // 贴地那一截中心相对脚点的横向偏移(场景 px)
uniform float uRadiusWu;       // 胶囊半径(wu)
uniform float uHeightWu;       // 胶囊高(wu)
uniform float uNearField;      // 无方向部分的遮挡高度占身高的比例
uniform float uConeK;          // 有方向部分的锥形软度
uniform float uDirReach;       // 有方向部分沿影子方向的淡出长度(占身高)
uniform float uDirWeight;      // 有方向部分的权重
// 有方向部分的几路光(contactAoSources.ts,最多 4 路;全用标量,见 cast 那段注释)。
// P=1:X/Y/Z 是灯位(M-world wu),逐像素朝它;P=0:X/Y/Z 是指向光的单位向量。W = 这一路占地面照度的比例,0 = 不算。
uniform float uS0X; uniform float uS0Y; uniform float uS0Z; uniform float uS0W; uniform float uS0P;
uniform float uS1X; uniform float uS1Y; uniform float uS1Z; uniform float uS1W; uniform float uS1P;
uniform float uS2X; uniform float uS2Y; uniform float uS2Z; uniform float uS2W; uniform float uS2P;
uniform float uS3X; uniform float uS3Y; uniform float uS3Z; uniform float uS3W; uniform float uS3P;
uniform sampler2D uDepthMap;   // 场景深度(与 cast 的前景遮挡同一份)
uniform float uInvert;
uniform float uScale;
uniform float uOffset;
uniform float uFloorOffset;
uniform float uTolerance;
uniform float uHasDepth;       // 有场景深度 + 行走面场才做"这像素看到的是不是地面"的判断
uniform float uGroundFeather;  // 上面那个判断的渐变宽度(深度 q 单位)
uniform float uWuPerQ;         // 1 个 q 单位 = 多少 wu
uniform sampler2D uGroundD;    // 行走面深度场(与 cast / 角色遮挡同一份)
uniform float uGroundMin;
uniform float uGroundMax;
uniform float uGroundW;        // 行走面深度场纹理尺寸(纹素),手写双线性用
uniform float uGroundH;
uniform float uHasGroundTex;
uniform vec2  uSceneSize;
uniform float uW2pX;
uniform float uW2pY;
uniform float uM_ppu;
uniform float uM_cx;
uniform float uM_cy;
uniform float uM_R00; uniform float uM_R01; uniform float uM_R02;
uniform float uM_R10; uniform float uM_R11; uniform float uM_R12;
uniform float uM_R20; uniform float uM_R21; uniform float uM_R22;

const float PI = 3.14159265;

/** 行走面深度场第 (i, j) 个纹素(RG16 打包,解码到 0..1)。nearest 纹理在纹素中心取 = 取到这个纹素本身。 */
float groundTexel(float i, float j) {
    vec2 sz = vec2(max(uGroundW, 1.0), max(uGroundH, 1.0));
    vec4 g = texture(uGroundD, (clamp(vec2(i, j), vec2(0.0), sz - 1.0) + 0.5) / sz);
    return (g.r * 255.0 * 256.0 + g.g * 255.0) / 65535.0;
}

/**
 * 行走面深度场在场景 px 处的深度(q.z)。**手写双线性**,与 CPU 的 sampleGroundField 同口径
 * (纹素 i 在 work px = i 处)。打包值不能交给硬件插值(高低字节分开插 = 错值),纹理只能 nearest;
 * 直接 nearest 取,地面点按约 10 屏幕 px 一级阶梯还原,胶囊 AO 在脚下画出方块硬边(2026-09-24 真机)。
 * ⚠ 本 shader 按 WebGL1 兼容编译(源里没有 ES3 版本声明):texelFetch / textureSize / ivec 的 clamp 都不能用,
 *   用了就整段编译失败、接触 AO 一点都不画、且不报 TS 错(2026-09-24 真机踩过)。纹理尺寸走 uniform。
 *   连注释里也别写那句版本声明的原文:Pixi 在整段源码里找那串字(注释也算)决定按哪个版本编。
 */
float groundDepthAt(vec2 wp) {
    vec2 uv = clamp(vec2(wp.x / max(uSceneSize.x, 1e-3), wp.y / max(uSceneSize.y, 1e-3)), 0.0, 1.0);
    vec2 sz = vec2(max(uGroundW, 1.0), max(uGroundH, 1.0));
    vec2 t = clamp(uv * sz, vec2(0.0), sz - 1.001);
    vec2 i0 = floor(t);
    vec2 f = t - i0;
    float a = mix(groundTexel(i0.x, i0.y), groundTexel(i0.x + 1.0, i0.y), f.x);
    float b = mix(groundTexel(i0.x, i0.y + 1.0), groundTexel(i0.x + 1.0, i0.y + 1.0), f.x);
    return uGroundMin + mix(a, b, f.y) * (uGroundMax - uGroundMin);
}

/** 场景 px → 该处地面的 M-world 坐标(wu)。有行走面深度场取它;没有就按世界 y=0 的平地解深度。 */
vec3 groundWorldWu(vec2 wp) {
    float px = (wp.x * uW2pX - uM_cx) / uM_ppu;
    float py = (uM_cy - wp.y * uW2pY) / uM_ppu;
    float d;
    if (uHasGroundTex > 0.5) {
        d = groundDepthAt(wp);
    } else {
        float r12 = abs(uM_R12) > 1e-6 ? uM_R12 : 1e-6;
        d = -(uM_R10 * px + uM_R11 * py) / r12;
    }
    vec3 w = vec3(uM_R00 * px + uM_R01 * py + uM_R02 * d,
                  uM_R10 * px + uM_R11 * py + uM_R12 * d,
                  uM_R20 * px + uM_R21 * py + uM_R22 * d);
    return w * uWuPerQ;
}

/**
 * 无方向部分:竖直胶囊(轴在地面点水平距离 x 处,半径 r,底端球心高 r、顶端球心高 top)对地面点的
 * 余弦加权遮蔽 (1/π)∫cos(天顶角)dω。按方位角切成竖直半平面:每个半平面里胶囊的截面是一个 2D 胶囊
 * (两个圆 + 中间竖条,半宽 w = sqrt(r² − p²),p = 这个方位离轴的垂距,圆心在 m = x·cos 方位处、高 r 与 top),
 * 截面是凸的,从地面点看被挡的仰角是一整段 [lo, hi](lo 贴底圆下切线,hi 贴顶圆上切线;竖条跨过头顶时 hi = 90°),
 * 余弦加权就是 (sin²hi − sin²lo)/2;再对方位角中点求积。x > r 时只有 |方位| < asin(r/x) 挨得着,x ≤ r 时整圈。
 * 8 片与蒙特卡洛精确积分差 < 0.006(x=0 → 1、x=r → 0.354、x=2r → 0.149);编辑器预览
 * light_env_visual._omni 同式,对账测试钉着这几个值。
 */
const int OMNI_SLICES = 8;
float capsuleOmni(float x, float r, float top) {
    float pm = x > r ? asin(r / x) : PI;
    float dphi = 2.0 * pm / float(OMNI_SLICES);
    float acc = 0.0;
    for (int i = 0; i < OMNI_SLICES; i++) {
        float phi = -pm + (float(i) + 0.5) * dphi;
        float m = x * cos(phi);
        float p = x * sin(phi);
        float w2 = r * r - p * p;
        if (w2 > 0.0) {
            float w = sqrt(w2);
            float lo = max(0.0, atan(r, m) - asin(min(1.0, w / length(vec2(m, r)))));
            float hi = m - w <= 0.0 ? 0.5 * PI : min(0.5 * PI, atan(top, m) + asin(min(1.0, w / length(vec2(m, top)))));
            if (hi > lo) {
                float sh = sin(hi);
                float sl = sin(lo);
                acc += 0.5 * (sh * sh - sl * sl);
            }
        }
    }
    return acc * dphi / PI;
}

/**
 * 射线 ro + rd·t 上 t 处这一点对胶囊(线段 ca→ca+ba,半径 r)的锥形软遮挡 0..1,含沿射线的淡出。
 * 这一点离胶囊表面 d、离地面点 t:d/t 就是它偏离光锥中心线的角度(k = 0.5/tan 锥角)。
 */
float capsuleOccAt(vec3 ro, vec3 rd, vec3 ca, vec3 ba, float baba, float r, float k, float reach, float t) {
    t = max(t, 1e-4);
    vec3 q = ro + rd * t;
    float h = clamp(dot(q - ca, ba) / baba, 0.0, 1.0);
    float d = length(q - ca - ba * h) - r;
    float s = clamp(k * d / t + 0.5, 0.0, 1.0);
    float f = t / reach;
    return (1.0 - s * s * (3.0 - 2.0 * s)) * exp(-f * f);
}

/**
 * 胶囊锥形软阴影(方向部分)= 射线上几个样本点的遮挡取最大(每个都是真实的一点,只会逼近真值、不会多算)。
 * 1. 射线与胶囊轴两直线的最近点:影子主体由它给,轴上最近点落在线段内时与原 Quilez 胶囊软阴影同值。
 *    光与轴近乎平行时这一解病态,跳过。
 * 2. 射线正对胶囊底、腰、顶的三点:光近乎头顶时,锥形半影其实由胶囊顶给(遮挡角 ≈ 离轴距离 / 身高);
 *    只算第 1 点时只有恰好在顶部高度掠过的一条窄带拿得到半影,脚下画出一条横线
 *    (2026-09-24 真机:仰角 84°~89° 时一条宽几 px、长约一个身高的暗线)。
 */
float capsuleDirOcc(vec3 ro, vec3 rd, vec3 ca, vec3 cb, float r, float k, float reach) {
    vec3 ba = cb - ca;
    float baba = max(dot(ba, ba), 1e-6);
    float dba = dot(rd, ba);
    float den = baba - dba * dba;
    float occ = 0.0;
    if (den > 1e-4 * baba) {
        vec3 oa = ro - ca;
        float t0 = (-dot(oa, rd) * baba + dba * dot(oa, ba)) / den;
        occ = capsuleOccAt(ro, rd, ca, ba, baba, r, k, reach, t0);
    }
    occ = max(occ, capsuleOccAt(ro, rd, ca, ba, baba, r, k, reach, dot(ca - ro, rd)));
    occ = max(occ, capsuleOccAt(ro, rd, ca, ba, baba, r, k, reach, dot(ca + 0.5 * ba - ro, rd)));
    occ = max(occ, capsuleOccAt(ro, rd, ca, ba, baba, r, k, reach, dot(cb - ro, rd)));
    return occ;
}

const float MIN_EL = ${((CONTACT_AO_MIN_ELEVATION_DEG * Math.PI) / 180).toFixed(6)};

/** 指向光的向量 → 单位向量,仰角只钳下限(与 contactAoSources.clampAoElevation 同式,正上方原样)。 */
vec3 aoLightDir(vec3 v) {
    float hn = length(v.xz);
    if (hn < 1e-6) return vec3(0.0, 1.0, 0.0);
    float el = max(MIN_EL, atan(v.y, hn));
    return vec3(v.x / hn * cos(el), sin(el), v.z / hn * cos(el));
}

/** 一路光对地面点 P 的方向遮挡:灯位型逐像素朝灯(站在灯下走过去影子逐像素跟着转),方向型用定向。 */
float sourceOcc(vec3 P, float sx, float sy, float sz, float isPoint, vec3 ca, vec3 cb, float reach) {
    vec3 v = isPoint > 0.5 ? vec3(sx, sy, sz) - P : vec3(sx, sy, sz);
    return capsuleDirOcc(P, aoLightDir(v), ca, cb, uRadiusWu, uConeK, reach);
}

void main(void) {
    // 这个像素看到的不是地面(墙、桶、屋顶挡在该处地面点前面)⇒ 地上的 AO 被挡住,淡掉。
    // 判据与 cast 的前景遮挡同一个(场景深度 vs 行走面深度,留容差,见 entity-lighting「深度自比较」);
    // 从容差开始、再近 uGroundFeather 才完全不画——一刀切在深度图画宽了的细遮挡物(灯杆)旁挖一圈硬边。
    // 2026-09-24 实测:不判的话队伍身后的木桶、墙面、前景瓦面都被压暗。
    float onGround = 1.0;
    if (uHasDepth > 0.5) {
        vec2 dUV = vec2(vWorld.x / max(uSceneSize.x, 1e-3), vWorld.y / max(uSceneSize.y, 1e-3));
        if (dUV.x >= 0.0 && dUV.x <= 1.0 && dUV.y >= 0.0 && dUV.y <= 1.0) {
            vec4 ds = texture(uDepthMap, dUV);
            float rawD = (ds.r * 255.0 * 256.0 + ds.g * 255.0) / 65535.0;
            float dRaw = uInvert > 0.5 ? 1.0 - rawD : rawD;
            float sceneDepth = dRaw * uScale + uOffset;
            float nearer = groundDepthAt(vWorld) + uFloorOffset - sceneDepth;   // >0:场景比地面近
            onGround = 1.0 - smoothstep(uTolerance, uTolerance + max(uGroundFeather, 1e-4), nearer);
            if (onGround < 0.003) { discard; }
        }
    }

    vec3 P = groundWorldWu(vWorld);
    vec3 F = groundWorldWu(vec2(uFootX + uAxisOffX, uFootY));
    vec3 away = normalize(vec3(uM_R01, 0.0, uM_R21));   // 地面上"远离镜头"的水平方向
    vec3 base = F + away * uRadiusWu;

    float x = length(P.xz - base.xz);
    float he = uHeightWu * uNearField;
    float omni = capsuleOmni(x, uRadiusWu, max(he, uRadiusWu));

    // 有方向部分:每一路光各投各的胶囊软影,按它占地面照度的比例加权(权重和 ≤ 1)
    float dirOcc = 0.0;
    if (uS0W + uS1W + uS2W + uS3W > 0.0) {
        vec3 ca = base + vec3(0.0, uRadiusWu, 0.0);
        vec3 cb = base + vec3(0.0, max(uHeightWu - uRadiusWu, uRadiusWu * 1.01), 0.0);
        float reach = max(uHeightWu * uDirReach, 1e-3);
        if (uS0W > 0.0) dirOcc += uS0W * sourceOcc(P, uS0X, uS0Y, uS0Z, uS0P, ca, cb, reach);
        if (uS1W > 0.0) dirOcc += uS1W * sourceOcc(P, uS1X, uS1Y, uS1Z, uS1P, ca, cb, reach);
        if (uS2W > 0.0) dirOcc += uS2W * sourceOcc(P, uS2X, uS2Y, uS2Z, uS2P, ca, cb, reach);
        if (uS3W > 0.0) dirOcc += uS3W * sourceOcc(P, uS3X, uS3Y, uS3Z, uS3P, ca, cb, reach);
        dirOcc *= uDirWeight;
    }

    float alpha = onGround * uDarkness * (1.0 - (1.0 - omni) * (1.0 - dirOcc));
    if (alpha < 0.003) { discard; }
    finalColor = vec4(uShadowColor, alpha);
}
`;

/** 方向 AO 几路光的 uniform 名（uS0X … uS3P），与 CONTACT_FRAG 同序。 */
const SOURCE_KEYS = Array.from({ length: MAX_CONTACT_AO_SOURCES }, (_, i) =>
  (['X', 'Y', 'Z', 'W', 'P'] as const).map((c) => `uS${i}${c}`));

function sourceUniformDefaults(): Record<string, ReturnType<typeof f32>> {
  const out: Record<string, ReturnType<typeof f32>> = {};
  for (const keys of SOURCE_KEYS) for (const k of keys) out[k] = f32(0);
  return out;
}

function makeContactShader(ctx: ShadowSceneContext | null): Shader {
  return Shader.from({
    gl: { vertex: VERT, fragment: CONTACT_FRAG },
    resources: {
      // 组名与 cast 相同:setU / setShadowColor 按这个名字找
      shadowUniforms: {
        uDarkness: f32(0.75),
        uShadowColor: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },
        uFootX: f32(0),
        uFootY: f32(0),
        uAxisOffX: f32(0),
        uRadiusWu: f32(1),
        uHeightWu: f32(1),
        // 以下四个逐实体由 updateContact 写(作者参数 contactAo,缺省见 contactAo.ts)
        uNearField: f32(CONTACT_AO_SPREAD_DEFAULT),
        uConeK: f32(coneKFromDeg(CONTACT_AO_DIR_CONE_DEG_DEFAULT)),
        uDirReach: f32(CONTACT_AO_DIR_LENGTH_DEFAULT),
        uDirWeight: f32(CONTACT_AO_DIR_STRENGTH_DEFAULT),
        uGroundFeather: f32(CONTACT_GROUND_FEATHER),
        ...sourceUniformDefaults(),
        uInvert: f32(ctx?.invert ?? 0),
        uScale: f32(ctx?.scale ?? 1),
        uOffset: f32(ctx?.offset ?? 0),
        uFloorOffset: f32(ctx?.floorOffset ?? 0),
        uTolerance: f32(ctx?.tolerance ?? 0),
        uHasDepth: f32(ctx?.groundTexture && ctx?.depthTexture ? 1 : 0),
        uWuPerQ: f32(1),
        uGroundMin: f32(ctx?.groundMin ?? 0),
        uGroundMax: f32(ctx?.groundMax ?? 1),
        uGroundW: f32(ctx?.groundTexture?.pixelWidth ?? 1),
        uGroundH: f32(ctx?.groundTexture?.pixelHeight ?? 1),
        uHasGroundTex: f32(ctx?.groundTexture ? 1 : 0),
        uSceneSize: { value: new Float32Array([ctx?.sceneW ?? 1, ctx?.sceneH ?? 1]), type: 'vec2<f32>' },
        uW2pX: f32(ctx?.worldToPixelX ?? 1),
        uW2pY: f32(ctx?.worldToPixelY ?? 1),
        uM_ppu: f32(ctx?.ppu ?? 1),
        uM_cx: f32(ctx?.cx ?? 0),
        uM_cy: f32(ctx?.cy ?? 0),
        uM_R00: f32(ctx?.r00 ?? 1), uM_R01: f32(ctx?.r01 ?? 0), uM_R02: f32(ctx?.r02 ?? 0),
        uM_R10: f32(ctx?.r10 ?? 0), uM_R11: f32(ctx?.r11 ?? 1), uM_R12: f32(ctx?.r12 ?? 0),
        uM_R20: f32(ctx?.r20 ?? 0), uM_R21: f32(ctx?.r21 ?? 0), uM_R22: f32(ctx?.r22 ?? 1),
      },
      uGroundD: ctx?.groundTexture ?? Texture.WHITE.source,
      uDepthMap: ctx?.depthTexture?.source ?? Texture.WHITE.source,
    },
  });
}

/** 用 context 构建 cast(投影剪影)shader。接触阴影另走 makeContactShader。 */
function makePlanarShader(ctx: ShadowSceneContext | null, texSource: TextureSource): Shader {
  const on = !!ctx;
  return Shader.from({
    gl: { vertex: VERT, fragment: FRAG },
    resources: {
      shadowUniforms: {
        uDarkness: f32(0.4),
        uShadowColor: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },
        uColEnabled: f32(on && ctx!.collisionTexture ? 1 : 0),
        uOccEnabled: f32(on ? 1 : 0),
        uShearX: f32(0),
        uShearY: f32(1),
        uHalfW: f32(1),
        uSpreadTop: f32(1),
        uTipFadeStart: f32(TIP_FADE_START),
        uTipAlpha: f32(TIP_ALPHA),
        uPenGrow: f32(PENUMBRA_GROW),
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
 *
 * cast 的 quad 是**梯形**(2026-08-22 起):底边=脚点半宽×迎光截面系数,头端再乘散开系数。
 * 恒等形状(spread=1, widthScale=1)退化回原来的平行四边形,没绑灯的实体走的就是这条。
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
    this.castShader = makePlanarShader(this.ctx, Texture.WHITE.source);
    this.castMesh = new Mesh({ geometry: this.castGeometry, shader: this.castShader, texture: Texture.WHITE }) as Mesh;
    this.castMesh.visible = false;
    layer.addChild(this.castMesh);

    this.contactPositions = new Float32Array(8);
    const contactUVs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    this.contactGeometry = new MeshGeometry({ positions: this.contactPositions, uvs: contactUVs, indices: quadIdx() });
    // 接触阴影 = 胶囊 AO(见 CONTACT_FRAG):不读剪影贴图,胶囊半径由 bodyFootprintOf 在 CPU 上按角色(站立片段)算好;不做碰撞/遮挡
    this.contactShader = makeContactShader(this.ctx);
    this.contactMesh = new Mesh({ geometry: this.contactGeometry, shader: this.contactShader, texture: Texture.WHITE }) as Mesh;
    this.contactMesh.visible = false;
    layer.addChild(this.contactMesh);
  }

  update(
    src: ShadowSource,
    env: ResolvedLightEnv,
    field?: ShadowProjectionField | null,
    shape?: ShadowShapeParams | null,
    contactAo?: ContactAoParams | null,
  ): void {
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

    this.contactMesh.visible = this.updateContact(src, env, tex, fx, fy, w, H, contactAo ?? null);

    const source = tex.source;
    if (source !== this.boundSource) {
      (this.castShader.resources as Record<string, unknown>)['uTexture'] = source;
      this.castMesh.texture = tex;
      this.boundSource = source;
    }

    const fr = tex.frame;
    const sw = source.width || 1;
    const sh = source.height || 1;
    let u0 = fr.x / sw;
    let u1 = (fr.x + fr.width) / sw;
    if (src.getFacing() < 0) { const t = u0; u0 = u1; u1 = t; }
    const vTop = fr.y / sh;
    const vBot = (fr.y + fr.height) / sh;

    // cast 平面投影 quad
    if (env.shadow.darkness <= 0) {
      this.castMesh.visible = false;
      return;
    }
    this.castMesh.visible = true;

    const proj = field
      ? field.sample(fx, fy)
      : { angleRad: (env.key.azimuthDeg + 180) * DEG2RAD, length: env.shadow.length };
    // 形状:绑定路径解得出迎光截面与散开;没绑定就是恒等(存量场景的 quad 逐像素不变)
    const shp = shape ?? IDENTITY_SHADOW_SHAPE;
    const spread = Number.isFinite(shp.spread) ? Math.max(0.2, shp.spread) : 1;
    const widthScale = Number.isFinite(shp.widthScale) ? Math.max(0.05, shp.widthScale) : 1;
    const hw = Math.max(0.5, w * 0.5 * widthScale);
    const hwTop = hw * spread;
    const reach = H * proj.length;
    const offX = Math.cos(proj.angleRad) * reach;
    const offY = Math.sin(proj.angleRad) * reach;

    // 梯形:头端半宽 = hwTop(点光散开)。凸,两三角形拆分无歧义;(s,t) 在片元里解析反解,
    // 与顶点插值无关,所以拆法不影响采样。
    const p = this.castPositions;
    p[0] = fx - hw;           p[1] = fy;          // BL 脚
    p[2] = fx + hw;           p[3] = fy;          // BR 脚
    p[4] = fx + hwTop + offX; p[5] = fy + offY;   // TR 头
    p[6] = fx - hwTop + offX; p[7] = fy + offY;   // TL 头
    this.castGeometry.getBuffer('aPosition').update();

    setU(this.castShader, 'uDarkness', Math.max(0, Math.min(1, env.shadow.darkness)));
    setU(this.castShader, 'uFootX', fx);
    setU(this.castShader, 'uFootY', fy);
    // 剪影 UV 走片元反解;顶点 aUV 缓冲逐帧 update 在 GPU 端不生效
    setU(this.castShader, 'uShearX', offX);
    setU(this.castShader, 'uShearY', offY);
    setU(this.castShader, 'uHalfW', hw);
    setU(this.castShader, 'uSpreadTop', spread);
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

  /**
   * 胶囊 AO 这一帧的几何与 uniform(见 CONTACT_FRAG)。返回 contactMesh 该不该可见。
   *
   * 尺度全部换到 M-world wu(铁律 0):贴地那一截半宽 → 胶囊半径,帧高 → 胶囊高。
   * quad 只是个覆盖范围:无方向部分到 2×近场高 + 半径就不到 1%;有方向部分沿影子方向再伸出去。
   */
  private updateContact(
    src: ShadowSource,
    env: ResolvedLightEnv,
    tex: Texture,
    fx: number,
    fy: number,
    w: number,
    H: number,
    ao: ContactAoParams | null,
  ): boolean {
    const ctx = this.ctx;
    // 作者参数:没传(非主实例的调用方)就按场景光环境解一份缺省(简单 AO)
    const p = ao?.ao ?? resolveContactAo(null, env.shadow);
    if (!ctx || !p.enabled || p.darkness <= 0 || p.size <= 0) return false;
    const fp = footprintOf(tex, CONTACT_BAND, CONTACT_SEARCH);
    if (fp === null) return false;                       // 这一帧底部没东西挨地
    // 胶囊宽度 / 中心按角色定(站立片段的中位数),不跟走 / 跑每帧的步幅变——按当前帧量时一跳一跳
    // (制作人 2026-09-25 真机)。定不下来(没有参照帧 / 像素还没到)才按当前帧;
    // 当前帧也是 undefined = 读不到像素,footprintOf 已出声,退回整帧宽
    const refs = src.getBodyReferenceFrames?.() ?? [];
    const body = bodyFootprintOf(refs, CONTACT_BAND, CONTACT_SEARCH);
    const ext = mirrorFootprint(body ?? fp ?? { lo: 0, hi: 1 }, src.getFacing() < 0);

    const wpq = ao && ao.wuPerQUnit > 0 ? ao.wuPerQUnit : 1;
    const { ppu, worldToPixelX: w2px, worldToPixelY: w2py } = ctx;
    // 场景 px → q:水平方向按世界 X 投屏的长度,竖直方向按世界竖直投屏的长度
    const qPerSceneX = w2px / (ppu * Math.max(Math.hypot(ctx.r00, ctx.r01), 1e-6));
    const qPerSceneUp = w2py / (ppu * Math.max(Math.hypot(ctx.r10, ctx.r11), 1e-6));
    const radiusWu = Math.max(1e-3, 0.5 * (ext.hi - ext.lo) * w * qPerSceneX * wpq * p.size);
    const heightWu = Math.max(radiusWu * 2, H * qPerSceneUp * wpq);
    const axisOffX = ((ext.lo + ext.hi) * 0.5 - 0.5) * w;

    // 覆盖范围:世界里的几个点投回场景 px(world → q = Rᵀ·w,屏幕 y 向下)
    const toScene = (dx: number, dz: number): [number, number] => {
      const qx = (ctx.r00 * dx + ctx.r20 * dz) / wpq;
      const qy = (ctx.r01 * dx + ctx.r21 * dz) / wpq;
      return [(qx * ppu) / w2px, (-qy * ppu) / w2py];
    };
    let reach = 2 * heightWu * p.spread + 2 * radiusWu;
    const centers: [number, number][] = [[0, radiusWu]];
    const sources = p.directional && ao ? ao.sources.slice(0, MAX_CONTACT_AO_SOURCES) : [];
    for (const s of sources) {
      const L = s.footDir;
      // 方向部分的锥形半影往两侧摊 0.5·t/k(t 最远到胶囊顶或淡出长度的两倍,e⁻⁴ ≈ 2%):
      // 覆盖不到就在片子边上切出一道直边——锥角调大、或光近头顶时半影绕着脚铺开一圈都会碰到。
      const tMax = Math.min(2 * heightWu * p.dirLength, heightWu / Math.max(L[1], 0.3) + radiusWu);
      reach = Math.max(reach, radiusWu + Math.min(4 * heightWu, (0.5 * tMax) / Math.max(p.coneK, 1e-3)));
      const hl = Math.hypot(L[0], L[2]);
      if (hl > 1e-6) {
        // 影子沿光的水平反方向;长度取"照到胶囊顶"与"淡出长度的两倍"里短的那个。
        // 灯位型逐像素朝灯,这里用脚点看过去的方向估覆盖范围,差的那点由 reach 兜住
        const len = Math.min(heightWu * (hl / Math.max(L[1], 1e-3)), 2 * heightWu * p.dirLength);
        centers.push([-(L[0] / hl) * len, radiusWu - (L[2] / hl) * len]);
      }
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [cx, cz] of centers) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const [px, py] = toScene(cx + sx * reach, cz + sz * reach);
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
      }
    }
    const ox = fx + axisOffX;
    const cp = this.contactPositions;
    cp[0] = ox + minX; cp[1] = fy + minY;
    cp[2] = ox + maxX; cp[3] = fy + minY;
    cp[4] = ox + maxX; cp[5] = fy + maxY;
    cp[6] = ox + minX; cp[7] = fy + maxY;
    this.contactGeometry.getBuffer('aPosition').update();

    const sh = this.contactShader;
    setU(sh, 'uDarkness', p.darkness);
    setU(sh, 'uNearField', p.spread);
    setU(sh, 'uConeK', p.coneK);
    setU(sh, 'uDirReach', p.dirLength);
    setU(sh, 'uDirWeight', p.dirStrength);
    setU(sh, 'uFootX', fx);
    setU(sh, 'uFootY', fy);
    setU(sh, 'uAxisOffX', axisOffX);
    setU(sh, 'uRadiusWu', radiusWu);
    setU(sh, 'uHeightWu', heightWu);
    setU(sh, 'uWuPerQ', wpq);
    for (let i = 0; i < SOURCE_KEYS.length; i++) {
      const s = sources[i];
      const [kx, ky, kz, kw, kp] = SOURCE_KEYS[i];
      setU(sh, kw, s ? Math.max(0, s.weight) : 0);
      if (!s) continue;
      setU(sh, kx, s.x);
      setU(sh, ky, s.y);
      setU(sh, kz, s.z);
      setU(sh, kp, s.point ? 1 : 0);
    }
    return true;
  }

  /** 深度调参广播：cast 的碰撞/前景遮挡，与接触阴影的"看到的是不是地面"判据共用容差与地面偏移 */
  setDepthParams(tolerance: number, floorOffset: number, occlusionBlendFactor: number): void {
    setU(this.castShader, 'uTolerance', tolerance);
    setU(this.castShader, 'uFloorOffset', floorOffset);
    setU(this.castShader, 'uOccBlend', occlusionBlendFactor);
    // 接触阴影(胶囊 AO)用同一个"这像素看到的是不是地面"判据,容差 / 地面偏移跟着走
    setU(this.contactShader, 'uTolerance', tolerance);
    setU(this.contactShader, 'uFloorOffset', floorOffset);
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
