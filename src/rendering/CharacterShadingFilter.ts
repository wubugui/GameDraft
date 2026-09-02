import { Filter, GlProgram, Texture, type TextureSource } from 'pixi.js';
// 角色着色核心 GLSL 的唯一真相源(与灯光实验室共用同一份,消灭 shader 镜像漂移)。
import CHAR_SHADE_CORE from './charShadeCore.glsl?raw';
import type { SceneDepthConfig } from '../data/types';
import type { IEntityShadingFilter } from './EntityLightingFilter';

/**
 * 角色物理着色滤镜:character_lighting_lab 查看器 CHAR_FS 的逐像素移植。
 * 假设 sprite 颜色 = albedo,最终色 = srgb2lin(albedo) × E / π × β × 增益。
 * E 来源四模式:0=实时RT gather(A7折叠+miss策略+NEE解析直射),1/2/3=L1/L2/BIN probe
 * 图集三线性(base+cov|amb|emit|nee 四分账,与实验室烘焙同源)。
 *
 * 与实验室的三处刻意差异(非算法差异):
 * 1. 遮挡沿用游戏 depthConfig 契约(P2a 已与实验室深度同源,billboard 语义一致);
 * 2. 法线不用贴图:spriteNormalAtlas 运行时按实验室 stage_character 同数学现算;
 * 3. 体素卷 sampler3D → Z 切片平铺 2D 图集 + 手写三线性(数学等价,Pixi 无 3D 纹理)。
 * 实验室接触阴影不进游戏(用户拍板);游戏自有接触 AO / 投影阴影保留。
 */

const VERT = /* glsl */ `#version 300 es
in vec2 aPosition;
out vec2 vTextureCoord;
out vec2 vScreenPos;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(void) {
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
    vScreenPos = aPosition * uOutputFrame.zw + uOutputFrame.xy;
}
`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vTextureCoord;
in vec2 vScreenPos;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uDepthMap;
uniform sampler2D uNrm;
uniform sampler2D uPL1;
uniform sampler2D uPL2;
uniform sampler2D uPBin;
uniform sampler2D uValid;
uniform sampler2D uVolRad;
// skyao probe 的 sampler:与 uPL1/uPL2 同约定,由各宿主自己声明
uniform sampler2D uSkyaoTex;
uniform sampler2D uVolEmit;

// ---- 场景/相机(SceneDepthSystem 逐帧驱动) ----
uniform vec2  uSceneSize;
uniform float uProjectionScale;
uniform float uWorldToPixelX;
uniform float uWorldToPixelY;
uniform vec2  uWorldContainerPos;
uniform float uEntityFootWorldX;
uniform float uEntityFootWorldY;

// ---- 遮挡(与 DepthOcclusionFilter 同契约) ----
uniform float uDepthEnabled;
uniform float uInvert;
uniform float uScale;
uniform float uOffset;
uniform float uDepthPerSy;
uniform float uFloorOffset;
uniform float uFloorOffsetExtra;
uniform float uTolerance;
uniform float uOcclusionBlendFactor;
uniform float uHasFootDepth;   // 0=本帧没拿到脚深度 → 整段遮挡跳过
uniform float uFootBias;       // 实验室 0.045
uniform float uDebug;

// ---- 角色 quad(逐帧驱动;**filter 专用**——mesh 路径的 UV/翻转/脚点全部来自几何,无此依赖) ----
uniform vec3  uFootQ;
uniform float uCharH;            // 直立 quad 高(wu)
uniform float uCharW;
uniform vec4  uNrmRect;          // 法线图集内当前帧 uv rect(x,y,w,h)
uniform float uFlipX;
uniform vec4 uSpriteWorldRect;
uniform float uHasNrm;

//__CLC_BEGIN__
// ---- 标定/伪世界(实验室 manifest 同源) ----
uniform vec2  uWorkSize;         // 载荷工作分辨率
uniform vec2  uWorldToWork;      // 场景世界坐标 → work px
uniform vec4  uCal;              // ppu, _, cx, cy(work px)
uniform float uCosT;
uniform float uSinT;
uniform vec3  uQMin;
uniform vec3  uQMax;
uniform vec3  uVolN;             // 体素维度(float)
uniform vec2  uVolTiles;         // Z 切片平铺列数/行数
uniform vec4  uLightQ[48];       // q 位置 + 面积
uniform vec4  uLightE[48];       // 发光辐射 rgb
uniform float uLightCount;

// ---- 照明参数(F2 全量可调,与实验室同名同义) ----
uniform float uSpp;
uniform float uMSteps;
uniform float uMissMode;         // 0=miss→J̄×强度 1=miss不计入(renormalize)
uniform float uNEE;
uniform float uStep;
uniform float uBeta;             // 曝光 2^β(CPU 端已 pow;角色曝光唯一旋钮)
uniform float uGiStrength;       // GI 底光增益:只乘 probe/RT 的 E(β 乘一切,这个只管 GI 多强)
uniform float uFixedNQ;          // 诊断·定法线:0=正常 1=强制世界水平朝相机 2=强制世界向上(只改查表方向)
uniform float uEChecker;         // 诊断:纯E 视图叠 probe 棋盘(与场景 uDebug==9 同一套 cell 奇偶)
uniform float uBulge;
uniform float uFlatten;
uniform float uShowN;
uniform float uEOnly;            // 「GI体·纯E」调试:1=albedo≡1,输出 E×2^β(F2 的 8/9 档)

// ---- 太阳(独立解析直射,方位与投影阴影解耦) ----
uniform float uSunOn;
uniform vec3  uSunDirQ;          // q 空间指向光源方向
uniform vec3  uSunColor;         // 颜色×强度

// ---- E 明暗/色度权重(F2 测试旋钮):0=只借场景明暗(luma)、角色保留自己颜色;1=完整彩色 E ----
uniform float uEChroma;

// ---- 保留的游戏侧 sprite AO ----
uniform float uAOContact;
uniform float uAOForm;

