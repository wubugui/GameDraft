import { Filter, GlProgram, Texture, type TextureSource } from 'pixi.js';
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
uniform mat3  uM;                // q -> world
uniform vec3  uWMin;
uniform vec3  uWScale;
uniform vec3  uPN;               // probe 网格维度(float)
uniform vec3  uAmbSH[9];
uniform vec4  uLightQ[48];       // q 位置 + 面积
uniform vec4  uLightE[48];       // 发光辐射 rgb
uniform float uLightCount;

// ---- 角色 quad(逐帧驱动) ----
uniform vec3  uFootQ;
uniform float uCharH;            // 直立 quad 高(wu)
uniform float uCharW;
uniform vec4  uNrmRect;          // 法线图集内当前帧 uv rect(x,y,w,h)
uniform float uFlipX;
uniform float uHasNrm;

// ---- 照明参数(F2 全量可调,与实验室同名同义) ----
uniform float uMode;             // 0=RT 1=L1 2=L2 3=BIN
uniform float uSpp;
uniform float uMSteps;
uniform float uFold;
uniform float uMissMode;         // 0=miss→J̄×强度 1=miss不计入(renormalize)
uniform float uNEE;
uniform float uStep;
uniform float uBeta;             // 曝光 2^β(CPU 端已 pow;角色曝光唯一旋钮)
uniform float uAmbStrength;      // miss 强度(J̄ 系数)
uniform float uBulge;
uniform float uFlatten;
uniform float uShowN;

// ---- 太阳(独立解析直射,方位与投影阴影解耦) ----
uniform float uSunOn;
uniform vec3  uSunDirQ;          // q 空间指向光源方向
uniform vec3  uSunColor;         // 颜色×强度

// ---- 保留的游戏侧 sprite AO ----
uniform float uAOContact;
uniform float uAOForm;

vec3 srgb2lin(vec3 c){ return mix(c/12.92, pow((c+.055)/1.055, vec3(2.4)), step(.04045,c)); }
vec3 lin2srgb(vec3 c){ c=max(c,0.); return mix(c*12.92, 1.055*pow(c,vec3(1./2.4))-.055, step(.0031308,c)); }
float shY(int k, vec3 n){
  if(k==0) return .282095;
  if(k==1) return .488603*n.y;  if(k==2) return .488603*n.z;  if(k==3) return .488603*n.x;
  if(k==4) return 1.092548*n.x*n.y; if(k==5) return 1.092548*n.y*n.z;
  if(k==6) return .315392*(3.*n.z*n.z-1.);
  if(k==7) return 1.092548*n.x*n.z; return .546274*(n.x*n.x-n.y*n.y);
}

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