vec3 srgb2lin(vec3 c){ return mix(c/12.92, pow((c+.055)/1.055, vec3(2.4)), step(.04045,c)); }
vec3 lin2srgb(vec3 c){ c=max(c,0.); return mix(c*12.92, 1.055*pow(c,vec3(1./2.4))-.055, step(.0031308,c)); }
${CHAR_SHADE_CORE}
//__PROBE_SAMPLING_BEGIN__
// probe 采样自足块(shY/ambIrr/octaEnc/probeE + 它们的 uniform)。
// 场景光照 pass 的「GI体」调试视图拼接**同一份**(SceneLightingPass),
// 与角色吃同一套采样数学——改这里 = 两边同时改。sampler(uPL1/uPL2/uPBin/uValid)
// 由各宿主 shader 自己声明,与本仓库其余共用块同一约定。
uniform mat3  uM;                // q -> world
uniform vec3  uWMin;
uniform vec3  uWScale;
uniform vec3  uPN;               // probe 网格维度(float)
uniform float uProbeT;           // probe 图集平铺:每行多少颗(P>8192 行时 GPU 纹理高度爆上限)
uniform float uShK;              // 'l2' 图集每颗的球谐系数数:9(L2)/25(L4),来自 lighting.json probes.sh_k
uniform float uBinOb;            // 八面体边长:8(64 方向)/16(256 方向),来自 lighting.json probes.bin_ob
uniform float uFold;             // A7 摄像机侧折叠(RT 逐射线折;probe 折查询法线,见 probeQueryN)
// ---- skyao probe(天穹遮蔽,乘在 GI 上)。sampler 由宿主声明,其余在这 ----
uniform vec3  uSkyaoN;        // 网格 (nx,ny,nz)
uniform vec2  uSkyaoTiles;    // Z 切片平铺 (tiles_x, tiles_y)
uniform vec3  uSkyaoMin;      // 世界 AABB 下角(det=+1 世界系)
uniform vec3  uSkyaoScale;    // 1/(AABB 尺寸)
uniform mat3  uSkyaoM;        // q -> 世界,**depthConfig 的 det=+1**,不是 uM
uniform float uSkyaoOn;       // 0=没有载荷,恒不遮蔽
uniform float uSkyaoBlend;    // 与全白 blend:0=全白(不遮蔽) 1=完整遮蔽
uniform vec3  uAmbSH[9];
uniform float uMode;             // 0=RT 1=L1 2=L2 3=BIN
uniform float uAmbStrength;      // miss 强度(J̄ 系数)
// 实球谐基 l<=4(k=0..24),与 estimators.sh_basis 逐行同值同序(改一处必须改两处;
// python 侧有 Gram 矩阵测试钉常数)。L4 的由来:贴壳 probe 99% 能量在下半球,
// 朝上真值只占 0.6~1.8%,L2 在这个谷底只给 0.30(0~0.80),L4 0.79,L6 0.92。
float shY(int k, vec3 n){
  if(k==0) return .282095;
  if(k==1) return .488603*n.y;  if(k==2) return .488603*n.z;  if(k==3) return .488603*n.x;
  if(k==4) return 1.092548*n.x*n.y; if(k==5) return 1.092548*n.y*n.z;
  if(k==6) return .315392*(3.*n.z*n.z-1.);
  if(k==7) return 1.092548*n.x*n.z; if(k==8) return .546274*(n.x*n.x-n.y*n.y);
  float x2=n.x*n.x, y2=n.y*n.y, z2=n.z*n.z;
  if(k==9)  return .590044*n.y*(3.*x2-y2);
  if(k==10) return 2.890611*n.x*n.y*n.z;
  if(k==11) return .457046*n.y*(5.*z2-1.);
  if(k==12) return .373176*n.z*(5.*z2-3.);
  if(k==13) return .457046*n.x*(5.*z2-1.);
  if(k==14) return 1.445306*n.z*(x2-y2);
  if(k==15) return .590044*n.x*(x2-3.*y2);
  if(k==16) return 2.503343*n.x*n.y*(x2-y2);
  if(k==17) return 1.770131*n.y*n.z*(3.*x2-y2);
  if(k==18) return .946175*n.x*n.y*(7.*z2-1.);
  if(k==19) return .669047*n.y*n.z*(7.*z2-3.);
  if(k==20) return .105786*(35.*z2*z2-30.*z2+3.);
  if(k==21) return .669047*n.x*n.z*(7.*z2-3.);
  if(k==22) return .473087*(x2-y2)*(7.*z2-1.);
  if(k==23) return 1.770131*n.x*n.z*(x2-3.*y2);
  return .625836*(x2*x2-6.*x2*y2+y2*y2);
}
vec3 ambIrr(vec3 n){
  float A[9]=float[9](3.141593,2.094395,2.094395,2.094395,.785398,.785398,.785398,.785398,.785398);
  vec3 E=vec3(0.);
  for(int k=0;k<9;k++) E+=uAmbSH[k]*A[k]*shY(k,n);
  return max(E,0.)*uAmbStrength;
}
// 八面体图的接缝环绕:越过边的 texel = 该边内侧沿边镜像的 texel(先 x 后 y,角落落到对角)。
// ⚠ 缺这一步就会把边界抽头 clamp 到内部、取到球面上无关的方向:地板法线在 q 空间
// 正好压在接缝上(n.x≈0、n.z<0),0.3° 抖动就让取值跳 1.77x(破屋平地板硬边斑驳,
// 2026-09-02)。与 estimators.octa_wrap 同一套规则,改一处必须改两处。
int octaIdx(ivec2 c, int ob){
  if(c.x<0){ c.x=0; c.y=ob-1-c.y; } else if(c.x>ob-1){ c.x=ob-1; c.y=ob-1-c.y; }
  if(c.y<0){ c.y=0; c.x=ob-1-c.x; } else if(c.y>ob-1){ c.y=ob-1; c.x=ob-1-c.x; }
  return c.y*ob+c.x;
}
vec2 octaEnc(vec3 n){
  n/=(abs(n.x)+abs(n.y)+abs(n.z));
  vec2 p=n.xy;
  if(n.z<0.) p=(1.-abs(n.yx))*vec2(n.x>=0.?1.:-1., n.y>=0.?1.:-1.);
  return p*.5+.5;
}
// q → probe 网格连续坐标。单独立名是为了调试视图(SceneLightingPass uDebug==9 的
// 棋盘格)能用**与采样一模一样**的映射画出 cell 结构 —— 复制一份迟早漂。
vec3 probeGridT(vec3 q){
  vec3 Xw = uM * q;                              // → 世界,插值轴为世界轴
  return clamp((Xw-uWMin)*uWScale, vec3(0.), uPN-1.001);
}
// flat probe 索引 → 平铺图集 texel。图集每行放 uProbeT 颗 probe(每颗 ncol 个 texel);
// 老布局「x=系数,y=probe」在 P=11.9 万颗时高度直接超 GPU 上限(16384),采样静默全黑
// (2026-09-01 撞上:盘上 E 正常、实机角色漆黑,无任何报错)。valid 图同一套(ncol=1)。
ivec2 probeTexel(int flat_, int ncol, int k){
  int T = int(uProbeT + .5);
  int r = flat_ / T;
  return ivec2((flat_ - r*T)*ncol + k, r);
}
// 单颗 probe 的 E 重建(按 flat 索引)。probeE 的 8 角与最近邻视图共用这一份 ——
// v3 固化:probe 图集只存最终 E 的球谐(L1=4列/L2=9列/BIN=64方向),按法线重建即得该方向 E。
// nee/miss_mode/amb 已在导出时 compose 进 E,运行时不再读分账、不再组合(那些只 RT 用)。
// A7(摄像机侧折叠)的 probe 版。烘焙逃逸是黑:朝相机的射线立刻出画拿 0,
// E(朝相机) 被系统性饿死(实测雾津街头同一点 E(-z)=0.21 vs E(+z)=2.72,差 13x)——
// 而角色法线恰恰全朝相机、场景面全朝上/纵深 ⇒ 同一份 probe,场景亮角色黑。
// 假设与 RT 侧 A7 同一条:镜头背后的世界统计上镜像可见场景 ⇒ E(n) ≈ E(折叠 n)。
vec3 probeQueryN(vec3 n){
  if(uFold > .5 && n.z < 0.) n.z = -n.z;
  return normalize(n);
}
vec3 probeEvalFlat(int flat_, vec3 n){
  n = probeQueryN(n);
  int mode = int(uMode + .5);
  vec3 E=vec3(0.);
  if(mode==1){
    // L1 = Geomerics/Enlighten 非线性重建(Hazel;制作人 2026-09-02 定为正式档):
    // 逐通道 R0=c0·Y00(E 的 DC),R1=½·Y1·(c_x,c_y,c_z),q=½(1+R̂1·n),r=|R1|/R0,
    // p=1+2r,a=(1-r)/(1+r),E=R0·(a+(1-a)(p+1)q^p)。永不为负,无截负翻色。
    // ⚠ 与 estimators.probe_eval_l1_geomerics 逐行同一公式,改一处必须改两处。
    vec3 c0=texelFetch(uPL1, probeTexel(flat_,4,0),0).rgb;
    vec3 c1=texelFetch(uPL1, probeTexel(flat_,4,1),0).rgb;   // y
    vec3 c2=texelFetch(uPL1, probeTexel(flat_,4,2),0).rgb;   // z
    vec3 c3=texelFetch(uPL1, probeTexel(flat_,4,3),0).rgb;   // x
    for(int ch=0;ch<3;ch++){
      float R0=max(c0[ch]*.282095, 1e-12);
      vec3 R1=.5*.488603*vec3(c3[ch], c1[ch], c2[ch]);
      float lenR1=length(R1)+1e-12;
      float q=clamp(.5*(1.+dot(R1/lenR1, n)), 0., 1.);
      float r=min(lenR1/R0, .9999);
      float p=1.+2.*r;
      float a=(1.-r)/(1.+r);
      E[ch]=R0*(a+(1.-a)*(p+1.)*pow(q,p));
    }
    return E;
  } else if(mode==2){
    // 'l2' 槽的列数 = uShK(L2=9 / L4=25),循环上限动态(GLSL ES 3.0 允许 break)
    int K=int(uShK+.5);
    for(int k=0;k<25;k++){ if(k>=K) break; E+=texelFetch(uPL2, probeTexel(flat_,K,k),0).rgb*shY(k,n); }
  } else {
    // 八面体分辨率由载荷 probes.bin_ob 决定(8=64 方向 / 16=256 方向)
    int ob=int(uBinOb+.5), B=ob*ob;
    vec2 ouv=octaEnc(n)*float(ob)-.5;
    ivec2 ob0=ivec2(floor(ouv));                 // 可为 -1/ob-1,越界交给 octaIdx
    vec2 of=clamp(ouv-vec2(ob0),0.,1.);
    ivec2 b00=probeTexel(flat_,B,octaIdx(ob0+ivec2(0,0),ob));
    ivec2 b10=probeTexel(flat_,B,octaIdx(ob0+ivec2(1,0),ob));
    ivec2 b01=probeTexel(flat_,B,octaIdx(ob0+ivec2(0,1),ob));
    ivec2 b11=probeTexel(flat_,B,octaIdx(ob0+ivec2(1,1),ob));
    E=mix(mix(texelFetch(uPBin,b00,0).rgb,texelFetch(uPBin,b10,0).rgb,of.x),
          mix(texelFetch(uPBin,b01,0).rgb,texelFetch(uPBin,b11,0).rgb,of.x),of.y);
  }
  return max(E, vec3(0.));
}
vec3 probeE(vec3 q, vec3 n){
  // 查询点沿法线偏 0.525 x 最小格距(DDGI self-shadow bias 的 N 项,B=0.7):
  // 薄面两侧 probe 混投的漏光实测降 25~80%,亮度中位/p95 同步小降。q↔世界 M 正交,
  // 格距按 1/uWScale 现算即是 q 单位。⚠ 0.525 与 const.PROBE_QUERY_NORMAL_BIAS 同值。
  float cellMin = min(min(1./uWScale.x, 1./uWScale.y), 1./uWScale.z);
  vec3 t = probeGridT(q + n * (0.525 * cellMin));
  ivec3 b0=ivec3(t); vec3 f=t-vec3(b0);
  float wsum=0.;
  vec3 Esum=vec3(0.);
  ivec3 pn = ivec3(uPN + .5);
  for(int c=0;c<8;c++){
    ivec3 off=ivec3(c&1,(c>>1)&1,(c>>2)&1);
    ivec3 pi=min(b0+off,pn-1);
    float w=mix(1.-f.x,f.x,float(off.x))*mix(1.-f.y,f.y,float(off.y))*mix(1.-f.z,f.z,float(off.z));
    int flat_=pi.x*(pn.y*pn.z)+pi.y*pn.z+pi.z;
    w*=step(.002, texelFetch(uValid, probeTexel(flat_,1,0),0).r);
    if(w<1e-5) continue;
    Esum+=probeEvalFlat(flat_, n)*w; wsum+=w;
  }
  if(wsum<1e-4) return ambIrr(n);
  return Esum/wsum;
}
// 最近邻原始值(场景调试视图「无插值」档):每个像素显示离它最近那颗 probe 的原始 E。
// 把数据画在**采样它的表面上**,固定视角也能逐颗检查(把点阵投到屏幕会自遮挡,没法看);
// 与三线性档来回切 = 插值前后对照。网格映射/SH 与 probeE 逐字同一套,唯一区别是 round。
// invalid 的格子**刻意亮品红**:这是查数据的视图,坏格必须扎眼,不许悄悄回落环境光。
vec3 probeENearest(vec3 q, vec3 n){
  vec3 t = probeGridT(q);
  ivec3 pn = ivec3(uPN + .5);
  ivec3 pi = min(ivec3(t + .5), pn-1);
  int flat_ = pi.x*(pn.y*pn.z) + pi.y*pn.z + pi.z;
  if(texelFetch(uValid, probeTexel(flat_,1,0),0).r < .002) return vec3(1., 0., 1.);
  return probeEvalFlat(flat_, n);
}
//__PROBE_SAMPLING_END__

// ---- 体素卷:平铺 2D 图集上的手写三线性(≡ GL LINEAR + CLAMP_TO_EDGE 3D) ----
vec4 volTap(sampler2D t, float xi, float yi, float zi){
  float tx = mod(zi, uVolTiles.x), ty = floor(zi / uVolTiles.x);
  return texelFetch(t, ivec2(int(tx * uVolN.x + xi), int(ty * uVolN.y + yi)), 0);
}
vec4 sampleVol3(sampler2D t, vec3 c01){
  vec3 vp = c01 * uVolN - 0.5;
  vec3 v0 = floor(vp);
  vec3 f = clamp(vp - v0, 0.0, 1.0);
  float x0 = clamp(v0.x, 0.0, uVolN.x - 1.0), x1 = clamp(v0.x + 1.0, 0.0, uVolN.x - 1.0);
  float y0 = clamp(v0.y, 0.0, uVolN.y - 1.0), y1 = clamp(v0.y + 1.0, 0.0, uVolN.y - 1.0);
  float z0 = clamp(v0.z, 0.0, uVolN.z - 1.0), z1 = clamp(v0.z + 1.0, 0.0, uVolN.z - 1.0);
  vec4 c000 = volTap(t,x0,y0,z0), c100 = volTap(t,x1,y0,z0);
  vec4 c010 = volTap(t,x0,y1,z0), c110 = volTap(t,x1,y1,z0);
  vec4 c001 = volTap(t,x0,y0,z1), c101 = volTap(t,x1,y0,z1);
  vec4 c011 = volTap(t,x0,y1,z1), c111 = volTap(t,x1,y1,z1);
  vec4 a = mix(mix(c000,c100,f.x), mix(c010,c110,f.x), f.y);
  vec4 b = mix(mix(c001,c101,f.x), mix(c011,c111,f.x), f.y);
  return mix(a, b, f.z);
}