vec3 ambRad(vec3 d){
  vec3 m=vec3(d.xy, abs(d.z)); vec3 L=vec3(0.);
  for(int k=0;k<9;k++) L+=uAmbSH[k]*shY(k,m);
  return max(L,0.)*uAmbStrength;
}
vec3 ambIrr(vec3 n){
  float A[9]=float[9](3.141593,2.094395,2.094395,2.094395,.785398,.785398,.785398,.785398,.785398);
  vec3 E=vec3(0.);
  for(int k=0;k<9;k++) E+=uAmbSH[k]*A[k]*shY(k,n);
  return max(E,0.)*uAmbStrength;
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

vec2 octaEnc(vec3 n){
  n/=(abs(n.x)+abs(n.y)+abs(n.z));
  vec2 p=n.xy;
  if(n.z<0.) p=(1.-abs(n.yx))*vec2(n.x>=0.?1.:-1., n.y>=0.?1.:-1.);
  return p*.5+.5;
}
vec3 probeE(vec3 q, vec3 n){
  int mode = int(uMode + .5);
  vec3 Xw = uM * q;                              // → 世界,插值轴为世界轴
  vec3 t = clamp((Xw-uWMin)*uWScale, vec3(0.), uPN-1.001);
  ivec3 b0=ivec3(t); vec3 f=t-vec3(b0);
  float wsum=0.;
  vec2 ouv; ivec2 ob0; vec2 of;
  if(mode==3){
    ouv=octaEnc(n)*8.-.5;
    ob0=ivec2(clamp(floor(ouv),vec2(0.),vec2(6.)));
    of=clamp(ouv-vec2(ob0),0.,1.);
  }
  float covSum=0.; vec3 Esum=vec3(0.); vec3 Asum=vec3(0.); vec3 EEsum=vec3(0.); vec3 NNsum=vec3(0.);
  ivec3 pn = ivec3(uPN + .5);
  for(int c=0;c<8;c++){
    ivec3 off=ivec3(c&1,(c>>1)&1,(c>>2)&1);
    ivec3 pi=min(b0+off,pn-1);
    float w=mix(1.-f.x,f.x,float(off.x))*mix(1.-f.y,f.y,float(off.y))*mix(1.-f.z,f.z,float(off.z));
    int flat_=pi.x*(pn.y*pn.z)+pi.y*pn.z+pi.z;
    w*=step(.002, texelFetch(uValid, ivec2(flat_,0),0).r);
    if(w<1e-5) continue;
    vec3 E=vec3(0.); vec3 Ea=vec3(0.); vec3 Ee=vec3(0.); vec3 En=vec3(0.); float cov=0.;
    if(mode==1){
      for(int k=0;k<4;k++){ vec4 q4=texelFetch(uPL1, ivec2(k,flat_),0);
        float y=shY(k,n); E+=q4.rgb*y; cov+=q4.a*y;
        Ea+=texelFetch(uPL1, ivec2(4+k,flat_),0).rgb*y;
        Ee+=texelFetch(uPL1, ivec2(8+k,flat_),0).rgb*y;
        En+=texelFetch(uPL1, ivec2(12+k,flat_),0).rgb*y; }
    } else if(mode==2){
      for(int k=0;k<9;k++){ vec4 q4=texelFetch(uPL2, ivec2(k,flat_),0);
        float y=shY(k,n); E+=q4.rgb*y; cov+=q4.a*y;
        Ea+=texelFetch(uPL2, ivec2(9+k,flat_),0).rgb*y;
        Ee+=texelFetch(uPL2, ivec2(18+k,flat_),0).rgb*y;
        En+=texelFetch(uPL2, ivec2(27+k,flat_),0).rgb*y; }
    } else {
      ivec2 b00=ivec2(ob0.y*8+ob0.x,flat_), b10=ivec2(ob0.y*8+ob0.x+1,flat_);
      ivec2 b01=ivec2((ob0.y+1)*8+ob0.x,flat_), b11=ivec2((ob0.y+1)*8+ob0.x+1,flat_);
      ivec2 oA=ivec2(64,0), oE=ivec2(128,0), oN=ivec2(192,0);
      vec4 q4=mix(mix(texelFetch(uPBin,b00,0),texelFetch(uPBin,b10,0),of.x),
                  mix(texelFetch(uPBin,b01,0),texelFetch(uPBin,b11,0),of.x),of.y);
      E=q4.rgb; cov=q4.a*3.14159265;   // bins 存 cov/π
      Ea=mix(mix(texelFetch(uPBin,b00+oA,0).rgb,texelFetch(uPBin,b10+oA,0).rgb,of.x),
             mix(texelFetch(uPBin,b01+oA,0).rgb,texelFetch(uPBin,b11+oA,0).rgb,of.x),of.y);
      Ee=mix(mix(texelFetch(uPBin,b00+oE,0).rgb,texelFetch(uPBin,b10+oE,0).rgb,of.x),
             mix(texelFetch(uPBin,b01+oE,0).rgb,texelFetch(uPBin,b11+oE,0).rgb,of.x),of.y);
      En=mix(mix(texelFetch(uPBin,b00+oN,0).rgb,texelFetch(uPBin,b10+oN,0).rgb,of.x),
             mix(texelFetch(uPBin,b01+oN,0).rgb,texelFetch(uPBin,b11+oN,0).rgb,of.x),of.y);
    }
    Esum+=max(E,vec3(0.))*w; Asum+=max(Ea,vec3(0.))*w;
    EEsum+=max(Ee,vec3(0.))*w; NNsum+=max(En,vec3(0.))*w;
    covSum+=cov*w; wsum+=w;
  }
  if(wsum<1e-4) return ambIrr(n);
  vec3 Ebase=Esum/wsum, Eamb=Asum/wsum, Eemit=EEsum/wsum, Enee=NNsum/wsum;
  float cov01=clamp(covSum/wsum/3.14159265, 0., 1.);
  // 射线聚集的分账(base,及 NEE 关时的 emit)服从 miss 策略;NEE 解析直射精确不动
  vec3 Eray = Ebase + (uNEE<.5 ? Eemit : vec3(0.));
  vec3 E_ = (uMissMode>.5) ? Eray/max(cov01,.06) : Eray + Eamb*uAmbStrength;
  if(uNEE>.5) E_ += Enee;
  return E_;
}

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
    vec4 ne = vec4(0.5, 0.5, 1.0, 0.35);
    if (uHasNrm > 0.5) {
        float ul = 0.5 + (qx - uFootQ.x) / max(uCharW, 1e-5);
        float vl = 1.0 - h / max(uCharH, 1e-5);
        if (uFlipX > 0.5) ul = 1.0 - ul;
        vec2 uvn = uNrmRect.xy + clamp(vec2(ul, vl), 0.0, 1.0) * uNrmRect.zw;
        ne = texture(uNrm, uvn);
    }
    vec3 n = normalize(vec3(-(ne.r*2.-1.), -(ne.g*2.-1.), -max(ne.b,.05)));
    if (uFlipX > 0.5) n.x = -n.x;
    n = normalize(mix(n, vec3(0.,0.,-1.), uFlatten));

    vec3 q = vec3(qx,
                  uFootQ.y + h * uCosT,
                  uFootQ.z - h * uSinT - ne.a * uBulge);

    if (uShowN > 0.5) { finalColor = vec4((n*.5+.5) * color.a, color.a); return; }

    // ---------- E:RT gather 或 probe 图集 ----------
    vec3 E = (uMode < 0.5) ? gatherRT(q + n*0.02, n) : probeE(q, n);

    // 太阳:独立解析直射(与投影阴影方位解耦)
    if (uSunOn > 0.5) {
        float ndl = max(dot(n, uSunDirQ), 0.0);
        E += uSunColor * ndl;
    }

    // ---------- albedo × E(实验室同式;pgain 是实验室预览增益,游戏不消费) ----------
    vec3 alb = color.rgb / max(color.a, 1e-4);   // Pixi 预乘 → 直通 albedo
    vec3 col = srgb2lin(alb) * E / 3.14159265 * uBeta;
    vec3 outRgb = clamp(lin2srgb(col), 0.0, 1.0);

    // ---------- 保留:游戏侧 sprite 空间 AO ----------
    float vy = clamp(vTextureCoord.y, 0.0, 1.0);
    float contact = uAOContact * smoothstep(0.78, 1.0, vy);
    float form = uAOForm * vy;
    float ao = clamp(1.0 - contact - form, 0.0, 1.0);
    outRgb *= ao;

    finalColor = vec4(outRgb * color.a, color.a);
}
`;

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
  ambSH: Float32Array;           // 27
  lightsQ: Float32Array;         // 48×4
  lightsE: Float32Array;         // 48×4
  lightCount: number;
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
          uWMin: { value: new Float32Array(scene.wMin), type: 'vec3<f32>' },
          uWScale: { value: new Float32Array(scene.wScale), type: 'vec3<f32>' },
          uPN: { value: new Float32Array(scene.pn), type: 'vec3<f32>' },
          uAmbSH: { value: scene.ambSH, type: 'vec3<f32>', size: 9 },
          uLightQ: { value: scene.lightsQ, type: 'vec4<f32>', size: 48 },
          uLightE: { value: scene.lightsE, type: 'vec4<f32>', size: 48 },
          uLightCount: { value: scene.lightCount, type: 'f32' },

          uFootQ: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },
          uCharH: { value: 1.5, type: 'f32' },
          uCharW: { value: 0.6, type: 'f32' },
          uNrmRect: { value: new Float32Array([0, 0, 1, 1]), type: 'vec4<f32>' },
          uFlipX: { value: 0, type: 'f32' },
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

          uSunOn: { value: 0, type: 'f32' },
          uSunDirQ: { value: new Float32Array([0, 1, 0]), type: 'vec3<f32>' },
          uSunColor: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },

          uAOContact: { value: 0, type: 'f32' },
          uAOForm: { value: 0, type: 'f32' },
        },
        uDepthMap: depthTexture?.source ?? Texture.WHITE.source,
        uNrm: Texture.WHITE.source,
        uPL1: scene.atlasL1,
        uPL2: scene.atlasL2,
        uPBin: scene.atlasBin,
        uValid: scene.valid,
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
  setNormalTexture(src: TextureSource | null): void {
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
}