// ================================ skyao probe:天穹遮蔽,乘在 GI 上 =========
// 载荷 lighting/<背景基名>/skyao_probe.bin:遮蔽矩,按 Z 切片横向平铺的
// rgba16f 图集,RGBA = (a0, a1x, a1y, a1z)。烘焙侧见 scene_fields.bake_skyao_probe。
//
// ⚠⚠ **坐标系不是 uM**。矩是用场景 depthConfig.M.R(**det=+1**)烘的,而 uM
//    是 lighting.json.world.M(**det=-1** 实验室查表那套)。混用一律不报错,
//    只是 a1·N 的方向整个镜像 —— 所以这里单独走 uSkyaoM。
//    (CLAUDE.md 铁律:两个 M 不许混。)
//
// ⚠ **必须除 cap0**,与场景侧 skyvis.png 的口径**相反**:
//    · 场景侧 sDay = (1-hemi) + hemi*skyvis 那边没有独立的朝向项,所以
//      skyvis.png 存的是不除 cap0 的 T(N)(开阔竖直墙 = 0.5);
//    · 角色这边 probe 的球谐**已经带了方向性**,再乘一次朝向就是同一件事扣两遍。
//      所以要的是纯遮蔽系数 V ∈ [0,1]、**开阔处恒为 1(与朝向无关)**。
//__SKYAO_SAMPLING_BEGIN__
vec4 skyaoTap(float xi, float yi, float zi){
  float tx = mod(zi, uSkyaoTiles.x), ty = floor(zi / uSkyaoTiles.x);
  return texelFetch(uSkyaoTex, ivec2(int(tx * uSkyaoN.x + xi),
                                     int(ty * uSkyaoN.y + yi)), 0);
}
vec4 sampleSkyao(vec3 c01){
  // ⚠ 节点口径:烘焙格点是 linspace(x0,x1,n)(端点在盒边界,n-1 段),与 probeE/verify 同。
  //   这里曾抄了体素卷 sampleVol3 的格心口径(c01*N-0.5) —— 那是给格心体素用的,
  //   套在节点数据上=系统性偏移 (u-0.5) 格:盒中心为零、边缘半格(2026-09-01 制作人抓出)。
  vec3 vp = c01 * (uSkyaoN - 1.0);
  vec3 v0 = floor(vp);
  vec3 f = clamp(vp - v0, 0.0, 1.0);
  vec3 lo = clamp(v0, vec3(0.), uSkyaoN - 1.0);
  vec3 hi = clamp(v0 + 1.0, vec3(0.), uSkyaoN - 1.0);
  // 平铺图集手写三线性:硬件过滤会跨 Z 切片串色(与体素卷同一个坑)
  vec4 c000 = skyaoTap(lo.x,lo.y,lo.z), c100 = skyaoTap(hi.x,lo.y,lo.z);
  vec4 c010 = skyaoTap(lo.x,hi.y,lo.z), c110 = skyaoTap(hi.x,hi.y,lo.z);
  vec4 c001 = skyaoTap(lo.x,lo.y,hi.z), c101 = skyaoTap(hi.x,lo.y,hi.z);
  vec4 c011 = skyaoTap(lo.x,hi.y,hi.z), c111 = skyaoTap(hi.x,hi.y,hi.z);
  vec4 a = mix(mix(c000,c100,f.x), mix(c010,c110,f.x), f.y);
  vec4 b = mix(mix(c001,c101,f.x), mix(c011,c111,f.x), f.y);
  return mix(a, b, f.z);
}
/** q 空间位置 + q 空间法线 -> 天穹遮蔽 V in [0,1]。无载荷时恒 1(不遮蔽)。 */
float skyaoAt(vec3 q, vec3 n){
  if(uSkyaoOn < 0.5) return 1.0;
  vec3 Xw = uSkyaoM * q;                                   // q -> 世界(det=+1 那套)
  vec3 c01 = clamp((Xw - uSkyaoMin) * uSkyaoScale, 0.0, 1.0);
  vec4 m = sampleSkyao(c01);
  vec3 nw = normalize(uSkyaoM * n);
  float cap = max((1.0 + nw.y) * 0.5, 1.0/255.0);          // 无遮挡时的解析上限
  return clamp((m.x + dot(m.yzw, nw)) / cap, 0.0, 1.0);
}
//__SKYAO_SAMPLING_END__
/** 临时诊断(uShowN==3):把查表落点画成盒内归一化坐标 RGB。x=红 y=绿 z=蓝。 */
vec3 skyaoBox(vec3 q){
  if(uSkyaoOn < 0.5) return vec3(1.0, 0.0, 1.0);           // 品红 = 根本没载荷
  return clamp((uSkyaoM * q - uSkyaoMin) * uSkyaoScale, 0.0, 1.0);
}
/** 临时诊断(uShowN==5):把 V 编成**色带** —— 色相扛得住后处理/色调映射,灰度扛不住。
    红<0.15 橙<0.35 黄<0.55 绿<0.75 蓝>=0.75 */
vec3 skyaoBand(vec3 q, vec3 n){
  if(uSkyaoOn < 0.5) return vec3(1.0, 0.0, 1.0);
  float v = skyaoAt(q, n);
  if(v < 0.15) return vec3(1.0, 0.0, 0.0);
  if(v < 0.35) return vec3(1.0, 0.45, 0.0);
  if(v < 0.55) return vec3(1.0, 1.0, 0.0);
  if(v < 0.75) return vec3(0.0, 1.0, 0.0);
  return vec3(0.0, 0.55, 1.0);
}
/** 临时诊断(uShowN==4):把**采样到的原始矩** a0 画成灰度。纹理没绑上时恒 1(纯白)。 */
vec3 skyaoRaw(vec3 q){
  if(uSkyaoOn < 0.5) return vec3(1.0, 0.0, 1.0);
  vec4 m = sampleSkyao(clamp((uSkyaoM * q - uSkyaoMin) * uSkyaoScale, 0.0, 1.0));
  return vec3(m.x);
}

vec3 ambRad(vec3 d){
  vec3 m=vec3(d.xy, abs(d.z)); vec3 L=vec3(0.);
  for(int k=0;k<9;k++) L+=uAmbSH[k]*shY(k,m);
  return max(L,0.)*uAmbStrength;
}
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }

// 射线-体素盒求交:把起点推进到盒入口(与实验室 pipeline._ray_box_enter / 查看器 boxEnter 同式)。
// 伪世界只覆盖背景画那一块 q 盒,角色带常常高过画面上沿;起点在盒外就一步出界的写法会让
// 上半身全 miss。返回 x=进盒距离,y<0=这条射线进不去。cache 侧同一个坑在烘焙里已修。
vec2 boxEnter(vec3 p0, vec3 dn, vec3 hi){
  vec3 d=mix(dn, vec3(1e-6), lessThan(abs(dn), vec3(1e-6)));
  vec3 t0=(vec3(0.)-p0)/d, t1=(hi-p0)/d;
  vec3 lo3=min(t0,t1), hi3=max(t0,t1);
  float tn=max(0., max(max(lo3.x,lo3.y),lo3.z));
  return vec2(tn, min(min(hi3.x,hi3.y),hi3.z)-tn);
}
vec3 gatherRT(vec3 q0, vec3 n){
  int spp = int(uSpp + .5);
  int msteps = int(uMSteps + .5);
  int lightCount = int(uLightCount + .5);
  vec3 t=normalize(abs(n.z)<.95?cross(n,vec3(0,0,1)):cross(n,vec3(1,0,0)));
  vec3 b=cross(n,t);
  vec3 scaleIdx=vec3(uVolN-1.)/max(uQMax-uQMin,vec3(1e-5));
  vec3 invN=1./uVolN;
  vec3 p0=(q0-uQMin)*scaleIdx;
  float rot=hash12(gl_FragCoord.xy)*6.2831853;
  const float GA=2.399963;
  vec3 acc=vec3(0.);
  float nHit=0.;
  for(int i=0;i<192;i++){
    if(i>=spp) break;
    float u1=(float(i)+.5)/float(spp);
    float ph=float(i)*GA+rot;
    float r=sqrt(u1);
    vec3 ld=vec3(r*cos(ph), r*sin(ph), sqrt(max(0.,1.-u1)));
    vec3 dir=normalize(t*ld.x+b*ld.y+n*ld.z);
    if(uFold>.5 && dir.z<0.) dir.z=-dir.z;      // A7: 摄像机侧折叠进观测半空间
    vec3 dn=normalize(dir*scaleIdx);
    vec3 dIdx=dn*uStep;
    vec2 be=boxEnter(p0, dn, uVolN-1.);
    bool hit=false; vec3 Li=vec3(0.);
    if(be.y<0.){                                // 进不去体素盒 → 当 miss 记账
      if(uMissMode<.5) acc+=ambRad(dir);
      continue;
    }
    vec3 p=p0+dn*be.x+dIdx*1.5;                 // 先推进到入口,再留 1.5 步自碰撞余量
    for(int s=0;s<256;s++){
      if(s>=msteps) break;
      p+=dIdx;
      if(any(lessThan(p,vec3(0.)))||any(greaterThan(p,uVolN-1.))) break;
      vec4 v=sampleVol3(uVolRad,(p+.5)*invN);
      if(v.a>.45){
        Li=v.rgb;                                     // base only(画作)
        if(uNEE<.5) Li+=sampleVol3(uVolEmit,(p+.5)*invN).rgb;  // NEE 关: emit 走射线
        hit=true; break;
      }
    }
    if(hit){ acc+=Li; nHit+=1.; }
    else if(uMissMode<.5) acc+=ambRad(dir);     // J̄ × 强度(0 = miss 记黑)
    /* uMissMode==1: miss 不计入,下方 renormalize */
  }
  vec3 E=(uMissMode>.5)?acc*(3.14159265/max(nHit,1.)):acc*(3.14159265/float(spp));
  if(uNEE>.5){
    // 精确确定性直射:遍历全部光源 surfel + 阴影 march(各向同性,无发射端余弦)
    for(int i=0;i<48;i++){
      if(i>=lightCount) break;
      vec3 lq=uLightQ[i].xyz;
      vec3 dl=lq-q0;
      float r2=max(dot(dl,dl),0.04);
      float r=sqrt(r2);
      vec3 d=dl/r;
      float cr=max(dot(n,d),0.);
      if(cr<=0.) continue;
      vec3 pi0=(q0-uQMin)*scaleIdx;
      vec3 pi1=(lq-uQMin)*scaleIdx;
      vec3 dli=pi1-pi0;
      float li_=length(dli);
      vec3 sd=dli/max(li_,1e-5)*1.6;
      float nst=max((li_-1.8)/1.6,0.);
      vec3 p=pi0+sd*1.2;
      float vis=1.;
      for(int s=0;s<160;s++){
        if(float(s)>=nst) break;
        p+=sd;
        if(any(lessThan(p,vec3(0.)))||any(greaterThan(p,uVolN-1.))) break;
        if(sampleVol3(uVolRad,(p+.5)*(1./uVolN)).a>.45){ vis=0.; break; }
      }
      E += uLightE[i].rgb * (vis*cr*uLightQ[i].w/r2);
    }
  }
  return E;
}

//__CLC_END__

void main(void) {
    vec4 color = texture(uTexture, vTextureCoord);
    if (color.a < 0.03) { discard; }

    float S = max(uProjectionScale, 1e-6);
    float wx = (vScreenPos.x - uWorldContainerPos.x) / S;
    float wy = (vScreenPos.y - uWorldContainerPos.y) / S;

    bool occluded = false;
    // ---------- 深度遮挡(P2a 契约,与旧滤镜一致) ----------
    if (uDepthEnabled > 0.5 && uHasFootDepth > 0.5) {   // 缺行走面场就不遮挡
        vec2 depthUV = vec2(wx / uSceneSize.x, wy / uSceneSize.y);
        if (depthUV.x >= 0.0 && depthUV.x <= 1.0 && depthUV.y >= 0.0 && depthUV.y <= 1.0) {
            vec4 depthSample = texture(uDepthMap, depthUV);
            float rawDepth = (depthSample.r * 255.0 * 256.0 + depthSample.g * 255.0) / 65535.0;
            float d_raw = uInvert > 0.5 ? 1.0 - rawDepth : rawDepth;
            float sceneDepth = d_raw * uScale + uOffset;
            // 遮挡与着色用**同一个**代理:立在伪世界里的直立 quad。
            // uDepthPerSy = tanθ/ppu 正是直立 quad 的深度梯度(往上越靠近相机)。
            // 脚点深度只认行走面场实测值(uFootQ.z,与着色同源)——floor 拟合直线已废除
            // (多层街巷可偏出 200+ 行地面),没有场就整段不遮挡,绝不退回旧模型顶上。
            float syTexFoot = uEntityFootWorldY * uWorldToPixelY;
            float syTex = wy * uWorldToPixelY;
            float upright = uDepthPerSy * (syTex - syTexFoot);
            float spriteDepth = uFootQ.z + upright + uFloorOffset + uFloorOffsetExtra - uFootBias;
            occluded = sceneDepth + uTolerance < spriteDepth;
        }
    }

    if (uDebug > 0.5) {
        finalColor = vec4(occluded ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0), 0.7);
        return;
    }

    if (occluded) {
        if (uOcclusionBlendFactor < 1e-5) { discard; }
        finalColor = vec4(color.rgb * uOcclusionBlendFactor, color.a * uOcclusionBlendFactor);
        return;
    }

    // ---------- 像素几何:世界坐标 → work px → 直立 quad q ----------
    float ppu = uCal.x;
    float sxw = wx * uWorldToWork.x;
    float syw = wy * uWorldToWork.y;
    float footSy = uEntityFootWorldY * uWorldToWork.y;
    float qx = (sxw - uCal.z) / ppu;
    float h = max((footSy - syw) / max(uCosT * ppu, 1e-6), 0.0);

    // ---------- 法线(运行时鼓包图集;无图集 → 平面朝相机) ----------
    // ⚠⚠ 法线 local UV **只**取自渲染几何本身(vObjUV),绝不从世界坐标反推。
    //
    // 老写法是 ul = 0.5 + (qx - uFootQ.x)/uCharW、vl = 1 - h/uCharH —— 绕世界坐标
    // 回来,依赖 uFootQ / uCharW 两个**每帧驱动**的 uniform。任何一帧没喂上,ul 就整体
    // 越界、被 clamp 死在 0 或 1,全身反复采**同一列边缘像素**:
    //   · 通体单色;翻转时 ul=1-ul 从另一端夹住 → 另一个颜色(实测的绿↔黄);
    //   · uNrmRect/uHasNrm 在默认值与真值间跳变 → 角色不动也逐帧闪。
    // 实测触发条件:非 Exploring 态(如 Cutscene)整段着色驱动被跳过,而滤镜仍挂着,
    // uniform 停在构造缺省(charW=0.6 / foot=(0,0,0) / hasNrm=0)。
    //
    // 现在:vObjUV 是顶点着色器直接给的包围盒归一化坐标,**不依赖任何驱动**;
    // 换算到 sprite 自身矩形后,与 color 帧用同一套 UV;镜像就只翻 local u。
    vec4 ne = vec4(0.5, 0.5, 1.0, 0.35);
    if (uHasNrm > 0.5) {
        // 像素世界坐标 (wx,wy) 在 sprite 世界 AABB 内的比例 = 与 color 帧完全同一套 local UV
        vec2 luv = (vec2(wx, wy) - uSpriteWorldRect.xy) / max(uSpriteWorldRect.zw, vec2(1e-5));
        if (uFlipX > 0.5) luv.x = 1.0 - luv.x;      // 镜像:只翻 local u
        vec2 uvn = uNrmRect.xy + clamp(luv, 0.0, 1.0) * uNrmRect.zw;
        ne = texture(uNrm, uvn);
    }
    vec3 n = normalize(vec3(-(ne.r*2.-1.), -(ne.g*2.-1.), -max(ne.b,.05)));
    if (uFlipX > 0.5) n.x = -n.x;
    n = normalize(mix(n, vec3(0.,0.,-1.), uFlatten));

    vec3 q = vec3(qx,
                  uFootQ.y + h * uCosT,
                  uFootQ.z - h * uSinT - ne.a * uBulge);

    // 法线档必须是**独占区间**:uShowN=2 是 skyao 档,写成 >0.5 会被这条
    // 先接住并 return,于是「看 skyao」看到的是法线(2026-09-01 踩过)。
    if (uShowN > 0.5 && uShowN < 1.5) { finalColor = vec4((n*.5+.5) * color.a, color.a); return; }

    // 诊断·定法线(与 mesh 路径同一组 q 常量;此前 filter 只声明未应用,诊断档只对 mesh 生效)
    if (uFixedNQ > 0.5) {
        n = uFixedNQ > 1.5 ? normalize(vec3(0., uCosT, -uSinT)) : vec3(0., 0., -1.);
    }
    // ---------- E:RT gather 或 probe 图集 ----------
    vec3 E = ((uMode < 0.5) ? gatherRT(q + n*0.02, n) : probeE(q, n)) * uGiStrength;
    vec3 EgiPure = E;   // 纯E 审计快照(同 mesh 路径:不含 skyao/太阳/灯)
    // ---- skyao:**乘在 GI 上**,与全白 blend(制作人 2026-09-01)----
    // 天穹遮蔽是几何项,只该衰减 GI 底光;太阳是独立解析直射,不吃它
    // (太阳自己的遮蔽将来要走 V_dir(w) 那条闭式,不是这个各向同性的 V)。
    E *= mix(1.0, skyaoAt(q, n), clamp(uSkyaoBlend, 0.0, 1.0));
    // 调试档:uShowN==2 => 直接把 skyao 的 V 画成灰度(1=不遮蔽 0=全遮)。
    // 判「这一项到底生没生效」只能看它 —— 角色在 800x450 里只有几十像素,
    // 靠肉眼比两张截图分不出 3 倍的 GI 差异(2026-09-01 实测走过这个弯路)。
    if (uShowN > 4.5) { finalColor = vec4(skyaoBand(q, n) * color.a, color.a); return; }
    if (uShowN > 3.5) { finalColor = vec4(skyaoRaw(q) * color.a, color.a); return; }
    if (uShowN > 2.5) { finalColor = vec4(skyaoBox(q) * color.a, color.a); return; }
    if (uShowN > 1.5) {
      // 与场景 uDebug==11 同看时必须同显示链:场景 V 写进 RT 后被 LitBackground 做
      // 显示变换,角色裸值直出就凭空暗一档 + 半透明边缘一圈黑边(2026-09-01 实测,
      // 与 eOnly 分支 2026-09-01 那课同一类)。此路径无 uDisp*,用 lin2srgb 同 eOnly 口径。
      float v = skyaoAt(q, n);
      finalColor = vec4(clamp(lin2srgb(vec3(v)), 0.0, 1.0) * color.a, color.a);
      return;
    }

    // 太阳:独立解析直射(与投影阴影方位解耦)
    if (uSunOn > 0.5) {
        float ndl = max(dot(n, uSunDirQ), 0.0);
        E += uSunColor * ndl;
    }
    // ---- 「GI体·纯E」调试(F2 的 8/9/10 档):albedo≡1,输出 E×2^β ----
    // 与 mesh 路径(CharacterLitSprite)同式。此路径没有场景显示变换参数,收尾用
    // lin2srgb —— 与缺省显示链(EV0/无tonemap)等价;display 非缺省的场景会有偏差。
    // ⚠ 2026-09-01 之前这条分支只有 mesh 路径有:GI体 档下 mesh 角色正确变白融进
    //   场景,filter 角色仍按 albedo 渲 —— 同一份 E,一个白一个黑,像数据坏了。
    if (uEOnly > 0.5 && uEOnly < 1.5) {
        vec3 pe = EgiPure * uBeta;   // 乘 skyao 之前的 E,与场景 uDebug==8 同式
        if (uEChecker > 0.5) {
            ivec3 cc = ivec3(probeGridT(q));
            pe *= mix(0.45, 1.0, float((cc.x + cc.y + cc.z) & 1));
        }
        finalColor = vec4(clamp(lin2srgb(pe), 0.0, 1.0) * color.a, color.a);
        return;
    }
    // ---------- 角色着色核心(共享:charShadeCore.glsl 的 shadeCharacterLinear) ----------
    // E 分解 + albedo×E 在唯一真相源里;游戏不乘实验室 pgain,直接 lin2srgb+clamp。
    vec3 alb = color.rgb / max(color.a, 1e-4);   // Pixi 预乘 → 直通 albedo
    vec3 outRgb = clamp(lin2srgb(shadeCharacterLinear(alb, E, uEChroma, uBeta)), 0.0, 1.0);

    // ---------- 保留:游戏侧 sprite 空间 AO ----------
    float vy = clamp(vTextureCoord.y, 0.0, 1.0);
    float contact = uAOContact * smoothstep(0.78, 1.0, vy);
    float form = uAOForm * vy;
    float ao = clamp(1.0 - contact - form, 0.0, 1.0);
    outRgb *= ao;

    finalColor = vec4(outRgb * color.a, color.a);
}
`;

// 照明数学公共块(标定/伪世界 uniform + 体素三线性 + SH + gatherRT + probeE + 着色核心):
// filter 与 CharacterLitSprite(sprite 网格着色)**共用同一段字符串**——同一份数学只写一遍,
// 改一处两处同步(与实验室 LIGHT_FNS 同一纪律)。标记由上面 FRAG 内的 __CLC_*__ 注释界定。
const CLC_B = '//__CLC_BEGIN__';
const CLC_E = '//__CLC_END__';
export const CHAR_LIGHT_COMMON_GLSL: string =
  FRAG.substring(FRAG.indexOf(CLC_B) + CLC_B.length, FRAG.indexOf(CLC_E));

let sharedProgram: GlProgram | null = null;
/** 直立 quad 的深度梯度 tanθ/ppu:从 depthConfig 的 M 现推(R 第二行 = [0, cosθ, −sinθ])。 */
function uprightGradientFromM(cfg?: SceneDepthConfig | null): number {
  const R = cfg?.M?.R, ppu = cfg?.M?.ppu;
  if (!R || !ppu) return 0;
  const cosT = R[1]?.[1] ?? 0, sinT = -(R[1]?.[2] ?? 0);
  return Math.abs(cosT) < 1e-6 ? 0 : (sinT / cosT) / ppu;
}

function getSharedProgram(): GlProgram {
  if (!sharedProgram) {
    sharedProgram = new GlProgram({ vertex: VERT, fragment: FRAG });
  }
  return sharedProgram;
}

/** 逐帧可调照明参数(F2 全量;与实验室查看器同名同义,默认值同实验室) */
export interface CharShadingParams {
  mode: number;          // 0=RT 1=L1 2=L2 3=BIN
  spp: number;
  step: number;
  msteps: number;
  fold: boolean;
  missMode: boolean;     // true = miss 不计入(renormalize)
  nee: boolean;
  beta: number;          // 曝光指数,上传 2^beta(角色曝光唯一旋钮;实验室 pgain 不进游戏)
  giStrength: number;    // GI 底光增益(0~10):只乘 probe/RT 的 E,不乘实体灯与测试太阳
  ambStrength: number;
  bulge: number;
  flatten: number;
  heightScale: number;
  showNormals: boolean;
  sunEnabled: boolean;
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  sunIntensity: number;
  sunColor: [number, number, number];
}

/** 场景级静态资源(CharacterLightingSystem 载入并共享给所有滤镜) */
/**
 * probe 采样 GLSL 切片(shY/ambIrr/octaEnc/probeE + probe uniform 声明)。
 * 场景光照 pass 的「GI体」调试视图拼接它——角色与场景吃**同一份**采样数学,
 * 不是两处写得像。调用方需自声明 uPL1/uPL2/uPBin/uValid 四个 sampler。
 */
/**
 * skyao probe 采样切片(uSkyaoTex 由宿主自声明;uSkyao* uniform 声明在 PROBE 切片里)。
 * 场景侧「skyao体」对账视图(SceneLightingPass uDebug==11)与角色共用这一份 ——
 * 改采样数学只改这里,两边同变。
 */
export const SKYAO_SAMPLING_GLSL: string = (() => {
  const b = '//__SKYAO_SAMPLING_BEGIN__';
  const e = '//__SKYAO_SAMPLING_END__';
  const i = CHAR_LIGHT_COMMON_GLSL.indexOf(b);
  const j = CHAR_LIGHT_COMMON_GLSL.indexOf(e);
  if (i < 0 || j < 0) throw new Error('[CharacterShadingFilter] 缺 SKYAO_SAMPLING 切片标记');
  return CHAR_LIGHT_COMMON_GLSL.slice(i, j + e.length);
})();

export const PROBE_SAMPLING_GLSL: string = (() => {
  const b = '//__PROBE_SAMPLING_BEGIN__';
  const e = '//__PROBE_SAMPLING_END__';
  const i = CHAR_LIGHT_COMMON_GLSL.indexOf(b);
  const j = CHAR_LIGHT_COMMON_GLSL.indexOf(e);
  if (i < 0 || j < 0) throw new Error('[CharacterShadingFilter] 缺 PROBE_SAMPLING 切片标记');
  return CHAR_LIGHT_COMMON_GLSL.substring(i + b.length, j);
})();

export interface CharShadingSceneResources {
  atlasL1: TextureSource;
  atlasL2: TextureSource;
  atlasBin: TextureSource;
  valid: TextureSource;
  volRad: TextureSource;
  volEmit: TextureSource;
  workW: number;
  workH: number;
  /** 场景世界坐标 → work px */
  worldToWorkX: number;
  worldToWorkY: number;
  cal: { ppu: number; cx: number; cy: number; theta: number };
  vol: {
    nx: number; ny: number; nz: number; tilesX: number; tilesY: number;
    qMin: [number, number, number]; qMax: [number, number, number];
  };
  /** q→world 矩阵,列主序 9 元素(GL 布局) */
  mCol: Float32Array;
  wMin: [number, number, number];
  wScale: [number, number, number];
  pn: [number, number, number];
  /** probe 图集平铺:每行多少颗(见 GLSL probeTexel;valid 图共用) */
  probeT: number;
  /** 'l2' 图集每颗的球谐系数数(9=L2 / 25=L4),与 GLSL uShK 同义 */
  shK: number;
  /** 八面体边长(8 或 16),与 GLSL uBinOb 同义 */
  binOb: number;
  ambSH: Float32Array;           // 27
  lightsQ: Float32Array;         // 48×4
  lightsE: Float32Array;         // 48×4
  lightCount: number;
  /**
   * skyao probe(`lighting/<背景基名>/skyao_probe.bin`):天穹遮蔽矩,乘在 GI 上。
   *
   * ⚠ `mCol` 是 **depthConfig 的 det=+1 世界系**(矩就是用它烘的),
   *   与 probe 图集那套 `lighting.json.world.M`(det=-1)**不是一个矩阵**。
   *   混用不报错,只是 `a1·N` 的方向整个镜像。
   */
  skyao?: {
    tex: TextureSource;
    n: [number, number, number];
    tiles: [number, number];
    wMin: [number, number, number];
    wScale: [number, number, number];
    mCol: Float32Array;
  } | null;
}

export interface CharacterShadingFilterOptions {
  depthTexture: Texture | null;
  cfg: SceneDepthConfig | null;
  scene: CharShadingSceneResources;
}

export class CharacterShadingFilter extends Filter implements IEntityShadingFilter {
  readonly _isDepthOcclusion = true;
  /** 类型判别(Game 逐帧驱动循环用,instanceof 之外的快速判断) */
  readonly _isCharacterShading = true;

  private constructor(opts: CharacterShadingFilterOptions) {
    const { cfg, depthTexture, scene } = opts;
    const depthOn = !!(cfg && depthTexture);
    const dm = cfg?.depth_mapping;
    const sh = cfg?.shader;

    super({
      glProgram: getSharedProgram(),
      resources: {
        shadeUniforms: {
          uSceneSize: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uProjectionScale: { value: 1, type: 'f32' },
          uWorldToPixelX: { value: 1, type: 'f32' },
          uWorldToPixelY: { value: 1, type: 'f32' },
          uWorldContainerPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uEntityFootWorldX: { value: 0, type: 'f32' },
          uEntityFootWorldY: { value: 0, type: 'f32' },

          uDepthEnabled: { value: depthOn ? 1 : 0, type: 'f32' },
          uInvert: { value: dm?.invert ? 1.0 : 0.0, type: 'f32' },
          uScale: { value: dm?.scale ?? 1, type: 'f32' },
          uOffset: { value: dm?.offset ?? 0, type: 'f32' },
          // 直立 quad 的深度梯度 tanθ/ppu。缺字段时**从 M 现推**——退成 0 等于
          // 悄悄变回 billboard(整张 sprite 一个深度),那正是已废除的口径。
          uDepthPerSy: { value: sh?.depth_per_sy ?? uprightGradientFromM(cfg), type: 'f32' },
          uFloorOffset: { value: cfg?.floor_offset ?? 0, type: 'f32' },
          uFloorOffsetExtra: { value: 0, type: 'f32' },
          uTolerance: { value: cfg?.depth_tolerance ?? 0, type: 'f32' },
          uOcclusionBlendFactor: { value: 0, type: 'f32' },
          uHasFootDepth: { value: 0, type: 'f32' },
          uFootBias: { value: 0.045, type: 'f32' },
          uDebug: { value: 0, type: 'f32' },

          uWorkSize: { value: new Float32Array([scene.workW, scene.workH]), type: 'vec2<f32>' },
          uWorldToWork: { value: new Float32Array([scene.worldToWorkX, scene.worldToWorkY]), type: 'vec2<f32>' },
          uCal: { value: new Float32Array([scene.cal.ppu, 0, scene.cal.cx, scene.cal.cy]), type: 'vec4<f32>' },
          uCosT: { value: Math.cos(scene.cal.theta), type: 'f32' },
          uSinT: { value: Math.sin(scene.cal.theta), type: 'f32' },
          uQMin: { value: new Float32Array(scene.vol.qMin), type: 'vec3<f32>' },
          uQMax: { value: new Float32Array(scene.vol.qMax), type: 'vec3<f32>' },
          uVolN: { value: new Float32Array([scene.vol.nx, scene.vol.ny, scene.vol.nz]), type: 'vec3<f32>' },
          uVolTiles: { value: new Float32Array([scene.vol.tilesX, scene.vol.tilesY]), type: 'vec2<f32>' },
          uM: { value: scene.mCol, type: 'mat3x3<f32>' },
          // ---- skyao probe。无载荷时 uSkyaoOn=0,shader 恒返回 1(不遮蔽)----
          uSkyaoN: { value: new Float32Array(scene.skyao?.n ?? [1, 1, 1]), type: 'vec3<f32>' },
          uSkyaoTiles: { value: new Float32Array(scene.skyao?.tiles ?? [1, 1]), type: 'vec2<f32>' },
          uSkyaoMin: { value: new Float32Array(scene.skyao?.wMin ?? [0, 0, 0]), type: 'vec3<f32>' },
          uSkyaoScale: { value: new Float32Array(scene.skyao?.wScale ?? [0, 0, 0]), type: 'vec3<f32>' },
          uSkyaoM: { value: scene.skyao?.mCol ?? new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
                     type: 'mat3x3<f32>' },
          uSkyaoOn: { value: scene.skyao ? 1 : 0, type: 'f32' },
          uSkyaoBlend: { value: 1, type: 'f32' },
          uWMin: { value: new Float32Array(scene.wMin), type: 'vec3<f32>' },
          uWScale: { value: new Float32Array(scene.wScale), type: 'vec3<f32>' },
          uPN: { value: new Float32Array(scene.pn), type: 'vec3<f32>' },
          uProbeT: { value: scene.probeT, type: 'f32' },
          uShK: { value: scene.shK, type: 'f32' },
          uBinOb: { value: scene.binOb, type: 'f32' },
          uAmbSH: { value: scene.ambSH, type: 'vec3<f32>', size: 9 },
          uLightQ: { value: scene.lightsQ, type: 'vec4<f32>', size: 48 },
          uLightE: { value: scene.lightsE, type: 'vec4<f32>', size: 48 },
          uLightCount: { value: scene.lightCount, type: 'f32' },

          uFootQ: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },
          uCharH: { value: 1.5, type: 'f32' },
          uCharW: { value: 0.6, type: 'f32' },
          uNrmRect: { value: new Float32Array([0, 0, 1, 1]), type: 'vec4<f32>' },
          uFlipX: { value: 0, type: 'f32' },
          uSpriteWorldRect: { value: new Float32Array([0, 0, 1, 1]), type: 'vec4<f32>' },
          uHasNrm: { value: 0, type: 'f32' },

          uMode: { value: 2, type: 'f32' },
          uSpp: { value: 64, type: 'f32' },
          uMSteps: { value: 160, type: 'f32' },
          uFold: { value: 1, type: 'f32' },
          uMissMode: { value: 0, type: 'f32' },
          uNEE: { value: 0, type: 'f32' },
          uStep: { value: 0.9, type: 'f32' },
          uBeta: { value: 1, type: 'f32' },
          uAmbStrength: { value: 1, type: 'f32' },
          uBulge: { value: 0.22, type: 'f32' },
          uFlatten: { value: 0, type: 'f32' },
          uShowN: { value: 0, type: 'f32' },
          uEOnly: { value: 0, type: 'f32' },
          uGiStrength: { value: 1, type: 'f32' },
          uFixedNQ: { value: 0, type: 'f32' },
          uEChecker: { value: 0, type: 'f32' },

          uSunOn: { value: 0, type: 'f32' },
          uSunDirQ: { value: new Float32Array([0, 1, 0]), type: 'vec3<f32>' },
          uSunColor: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },

          uEChroma: { value: 0, type: 'f32' },

          uAOContact: { value: 0, type: 'f32' },
          uAOForm: { value: 0, type: 'f32' },
        },
        uDepthMap: depthTexture?.source ?? Texture.WHITE.source,
        uNrm: Texture.WHITE.source,
        uPL1: scene.atlasL1,
        uPL2: scene.atlasL2,
        uPBin: scene.atlasBin,
        uValid: scene.valid,
        uSkyaoTex: scene.skyao?.tex ?? Texture.EMPTY.source,
        uVolRad: scene.volRad,
        uVolEmit: scene.volEmit,
      },
    });
  }

  static createForEntity(opts: CharacterShadingFilterOptions): CharacterShadingFilter {
    return new CharacterShadingFilter(opts);
  }

  private get _u(): Record<string, unknown> | undefined {
    return (this.resources as Record<string, { uniforms: Record<string, unknown> }>)['shadeUniforms']
      ?.uniforms;
  }

  // ---- IEntityShadingFilter 驱动接口(遮挡/场景几何) ----
  setSceneSize(w: number, h: number): void {
    const u = this._u;
    if (u) { const a = u['uSceneSize'] as Float32Array; a[0] = w; a[1] = h; }
  }
  setWorldToPixel(tx: number, ty: number): void {
    const u = this._u;
    if (u) { u['uWorldToPixelX'] = tx; u['uWorldToPixelY'] = ty; }
  }
  setProjectionScale(s: number): void {
    const u = this._u;
    if (u) u['uProjectionScale'] = s;
  }
  setWorldContainerPos(x: number, y: number): void {
    const u = this._u;
    if (u) { const a = u['uWorldContainerPos'] as Float32Array; a[0] = x; a[1] = y; }
  }
  setEntityFootY(worldY: number): void {
    const u = this._u;
    if (u) u['uEntityFootWorldY'] = worldY;
  }
  setEntityFootX(worldX: number): void {
    const u = this._u;
    if (u) u['uEntityFootWorldX'] = worldX;
  }
  setFloorOffset(v: number): void {
    const u = this._u;
    if (u) u['uFloorOffset'] = v;
  }
  setFloorOffsetExtra(v: number): void {
    const u = this._u;
    if (u) u['uFloorOffsetExtra'] = v;
  }
  setTolerance(v: number): void {
    const u = this._u;
    if (u) u['uTolerance'] = v;
  }
  setOcclusionBlendFactor(v: number): void {
    const u = this._u;
    if (u) u['uOcclusionBlendFactor'] = Math.min(1, Math.max(0, v));
  }

  /** 脚点行走面深度。与 setFootQ 写同一个 uFootQ.z（同源同值，避免两份脚深度漂移）；
   *  null = 无行走面场，回落旧的 floor 直线口径。 */
  setFootDepthQ(v: number | null): void {
    const u = this._u;
    if (!u) return;
    if (v === null || !Number.isFinite(v)) { u['uHasFootDepth'] = 0; return; }
    (u['uFootQ'] as Float32Array)[2] = v;
    u['uHasFootDepth'] = 1;
  }

  /** 脚点遮挡偏置（实验室常数 0.045） */
  setFootBias(v: number): void {
    const u = this._u;
    if (u) u['uFootBias'] = Math.max(0, v);
  }
  setDebug(on: boolean): void {
    const u = this._u;
    if (u) u['uDebug'] = on ? 1 : 0;
  }
  /** 保留的游戏侧 sprite AO(applyShadowFilterToneAO 广播命中;tone 无 setter=淘汰) */
  setAO(contact: number, form: number): void {
    const u = this._u;
    if (u) {
      u['uAOContact'] = Math.max(0, Math.min(1, contact));
      u['uAOForm'] = Math.max(0, Math.min(1, form));
    }
  }

  // ---- 角色照明驱动(CharacterLightingSystem 逐帧调用) ----
  setFootQ(x: number, y: number, z: number): void {
    const u = this._u;
    if (u) { const a = u['uFootQ'] as Float32Array; a[0] = x; a[1] = y; a[2] = z; }
  }
  setCharSize(wWu: number, hWu: number): void {
    const u = this._u;
    if (u) { u['uCharW'] = Math.max(wWu, 1e-4); u['uCharH'] = Math.max(hWu, 1e-4); }
  }
  setNormalFrame(rect: [number, number, number, number] | null, flipX: boolean): void {
    const u = this._u;
    if (!u) return;
    if (rect) {
      const a = u['uNrmRect'] as Float32Array;
      a[0] = rect[0]; a[1] = rect[1]; a[2] = rect[2]; a[3] = rect[3];
      u['uHasNrm'] = 1;
    } else {
      u['uHasNrm'] = 0;
    }
    u['uFlipX'] = flipX ? 1 : 0;
  }
  /** sprite 的世界 AABB(左上 x,y + 宽高)—— 法线 local UV 的唯一依据,裁剪无关。 */
  setSpriteWorldRect(x: number, y: number, w: number, h: number): void {
    const u = this._u;
    if (!u) return;
    const a = u['uSpriteWorldRect'] as Float32Array;
    a[0] = x; a[1] = y; a[2] = Math.max(w, 1e-5); a[3] = Math.max(h, 1e-5);
  }
  /** 当前绑定的法线图集源;用于逐帧同步时跳过未变的情况(见 boundNormalSource)。 */
  private _nrmSrc: TextureSource | null = null;
  get boundNormalSource(): TextureSource | null { return this._nrmSrc; }
  setNormalTexture(src: TextureSource | null): void {
    if (src === this._nrmSrc) return;                 // 未变:逐帧调用零开销
    this._nrmSrc = src ?? null;
    (this.resources as Record<string, unknown>)['uNrm'] = src ?? Texture.WHITE.source;
  }
  applyParams(p: CharShadingParams): void {
    const u = this._u;
    if (!u) return;
    u['uMode'] = p.mode;
    u['uSpp'] = p.spp;
    u['uMSteps'] = p.msteps;
    u['uFold'] = p.fold ? 1 : 0;
    u['uMissMode'] = p.missMode ? 1 : 0;
    u['uNEE'] = p.nee ? 1 : 0;
    u['uStep'] = p.step;
    u['uBeta'] = Math.pow(2, p.beta);
    u['uAmbStrength'] = p.ambStrength;
    u['uBulge'] = p.bulge;
    u['uFlatten'] = p.flatten;
    u['uShowN'] = p.showNormals ? 1 : 0;
    u['uGiStrength'] = p.giStrength;
    u['uSunOn'] = p.sunEnabled ? 1 : 0;
    const az = (p.sunAzimuthDeg * Math.PI) / 180;
    const el = (p.sunElevationDeg * Math.PI) / 180;
    const d = u['uSunDirQ'] as Float32Array;
    // q 空间:x=画面右,y=上,z=纵深(远为正);az 0°右/90°纵深/180°左/270°朝镜头
    d[0] = Math.cos(el) * Math.cos(az);
    d[1] = Math.sin(el);
    d[2] = Math.cos(el) * Math.sin(az);
    const c = u['uSunColor'] as Float32Array;
    c[0] = p.sunColor[0] * p.sunIntensity;
    c[1] = p.sunColor[1] * p.sunIntensity;
    c[2] = p.sunColor[2] * p.sunIntensity;
  }

  /**
   * 调试/覆盖状态(showN 覆盖档、纯E、棋盘、skyao blend)。
   * mesh 路径这些走 syncFrame 的 frameLit 共享组;filter 每实体一份 uniform,
   * 必须在 driveFilter 里逐个推 —— 漏推的症状是「调试档只有 mesh 角色生效」
   * (2026-09-01:GI体 档 filter 角色漆黑、band 档 filter 角色无色,均此因)。
   */
  applyDebugState(showN: number, eOnly: number, eChecker: number, skyaoBlend: number,
                  fixedNQ = 0): void {
    const u = this._u;
    if (!u) return;
    u['uFixedNQ'] = fixedNQ;
    u['uShowN'] = showN;
    u['uEOnly'] = eOnly;
    u['uEChecker'] = eChecker;
    u['uSkyaoBlend'] = skyaoBlend;
  }

  /** F2 测试旋钮:E 色度权重 0(只借明暗)~1(完整彩色 E)。 */
  setEChroma(v: number): void {
    const u = this._u;
    if (u) u['uEChroma'] = v;
  }
}
