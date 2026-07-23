/* Character lighting tool viewer v2.
 * WORLD-space probes: quad pixels are transformed q->world in-shader and
 * trilinearly interpolated in a world-axis-aligned probe volume.
 * RT gather uses double-sided folding (A7): camera-side rays trace mirrored.
 * Collision lives on a WORLD ground grid, decoupled from screen occlusion.
 * 3D inspector: orbit view of point cloud + probes + character + rays.
 */
'use strict';
const $ = id => document.getElementById(id);
const canvas = $('gl');
const gl = canvas.getContext('webgl2', {antialias: true});
if (!gl) { alert('need WebGL2'); throw 0; }

// ------------------------------------------------------------- tiny math
function f16(h){ const s=(h&0x8000)?-1:1,e=(h>>10)&31,m=h&1023;
  if(e===0) return s*m*5.96046448e-8;
  if(e===31) return m?NaN:s*Infinity;
  return s*(1+m/1024)*Math.pow(2,e-15); }
function m4perspective(fov,aspect,near,far){
  const f=1/Math.tan(fov/2), nf=1/(near-far);
  return [f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]; }
function m4ortho(hw,hh,near,far){
  return [1/hw,0,0,0, 0,1/hh,0,0, 0,0,-2/(far-near),0, 0,0,-(far+near)/(far-near),1]; }
function m4lookAt(eye,c,up){
  const z=norm3(sub3(eye,c)), x=norm3(cross3(up,z)), y=cross3(z,x);
  return [x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0,
          -dot3(x,eye),-dot3(y,eye),-dot3(z,eye),1]; }
function m4mul(a,b){ const o=new Array(16);
  for(let c=0;c<4;c++)for(let r=0;r<4;r++){ let s=0;
    for(let k=0;k<4;k++) s+=a[k*4+r]*b[c*4+k]; o[c*4+r]=s; } return o; }
const sub3=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const dot3=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross3=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm3=a=>{const l=Math.hypot(...a)||1;return [a[0]/l,a[1]/l,a[2]/l];};

// ------------------------------------------------------------- shaders
function sh(type, src){ const s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s);
  if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s; }
function prog(vs,fs){ const p=gl.createProgram();
  gl.attachShader(p,sh(gl.VERTEX_SHADER,vs)); gl.attachShader(p,sh(gl.FRAGMENT_SHADER,fs));
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p; }

const QUAD_VS = `#version 300 es
layout(location=0) in vec2 aP;
uniform vec4 uRect;
out vec2 vUV;
void main(){ vUV=aP; gl_Position=vec4(uRect.xy+aP*uRect.zw,0.,1.); }`;

const COMMON = `
vec3 srgb2lin(vec3 c){ return mix(c/12.92, pow((c+.055)/1.055, vec3(2.4)), step(.04045,c)); }
vec3 lin2srgb(vec3 c){ c=max(c,0.); return mix(c*12.92, 1.055*pow(c,vec3(1./2.4))-.055, step(.0031308,c)); }
float shY(int k, vec3 n){
  if(k==0) return .282095;
  if(k==1) return .488603*n.y;  if(k==2) return .488603*n.z;  if(k==3) return .488603*n.x;
  if(k==4) return 1.092548*n.x*n.y; if(k==5) return 1.092548*n.y*n.z;
  if(k==6) return .315392*(3.*n.z*n.z-1.);
  if(k==7) return 1.092548*n.x*n.z; return .546274*(n.x*n.x-n.y*n.y);
}`;

// LDR→HDR 恢复方法(可实验室下拉切换,即时预览;都是有出处的算子,不是手搓)。
// base=srgb2lin(bg),g01=烘焙 gain 场,uMaxGain=最大提升EV,uPA=方法参数。
const HDR_RECOVER = `
vec3 hdrRad(vec3 base, float g01){
  float L = max(dot(base, vec3(.2126,.7152,.0722)), 1e-5);
  if(uHdrMethod < 0.5){                       // 0 emitter门(烘焙 gain·当前)
    return base * exp2(g01 * uMaxGain);
  } else if(uHdrMethod < 1.5){                 // 1 逆Reinhard 全局高光展开(Banterle式)
    float k = clamp(uPA, 0., 0.985);
    return base / max(1.0 - k*L, 0.015);
  } else if(uHdrMethod < 2.5){                 // 2 全局 gamma 展开
    float g = mix(1.0, 0.34, clamp(uPA,0.,1.));
    return pow(max(base,vec3(0.)), vec3(g)) * exp2(uMaxGain*0.12);
  }                                            // 3 亮度扩展映射(Rempel/Banterle 式)
  float lo = clamp(uPA, 0., 0.9);
  float e = smoothstep(lo, min(lo+0.35,1.0), L);
  return base * (1.0 + (exp2(uMaxGain)-1.0)*e);
}`;

const BG_FS = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 frag;
uniform sampler2D uBG, uDepth, uGain, uEdit;
uniform ivec2 uWork; uniform int uDbgDepth, uDbgGain, uDbgHDR, uShowEdit, uDbgZone;
uniform float uPGain, uMaxGain, uHdrMethod, uPA;
${COMMON}
${HDR_RECOVER}
vec3 ramp(float t){
  vec3 s0=vec3(.06,.06,.24),s1=vec3(.16,.35,.78),s2=vec3(.12,.78,.82),s3=vec3(.9,.86,.16),s4=vec3(.86,.16,.12);
  t=clamp(t,0.,1.)*4.; int i=int(t); float f=fract(t);
  if(i==0)return mix(s0,s1,f); if(i==1)return mix(s1,s2,f); if(i==2)return mix(s2,s3,f); return mix(s3,s4,f);
}
// 亮度分层:恢复 HDR 的亮度按 1-EV 一层量化上色 + 层界黑线。显示区间 [-8,+6] EV(显示白=0EV)。
// EV≥+6 全钉在洋红顶层=辐射被顶到显示天花板(可判"限制");层数多=动态范围宽。
vec3 zone(float ev){
  float b=clamp(ev,-8.0,6.0);
  float t=(b+8.0)/14.0;                       // 层色:蓝(暗)→红(亮)
  vec3 col=ramp(t);
  if(ev>=6.0) col=vec3(1.0,0.15,0.9);         // 顶层洋红=撞显示天花板
  float f=fract(b);                           // 层界黑线
  float edge=1.0-smoothstep(0.0,0.10,min(f,1.0-f));
  return col*mix(1.0,0.12,edge);
}
void main(){
  vec3 c = texture(uBG, vUV).rgb;
  if(uDbgHDR==1){
    // 选中的 LDR→HDR 方法恢复辐射;预览亮度扫曝光
    float g01 = texture(uGain, vUV).r;
    vec3 L = hdrRad(srgb2lin(c), g01);
    frag = vec4(lin2srgb(L*uPGain), 1.); return;
  }
  if(uDbgZone==1){
    // 亮度分层:恢复 HDR 亮度的 EV 分带图(即时跟随恢复方法)。看动态范围有多少层、有没有撞顶。
    vec3 L=hdrRad(srgb2lin(c), texture(uGain,vUV).r);
    float ev=log2(max(dot(L,vec3(.2126,.7152,.0722)),1e-6));
    frag=vec4(lin2srgb(zone(ev)),1.); return;
  }
  if(uDbgDepth==1){ float d=texelFetch(uDepth, ivec2(vUV*vec2(uWork)),0).r; c=ramp(fract(d*.35)); }
  if(uDbgGain==1){ vec3 bl=srgb2lin(c); vec3 rd=hdrRad(bl, texture(uGain,vUV).r);
    float g=clamp(log2(max(dot(rd,vec3(.2126,.7152,.0722)),1e-5)/max(dot(bl,vec3(.2126,.7152,.0722)),1e-5))/max(uMaxGain,1e-3),0.,1.);
    c=mix(c, ramp(g), smoothstep(.02,.25,g)); }
  if(uShowEdit==1){ vec4 e=texture(uEdit, vUV); c=mix(c, e.rgb, e.a*.75); }
  frag=vec4(lin2srgb(srgb2lin(c)*uPGain),1.);
}`;

// probe/RT 那套 uniform 与函数被三个程序共用(2D 角色 CHAR_FS / 3D 角色 CHAR3D_FS /
// 全景 PANO_FS),抽成公共块——同一份数学只写一遍,免得三处漂移。
const LIGHT_UNIFORMS = `
uniform sampler2D uValid;
// probe atlases: columns [0,K)=base+cov | [K,2K)=amb | [2K,3K)=emit | [3K,4K)=nee
uniform sampler2D uPL1, uPL2, uPBin;
uniform sampler3D uVol, uVolEmit;
uniform int uNEE, uLightCount;
uniform vec4 uLightQ[48];                 // q pos + area
uniform vec4 uLightE[48];                 // emissive radiance rgb
uniform vec4 uLightN[48];                 // normal in q
uniform vec3 uQMin, uQMax;
uniform ivec3 uVolN;
uniform mat3 uM;                 // q -> world
uniform vec3 uWMin, uWScale;     // probe grid: t=(Xw-uWMin)*uWScale  in [0,PN-1]
uniform ivec3 uPN;
uniform vec3 uAmbSH[9];
uniform int uMode, uSpp, uMSteps, uFold, uMissMode;
uniform float uStep, uAmb;
// 单 probe 直查(全景「插值关」用):>=0 时跳过三线性,直接读这颗
uniform int uProbeOne;`;

const LIGHT_FNS = `
vec3 ambRad(vec3 d){
  vec3 m=vec3(d.xy, abs(d.z)); vec3 L=vec3(0.);
  for(int k=0;k<9;k++) L+=uAmbSH[k]*shY(k,m);
  return max(L,0.)*uAmb;
}
vec3 ambIrr(vec3 n){
  float A[9]=float[9](3.141593,2.094395,2.094395,2.094395,.785398,.785398,.785398,.785398,.785398);
  vec3 E=vec3(0.);
  for(int k=0;k<9;k++) E+=uAmbSH[k]*A[k]*shY(k,n);
  return max(E,0.)*uAmb;
}
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
// 射线-体素盒求交:把起点推进到盒入口(与 pipeline._ray_box_enter 同式)。
// 伪世界只覆盖画面那块 q 盒,角色带高过画面上沿是常态;起点在盒外就一步出界的老写法
// 会让上半身全 miss(cache 侧同一个坑已在烘焙里修掉,RT 必须同步才有对照价值)。
// 返回 x=进盒前要走的距离(索引空间),y<0 表示这条射线根本进不去。
vec2 boxEnter(vec3 p0, vec3 dn, vec3 hi){
  vec3 d=mix(dn, vec3(1e-6), lessThan(abs(dn), vec3(1e-6)));
  vec3 t0=(vec3(0.)-p0)/d, t1=(hi-p0)/d;
  vec3 lo3=min(t0,t1), hi3=max(t0,t1);
  float tn=max(0., max(max(lo3.x,lo3.y),lo3.z));
  float tf=min(min(hi3.x,hi3.y),hi3.z);
  return vec2(tn, tf-tn);
}
vec3 gatherRT(vec3 q0, vec3 n){
  vec3 t=normalize(abs(n.z)<.95?cross(n,vec3(0,0,1)):cross(n,vec3(1,0,0)));
  vec3 b=cross(n,t);
  vec3 scaleIdx=vec3(uVolN-1)/max(uQMax-uQMin,vec3(1e-5));
  vec3 invN=1./vec3(uVolN);
  vec3 p0=(q0-uQMin)*scaleIdx;
  float rot=hash12(gl_FragCoord.xy)*6.2831853;
  const float GA=2.399963;
  vec3 acc=vec3(0.);
  float nHit=0.;
  for(int i=0;i<192;i++){
    if(i>=uSpp) break;
    float u1=(float(i)+.5)/float(uSpp);
    float ph=float(i)*GA+rot;
    float r=sqrt(u1);
    vec3 ld=vec3(r*cos(ph), r*sin(ph), sqrt(max(0.,1.-u1)));
    vec3 dir=normalize(t*ld.x+b*ld.y+n*ld.z);
    if(uFold==1 && dir.z<0.) dir.z=-dir.z;      // A7: fold camera-side into observed half
    vec3 dn=normalize(dir*scaleIdx);
    vec3 dIdx=dn*uStep;
    vec2 be=boxEnter(p0, dn, vec3(uVolN-1));
    bool hit=false; vec3 Li=vec3(0.);
    if(be.y<0.){                                  // 进不去盒子:算 miss(下面照常补环境)
      if(uMissMode==0) acc+=ambRad(dir);
      continue;
    }
    vec3 p=p0+dn*be.x+dIdx*1.5;                   // 先推进到入口,再留 1.5 步自碰撞余量
    for(int s=0;s<256;s++){
      if(s>=uMSteps) break;
      p+=dIdx;
      if(any(lessThan(p,vec3(0.)))||any(greaterThan(p,vec3(uVolN-1)))) break;
      vec4 v=texture(uVol,(p+.5)*invN);
      if(v.a>.45){
        Li=v.rgb;                                     // base only (painting)
        if(uNEE==0) Li+=texture(uVolEmit,(p+.5)*invN).rgb;  // NEE off: emit via rays
        hit=true; break;
      }
    }
    if(hit){ acc+=Li; nHit+=1.; }
    else if(uMissMode==0) acc+=ambRad(dir);     // J-bar x strength (uAmb; 0 = miss black)
    /* uMissMode==1: miss excluded, renormalized below */
  }
  vec3 E=(uMissMode==1)?acc*(3.14159265/max(nHit,1.)):acc*(3.14159265/float(uSpp));
  if(uNEE==1){
    // exact deterministic direct: iterate ALL light surfels with shadow march
    for(int i=0;i<48;i++){
      if(i>=uLightCount) break;
      vec3 lq=uLightQ[i].xyz;
      vec3 dl=lq-q0;
      float r2=max(dot(dl,dl),0.04);
      float r=sqrt(r2);
      vec3 d=dl/r;
      float cr=max(dot(n,d),0.);   // isotropic surfel: no emitter cosine
      if(cr<=0.) continue;
      // shadow march in index space, stop ~1.8 voxels short of the light
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
        if(any(lessThan(p,vec3(0.)))||any(greaterThan(p,vec3(uVolN-1)))) break;
        if(texture(uVol,(p+.5)*invN).a>.45){ vis=0.; break; }
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
vec3 fetchCoeff(sampler2D tex,int p,int k){ return texelFetch(tex, ivec2(k,p),0).rgb; }
// 单颗 probe 的四分账解码(基函数由 uMode 决定)。八角插值与「只看一颗」共用同一份解码。
void probeFetch(int flat_, vec3 n, ivec2 ob0, vec2 of,
                out vec3 E, out vec3 Ea, out vec3 Ee, out vec3 En, out float cov){
    E=vec3(0.); Ea=vec3(0.); Ee=vec3(0.); En=vec3(0.); cov=0.;
    if(uMode==1){
      for(int k=0;k<4;k++){ vec4 q4=texelFetch(uPL1, ivec2(k,flat_),0);
        float y=shY(k,n); E+=q4.rgb*y; cov+=q4.a*y;
        Ea+=texelFetch(uPL1, ivec2(4+k,flat_),0).rgb*y;
        Ee+=texelFetch(uPL1, ivec2(8+k,flat_),0).rgb*y;
        En+=texelFetch(uPL1, ivec2(12+k,flat_),0).rgb*y; }
    } else if(uMode==2){
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
      E=q4.rgb; cov=q4.a*3.14159265;   // bins store cov/pi
      Ea=mix(mix(texelFetch(uPBin,b00+oA,0).rgb,texelFetch(uPBin,b10+oA,0).rgb,of.x),
             mix(texelFetch(uPBin,b01+oA,0).rgb,texelFetch(uPBin,b11+oA,0).rgb,of.x),of.y);
      Ee=mix(mix(texelFetch(uPBin,b00+oE,0).rgb,texelFetch(uPBin,b10+oE,0).rgb,of.x),
             mix(texelFetch(uPBin,b01+oE,0).rgb,texelFetch(uPBin,b11+oE,0).rgb,of.x),of.y);
      En=mix(mix(texelFetch(uPBin,b00+oN,0).rgb,texelFetch(uPBin,b10+oN,0).rgb,of.x),
             mix(texelFetch(uPBin,b01+oN,0).rgb,texelFetch(uPBin,b11+oN,0).rgb,of.x),of.y);
    }
}
// 四分账 → 最终 E(与运行时同式:base/emit 走 miss 策略,NEE 是解析直射直接加)
vec3 probeCompose(vec3 Ebase, vec3 Eamb, vec3 Eemit, vec3 Enee, float cov01){
  vec3 Eray = Ebase + (uNEE==0 ? Eemit : vec3(0.));
  vec3 E_ = (uMissMode==1) ? Eray/max(cov01,.06) : Eray + Eamb*uAmb;
  if(uNEE==1) E_ += Enee;
  return E_;
}
vec3 probeE(vec3 q, vec3 n){
  vec2 ouv; ivec2 ob0=ivec2(0); vec2 of=vec2(0.);
  if(uMode==3){
    ouv=octaEnc(n)*8.-.5;
    ob0=ivec2(clamp(floor(ouv),vec2(0.),vec2(6.)));
    of=clamp(ouv-vec2(ob0),0.,1.);
  }
  vec3 E,Ea,Ee,En; float cov;
  if(uProbeOne>=0){                              // 全景「插值关」:只看指定那一颗
    probeFetch(uProbeOne,n,ob0,of,E,Ea,Ee,En,cov);
    return probeCompose(max(E,vec3(0.)),max(Ea,vec3(0.)),max(Ee,vec3(0.)),max(En,vec3(0.)),
                        clamp(cov/3.14159265,0.,1.));
  }
  vec3 Xw = uM * q;                              // -> WORLD, interp axes are world
  vec3 t = clamp((Xw-uWMin)*uWScale, vec3(0.), vec3(uPN)-1.001);
  ivec3 b0=ivec3(t); vec3 f=t-vec3(b0);
  vec3 Esum=vec3(0.), Asum=vec3(0.), EEsum=vec3(0.), NNsum=vec3(0.);
  float covSum=0., wsum=0.;
  for(int c=0;c<8;c++){
    ivec3 off=ivec3(c&1,(c>>1)&1,(c>>2)&1);
    ivec3 pi=min(b0+off,uPN-1);
    float w=mix(1.-f.x,f.x,float(off.x))*mix(1.-f.y,f.y,float(off.y))*mix(1.-f.z,f.z,float(off.z));
    int flat_=pi.x*(uPN.y*uPN.z)+pi.y*uPN.z+pi.z;
    w*=step(.002, texelFetch(uValid, ivec2(flat_,0),0).r);
    if(w<1e-5) continue;
    probeFetch(flat_,n,ob0,of,E,Ea,Ee,En,cov);
    Esum+=max(E,vec3(0.))*w; Asum+=max(Ea,vec3(0.))*w;
    EEsum+=max(Ee,vec3(0.))*w; NNsum+=max(En,vec3(0.))*w;
    covSum+=cov*w; wsum+=w;
  }
  if(wsum<1e-4) return ambIrr(n);
  return probeCompose(Esum/wsum, Asum/wsum, EEsum/wsum, NNsum/wsum,
                      clamp(covSum/wsum/3.14159265, 0., 1.));
}
`;

const CHAR_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUV; out vec4 frag;
uniform sampler2D uAlb, uNrm, uDepthTex;
uniform ivec2 uWork;
uniform vec3 uFootQ;
uniform float uCharH, uCharW, uCosT, uSinT;
uniform vec4 uCal;               // ppu,_,cx,cy
uniform int uOccl, uShowN;
uniform float uBeta, uBulge, uFlatten, uPGain;
${LIGHT_UNIFORMS}
${COMMON}
${LIGHT_FNS}
void main(){
  vec4 alb=texture(uAlb,vUV);
  if(alb.a<.03) discard;
  vec4 ne=texture(uNrm,vUV);
  vec3 n=normalize(vec3(-(ne.r*2.-1.), -(ne.g*2.-1.), -max(ne.b,.05)));
  n=normalize(mix(n, vec3(0.,0.,-1.), uFlatten));
  float h=(1.-vUV.y)*uCharH;
  vec3 q=vec3(uFootQ.x+(vUV.x-.5)*uCharW,
              uFootQ.y+h*uCosT,
              uFootQ.z-h*uSinT-ne.a*uBulge);
  vec2 spx=vec2(uCal.z+q.x*uCal.x, uCal.w-q.y*uCal.x);
  ivec2 ip=ivec2(clamp(spx,vec2(0.),vec2(uWork)-1.));
  float dFront=texelFetch(uDepthTex,ip,0).r;
  // 遮挡与着色用**同一个**代理:立在伪世界里的直立 quad。该像素自己的深度 =
  // 脚点深度 − h·sinθ(往上越靠近相机)。不含 bulge——那是着色用的假法线偏移,
  // 不该影响谁挡谁。(旧写法整张 sprite 取脚点深度=相机平行 billboard,已废除)
  float qzOcc=uFootQ.z-h*uSinT;
  if(uOccl==1 && dFront<qzOcc-.045) discard;
  if(uShowN==1){ frag=vec4(n*.5+.5, alb.a); return; }
  vec3 E=(uMode==0)?gatherRT(q+n*.02,n):probeE(q,n);
  vec3 col=srgb2lin(alb.rgb)*E/3.14159265*uBeta*uPGain;
  frag=vec4(lin2srgb(col), alb.a);
}`;

// ---------------------------------------------------------------- 3D 全景
// 漫游相机被 probe 可视化包起来:每个像素的视线方向(世界)→ Mᵀ 转回 q → 取值。
// 所以你转头看到的方向**就是**世界方向。四种可视化与⑥面板同源:
//   0 irradiance E(n) / 1 亮度分层 / 2 射线命中 / 3 命中辐射 L(ω)
// 插值开:E 走 probeE 的八角三线性(= 游戏口径),射线从相机位置打;
// 插值关:E 只读 uProbeOne 那颗,射线从那颗 probe 的实际采样点打。
const PANO_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUV; out vec4 frag;
uniform vec3 uEyeQ;              // 相机(或最近 probe)在 q 空间的位置
uniform vec3 uCamR, uCamU, uCamF; // 相机基(世界)
uniform vec2 uTanHalf;           // tan(fov/2)*aspect, tan(fov/2)
uniform float uGain, uAlpha, uMaxDist;
uniform int uPanoMode, uClamped;
${LIGHT_UNIFORMS}
${COMMON}
${LIGHT_FNS}
vec3 ramp2(float t){
  vec3 s0=vec3(.06,.06,.24),s1=vec3(.16,.35,.78),s2=vec3(.12,.78,.82),s3=vec3(.9,.86,.16),s4=vec3(.86,.16,.12);
  t=clamp(t,0.,1.)*4.; int i=int(t); float f=fract(t);
  if(i==0)return mix(s0,s1,f); if(i==1)return mix(s1,s2,f); if(i==2)return mix(s2,s3,f); return mix(s3,s4,f);
}
vec3 zone2(float ev){                       // 与 BG_FS::zone 同式:1EV 一带 + 层界黑线
  float b=clamp(ev,-8.,6.);
  vec3 col=ramp2((b+8.)/14.);
  if(ev>=6.) col=vec3(1.,.15,.9);
  float f=fract(b);
  float e=1.-smoothstep(0.,.10,min(f,1.-f));
  return col*mix(1.,.12,e);
}
void main(){
  // 屏幕像素 → 世界视线 → q 空间方向(uM 正交,逆=转置:d_q = dW * uM)
  vec2 p=vUV*2.-1.;
  vec3 dW=normalize(uCamF + uCamR*p.x*uTanHalf.x + uCamU*p.y*uTanHalf.y);
  vec3 d=normalize(dW*uM);
  vec3 col;
  if(uPanoMode<=1){                          // ① E(n) / ② 亮度分层
    vec3 E=probeE(uEyeQ,d)/3.14159265;
    col = (uPanoMode==0) ? lin2srgb(E*uGain)
                         : lin2srgb(zone2(log2(max(dot(E*uGain,vec3(.2126,.7152,.0722)),1e-9))));
  }else{                                     // ③ 射线命中 / ④ 命中辐射
    vec3 scaleIdx=vec3(uVolN-1)/max(uQMax-uQMin,vec3(1e-5));
    vec3 invN=1./vec3(uVolN);
    vec3 p0=(uEyeQ-uQMin)*scaleIdx;
    vec3 dd=d; float folded=0.;
    if(uFold==1 && dd.z<0.){ dd.z=-dd.z; folded=1.; }
    vec3 dn=normalize(dd*scaleIdx);
    vec2 be=boxEnter(p0,dn,vec3(uVolN-1));
    bool hit=false; vec3 Li=vec3(0.); float trav=0.;
    if(be.y>=0.){
      float wPerIdx=length(vec3(dn.x/scaleIdx.x,dn.y/scaleIdx.y,dn.z/scaleIdx.z));
      vec3 pp=p0+dn*be.x;
      for(int s=0;s<256;s++){
        if(s>=uMSteps) break;
        pp+=dn*uStep; trav+=uStep;
        if(any(lessThan(pp,vec3(0.)))||any(greaterThan(pp,vec3(uVolN-1)))) break;
        vec4 v=texture(uVol,(pp+.5)*invN);
        if(v.a>.45){ Li=v.rgb; if(uNEE==0) Li+=texture(uVolEmit,(pp+.5)*invN).rgb;
          hit=true; trav=(be.x+trav)*wPerIdx; break; }
      }
    }
    if(uPanoMode==2){
      if(!hit) col=vec3(.08,.14,.34);                       // miss:深蓝
      else{
        col=ramp2(1.-clamp(trav/max(uMaxDist,1e-3),0.,1.)); // 近=暖 远=冷
        if(folded>.5 && mod(floor(gl_FragCoord.x)+floor(gl_FragCoord.y),2.)<.5) col*=.72;
      }
    }else{
      vec3 L = hit ? Li : ambRad(dd);
      col=lin2srgb(L*uGain);
    }
  }
  // 相机被钳进 probe 盒/体素盒时,屏幕四边描红——"这不是你站的位置的真值"
  if(uClamped==1){
    vec2 e=min(vUV,1.-vUV);
    if(min(e.x,e.y)<0.012) col=mix(col,vec3(.95,.2,.15),.85);
  }
  frag=vec4(col,uAlpha);
}`;

// 3D 里的角色 quad:立在伪世界的直立四边形,走与 2D 完全同一套着色(albedo×E/π×β)
const CHAR3D_VS = `#version 300 es
layout(location=0) in vec3 aP;    // 世界坐标
layout(location=1) in vec3 aQ;    // 对应的 q 坐标
layout(location=2) in vec2 aUV;
uniform mat4 uMVP;
out vec3 vQ; out vec2 vUVc;
void main(){ vQ=aQ; vUVc=aUV; gl_Position=uMVP*vec4(aP,1.); }`;
const CHAR3D_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec3 vQ; in vec2 vUVc; out vec4 frag;
uniform sampler2D uAlb, uNrm;
uniform float uBeta, uBulge, uFlatten, uPGain;
uniform int uShowN;
${LIGHT_UNIFORMS}
${COMMON}
${LIGHT_FNS}
void main(){
  vec4 alb=texture(uAlb,vUVc);
  if(alb.a<.03) discard;
  vec4 ne=texture(uNrm,vUVc);
  vec3 n=normalize(vec3(-(ne.r*2.-1.), -(ne.g*2.-1.), -max(ne.b,.05)));
  n=normalize(mix(n, vec3(0.,0.,-1.), uFlatten));
  vec3 q=vec3(vQ.x, vQ.y, vQ.z-ne.a*uBulge);      // 与 2D 同:bulge 只推着色位置
  if(uShowN==1){ frag=vec4(n*.5+.5, alb.a); return; }
  vec3 E=(uMode==0)?gatherRT(q+n*.02,n):probeE(q,n);
  vec3 col=srgb2lin(alb.rgb)*E/3.14159265*uBeta*uPGain;
  frag=vec4(lin2srgb(col), alb.a);
}`;

const SHADOW_FS = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 frag;
uniform float uStrength;
void main(){
  vec2 d=(vUV-.5)*2.;
  float a=(1.-smoothstep(.25,1.,length(d)))*uStrength;
  frag=vec4(0.,0.,0.,a);
}`;

// world-space POINTS / LINES for both views ------------------------------
const P3_VS = `#version 300 es
layout(location=0) in vec3 aP;
layout(location=1) in vec4 aC;    // rgb + tag/class in .a (0..255)
uniform mat4 uMVP;
uniform float uPtSize;
out vec4 vC;
void main(){ vC=aC; gl_Position=uMVP*vec4(aP,1.); gl_PointSize=uPtSize; }`;
const P3_FS = `#version 300 es
precision highp float;
in vec4 vC; out vec4 frag;
uniform vec4 uTagShow;            // show flags for tag 0..3
uniform float uPGain;
void main(){
  int tag=int(vC.a*255.+.5);
  if(tag<4 && uTagShow[tag]<.5) discard;
  frag=vec4(pow(pow(max(vC.rgb,0.),vec3(2.2))*uPGain,vec3(1./2.2)),1.);
}`;

// probe 点云专用程序:顶点色是**线性 E/π**(不是预 gamma 的 u8),片元里独立曝光后
// 才 tonemap —— 这样一根滑条就能扫出 probe 之间的相对明暗,不会被 u8 地板/天花板吃掉。
// .a=valid 标记;选中的那颗画洋红环。
const PB_VS = `#version 300 es
layout(location=0) in vec3 aP;
layout(location=1) in vec4 aE;      // 线性 E/pi + valid
uniform mat4 uMVP; uniform float uPtSize, uPtRef; uniform int uSel;
out vec4 vE; flat out int vSel;
void main(){ vE=aE; vSel=(gl_VertexID==uSel)?1:0;
  gl_Position=uMVP*vec4(aP,1.);
  // 漫游(透视)时按距离缩放,近大远小才有纵深;正交下 w≡1,uPtRef=1 即恒定大小
  float ps=uPtSize*clamp(uPtRef/max(gl_Position.w,1e-3), .45, 3.5);
  gl_PointSize=ps*(vSel==1?2.2:1.0); }`;
const PB_FS = `#version 300 es
precision highp float;
in vec4 vE; flat in int vSel; out vec4 frag;
uniform float uGain;
${COMMON}
void main(){
  vec2 d=gl_PointCoord*2.-1.; float r=length(d);
  if(r>1.) discard;
  if(vE.a<.5){ frag=vec4(.42,.10,.10,1.); return; }        // 无效 probe(格外/越界):暗红
  if(vSel==1 && r>.62){ frag=vec4(1.,.35,.85,1.); return; } // 选中:洋红环
  vec3 c=lin2srgb(max(vE.rgb,0.)*uGain);
  if(vSel==0 && r>.82) c*=.32;                              // 暗边:点与点分得开
  frag=vec4(c,1.);
}`;

// textured (scene-skinned) mesh for the 3D inspector
const MESH_VS = `#version 300 es
layout(location=0) in vec3 aP;
layout(location=1) in vec4 aC;
uniform mat4 uMVP;
out vec4 vC; out vec3 vW;
void main(){ vC=aC; vW=aP; gl_Position=uMVP*vec4(aP,1.); }`;
const MESH_FS = `#version 300 es
precision highp float;
in vec4 vC; in vec3 vW; out vec4 frag;
uniform vec4 uTagShow;
uniform sampler2D uBG, uHid;
uniform mat3 uMinv;               // world -> q (transpose of M)
uniform vec4 uCal;                // ppu,_,cx,cy
uniform ivec2 uWork;
uniform float uPGain;
void main(){
  int tag=int(vC.a*255.+.5);
  if(tag<3 && uTagShow[tag]<.5) discard;
  vec3 q = uMinv * vW;
  vec2 uv = clamp(vec2((uCal.z+q.x*uCal.x)/float(uWork.x), (uCal.w-q.y*uCal.x)/float(uWork.y)), 0., 1.);
  vec3 c = (tag==0) ? texture(uBG, uv).rgb : texture(uHid, uv).rgb;
  if(tag==2) c = mix(c, vec3(.2,.5,.3), .30);
  frag = vec4(pow(pow(max(c,0.),vec3(2.2))*uPGain, vec3(1./2.2)), 1.);
}`;
// 2D overlay lines in work-screen space
const L2_VS = `#version 300 es
layout(location=0) in vec2 aP;    // work px
layout(location=1) in vec3 aC;
uniform ivec2 uWork;
uniform vec3 uV2;                 // ox, oy, zoom
out vec3 vC;
void main(){ vC=aC; gl_PointSize=4.0;
  vec2 p=(aP-uV2.xy)*uV2.z;
  gl_Position=vec4(p.x/float(uWork.x)*2.-1., 1.-p.y/float(uWork.y)*2., 0., 1.); }`;
const L2_FS = `#version 300 es
precision highp float;
in vec3 vC; out vec4 frag;
void main(){ frag=vec4(vC,.85); }`;

const quadVBO = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0,1,0,0,1,1,1]), gl.STATIC_DRAW);
function bindQuad(){ gl.bindBuffer(gl.ARRAY_BUFFER,quadVBO);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  gl.disableVertexAttribArray(1); }

const pBG=prog(QUAD_VS,BG_FS), pChar=prog(QUAD_VS,CHAR_FS), pShadow=prog(QUAD_VS,SHADOW_FS);
const pP3=prog(P3_VS,P3_FS), pL2=prog(L2_VS,L2_FS), pMesh=prog(MESH_VS,MESH_FS);
const pProbe=prog(PB_VS,PB_FS);
const pPano=prog(QUAD_VS,PANO_FS), pChar3D=prog(CHAR3D_VS,CHAR3D_FS);

// 常驻缩略图:恢复的 HDR 场景 + 分割出的光源图。与 trace 同源(rad=linear·2^gain,
// emit=rad−base=HDR 提升量),Reinhard 色调映射一张看全动态范围,不用扫曝光。
const THUMB_FS = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 frag;
uniform sampler2D uBG, uGain, uMask;
uniform float uMaxGain, uHdrMethod, uPA, uHasMask; uniform int uMode;   // 0=HDR场景 1=光源分割 2=gain场
${COMMON}
${HDR_RECOVER}
vec3 heat(float t){
  vec3 s0=vec3(.03,.03,.08),s1=vec3(.5,.06,.5),s2=vec3(.95,.35,.05),s3=vec3(1.,.95,.6);
  t=clamp(t,0.,1.)*3.; int i=int(t); float f=fract(t);
  if(i==0)return mix(s0,s1,f); if(i==1)return mix(s1,s2,f); return mix(s2,s3,f);
}
void main(){
  vec3 base=srgb2lin(texture(uBG,vUV).rgb);
  float g01=texture(uGain,vUV).r;
  vec3 rad=hdrRad(base, g01);
  if(uMode==0){
    vec3 t=rad/(rad+vec3(1.));                 // Reinhard:全动态范围压进 [0,1]
    // alpha 携带 HDR 超出量(rad 超过显示白 1.0 的部分)→ 随 HDR最大EV 缩放,供 CPU bloom
    float excess=dot(max(rad-vec3(1.),vec3(0.)),vec3(.333));
    frag=vec4(lin2srgb(t), clamp(log(1.+excess)*.28,0.,1.)); return;
  }
  if(uMode==1){
    // 光源分割图 = emit = rad × **语义 mask**(纯 SAM3,非亮度)。烘焙已产出 mask.png:
    // 有 mask 则严格用语义分离;缺 mask(旧场景/未开语义门控)退回 HDR 提升量热力兜底。
    float m=uHasMask>.5 ? texture(uMask,vUV).r : 0.;
    vec3 emit = uHasMask>.5 ? rad*m : max(rad-base,vec3(0.));
    float e=dot(emit,vec3(.2126,.7152,.0722));
    frag=vec4(heat(log2(1.+e*4.)*.5),1.); return;  // log 压缩后热力上色
  }
  // uMode==2:**当前方法**的逐像素 HDR 提升场(提升 EV / 最大EV)。method0=集中在灯芯
  // (conf,白天无灯→黑是对的),method2=整体提亮,method3=亮区——换方法/方法参数这张立即变,
  // 不再永远是烘焙 conf。全黑=该方法在此场景没提升任何像素。
  float lb=dot(base,vec3(.2126,.7152,.0722)), lr=dot(rad,vec3(.2126,.7152,.0722));
  float liftEV=log2(max(lr,1e-5)/max(lb,1e-5));
  frag=vec4(heat(clamp(liftEV/max(uMaxGain,1e-3),0.,1.)),1.);
}`;
const pThumb=prog(QUAD_VS,THUMB_FS);
let thumbFBO=null, thumbTex=null, thumbW=0, thumbH=0;
function ensureThumbFBO(w,h){
  if(thumbFBO && thumbW===w && thumbH===h) return;
  if(thumbTex) gl.deleteTexture(thumbTex);
  if(thumbFBO) gl.deleteFramebuffer(thumbFBO);
  thumbTex=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,thumbTex);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  thumbFBO=gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER,thumbFBO);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,thumbTex,0);
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  thumbW=w; thumbH=h;
}
/** 渲染两张常驻缩略图(场景 load / 重烘后调一次;纯显示,与计算无关)。 */
function refreshThumbs(){
  if(!S.man||!S.tex.bg||!S.tex.gain) return;
  const aw=S.work.w, ah=S.work.h;
  const W=200, H=Math.max(60,Math.round(W*ah/aw));
  ensureThumbFBO(W,H);
  // HDR最大EV 用**实时滑条值**(gain.png=conf^0.72 与 maxEV 无关,故拖滑条即可实时预览,
  // 不必重烘);其余改 gain 场的参数(EV/语义门控/tau)才需重烘后由 loadScene 刷新。
  const rbg=document.getElementById('rb_gain');
  const maxGain=rbg?parseFloat(rbg.value):(S.man.params.max_gain_ev??3.32);
  const buf=new Uint8Array(W*H*4);
  for(const [mode,cid] of [[0,'thumb_hdr'],[1,'thumb_lights'],[2,'thumb_gain']]){
    gl.bindFramebuffer(gl.FRAMEBUFFER,thumbFBO);
    gl.viewport(0,0,W,H);
    gl.disable(gl.BLEND);
    gl.useProgram(pThumb); bindQuad();
    gl.uniform4f(gl.getUniformLocation(pThumb,'uRect'),-1,-1,2,2);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,S.tex.bg);
    gl.uniform1i(gl.getUniformLocation(pThumb,'uBG'),0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D,S.tex.gain);
    gl.uniform1i(gl.getUniformLocation(pThumb,'uGain'),1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D,S.tex.mask||S.tex.gain);
    gl.uniform1i(gl.getUniformLocation(pThumb,'uMask'),2);
    gl.uniform1f(gl.getUniformLocation(pThumb,'uHasMask'),S.tex.mask?1:0);
    gl.uniform1f(gl.getUniformLocation(pThumb,'uMaxGain'),maxGain);
    // 三张全用选中的恢复方法(gain 场也不再强制 method0,才能反映当前方法的实际提升)
    gl.uniform1f(gl.getUniformLocation(pThumb,'uHdrMethod'),S.hdrMethod??0);
    gl.uniform1f(gl.getUniformLocation(pThumb,'uPA'),S.hdrPA??0.7);
    gl.uniform1i(gl.getUniformLocation(pThumb,'uMode'),mode);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    const cv=document.getElementById(cid); if(!cv) continue;
    cv.width=W; cv.height=H;
    const ctx=cv.getContext('2d');
    const img=ctx.createImageData(W,H);
    // 采样已按主视图约定(image top→FBO bottom),readPixels 底行=场景顶 → 直拷即正向
    img.data.set(buf);
    // HDR 图加辉光:提升集中在 0.02% 灯芯像素,整图看着没动静;把 HDR 超出量(alpha 通道,
    // 随 HDR最大EV 缩放)扩散成暖光晕,拖 EV 就能肉眼看到灯发光变强/变弱(纯显示)。
    if(mode===0){
      const N=W*H, br=new Float32Array(N), tmp=new Float32Array(N);
      for(let i=0;i<N;i++) br[i]=buf[i*4+3]/255;    // alpha=HDR 超出量
      const R=4;
      const blur=(s,d)=>{ for(let y=0;y<H;y++)for(let x=0;x<W;x++){ let a=0,c=0;
        for(let k=-R;k<=R;k++){ const xx=x+k; if(xx>=0&&xx<W){a+=s[y*W+xx];c++;} } d[y*W+x]=a/c; }
        for(let x=0;x<W;x++)for(let y=0;y<H;y++){ let a=0,c=0;
          for(let k=-R;k<=R;k++){ const yy=y+k; if(yy>=0&&yy<H){a+=d[yy*W+x];c++;} } s[y*W+x]=a/c; } };
      blur(br,tmp); blur(br,tmp);                   // 两趟分离盒糊 → 扩散光晕
      for(let i=0;i<N;i++){ const g=Math.min(1,br[i]*6)*230;   // ×6 放大稀疏核的可见度
        img.data[i*4]=Math.min(255,img.data[i*4]+g);
        img.data[i*4+1]=Math.min(255,img.data[i*4+1]+g*0.85);
        img.data[i*4+2]=Math.min(255,img.data[i*4+2]+g*0.55);
        img.data[i*4+3]=255; }
    }
    ctx.putImageData(img,0,0);
    // 光源图叠提取出的 surfel 位置(橙圈,半径∝功率)
    if(mode===1 && S.man.lights){
      ctx.strokeStyle='#e0764a'; ctx.lineWidth=1.5;
      const cal=S.man.cal;
      for(const li of S.man.lights){
        const q=qFromWorld(li.pos);
        const sx=(cal.cx+q[0]*cal.ppu)/aw*W;
        const sy=(cal.cy-q[1]*cal.ppu)/ah*H;
        const r=Math.max(3,Math.min(12,Math.sqrt((li.power||li.area||1e-4)*4e4)));
        ctx.beginPath(); ctx.arc(sx,sy,r,0,6.283); ctx.stroke();
      }
      // 无离散光源(白天/无灯)→ emit 本就全黑,标注清楚不是坏了
      const maskPct=S.man.hdr?.mask_pixel_pct;
      if((maskPct!=null&&maskPct<0.001)||(S.man.lights.length===0)){
        ctx.fillStyle='rgba(0,0,0,.55)'; ctx.fillRect(0,H-15,W,15);
        ctx.fillStyle='#c8a86a'; ctx.font='9px sans-serif'; ctx.textAlign='center';
        ctx.fillText('本场景无离散光源→全归背景 base(正常)',W/2,H-5);
        ctx.textAlign='left';
      }
    }
  }
  gl.viewport(0,0,canvas.width,canvas.height);
  // 说明:讲清最终光照怎么从原图算出来 + 本场景提升有多稀疏(诚实交代)
  const note=document.getElementById('preview_note');
  if(note){
    const h=S.man.hdr||{};
    const nL=(S.man.lights||[]).length;
    const mName=['emitter门(只提发光体)','逆Reinhard','全局gamma','亮度扩展'][S.hdrMethod??0]||'—';
    const maskPct=h.mask_pixel_pct;
    const emitTxt=(maskPct==null)
      ? '此场景未烘语义门(emit 未分离)'
      : (maskPct<0.001
        ? '此场景<b>无离散光源</b>(白天/无灯)→ emit 全黑、全部归 base,正常'
        : `分出 <b>${maskPct.toFixed(2)}%</b> 发光像素 / <b>${nL}</b> 个 surfel`);
    note.innerHTML=
      `三张预览<b>即时跟随「HDR辐射恢复」那组参数</b>(改方法/参数不用重烘)。当前恢复法:<b>${mName}</b>。`
      +'原图整张按此法恢复成 HDR <b>rad</b> → 用<b>纯 SAM3 语义 mask</b>切成 '
      +'<b>emit=rad×mask</b>(直接光)+<b>base=rad×(1−mask)</b>(背景),两张带进体素/probe。<br>'
      +`<b>HDR提升场</b>=当前方法逐像素提了多少(全黑=这方法在此场景没提亮——换 全局gamma 或调低 方法参数试试)。`
      +`<b>光源分割</b>:${emitTxt}。满意后点<b>重烘</b>写盘(mask.png/base/emit)。`;
  }
}

function tex2D(data,w,h,ifmt,fmt,type,filter=gl.NEAREST){
  const t=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
  gl.texImage2D(gl.TEXTURE_2D,0,ifmt,w,h,0,fmt,type,data);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  return t;
}
function texImg(img,filter=gl.LINEAR){
  const t=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,img);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  return t;
}

// ------------------------------------------------------------- state
const S = {
  scenes:[], man:null, view:0, mode:0,
  spp:64, step:0.9, msteps:160, beta:0, amb:1, contact:0.55,
  qscale:1, charH:1.5, bulge:0.22, flatten:0, fold:1, missMode:0, collide:1, nee:0,
  lights:[], pgain:1, hdrMethod:0, hdrPA:0.7, v2:{zoom:1, ox:0, oy:0},
  dbg:{depth:0,walk:0,probes:0,occl:1,normal:0,rays:0,gain:0,lights:0,terrain:0},
  brush:0, brushR:12, brushS:0.15,
  editDepth:null, editDepthBaked:null, editCol:null, editDirty:false, geoStale:false,
  // 物体/地形判定:objAuto=SAM 自动结果(按分数门槛), editObj=人工覆写(1=物体 2=地形)
  objAuto:null, editObj:null, objIds:null, objMeta:null, objScoreMin:0.35, topPoly:[],
  hotInstance:0,                                   // 悬停/选中的实例(两视图联动高亮)
  frontD:null, walkD2:null,
  pcShow:[1,1,1], meshMode:1, meshTris:0,
  footW:{x:0,z:0},           // WORLD position
  keys:{},
  work:{w:512,h:288}, charAspect:0.5,
  walk:null,                  // {nx,nz,x0,z0,dx,dz,y:Float32Array,mask:Uint8Array}
  M:null,                     // world matrix rows (3x3, q->world)
  occCPU:null,                // volume occupancy for CPU ray viz
  volU16:null, volEmitU16:null,   // 体素辐射(CPU 侧,给 probe 射线取命中辐射用)
  rays:null,                  // {q:Float32Array lines, w:Float32Array, col:...}
  // 3D 相机:fly=第一人称漫游(透视),orbit=老的绕中心正交检视;共用 yaw/pitch,切换不跳视角
  cam:{mode:'fly',yaw:-0.7,pitch:0.45,dist:10,tgt:[0,0,0],pos:[0,0,0],speed:4,fov:60,far:400},
  probe:null,                 // CPU 侧 probe 全量(四分账 × 三基),给检视面板/点云配色
  probeDC:null, probeGain:1, selProbe:null, pbGain:1, pbBasisSel:0, pbRays:1,
  // 3D 全景:mode -1=关 / 0=E(n) / 1=亮度分层 / 2=射线命中 / 3=命中辐射
  // blend 0=全是全景,1=全是 mesh;interp 关=只看最近那颗 probe
  pano:{mode:-1, blend:0.35, interp:1, drawChar:1, activeProbe:-1},
  tex:{}, bufs:{}, probeCount:0, pointCount:0,
  fps:0, frames:0, tFPS:performance.now(),
};

// no-store:重烘后同名 .bin 被覆盖,浏览器启发式缓存会喂旧字节(3D 几何不更新的元凶)→ 强制绕缓存。
async function fetchBin(u){ const r=await fetch(u,{cache:'no-store'}); if(!r.ok) throw new Error(u); return r.arrayBuffer(); }
function loadImg(u){ return new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=u; }); }
function padRGBtoRGBA16(u16rgb,count){
  const out=new Uint16Array(count*4);
  for(let i=0;i<count;i++){ out[i*4]=u16rgb[i*3]; out[i*4+1]=u16rgb[i*3+1]; out[i*4+2]=u16rgb[i*3+2]; out[i*4+3]=0x3c00; }
  return out;
}

// world <-> q (JS)
function qFromWorld(X){ const M=S.man.world.M;
  return [M[0][0]*X[0]+M[1][0]*X[1]+M[2][0]*X[2],
          M[0][1]*X[0]+M[1][1]*X[1]+M[2][1]*X[2],
          M[0][2]*X[0]+M[1][2]*X[1]+M[2][2]*X[2]]; }
function worldFromQ(q){ const M=S.man.world.M;
  return [M[0][0]*q[0]+M[0][1]*q[1]+M[0][2]*q[2],
          M[1][0]*q[0]+M[1][1]*q[1]+M[1][2]*q[2],
          M[2][0]*q[0]+M[2][1]*q[1]+M[2][2]*q[2]]; }
function screenFromQ(q){ const c=S.man.cal;
  return [c.cx+q[0]*c.ppu, c.cy-q[1]*c.ppu]; }

// walk grid access (world)
function walkIdx(wx,wz){ const w=S.walk;
  const gx=(wx-w.x0)/w.dx, gz=(wz-w.z0)/w.dz;
  return [gx,gz]; }
function walkableAt(wx,wz){ const w=S.walk;
  const [gx,gz]=walkIdx(wx,wz);
  const xi=Math.round(gx), zi=Math.round(gz);
  if(xi<1||zi<1||xi>=w.nx-1||zi>=w.nz-1) return false;
  return w.mask[zi*w.nx+xi]===1; }
function groundY(wx,wz){ const w=S.walk;
  let [gx,gz]=walkIdx(wx,wz);
  gx=Math.max(0,Math.min(w.nx-2,gx)); gz=Math.max(0,Math.min(w.nz-2,gz));
  const x0=Math.floor(gx), z0=Math.floor(gz), fx=gx-x0, fz=gz-z0, Y=w.y, nx=w.nx;
  return Y[z0*nx+x0]*(1-fx)*(1-fz)+Y[z0*nx+x0+1]*fx*(1-fz)+Y[(z0+1)*nx+x0]*(1-fx)*fz+Y[(z0+1)*nx+x0+1]*fx*fz; }

function spawnWorld(){
  const w=S.walk, n=w.nx*w.nz;
  const comp=new Int32Array(n).fill(-1), stack=new Int32Array(n);
  let bestC=-1,bestSz=0,nc=0; const cxs=[],czs=[];
  for(let i=0;i<n;i++){
    if(!w.mask[i]||comp[i]>=0) continue;
    let sp=0,size=0,sx=0,sz=0; stack[sp++]=i; comp[i]=nc;
    while(sp>0){ const j=stack[--sp]; size++;
      const x=j%w.nx, z=(j/w.nx)|0; sx+=x; sz+=z;
      if(x>0&&w.mask[j-1]&&comp[j-1]<0){comp[j-1]=nc;stack[sp++]=j-1;}
      if(x<w.nx-1&&w.mask[j+1]&&comp[j+1]<0){comp[j+1]=nc;stack[sp++]=j+1;}
      if(z>0&&w.mask[j-w.nx]&&comp[j-w.nx]<0){comp[j-w.nx]=nc;stack[sp++]=j-w.nx;}
      if(z<w.nz-1&&w.mask[j+w.nx]&&comp[j+w.nx]<0){comp[j+w.nx]=nc;stack[sp++]=j+w.nx;}
    }
    cxs.push(sx/size); czs.push(sz/size);
    if(size>bestSz){bestSz=size;bestC=nc;} nc++;
  }
  if(bestC<0){ S.footW={x:(S.man.world.x0+S.man.world.x1)/2, z:(S.man.world.z0+S.man.world.z1)/2}; return; }
  // in the biggest component, pick the cell whose PROJECTION is closest to a
  // sensible screen anchor (lower-middle of the picture = well-observed street)
  const tx=S.work.w*0.5, ty=S.work.h*0.72;
  let best=null,bd=1e18;
  for(let z=0;z<w.nz;z+=1) for(let x=0;x<w.nx;x+=1){
    if(comp[z*w.nx+x]!==bestC) continue;
    const wx=w.x0+x*w.dx, wz=w.z0+z*w.dz;
    const sp=screenFromQ(qFromWorld([wx,groundY(wx,wz),wz]));
    const d=(sp[0]-tx)**2+(sp[1]-ty)**2;
    if(d<bd){bd=d;best=[wx,wz];}
  }
  S.footW={x:best[0], z:best[1]};
}

// ------------------------------------------------------------- scene load
async function loadScene(man){
  S.man=man;
  const base=`/out/${encodeURIComponent(man.name)}`;
  // 每次 load 一个新 cache-bust 令牌:重烘后同名 png 被覆盖,Image 元素无法用 fetch 的 no-store,
  // 必须靠 query 破缓存,否则背景/gain/mask/hidden 图与几何一样喂旧帧(3D 不更新的姊妹坑)。
  const cb=`?t=${Date.now()}`;
  const W=man.work.w, H=man.work.h;
  S.work={w:W,h:H};
  const [bgImg,walkImg,gainImg,front,walky,vol,l1,l2,bins,l1a,l2a,binsa,valid,ppos,points,meshv,meshi,
         volE,l1e,l2e,binse,l1n,l2n,binsn]=await Promise.all([
    loadImg(`${base}/background.png${cb}`), loadImg(`${base}/walk_mask.png${cb}`), loadImg(`${base}/gain.png${cb}`),
    fetchBin(`${base}/front_depth.bin`), fetchBin(`${base}/walk_y.bin`),
    fetchBin(`${base}/volume.bin`), fetchBin(`${base}/probes_l1.bin`),
    fetchBin(`${base}/probes_l2.bin`), fetchBin(`${base}/probes_bins.bin`),
    fetchBin(`${base}/probes_l1amb.bin`), fetchBin(`${base}/probes_l2amb.bin`),
    fetchBin(`${base}/probes_binsamb.bin`),
    fetchBin(`${base}/probes_valid.bin`), fetchBin(`${base}/probes_pos.bin`),
    fetchBin(`${base}/points.bin`),
    fetchBin(`${base}/mesh_verts.bin`), fetchBin(`${base}/mesh_idx.bin`),
    fetchBin(`${base}/volume_emit.bin`),
    fetchBin(`${base}/probes_l1emit.bin`), fetchBin(`${base}/probes_l2emit.bin`),
    fetchBin(`${base}/probes_binsemit.bin`),
    fetchBin(`${base}/probes_l1nee.bin`), fetchBin(`${base}/probes_l2nee.bin`),
    fetchBin(`${base}/probes_binsnee.bin`),
  ]);
  canvas.width=Math.round(man.native.w/2); canvas.height=Math.round(man.native.h/2);

  S.tex.bg=texImg(bgImg);
  S.tex.gain=texImg(gainImg,gl.LINEAR);
  // 纯语义 mask(SAM3)——分离直接光/背景的依据。旧场景无 mask.png 时置空,缩略图退回兜底。
  if(S.tex.mask){ gl.deleteTexture(S.tex.mask); S.tex.mask=null; }
  try{ S.tex.mask=texImg(await loadImg(`${base}/mask.png${cb}`),gl.LINEAR); }catch(e){ S.tex.mask=null; }
  S.tex.hidden=texImg(await loadImg(`${base}/hidden.png${cb}`),gl.LINEAR);
  S.tex.depth=tex2D(new Float32Array(front),W,H,gl.R32F,gl.RED,gl.FLOAT);
  S.v2={zoom:1, ox:0, oy:0};

  // CPU depth fields for the geometry brushes
  S.frontD=new Float32Array(front);
  try{ S.walkD2=new Float32Array(await fetchBin(`${base}/walk_depth.bin`)); }catch(e){ S.walkD2=null; }
  // persisted brush edits (RG16 png for depth delta, L png 0/1/2 for collision)
  S.editDepth=new Float32Array(W*H); S.editCol=new Uint8Array(W*H); S.editDirty=false;
  async function tryEdit(url, decode){
    try{ const img=await loadImg(url+'?t='+Date.now());
      const c2=document.createElement('canvas'); c2.width=W; c2.height=H;
      const x2=c2.getContext('2d'); x2.drawImage(img,0,0,W,H);
      decode(x2.getImageData(0,0,W,H).data);
    }catch(e){/* no edits yet */}
  }
  await tryEdit(`${base}/depth_edit.png`, d=>{
    for(let i=0;i<W*H;i++){ const u16=d[i*4]*256+d[i*4+1];
      S.editDepth[i]=(u16-32768)/32768*2.0; } });
  await tryEdit(`${base}/collision_edit.png`, d=>{
    for(let i=0;i<W*H;i++) S.editCol[i]=d[i*4]; });
  // 物体识别结果(实例 id 图 RG 编码 + 元信息)与人工覆写层
  S.editObj=new Uint8Array(W*H); S.objAuto=new Uint8Array(W*H);
  S.objIds=new Uint16Array(W*H); S.objMeta=null;
  try{
    const meta=await (await fetch(`${base}/objects_${man.hash}.json?t=`+Date.now())).json();
    S.objMeta=new Map(meta.map(m=>[m.id,m]));
    const img=await loadImg(`${base}/objects_${man.hash}.png?t=`+Date.now());
    const c3=document.createElement('canvas'); c3.width=W; c3.height=H;
    const x3=c3.getContext('2d',{willReadFrequently:true});
    x3.imageSmoothingEnabled=false;                 // id 图必须最近邻,插值会造出不存在的 id
    x3.drawImage(img,0,0,W,H);
    const d3=x3.getImageData(0,0,W,H).data;
    for(let i=0;i<W*H;i++) S.objIds[i]=(d3[i*4]<<8)|d3[i*4+1];
    recomputeObjAuto();
  }catch(e){ S.objMeta=null; }                      // 尚未跑过物体识别的旧场景
  await tryEdit(`${base}/object_edit.png`, d=>{
    for(let i=0;i<W*H;i++) S.editObj[i]=d[i*4]; });
  S.editDepthBaked=S.editDepth.slice();
  if(!S.tex.edit){ /* created lazily in refreshEditOverlay */ }
  refreshEditOverlay();
  refreshGeoStatus(man.name);

  // world walk grid
  const wk=man.walk;
  const c2=document.createElement('canvas'); c2.width=wk.nx; c2.height=wk.nz;
  const cx2=c2.getContext('2d'); cx2.drawImage(walkImg,0,0,wk.nx,wk.nz);
  const idata=cx2.getImageData(0,0,wk.nx,wk.nz).data;
  const mask=new Uint8Array(wk.nx*wk.nz);
  for(let i=0;i<mask.length;i++) mask[i]=idata[i*4]>127?1:0;
  S.walk={...wk, y:new Float32Array(walky), mask};

  // volume 3D + CPU occupancy for ray viz
  const V=man.vol;
  const volU16=new Uint16Array(vol);
  const t3=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D,t3);
  gl.texImage3D(gl.TEXTURE_3D,0,gl.RGBA16F,V.Nx,V.Ny,V.Nz,0,gl.RGBA,gl.HALF_FLOAT,volU16);
  for(const [p,v] of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],
      [gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_R,gl.CLAMP_TO_EDGE]])
    gl.texParameteri(gl.TEXTURE_3D,p,v);
  S.tex.vol=t3;
  const nvox=V.Nx*V.Ny*V.Nz;
  const occ=new Uint8Array(nvox);
  for(let i=0;i<nvox;i++) occ[i]=volU16[i*4+3]>=0x3800?1:0;   // a>=0.5-ish
  S.occCPU=occ;
  // 已经在内存里的同一块 buffer,留着引用即可(零额外分配):probe 射线要取命中处的辐射
  S.volU16=volU16; S.volEmitU16=new Uint16Array(volE);

  // probe ATLASES: per basis one texture, columns = [base+cov | amb | emit | nee]
  // (fragment sampler budget: 18 separate textures blew past the GL limit of 16)
  const P=man.probes, Pn=P.nx*P.ny*P.nz;
  function atlas4(mainBuf, ambBuf, emitBuf, neeBuf, K){
    const m4=new Uint16Array(mainBuf);                       // (Pn,K,4)
    const a3=new Uint16Array(ambBuf), e3=new Uint16Array(emitBuf), n3=new Uint16Array(neeBuf);
    const W=K*4, out=new Uint16Array(Pn*W*4);
    for(let p=0;p<Pn;p++){
      for(let k=0;k<K;k++){
        const o=(p*W+k)*4, i4=(p*K+k)*4;
        out[o]=m4[i4]; out[o+1]=m4[i4+1]; out[o+2]=m4[i4+2]; out[o+3]=m4[i4+3];
        const i3=(p*K+k)*3;
        const oa=(p*W+K+k)*4, oe=(p*W+2*K+k)*4, on=(p*W+3*K+k)*4;
        out[oa]=a3[i3]; out[oa+1]=a3[i3+1]; out[oa+2]=a3[i3+2]; out[oa+3]=0x3c00;
        out[oe]=e3[i3]; out[oe+1]=e3[i3+1]; out[oe+2]=e3[i3+2]; out[oe+3]=0x3c00;
        out[on]=n3[i3]; out[on+1]=n3[i3+1]; out[on+2]=n3[i3+2]; out[on+3]=0x3c00;
      }
    }
    return tex2D(out,W,Pn,gl.RGBA16F,gl.RGBA,gl.HALF_FLOAT);
  }
  S.tex.l1=atlas4(l1,l1a,l1e,l1n,4);
  S.tex.l2=atlas4(l2,l2a,l2e,l2n,9);
  S.tex.bins=atlas4(bins,binsa,binse,binsn,64);
  // emit volume (3D)
  const tE=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D,tE);
  gl.texImage3D(gl.TEXTURE_3D,0,gl.RGBA16F,V.Nx,V.Ny,V.Nz,0,gl.RGBA,gl.HALF_FLOAT,new Uint16Array(volE));
  for(const [p,v] of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],
      [gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_R,gl.CLAMP_TO_EDGE]])
    gl.texParameteri(gl.TEXTURE_3D,p,v);
  S.tex.volEmit=tE;
  // light list in q space (positions AND directions transform by M^T)
  S.lights=(man.lights||[]).map(li=>{
    const q=qFromWorld(li.pos);
    const nq=qFromWorld(li.normal);   // linear transform, ok for directions
    return {q, nq, e:li.radiance, area:li.area, power:li.power, world:li.pos};
  });
  S.tex.valid=tex2D(new Uint8Array(valid),Pn,1,gl.R8,gl.RED,gl.UNSIGNED_BYTE);
  S.probeCount=Pn;

  // CPU 侧留一份 probe 全量(四分账 × 三基 + 位置/有效位):点云配色与⑥检视面板都从这里读,
  // 与 GPU atlas 同源同布局(l1/l2/bins 每格 4 通道含 cov,amb/emit/nee 每格 3 通道)。
  S.probe={ Pn, nx:P.nx, ny:P.ny, nz:P.nz, gx:P.gx, gy:P.gy, gz:P.gz,
    pos:new Float32Array(ppos), valid:new Uint8Array(valid),
    l1:new Uint16Array(l1), l2:new Uint16Array(l2), bins:new Uint16Array(bins),
    l1a:new Uint16Array(l1a), l2a:new Uint16Array(l2a), binsa:new Uint16Array(binsa),
    l1e:new Uint16Array(l1e), l2e:new Uint16Array(l2e), binse:new Uint16Array(binse),
    l1n:new Uint16Array(l1n), l2n:new Uint16Array(l2n), binsn:new Uint16Array(binsn) };
  S.probeDC=new Float32Array(Pn*4);
  S.bufs.probePos=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.probePos); gl.bufferData(gl.ARRAY_BUFFER,S.probe.pos,gl.STATIC_DRAW);
  if(!S.bufs.probeE) S.bufs.probeE=gl.createBuffer();
  selectProbe(null);
  recomputeProbeDC();
  autoProbeGain();

  // point cloud interleaved (16B: 3f32 pos, 3u8 rgb, 1u8 tag)
  S.pointCount=man.point_count;
  S.bufs.cloud=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.cloud); gl.bufferData(gl.ARRAY_BUFFER,points,gl.STATIC_DRAW);
  // triangulated mesh (same 16B vertex layout + uint32 indices)
  S.meshTris=(man.mesh?man.mesh.tris:0);
  S.bufs.meshV=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.meshV); gl.bufferData(gl.ARRAY_BUFFER,meshv,gl.STATIC_DRAW);
  S.bufs.meshI=gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,S.bufs.meshI); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,meshi,gl.STATIC_DRAW);

  fitCamera();

  spawnWorld();
  S.rays=null;
  const sel=$('scene'); if(sel&&sel.value!==man.name) sel.value=man.name;
  setSlider('rb_pitch',man.params.pitch_deg); setSlider('rb_ppu',man.params.ppu_ratio);
  setSlider('rb_az',man.params.azimuth_deg??0);
  setSlider('rb_dscale',man.params.depth_scale_adj??1);
  setSlider('rb_doff',man.params.depth_offset_adj??0);
  setSlider('rb_chlo',man.params.col_h_lo??0.35);
  setSlider('rb_chhi',man.params.col_h_hi??1.3);
  const rbm=$('rb_model'); if(rbm) rbm.value=man.params.depth_model||'base';
  setSlider('rb_ev',man.params.ev); setSlider('rb_tau',man.params.occluder_tau);
  setSlider('rb_gain',man.params.max_gain_ev??3.32);
  setSlider('rb_relief',man.params.relief??1.8);
  setSlider('rb_objthr',man.params.object_score_min??0.35);
  S.objScoreMin=+(man.params.object_score_min??0.35);
  const rbf=$('rb_fold'); if(rbf) rbf.checked=!!(man.params.fold??1);
  const rbs=$('rb_sem'); if(rbs) rbs.checked=!!(man.params.semantic_gate??1);
  // HDR 恢复方法/参数:同步到烘焙值(否则 reload 后下拉回 method0,看着像"白改了")
  const hm=$('hdr_method'); if(hm){ S.hdrMethod=man.params.hdr_method??0; hm.value=String(S.hdrMethod); }
  setSlider('hdr_pa',man.params.hdr_pa??0.7); S.hdrPA=man.params.hdr_pa??0.7;
  const rf=$('fold'); if(rf){ rf.checked=!!(man.params.fold??1); S.fold=rf.checked?1:0; }
  setSlider('rb_px',man.params.probe_nx); setSlider('rb_py',man.params.probe_ny);
  setSlider('rb_pz',man.params.probe_nz); setSlider('rb_band',man.params.probe_band??1.6);
  markDirty(false);
  renderHDRPanel();
  refreshThumbs();   // 底部常驻 HDR 场景 + 光源分割条(与 trace 同源)
}

// ------------------------------------------------------------- HDR panel
function renderHDRPanel(){
  const h=S.man&&S.man.hdr; if(!h) return;
  $('hdrstats').textContent=
    `P50 ${h.p50_nits.toFixed(1)} nit   P99 ${h.p99_nits.toFixed(1)} nit\n`+
    `白天分 ${h.daylight_score.toFixed(2)}   发光像素 ${h.emitter_pixel_pct.toFixed(1)}%\n`+
    `实际最大增益 +${h.max_gain_applied_ev.toFixed(2)} EV`;
  const cv=$('hist'), ctx=cv.getContext('2d');
  ctx.clearRect(0,0,cv.width,cv.height);
  const n=h.hist_pre.length, bw=cv.width/n;
  ctx.fillStyle='#5a636b';
  for(let i=0;i<n;i++){ const v=h.hist_pre[i]; ctx.fillRect(i*bw, cv.height*(1-v), bw-1, cv.height*v); }
  ctx.fillStyle='#e0764acc';
  for(let i=0;i<n;i++){ const v=h.hist_post[i]; ctx.fillRect(i*bw, cv.height*(1-v), Math.max(1,bw*0.4), cv.height*v); }
  ctx.fillStyle='#8b939b'; ctx.font='9px monospace';
  ctx.fillText('log2 显示亮度  灰=原图  橙=HDR恢复后', 4, 10);
}

// ------------------------------------------------------------- 3D 相机
// 两种模式共用 yaw/pitch(同一套公式),所以来回切视线方向不跳:
//   fly   第一人称漫游:透视相机,pos 就是眼睛,WASD/QE 走,拖动改朝向
//   orbit 老的绕中心检视:正交相机,eye 由 tgt+yaw/pitch/dist 推出
function camForward(c=S.cam){
  return [-Math.cos(c.pitch)*Math.sin(c.yaw), -Math.sin(c.pitch), -Math.cos(c.pitch)*Math.cos(c.yaw)];
}
function camRight(c=S.cam){ const f=camForward(c); return norm3([-f[2],0,f[0]]); }
function camOrbitEye(c=S.cam){
  return [c.tgt[0]+c.dist*Math.cos(c.pitch)*Math.sin(c.yaw),
          c.tgt[1]+c.dist*Math.sin(c.pitch),
          c.tgt[2]+c.dist*Math.cos(c.pitch)*Math.cos(c.yaw)];
}
function camEye(c=S.cam){ return c.mode==='fly'?c.pos.slice():camOrbitEye(c); }
/** 当前相机的 MVP(fly=透视 / orbit=正交)。 */
function camMVP(){
  const c=S.cam, asp=canvas.width/canvas.height;
  if(c.mode==='orbit'){
    const hh=c.dist*0.42, hw=hh*asp;          // c.dist 兼作正交半高(滚轮缩放)
    return m4mul(m4ortho(hw,hh,0.02,c.dist*12), m4lookAt(camOrbitEye(c),c.tgt,[0,1,0]));
  }
  const f=camForward(c);
  const tgt=[c.pos[0]+f[0],c.pos[1]+f[1],c.pos[2]+f[2]];
  return m4mul(m4perspective(c.fov*Math.PI/180, asp, 0.05, c.far), m4lookAt(c.pos,tgt,[0,1,0]));
}
function setCamMode(m){
  const c=S.cam;
  if(m===c.mode) return;
  if(m==='fly') c.pos=camOrbitEye(c);                       // 站到当前眼位,朝向不变
  else{ const f=camForward(c);                              // 把注视点放回视线前 dist 处
    c.tgt=[c.pos[0]+f[0]*c.dist, c.pos[1]+f[1]*c.dist, c.pos[2]+f[2]*c.dist]; }
  c.mode=m;
  document.querySelectorAll('#cam_modes button').forEach(b=>b.classList.toggle('on',b.dataset.cm===m));
}
/** 载入/复位:按世界包围盒摆一个既能看全景又能立刻开走的机位。 */
function fitCamera(){
  const wd=S.man.world, c=S.cam;
  c.tgt=[(wd.x0+wd.x1)/2,(wd.y0+wd.y1)/2,(wd.z0+wd.z1)/2];
  c.dist=Math.max(wd.x1-wd.x0, wd.z1-wd.z0)*1.1;
  c.yaw=-0.7; c.pitch=0.45;
  c.pos=camOrbitEye(c);                                     // 漫游起点=老轨道默认机位
  const diag=Math.hypot(wd.x1-wd.x0, wd.y1-wd.y0, wd.z1-wd.z0);
  c.far=Math.max(60, diag*8);
  setSlider('camspeed', Math.max(0.4, Math.min(24, +(diag*0.12).toFixed(1))));
}
/** 漫游位移:限制在世界包围盒外扩一圈内,免得飞丢了找不回来。 */
function clampCam(){
  const wd=S.man&&S.man.world; if(!wd) return;
  const mx=Math.max(wd.x1-wd.x0, wd.z1-wd.z0), p=S.cam.pos;
  p[0]=Math.max(wd.x0-mx,Math.min(wd.x1+mx,p[0]));
  p[1]=Math.max(wd.y0-mx,Math.min(wd.y1+mx,p[1]));
  p[2]=Math.max(wd.z0-mx,Math.min(wd.z1+mx,p[2]));
}
let lastCam=performance.now();
function moveCam(now){
  const c=S.cam, dt=Math.min(.05,(now-lastCam)/1000); lastCam=now;
  if(c.mode!=='fly') return;
  const k=S.keys, sp=c.speed*dt*(k['Shift']?4:1);
  let fw=0,rt=0,up=0;
  if(k['w']||k['ArrowUp']) fw+=sp;
  if(k['s']||k['ArrowDown']) fw-=sp;
  if(k['d']||k['ArrowRight']) rt+=sp;
  if(k['a']||k['ArrowLeft']) rt-=sp;
  if(k['e']) up+=sp;
  if(k['q']) up-=sp;
  if(!fw&&!rt&&!up) return;
  const f=camForward(c), r=camRight(c);
  c.pos=[c.pos[0]+f[0]*fw+r[0]*rt, c.pos[1]+f[1]*fw+up, c.pos[2]+f[2]*fw+r[2]*rt];
  clampCam();
}

// ------------------------------------------------------------- ray viz (CPU)
function buildRays(){
  const man=S.man, V=man.vol;
  const cal=man.cal, cosT=Math.cos(cal.theta), sinT=Math.sin(cal.theta);
  const wy=groundY(S.footW.x,S.footW.z);
  const q0=qFromWorld([S.footW.x, wy+0.8*S.charH*S.qscale/1.5, S.footW.z]);
  const scale=[(V.Nx-1)/(V.qx_max-V.qx_min),(V.Ny-1)/(V.qy_max-V.qy_min),(V.Nz-1)/(V.qz_max-V.qz_min)];
  const p0=[(q0[0]-V.qx_min)*scale[0],(q0[1]-V.qy_min)*scale[1],(q0[2]-V.qz_min)*scale[2]];
  const NR=40, lines2=[], lines3=[], GA=2.399963;
  for(let i=0;i<NR;i++){
    const u1=(i+.5)/NR, ph=i*GA, r=Math.sqrt(u1);
    const d=[r*Math.cos(ph), r*Math.sin(ph), -Math.sqrt(Math.max(0,1-u1))];   // around n=(0,0,-1)
    // 与 RT 着色器同一套行进(含射线-盒求交:角色胸口可能已在画面上沿以外)
    const res=marchQ(p0,scale,d,S.fold,S.step,S.msteps);
    const cls=res.hit>=0?(res.folded?1:0):2;
    const pe=res.p;
    const qe=[pe[0]/scale[0]+V.qx_min, pe[1]/scale[1]+V.qy_min, pe[2]/scale[2]+V.qz_min];
    const col=cls===0?[1,0.85,0.2]:cls===1?[1,0.45,0.15]:[0.35,0.55,0.9];
    const s0=screenFromQ(q0), s1=screenFromQ(qe);
    lines2.push([...s0,...col],[...s1,...col]);
    const w0=worldFromQ(q0), w1=worldFromQ(qe);
    lines3.push([...w0,...col],[...w1,...col]);
  }
  const f2=new Float32Array(lines2.flat()), f3=new Float32Array(lines3.flat());
  if(!S.bufs.rays2) S.bufs.rays2=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.rays2); gl.bufferData(gl.ARRAY_BUFFER,f2,gl.DYNAMIC_DRAW);
  if(!S.bufs.rays3) S.bufs.rays3=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.rays3); gl.bufferData(gl.ARRAY_BUFFER,f3,gl.DYNAMIC_DRAW);
  S.rays={n2:lines2.length, n3:lines3.length};
}

// ============================================================= ⑥ probe 检视
// 选中一颗 probe → ①把它存的 irradiance cache 展开成经纬图 ②按 EV 分带看动态范围
// ③④按烘焙同参现场重追它的射线,对账「cache 说的」与「射线真看见的」。
// 全部纯可视化:不改任何烘焙数值、不重烘、不导出;解码/合成一律照抄 CHAR_FS::probeE。
const PB={ irrW:160, irrH:80, rayW:128, rayH:64,
           trace:null, traceKey:'', arrays:null, arraysKey:'',
           Ec:null, EcKey:'', EcEV:[0,0] };

// —— 与 GLSL 同式的小工具(面板和着色器必须读同一份数字,不许各写一套) ——
function shYJ(k,n){
  if(k===0) return .282095;
  if(k===1) return .488603*n[1]; if(k===2) return .488603*n[2]; if(k===3) return .488603*n[0];
  if(k===4) return 1.092548*n[0]*n[1]; if(k===5) return 1.092548*n[1]*n[2];
  if(k===6) return .315392*(3*n[2]*n[2]-1);
  if(k===7) return 1.092548*n[0]*n[2];
  return .546274*(n[0]*n[0]-n[1]*n[1]);
}
function octaEncJ(n){
  const s=Math.abs(n[0])+Math.abs(n[1])+Math.abs(n[2])||1;
  const x=n[0]/s, y=n[1]/s, z=n[2]/s;
  let p=[x,y];
  if(z<0) p=[(1-Math.abs(y))*(x>=0?1:-1), (1-Math.abs(x))*(y>=0?1:-1)];
  return [p[0]*.5+.5, p[1]*.5+.5];
}
/** 经纬展开:u 绕竖轴一圈(u=.5 → −z 朝相机),v 从 +y(上)到 −y(下)。 */
function dirFromLatLong(u,v){
  const th=Math.PI*v, st=Math.sin(th), psi=2*Math.PI*(u-.5);
  return [st*Math.sin(psi), Math.cos(th), -st*Math.cos(psi)];
}
function lin2srgbJ(v){ v=Math.max(v,0);
  return v<=.0031308 ? v*12.92 : 1.055*Math.pow(v,1/2.4)-.055; }
const lumaJ=c=>.2126*c[0]+.7152*c[1]+.0722*c[2];
function rampJ(t){                       // 与 BG_FS::ramp 同色
  const s=[[.06,.06,.24],[.16,.35,.78],[.12,.78,.82],[.9,.86,.16],[.86,.16,.12]];
  t=Math.max(0,Math.min(1,t))*4; const i=Math.min(3,Math.floor(t)), f=t-Math.floor(t);
  return [0,1,2].map(c=>s[i][c]+(s[i+1][c]-s[i][c])*f);
}
function zoneJ(ev){                      // 与 BG_FS::zone 同式:1EV 一带 + 层界黑线 + 顶层洋红
  const b=Math.max(-8,Math.min(6,ev));
  let col=rampJ((b+8)/14);
  if(ev>=6) col=[1,.15,.9];
  const f=b-Math.floor(b);
  const t=Math.max(0,Math.min(1,Math.min(f,1-f)/.10));
  const edge=1-t*t*(3-2*t);              // = 1-smoothstep(0,.1,·),层界黑线
  return col.map(v=>v*(1+(0.12-1)*edge));
}
/** miss 方向补的环境辐射,与 CHAR_FS::ambRad 同式(J̄ 用镜像 z 求值 × miss 环境强度)。 */
function ambRadJ(d){
  const sh=S.man.ambient.sh, m=[d[0],d[1],Math.abs(d[2])], L=[0,0,0];
  for(let k=0;k<9;k++){ const y=shYJ(k,m); for(let c=0;c<3;c++) L[c]+=sh[k*3+c]*y; }
  return L.map(v=>Math.max(v,0)*S.amb);
}

/** 解出一颗 probe 在某基下的四分账系数(f16→f32),按 (probe,basis) 缓存。 */
function probeBasisArrays(i,basis){
  const key=i+'|'+basis;
  if(PB.arraysKey===key) return PB.arrays;
  const D=S.probe, K=basis===1?4:basis===2?9:64;
  const M=basis===1?D.l1:basis===2?D.l2:D.bins;
  const Am=basis===1?D.l1a:basis===2?D.l2a:D.binsa;
  const Em=basis===1?D.l1e:basis===2?D.l2e:D.binse;
  const Nm=basis===1?D.l1n:basis===2?D.l2n:D.binsn;
  const m=new Float32Array(K*4), a=new Float32Array(K*3),
        e=new Float32Array(K*3), n=new Float32Array(K*3);
  for(let k=0;k<K;k++){
    for(let c=0;c<4;c++) m[k*4+c]=f16(M[(i*K+k)*4+c]);
    for(let c=0;c<3;c++){
      a[k*3+c]=f16(Am[(i*K+k)*3+c]);
      e[k*3+c]=f16(Em[(i*K+k)*3+c]);
      n[k*3+c]=f16(Nm[(i*K+k)*3+c]);
    }
  }
  PB.arrays={K,basis,m,a,e,n}; PB.arraysKey=key;
  return PB.arrays;
}
/** 单颗 probe 的 E(n):解码 + 四分账合成,与 CHAR_FS::probeE 同式(含运行时开关)。 */
function probeEvalDir(A,n){
  const base=[0,0,0], amb=[0,0,0], emi=[0,0,0], nee=[0,0,0];
  let cov=0;
  const acc=(k,w)=>{
    for(let c=0;c<3;c++){ base[c]+=A.m[k*4+c]*w; amb[c]+=A.a[k*3+c]*w;
                          emi[c]+=A.e[k*3+c]*w; nee[c]+=A.n[k*3+c]*w; }
    cov+=A.m[k*4+3]*w;
  };
  if(A.basis===3){                        // BIN:八面体双线性,与着色器同一套取样
    const uv=octaEncJ(n), ou=uv[0]*8-.5, ov=uv[1]*8-.5;
    const x0=Math.max(0,Math.min(6,Math.floor(ou))), y0=Math.max(0,Math.min(6,Math.floor(ov)));
    const fx=Math.max(0,Math.min(1,ou-x0)), fy=Math.max(0,Math.min(1,ov-y0));
    acc(y0*8+x0,(1-fx)*(1-fy)); acc(y0*8+x0+1,fx*(1-fy));
    acc((y0+1)*8+x0,(1-fx)*fy); acc((y0+1)*8+x0+1,fx*fy);
    cov*=Math.PI;                         // bins 存的是 cov/π
  }else{
    for(let k=0;k<A.K;k++) acc(k,shYJ(k,n));
  }
  const cov01=Math.max(0,Math.min(1,cov/Math.PI));
  const out=[0,0,0];
  for(let c=0;c<3;c++){
    let E=Math.max(base[c],0)+(S.nee?0:Math.max(emi[c],0));
    E=(S.missMode===1) ? E/Math.max(cov01,.06) : E+Math.max(amb[c],0)*S.amb;
    if(S.nee) E+=Math.max(nee[c],0);
    out[c]=E;
  }
  return out;
}
/** 点云配色用的 DC(各方向平均)E/π,合成规则同上,只取 L2 的 k=0 项。 */
function recomputeProbeDC(){
  const D=S.probe; if(!D||!S.probeDC) return;
  const Y0=.282095, iPI=1/Math.PI, out=S.probeDC;
  for(let i=0;i<D.Pn;i++){
    const o=i*36, o3=i*27;
    const cov01=Math.max(0,Math.min(1,f16(D.l2[o+3])*Y0/Math.PI));
    for(let c=0;c<3;c++){
      const b=Math.max(f16(D.l2[o+c])*Y0,0), a=Math.max(f16(D.l2a[o3+c])*Y0,0),
            e=Math.max(f16(D.l2e[o3+c])*Y0,0), n=Math.max(f16(D.l2n[o3+c])*Y0,0);
      let E=b+(S.nee?0:e);
      E=(S.missMode===1) ? E/Math.max(cov01,.06) : E+a*S.amb;
      if(S.nee) E+=n;
      out[i*4+c]=E*iPI;
    }
    out[i*4+3]=D.valid[i]>2?1:0;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.probeE);
  gl.bufferData(gl.ARRAY_BUFFER,out,gl.DYNAMIC_DRAW);
}
function probeDotColor(i){               // 2D 叠加层的 probe 点色(CPU 端 tonemap)
  const C=S.probeDC;
  if(!C||!S.probe||i>=S.probe.Pn) return [.3,1,.5];
  if(C[i*4+3]<.5) return [.42,.10,.10];  // 无效 probe:暗红
  const g=S.probeGain;
  return [lin2srgbJ(C[i*4]*g), lin2srgbJ(C[i*4+1]*g), lin2srgbJ(C[i*4+2]*g)];
}
/** 载入场景时给 probe 亮度一个能看出相对明暗的起点(纯显示,不落盘)。 */
function autoProbeGain(){
  const D=S.probe, C=S.probeDC; if(!D) return;
  const v=[];
  for(let i=0;i<D.Pn;i++) if(C[i*4+3]>.5) v.push(lumaJ([C[i*4],C[i*4+1],C[i*4+2]]));
  v.sort((a,b)=>a-b);
  const p90=v.length?v[Math.min(v.length-1,Math.floor(v.length*.9))]:0;
  const ev=Math.max(-4,Math.min(12,p90>1e-7?Math.round(Math.log2(.75/p90)*4)/4:0));
  setSlider('probegain', ev);
  setSlider('pb_gain', ev);        // ⑥面板的展开图给同一个起点(之后各调各的)
}

/** 射线-体素盒求交,与 pipeline._ray_box_enter / GLSL boxEnter 同式。 */
function boxEnterJ(p0, di, N){
  let tn=0, tf=1e30;
  for(let a=0;a<3;a++){
    const d=Math.abs(di[a])<1e-9?1e-9:di[a];
    const t0=(0-p0[a])/d, t1=((N[a]-1)-p0[a])/d;
    tn=Math.max(tn,Math.min(t0,t1)); tf=Math.min(tf,Math.max(t0,t1));
  }
  return tf>=tn ? tn : -1;
}
/** 体素里追一条射线,与 pipeline._trace 同参(默认 0.9 体素步长、220 步、折叠镜像 z)。
 *  起点允许在盒外(角色带高过画面上沿是常态):先推进到盒入口再走。 */
function marchQ(p0, sc, d, fold, step=0.9, maxSteps=220){
  let folded=0;
  if(fold && d[2]<0){ d=[d[0],d[1],-d[2]]; folded=1; }
  const di=norm3([d[0]*sc[0],d[1]*sc[1],d[2]*sc[2]]);
  const V=S.man.vol, occ=S.occCPU;
  const wPerIdx=Math.hypot(di[0]/sc[0], di[1]/sc[1], di[2]/sc[2]);   // 1 索引单位 = 多少世界单位
  const tn=boxEnterJ(p0,di,[V.Nx,V.Ny,V.Nz]);
  if(tn<0) return {hit:-1, folded, dir:d, dist:maxSteps*step*wPerIdx, p:[...p0]};   // 进不去=纯 miss
  const p=[p0[0]+di[0]*tn, p0[1]+di[1]*tn, p0[2]+di[2]*tn];
  let hit=-1, steps=0;
  for(let s=0;s<maxSteps;s++){
    p[0]+=di[0]*step; p[1]+=di[1]*step; p[2]+=di[2]*step; steps++;
    const xi=Math.round(p[0]), yi=Math.round(p[1]), zi=Math.round(p[2]);
    if(xi<0||yi<0||zi<0||xi>=V.Nx||yi>=V.Ny||zi>=V.Nz) break;
    if(occ[(zi*V.Ny+yi)*V.Nx+xi]){ hit=(zi*V.Ny+yi)*V.Nx+xi; break; }
  }
  // 距离从**真实起点**算(含盒外飞过来那一段),画线和统计才对得上
  return {hit, folded, dir:d, dist:(tn+steps*step)*wPerIdx, p};
}
function probeVolFrame(i){               // 该 probe 的体素索引原点 + 索引/q 比例
  const D=S.probe, V=S.man.vol;
  const q=qFromWorld([D.pos[i*3],D.pos[i*3+1],D.pos[i*3+2]]);
  const sc=[(V.Nx-1)/(V.qx_max-V.qx_min),(V.Ny-1)/(V.qy_max-V.qy_min),(V.Nz-1)/(V.qz_max-V.qz_min)];
  return {q, sc, p0:[(q[0]-V.qx_min)*sc[0],(q[1]-V.qy_min)*sc[1],(q[2]-V.qz_min)*sc[2]],
          fold:(S.man.params.fold??1)?1:0};
}
/** 经纬全景重追:每像素一条射线,产出命中距离/类别/命中辐射,供③④与统计用。 */
function traceProbePanorama(i,W,H){
  const F=probeVolFrame(i), V=S.man.vol;
  const dist=new Float32Array(W*H), cls=new Uint8Array(W*H), rad=new Float32Array(W*H*3);
  // 统计按**立体角**加权(经纬图每行的权重 ∝ sinθ),否则两极被严重高估,
  // 命中率也就没法跟 cache 里存的 cov(=真实命中立体角占比)对账。
  let wHit=0,wFold=0,wAll=0,sumD=0,minD=1e9,maxD=0,nHit=0;
  for(let y=0;y<H;y++){
  const sw=Math.sin(Math.PI*(y+.5)/H);
  for(let x=0;x<W;x++){
    const r=marchQ(F.p0,F.sc,dirFromLatLong((x+.5)/W,(y+.5)/H),F.fold);
    const o=y*W+x;
    wAll+=sw;
    if(r.hit>=0){
      cls[o]=r.folded?1:0; dist[o]=r.dist;
      wHit+=sw; if(r.folded) wFold+=sw; nHit++;
      sumD+=r.dist*sw; minD=Math.min(minD,r.dist); maxD=Math.max(maxD,r.dist);
      for(let c=0;c<3;c++){
        let v=f16(S.volU16[r.hit*4+c]);
        if(!S.nee) v+=f16(S.volEmitU16[r.hit*4+c]);   // NEE 关时 emit 走射线(同 gatherRT)
        rad[o*3+c]=v;
      }
    }else{
      cls[o]=2;
      const L=ambRadJ(r.dir);
      rad[o*3]=L[0]; rad[o*3+1]=L[1]; rad[o*3+2]=L[2];
    }
  }}
  return {dist,cls,rad,n:W*H,nHit,
          hitFrac:wAll?wHit/wAll:0, foldFrac:wHit?wFold/wHit:0, maxDist:maxD||1,
          meanDist:wHit?sumD/wHit:0, minDist:nHit?minD:0};
}
/** 稀疏射线(96 条)用于 3D/2D 里画线:黄=命中 橙=折叠命中 蓝=miss。 */
function buildProbeRayLines(i){
  const F=probeVolFrame(i), V=S.man.vol, D=S.probe;
  const org=[D.pos[i*3],D.pos[i*3+1],D.pos[i*3+2]];
  const q0=F.q, s0=screenFromQ(q0);
  const NR=96, l2=[], l3=[];
  for(let k=0;k<NR;k++){                 // fib 球面,与烘焙的方向集同构
    const t=(k+.5)/NR, z=1-2*t, r=Math.sqrt(Math.max(0,1-z*z)), ph=Math.PI*(3-Math.sqrt(5))*k;
    const res=marchQ(F.p0,F.sc,[r*Math.cos(ph), r*Math.sin(ph), z],F.fold);
    const qe=[res.p[0]/F.sc[0]+V.qx_min, res.p[1]/F.sc[1]+V.qy_min, res.p[2]/F.sc[2]+V.qz_min];
    const col=res.hit<0?[.35,.55,.9]:(res.folded?[1,.45,.15]:[1,.85,.2]);
    const s1=screenFromQ(qe), w1=worldFromQ(qe);
    l2.push([...s0,...col],[...s1,...col]);
    l3.push([...org,...col],[...w1,...col]);
  }
  if(!S.bufs.pbRay2) S.bufs.pbRay2=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.pbRay2);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(l2.flat()),gl.DYNAMIC_DRAW);
  if(!S.bufs.pbRay3) S.bufs.pbRay3=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.pbRay3);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(l3.flat()),gl.DYNAMIC_DRAW);
  S.pbLines={n2:l2.length, n3:l3.length};
}

// —— 选中 / 拾取 ——
function selectProbe(i){
  S.selProbe=i;
  PB.trace=null; PB.traceKey=''; PB.arraysKey=''; PB.EcKey=''; S.pbLines=null;
  if(i==null){ $('probe_sec').style.display='none'; return; }
  buildProbeRayLines(i);
  renderProbePanel();
  // 滚到面板顶(减去吸顶条高度),别让 sticky topbar 盖住读数
  const panel=$('probe_sec').parentElement;
  panel.scrollTop=Math.max(0, $('probe_sec').offsetTop-$('topbar').offsetHeight-8);
}
function projectToCanvas(mvp,X){
  const cw=mvp[3]*X[0]+mvp[7]*X[1]+mvp[11]*X[2]+mvp[15];
  if(cw<=1e-6) return null;
  const cx=(mvp[0]*X[0]+mvp[4]*X[1]+mvp[8]*X[2]+mvp[12])/cw;
  const cy=(mvp[1]*X[0]+mvp[5]*X[1]+mvp[9]*X[2]+mvp[13])/cw;
  return [(cx*.5+.5)*canvas.width, (1-(cy*.5+.5))*canvas.height];
}
function pickProbe3D(e){
  if(!S.probe||!S.dbg.probes) return;
  const r=canvas.getBoundingClientRect();
  const mx=(e.clientX-r.left)/r.width*canvas.width, my=(e.clientY-r.top)/r.height*canvas.height;
  if(mx<0||my<0||mx>canvas.width||my>canvas.height) return;
  // 屏幕距离先筛,再在"差不多同样近"的候选里取**离相机最近**的那颗——
  // 密集晶格从内部看时一条视线上串着好几颗,不这样会选到后面被挡住的。
  const mvp=camMVP(), D=S.probe, eye=camEye();
  const cand=[];
  for(let i=0;i<D.Pn;i++){
    const X=[D.pos[i*3],D.pos[i*3+1],D.pos[i*3+2]];
    const p=projectToCanvas(mvp,X);
    if(!p) continue;
    const d=(p[0]-mx)**2+(p[1]-my)**2;
    if(d<20*20) cand.push({i,d,z:(X[0]-eye[0])**2+(X[1]-eye[1])**2+(X[2]-eye[2])**2});
  }
  selectProbe(pickNearest(cand));        // 点空处 = 取消选中
}
/** 候选里选:屏幕最近的那批(与最优相差 <6px)中取离视点最近的。 */
function pickNearest(cand){
  if(!cand.length) return null;
  const bd=Math.min(...cand.map(c=>c.d));
  const tie=cand.filter(c=>c.d<=Math.max(bd,36));
  return tie.reduce((a,b)=>b.z<a.z?b:a).i;
}
function pickProbe2D(px,py){
  if(!S.probe) return false;
  const P=S.man.probes, thr=(10/S.v2.zoom)**2, cand=[];
  for(let i=0;i<P.nx;i++)for(let j=0;j<P.ny;j++)for(let k=0;k<P.nz;k++){
    const q=qFromWorld([P.gx[i],P.gy[j],P.gz[k]]);
    const sp=screenFromQ(q);
    const d=(sp[0]-px)**2+(sp[1]-py)**2;
    if(d<thr) cand.push({i:(i*P.ny+j)*P.nz+k, d, z:q[2]});   // q.z 小=更靠近相机
  }
  const best=pickNearest(cand);
  if(best==null) return false;
  selectProbe(best);
  return true;
}
function probeRefresh(){                 // 影响 probe 合成的运行时开关变了
  if(!S.probe) return;
  recomputeProbeDC();
  if(S.selProbe!=null) renderProbePanel();
}

// —— 面板绘制 ——
function paintMap(cv,W,H,fn){
  const ctx=cv.getContext('2d'), img=ctx.createImageData(W,H);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const c=fn(x,y), o=(y*W+x)*4;
    img.data[o]=Math.max(0,Math.min(255,c[0]*255));
    img.data[o+1]=Math.max(0,Math.min(255,c[1]*255));
    img.data[o+2]=Math.max(0,Math.min(255,c[2]*255));
    img.data[o+3]=255;
  }
  ctx.putImageData(img,0,0);
  ctx.strokeStyle='rgba(255,255,255,.22)'; ctx.lineWidth=1;   // 十字辅助线:中=朝相机/水平
  ctx.beginPath(); ctx.moveTo(W/2,0); ctx.lineTo(W/2,H);
  ctx.moveTo(0,H/2); ctx.lineTo(W,H/2); ctx.stroke();
}
function renderProbePanel(){
  const i=S.selProbe, sec=$('probe_sec');
  if(i==null||!S.probe||!S.man){ sec.style.display='none'; return; }
  sec.style.display='';
  const D=S.probe, P=S.man.probes, iPI=1/Math.PI, g=S.pbGain;
  const basis=S.pbBasisSel||(S.mode===0?2:S.mode);
  const A=probeBasisArrays(i,basis);
  const W1=PB.irrW, H1=PB.irrH;

  // ① irradiance cache 展开(存的是 E(n);按白色朗伯的出射亮度 E/π 显示,与角色着色同口径)
  // 展开一次要 12800 次基函数求值,按(probe/基/合成开关)缓存——拖「可视化亮度」时只重上色。
  const eKey=[i,basis,S.nee,S.missMode,S.amb.toFixed(3)].join('|');
  if(PB.EcKey!==eKey){
    const Ec=new Float32Array(W1*H1*3);
    let lo=1e9, hi=-1e9;
    for(let y=0;y<H1;y++)for(let x=0;x<W1;x++){
      const E=probeEvalDir(A,dirFromLatLong((x+.5)/W1,(y+.5)/H1)), o=(y*W1+x)*3;
      Ec[o]=E[0]*iPI; Ec[o+1]=E[1]*iPI; Ec[o+2]=E[2]*iPI;
      const l=lumaJ([Ec[o],Ec[o+1],Ec[o+2]]);
      if(l>1e-9){ const ev=Math.log2(l); lo=Math.min(lo,ev); hi=Math.max(hi,ev); }
    }
    PB.Ec=Ec; PB.EcEV=[lo,hi]; PB.EcKey=eKey;
  }
  const Ec=PB.Ec, [evMin,evMax]=PB.EcEV;
  paintMap($('pb_irr'),W1,H1,(x,y)=>{ const o=(y*W1+x)*3;
    return [lin2srgbJ(Ec[o]*g), lin2srgbJ(Ec[o+1]*g), lin2srgbJ(Ec[o+2]*g)]; });
  // ② 亮度分层:曝光后按 1EV 分带(带数=动态范围,洋红=撞显示天花板)
  paintMap($('pb_zone'),W1,H1,(x,y)=>{ const o=(y*W1+x)*3;
    const l=lumaJ([Ec[o],Ec[o+1],Ec[o+2]])*g;
    return zoneJ(Math.log2(Math.max(l,1e-9))).map(lin2srgbJ); });

  // ③④ 射线:同一颗 probe + 同一组开关只追一次(amb 会改 miss 的补光,故进 key)
  const key=[i,S.nee,S.man.params.fold??1,S.amb.toFixed(3)].join('|');
  if(PB.traceKey!==key){ PB.trace=traceProbePanorama(i,PB.rayW,PB.rayH); PB.traceKey=key; }
  const T=PB.trace, W2=PB.rayW, H2=PB.rayH;
  paintMap($('pb_hit'),W2,H2,(x,y)=>{ const o=y*W2+x;
    if(T.cls[o]===2) return [.08,.14,.34];                       // miss:深蓝
    let c=rampJ(1-Math.min(1,T.dist[o]/T.maxDist));              // 近=暖 远=冷
    if(T.cls[o]===1 && ((x+y)&1)) c=c.map(v=>v*.72);             // 折叠命中:交错纹压暗
    return c; });
  paintMap($('pb_rad'),W2,H2,(x,y)=>{ const o=(y*W2+x)*3;
    return [lin2srgbJ(T.rad[o]*g), lin2srgbJ(T.rad[o+1]*g), lin2srgbJ(T.rad[o+2]*g)]; });

  // 文字读数
  const ny=P.ny, nz=P.nz;
  const gi=Math.floor(i/(ny*nz)), gj=Math.floor(i/nz)%ny, gk=i%nz;
  const gpos=[P.gx[gi],P.gy[gj],P.gz[gk]];
  const wpos=[D.pos[i*3],D.pos[i*3+1],D.pos[i*3+2]];
  const snap=Math.hypot(wpos[0]-gpos[0],wpos[1]-gpos[1],wpos[2]-gpos[2]);
  const C=S.probeDC, dc=[C[i*4],C[i*4+1],C[i*4+2]], dcL=lumaJ(dc);
  const o3=i*27, Y0=.282095;
  const acc=(buf,off)=>lumaJ([0,1,2].map(c=>Math.max(f16(buf[off+c])*Y0,0)))*iPI;
  const covDC=Math.max(0,Math.min(1,f16(D.l2[i*36+3])*Y0*iPI));   // cov 的 DC = 命中立体角占比
  const bn=['—','L1(4)','L2(9)','BIN(8×8)'][basis];
  $('pb_title').textContent=`#${i}`;
  $('pb_info').textContent=
    `格点(${gi},${gj},${gk})  ${D.valid[i]>2?'有效':'⚠无效(不参与插值)'}`+
    `  ${snap>1e-3?`吸附 ${snap.toFixed(2)}m`:'未吸附'}\n`+
    `world(${wpos[0].toFixed(2)}, ${wpos[1].toFixed(2)}, ${wpos[2].toFixed(2)})   基=${bn}\n`+
    `E/π 平均 ${dcL.toExponential(2)} (${(dcL>0?Math.log2(dcL):-99).toFixed(1)} EV)`+
    `   展开图跨度 ${evMin>1e8?'—':evMin.toFixed(1)}…${evMax<-1e8?'—':evMax.toFixed(1)} EV\n`+
    `分账DC  base ${acc(D.l2,i*36).toExponential(1)}`+
    `  amb ${acc(D.l2a,o3).toExponential(1)}`+
    `  emit ${acc(D.l2e,o3).toExponential(1)}`+
    `  nee ${acc(D.l2n,o3).toExponential(1)}\n`+
    `射线 ${T.n}(立体角加权) 命中 ${(T.hitFrac*100).toFixed(1)}%`+
    `(其中折叠 ${(T.foldFrac*100).toFixed(0)}%)  miss ${((1-T.hitFrac)*100).toFixed(1)}%\n`+
    // 对账:cache 里存的 cov(DC)就是真实命中立体角占比,与现追命中率应当一致
    `cache cov ${(covDC*100).toFixed(1)}% ${Math.abs(covDC-T.hitFrac)>.08?'⚠与现追差得多(cache/几何可能对不上)':'≈ 现追,一致'}\n`+
    `命中距离 最近 ${T.minDist.toFixed(2)}m 平均 ${T.meanDist.toFixed(2)}m 最远 ${T.maxDist.toFixed(2)}m`+
    ((S.man.params.fold??1)?'\n③④ 烘焙折叠开:朝相机的方向被镜像回观测半球,展开图左右两半沿 ±x 轴对称是正常的':'');
}

// ------------------------------------------------------------- geometry brush
/** SAM 实例 + 分数门槛 → 自动物体掩膜(改门槛不用重跑推理,元信息里带分数) */
function recomputeObjAuto(){
  if(!S.objIds||!S.objMeta) return;
  const n=S.objAuto.length;
  for(let i=0;i<n;i++){
    const id=S.objIds[i];
    const m=id?S.objMeta.get(id):null;
    S.objAuto[i]=(m&&m.score>=S.objScoreMin)?1:0;
  }
}
/** 点选整个实例翻转:比多边形快,适合「这座楼判错了」这种整块改判。
 *  写的是覆写层而非自动结果——重烘后 SAM 重算,人工决定仍然优先。 */
function flipInstance(id){
  if(!id||!S.objIds||!S.editObj) return 0;
  let first=-1, n=0;
  for(let i=0;i<S.objIds.length;i++) if(S.objIds[i]===id){ first=i; break; }
  if(first<0) return 0;
  const val=isObjectAt(first)?2:1;                 // 当前是物体 → 翻成地形,反之亦然
  for(let i=0;i<S.objIds.length;i++) if(S.objIds[i]===id){ S.editObj[i]=val; n++; }
  S.editDirty=true;
  refreshEditOverlay(); if(S.view===2) buildTopView();
  const m=S.objMeta&&S.objMeta.get(id);
  $('log').textContent=`✓ 实例 #${id}${m?`(${m.prompt} ${m.score.toFixed(2)})`:''} `+
    `${n} 像素翻为${val===1?'物体':'地形'}——保存编辑后重烘生效`;
  return n;
}

/** 最终判定:人工覆写优先(1=物体 2=地形),否则听自动 */
function isObjectAt(i){
  const e=S.editObj?S.editObj[i]:0;
  if(e===1) return 1; if(e===2) return 0;
  return S.objAuto?S.objAuto[i]:0;
}

function refreshEditOverlay(){
  const {w,h}=S.work;
  const rgba=new Uint8Array(w*h*4);
  for(let i=0;i<w*h;i++){
    const d=S.editDepth[i], c=S.editCol[i];
    let r=0,g=0,b=0,a=0;
    if(Math.abs(d)>1e-4){
      const t=Math.min(1,Math.abs(d)/0.6);
      if(d>0){ r=60;g=120;b=255; } else { r=255;g=110;b=40; }   // 抬高(近)=蓝 压低(远)=橙
      a=Math.round(90+t*140);
    }
    if(c===1){ r=40;g=230;b=90; a=Math.max(a,150); }
    if(c===2){ r=235;g=50;b=50; a=Math.max(a,150); }
    if(S.hotInstance&&S.objIds&&S.objIds[i]===S.hotInstance){
      r=255; g=213; b=74; a=210;                   // 联动高亮:两视图同一枚实例
    } else if(S.dbg.terrain){                      // 地形判定:绿=地形 红=物体,人工覆写更亮
      const o=isObjectAt(i), manual=S.editObj&&S.editObj[i]!==0;
      const rr=o?210:30, gg=o?40:210, bb=o?60:110;
      const aa=manual?190:110;
      if(aa>a){ r=rr; g=gg; b=bb; a=aa; }
    }
    rgba[i*4]=r; rgba[i*4+1]=g; rgba[i*4+2]=b; rgba[i*4+3]=a;
  }
  if(!S.tex.edit){
    S.tex.edit=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,S.tex.edit);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  }
  gl.bindTexture(gl.TEXTURE_2D,S.tex.edit);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
}
function paintAt(wx, wy){
  const {w,h}=S.work, R=S.brushR, R2=R*R;
  const x0=Math.max(0,Math.floor(wx-R)), x1=Math.min(w-1,Math.ceil(wx+R));
  const y0=Math.max(0,Math.floor(wy-R)), y1=Math.min(h-1,Math.ceil(wy+R));
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
    const dd=(x-wx)*(x-wx)+(y-wy)*(y-wy);
    if(dd>R2) continue;
    const fall=1-Math.sqrt(dd)/R, i=y*w+x;
    switch(S.brush){
      case 1: S.editDepth[i]=Math.max(-2,Math.min(2,S.editDepth[i]-S.brushS*fall*0.25)); break; // 抬高=拉近=减深度
      case 2: S.editDepth[i]=Math.max(-2,Math.min(2,S.editDepth[i]+S.brushS*fall*0.25)); break;
      case 3: if(S.walkD2&&S.frontD){
          // 抹平到地面:最终深度=walk 面 → delta = walk − d_auto,d_auto = front − 烘焙时delta
          const dAuto=S.frontD[i]-S.editDepthBaked[i];
          const target=S.walkD2[i]-dAuto;
          S.editDepth[i]+= (target-S.editDepth[i])*Math.min(1,fall*0.5);
        } break;
      case 4: S.editCol[i]=1; break;
      case 5: S.editCol[i]=2; break;
      case 6: S.editDepth[i]=0; S.editCol[i]=0; S.editObj[i]=0; break;
      case 12: S.editObj[i]=1; break;
      case 13: S.editObj[i]=2; break;
      case 7: if(S.frontD){    // 平滑:圆盘均值(基于最终深度),按衰减混入
          const K=3; let sum=0,n=0;
          for(let sy=-K;sy<=K;sy++)for(let sx=-K;sx<=K;sx++){
            const xx=x+sx, yy=y+sy;
            if(xx<0||yy<0||xx>=w||yy>=h) continue;
            const j=yy*w+xx;
            sum+=S.frontD[j]-S.editDepthBaked[j]+S.editDepth[j]; n++;
          }
          const dAuto=S.frontD[i]-S.editDepthBaked[i];
          const target=(sum/n)-dAuto;
          S.editDepth[i]+=(target-S.editDepth[i])*Math.min(1,fall*0.5);
        } break;
    }
  }
  S.editDirty=true;
}
// ---- polygon region tool (brush 8-11): click=vertex, dblclick=close+fill, Esc=cancel
function polyApply(){
  const pts=S.polyPts; if(!pts||pts.length<3){ S.polyPts=[]; return; }
  const {w,h}=S.work;
  const xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]);
  const x0=Math.max(0,Math.floor(Math.min(...xs))), x1=Math.min(w-1,Math.ceil(Math.max(...xs)));
  const y0=Math.max(0,Math.floor(Math.min(...ys))), y1=Math.min(h-1,Math.ceil(Math.max(...ys)));
  function inside(px,py){
    let c=false;
    for(let i=0,j=pts.length-1;i<pts.length;j=i++){
      const [xi,yi]=pts[i],[xj,yj]=pts[j];
      if(((yi>py)!==(yj>py)) && (px<(xj-xi)*(py-yi)/(yj-yi)+xi)) c=!c;
    }
    return c;
  }
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
    if(!inside(x+.5,y+.5)) continue;
    const i=y*w+x;
    switch(S.brush){
      case 8: if(S.walkD2&&S.frontD){
          const dAuto=S.frontD[i]-S.editDepthBaked[i];
          S.editDepth[i]=S.walkD2[i]-dAuto;
        } break;
      case 9: S.editCol[i]=1; break;
      case 10: S.editCol[i]=2; break;
      case 11: S.editDepth[i]=0; S.editCol[i]=0; S.editObj[i]=0; break;
      case 14: S.editObj[i]=1; break;
      case 15: S.editObj[i]=2; break;
    }
  }
  S.polyPts=[]; S.editDirty=true;
  refreshEditOverlay();
}
async function refreshGeoStatus(name){
  try{
    const r=await (await fetch('/api/geo_status?scene='+encodeURIComponent(name))).json();
    S.geoStale=!!(r.ok&&r.stale);
  }catch(e){ S.geoStale=false; }
  $('geo_warn').style.display=S.geoStale?'block':'none';
  markDirty(S.geoStale);
}
function encodeEditPngs(){
  const {w,h}=S.work;
  const cd=document.createElement('canvas'); cd.width=w; cd.height=h;
  const xd=cd.getContext('2d'); const idd=xd.createImageData(w,h);
  for(let i=0;i<w*h;i++){
    const u16=Math.max(0,Math.min(65535,Math.round(S.editDepth[i]/2.0*32768+32768)));
    idd.data[i*4]=u16>>8; idd.data[i*4+1]=u16&0xFF; idd.data[i*4+2]=0; idd.data[i*4+3]=255;
  }
  xd.putImageData(idd,0,0);
  const cc=document.createElement('canvas'); cc.width=w; cc.height=h;
  const xc=cc.getContext('2d'); const idc=xc.createImageData(w,h);
  for(let i=0;i<w*h;i++){ idc.data[i*4]=S.editCol[i]; idc.data[i*4+3]=255; }
  xc.putImageData(idc,0,0);
  const co=document.createElement('canvas'); co.width=w; co.height=h;
  const xo=co.getContext('2d'); const ido=xo.createImageData(w,h);
  for(let i=0;i<w*h;i++){ ido.data[i*4]=S.editObj?S.editObj[i]:0; ido.data[i*4+3]=255; }
  xo.putImageData(ido,0,0);
  return Promise.all([
    new Promise(r=>cd.toBlob(r,'image/png')),
    new Promise(r=>cc.toBlob(r,'image/png')),
    new Promise(r=>co.toBlob(r,'image/png')),
  ]);
}
// ---- 秒级重算地形 + 站位体检(改完覆写层立刻看结果,不用陪跑整条烘焙管线) ----
$('terrain_recalc').onclick=async()=>{
  const name=activeScene(); if(!name) return;
  $('terrain_stats').textContent='重算中…';
  if(S.editDirty){                                  // 覆写层在内存里,先落盘服务端才读得到
    const [bd,bc,bo]=await encodeEditPngs();
    for(const [k,b] of [['depth',bd],['collision',bc],['object',bo]])
      await fetch(`/api/save_edit?scene=${encodeURIComponent(name)}&kind=${k}`,{method:'POST',body:b});
    S.editDirty=false;
  }
  try{
    const r=await (await fetch('/api/terrain?scene='+encodeURIComponent(name))).json();
    if(!r.ok){ $('terrain_stats').textContent='✗ '+(r.err||''); return; }
    const s2=r.stats;
    $('terrain_stats').textContent=
      `站位体检(脚下是可见地面的点 ${s2.samples}):\n`+
      `  全遮挡 ${(s2.full_occluded*100).toFixed(1)}%  重度>50% ${(s2.heavy*100).toFixed(1)}%  中位 ${s2.median.toFixed(3)}\n`+
      `地面掩膜 ${(s2.ground_mask*100).toFixed(1)}%  物体 ${(s2.objects*100).toFixed(1)}%  地形高度 p95 ${s2.terrain_p95.toFixed(3)}\n`+
      `注意:可走掩膜/碰撞图不在快通道里,仍需完整重烘`;
    S.terrainReady=true;
    showTerrainImage(0);
  }catch(e){ $('terrain_stats').textContent='✗ '+e; }
};
let terrainImgIdx=0;
function showTerrainImage(idx){
  const name=activeScene(); if(!name) return;
  const files=['terrain_preview.png','occupancy_preview.png'];
  const labels=['地形高度场(蓝低→红高)','站位体检(绿=不被遮 红=整块被吃)'];
  terrainImgIdx=idx%files.length;
  const tv=$('topview'), th=$('topview_hint');
  const img=new Image();
  img.onload=()=>{
    tv.width=img.width; tv.height=img.height;
    tv.getContext('2d').drawImage(img,0,0);
    tv.style.display='block'; th.style.display='block';
    fitOverlayCanvas(tv);
    th.innerHTML=`${labels[terrainImgIdx]} · 再点「看结果」切换另一张 · 点视图按钮退出`;
    canvas.style.visibility='hidden'; $('hud').style.display='none';
    S.view=-1;                                     // 图片查看态:不走 GL 主循环也不吃多边形
  };
  img.src=`out/${encodeURIComponent(name)}/${files[terrainImgIdx]}?t=`+Date.now();
}
$('terrain_show').onclick=()=>{ showTerrainImage(terrainImgIdx+1); };

$('edit_save').onclick=async()=>{
  const name=activeScene(); if(!name) return;
  const [bd,bc,bo]=await encodeEditPngs();
  const bad=[];
  for(const [kind,body] of [['depth',bd],['collision',bc],['object',bo]]){
    try{
      const r=await fetch(`/api/save_edit?scene=${encodeURIComponent(name)}&kind=${kind}`,
                          {method:'POST',body});
      if(!r.ok) bad.push(kind);
    }catch(e){ bad.push(kind); }
  }
  if(bad.length){
    $('log').textContent=`✗ 这些层没存上:${bad.join('/')}(服务端不认该 kind?`+
      ` 改过 serve.py 要重启实验室服务)——编辑仍在内存里,别关页面`;
    return;
  }
  S.editDirty=false;
  $('log').textContent='✓ 编辑已保存——需重烘生效';
  refreshGeoStatus(name);
};
$('edit_clear').onclick=async()=>{
  const name=activeScene(); if(!name) return;
  S.editDepth.fill(0); S.editCol.fill(0); if(S.editObj) S.editObj.fill(0); S.editDirty=false;
  refreshEditOverlay();
  for(const k of ['depth','collision','object'])
    await fetch(`/api/save_edit?scene=${encodeURIComponent(name)}&kind=${k}`,{method:'POST',body:'CLEAR'});
  $('log').textContent='✓ 编辑已清除——需重烘生效';
  refreshGeoStatus(name);
};
$('export_depth').onclick=async()=>{
  const name=activeScene(); if(!name) return;
  const r=await (await fetch('/api/export_depth?scene='+encodeURIComponent(name))).json();
  $('log').textContent=r.ok?'✓ 场景深度已导出(depthConfig+RG16+碰撞已写入游戏)':'✗ '+(r.err||'');
};
$('brush').addEventListener('change',e=>{ S.brush=+e.target.value; });
bindSlider('rb_objthr',null,v=>(+v).toFixed(2),v=>{
  S.objScoreMin=+v;
  if(!S.work||!S.objIds) return;                    // bindSlider 会在载场景前先跑一次
  recomputeObjAuto(); refreshEditOverlay();
  if(S.view===2) buildTopView();
  markDirty(true);                                  // 门槛进 rbParams,重烘才正式生效
});
bindSlider('brushr','brushR',v=>v.toFixed(0));
bindSlider('brushs','brushS',v=>v.toFixed(2));
let painting=false;
S.polyPts=[];
canvas.addEventListener('mousedown',e=>{
  if(S.view!==0||S.brush===0||e.button!==0) return;
  if(S.brush===16){                                 // 点选实例:单击即翻转,不涂不圈
    const [wx,wy]=canvasToWork(e);
    const x=Math.floor(wx), y=Math.floor(wy);
    if(x>=0&&y>=0&&x<S.work.w&&y<S.work.h&&S.objIds) flipInstance(S.objIds[y*S.work.w+x]|0);
    return;
  }
  if(S.brush>=8&&S.brush<=11){                      // polygon mode: collect vertices
    const [wx,wy]=canvasToWork(e);
    S.polyPts.push([wx,wy]);
    return;
  }
  painting=true;
  const [wx,wy]=canvasToWork(e); paintAt(wx,wy); refreshEditOverlay();
});
window.addEventListener('mousemove',e=>{
  if(!painting||S.view!==0||S.brush===0||S.brush>=8) return;   // 8+ 是多边形/点选,不走涂抹
  const [wx,wy]=canvasToWork(e); paintAt(wx,wy); refreshEditOverlay();
});
window.addEventListener('mouseup',()=>{ painting=false; });
window.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&S.polyPts.length){ S.polyPts=[]; }
});

// ------------------------------------------------------------- char assets
let charReady=false;
(async()=>{
  const [alb,nrm]=await Promise.all([loadImg('/char/albedo.png'),loadImg('/char/normal.png')]);
  S.tex.alb=texImg(alb); S.tex.nrm=texImg(nrm);
  S.charAspect=alb.width/alb.height;
  charReady=true;
})();

/** 绑定 LIGHT_UNIFORMS 那一组(2D 角色 / 3D 角色 / 全景 三个程序共用同一份 probe 数据
 *  与运行时开关,一处绑完,免得三处漂移)。返回下一个可用纹理单元号。 */
function bindLightUniforms(p){
  const u=n=>gl.getUniformLocation(p,n);
  const man=S.man, V=man.vol, P=man.probes, wd=man.world, M=man.world.M;
  let unit=0;
  for(const [nm,t,tt] of [['uValid',S.tex.valid,gl.TEXTURE_2D],['uPL1',S.tex.l1,gl.TEXTURE_2D],
      ['uPL2',S.tex.l2,gl.TEXTURE_2D],['uPBin',S.tex.bins,gl.TEXTURE_2D],
      ['uVol',S.tex.vol,gl.TEXTURE_3D],['uVolEmit',S.tex.volEmit,gl.TEXTURE_3D]]){
    gl.activeTexture(gl.TEXTURE0+unit); gl.bindTexture(tt,t); gl.uniform1i(u(nm),unit); unit++;
  }
  gl.uniform3f(u('uQMin'),V.qx_min,V.qy_min,V.qz_min);
  gl.uniform3f(u('uQMax'),V.qx_max,V.qy_max,V.qz_max);
  gl.uniform3i(u('uVolN'),V.Nx,V.Ny,V.Nz);
  gl.uniformMatrix3fv(u('uM'),false,[M[0][0],M[1][0],M[2][0],M[0][1],M[1][1],M[2][1],M[0][2],M[1][2],M[2][2]]);
  gl.uniform3f(u('uWMin'),wd.x0,wd.y0,wd.z0);
  gl.uniform3f(u('uWScale'),(P.nx-1)/Math.max(wd.x1-wd.x0,1e-5),
    (P.ny-1)/Math.max(wd.y1-wd.y0,1e-5),(P.nz-1)/Math.max(wd.z1-wd.z0,1e-5));
  gl.uniform3i(u('uPN'),P.nx,P.ny,P.nz);
  const amb=man.ambient.sh;
  for(let k=0;k<9;k++) gl.uniform3f(u(`uAmbSH[${k}]`),amb[k*3],amb[k*3+1],amb[k*3+2]);
  gl.uniform1i(u('uMode'),S.mode); gl.uniform1i(u('uSpp'),S.spp);
  gl.uniform1i(u('uMSteps'),S.msteps); gl.uniform1i(u('uFold'),S.fold);
  gl.uniform1i(u('uMissMode'),S.missMode); gl.uniform1i(u('uNEE'),S.nee);
  gl.uniform1f(u('uStep'),S.step); gl.uniform1f(u('uAmb'),S.amb);
  gl.uniform1i(u('uProbeOne'),-1);          // 默认走八角插值;全景「插值关」时另行覆盖
  const LN=Math.min(48,S.lights.length);
  gl.uniform1i(u('uLightCount'),LN);
  if(LN){
    const lq=new Float32Array(48*4), le=new Float32Array(48*4), ln=new Float32Array(48*4);
    for(let i=0;i<LN;i++){ const L=S.lights[i];
      lq.set([L.q[0],L.q[1],L.q[2],L.area],i*4);
      le.set([L.e[0],L.e[1],L.e[2],0],i*4);
      ln.set([L.nq[0],L.nq[1],L.nq[2],0],i*4); }
    gl.uniform4fv(u('uLightQ'),lq); gl.uniform4fv(u('uLightE'),le); gl.uniform4fv(u('uLightN'),ln);
  }
  return unit;
}

// ------------------------------------------------------------- draw 2D
function draw2D(){
  const man=S.man, cal=man.cal;
  gl.viewport(0,0,canvas.width,canvas.height);
  gl.clearColor(.04,.05,.06,1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.disable(gl.DEPTH_TEST);

  const V2=S.v2;
  const wxc=x=>((x-V2.ox)*V2.zoom)/S.work.w*2-1;
  const wyc=y=>1-((y-V2.oy)*V2.zoom)/S.work.h*2;
  gl.useProgram(pBG); bindQuad();
  gl.uniform4f(gl.getUniformLocation(pBG,'uRect'), wxc(0), wyc(0), 2*V2.zoom, -2*V2.zoom);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,S.tex.bg);
  gl.uniform1i(gl.getUniformLocation(pBG,'uBG'),0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D,S.tex.depth);
  gl.uniform1i(gl.getUniformLocation(pBG,'uDepth'),1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D,S.tex.gain);
  gl.uniform1i(gl.getUniformLocation(pBG,'uGain'),2);
  gl.uniform2i(gl.getUniformLocation(pBG,'uWork'),S.work.w,S.work.h);
  gl.uniform1i(gl.getUniformLocation(pBG,'uDbgDepth'),S.bgview===3?1:0);
  gl.uniform1i(gl.getUniformLocation(pBG,'uDbgGain'),S.bgview===2?1:0);
  gl.uniform1i(gl.getUniformLocation(pBG,'uDbgHDR'),S.bgview===1?1:0);
  gl.uniform1i(gl.getUniformLocation(pBG,'uDbgZone'),S.bgview===4?1:0);
  const _rbg=document.getElementById('rb_gain');
  gl.uniform1f(gl.getUniformLocation(pBG,'uMaxGain'),_rbg?parseFloat(_rbg.value):(S.man.params.max_gain_ev??3.32));
  gl.uniform1f(gl.getUniformLocation(pBG,'uHdrMethod'),S.hdrMethod??0);
  gl.uniform1f(gl.getUniformLocation(pBG,'uPA'),S.hdrPA??0.7);
  gl.uniform1f(gl.getUniformLocation(pBG,'uPGain'),S.pgain);
  if(S.tex.edit){
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D,S.tex.edit);
    gl.uniform1i(gl.getUniformLocation(pBG,'uEdit'),3);
  }
  gl.uniform1i(gl.getUniformLocation(pBG,'uShowEdit'),(S.brush>0||S.editDirty||S.dbg.terrain)?1:0);
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);

  // walkable overlay: project world walk mask cells to screen as green points
  if(S.dbg.walk){
    const w=S.walk, pts=[];
    for(let z=0;z<w.nz;z+=2) for(let x=0;x<w.nx;x+=2){
      if(!w.mask[z*w.nx+x]) continue;
      const wx=w.x0+x*w.dx, wz=w.z0+z*w.dz;
      const q=qFromWorld([wx,groundY(wx,wz),wz]);
      const sp=screenFromQ(q);
      pts.push([...sp,0.1,0.9,0.35]);
    }
    drawL2(pts, gl.POINTS);
  }
  if(S.dbg.probes){
    const pts=[]; const P=man.probes;
    // world regular grid positions projected;颜色=该 probe 的 E/π × probe 专属显示增益
    // (与 3D 点云同一份 S.probeDC,只是这里 CPU 端就 tonemap 完再喂 2D 线段程序)
    for(let i=0;i<P.nx;i++)for(let j=0;j<P.ny;j++)for(let k=0;k<P.nz;k++){
      const X=[P.gx[i],P.gy[j],P.gz[k]];
      const sp=screenFromQ(qFromWorld(X));
      const fi=(i*P.ny+j)*P.nz+k;
      pts.push([...sp,...probeDotColor(fi)]);
    }
    drawL2(pts, gl.POINTS);
    if(S.selProbe!=null){                       // 选中的那颗:洋红十字,和 3D 的洋红环呼应
      const D=S.probe, sp=screenFromQ(qFromWorld([D.pos[S.selProbe*3],D.pos[S.selProbe*3+1],D.pos[S.selProbe*3+2]]));
      const r=6/S.v2.zoom+2;
      drawL2([[sp[0]-r,sp[1],1,.35,.85],[sp[0]+r,sp[1],1,.35,.85],
              [sp[0],sp[1]-r,1,.35,.85],[sp[0],sp[1]+r,1,.35,.85]], gl.LINES);
    }
  }
  if(S.dbg.lights && S.lights.length){
    const seg=[];
    for(const L of S.lights){
      const sp=screenFromQ(L.q);
      const r=3+Math.min(9,Math.sqrt(L.power)*160);
      seg.push([sp[0]-r,sp[1],1,.75,.1],[sp[0]+r,sp[1],1,.75,.1]);
      seg.push([sp[0],sp[1]-r,1,.75,.1],[sp[0],sp[1]+r,1,.75,.1]);
    }
    drawL2(seg, gl.LINES);
  }

  if(!charReady) return;
  const cosT=Math.cos(cal.theta), sinT=Math.sin(cal.theta);
  const wy=groundY(S.footW.x,S.footW.z);
  const footQ=qFromWorld([S.footW.x,wy,S.footW.z]);
  const [fsx,fsy]=screenFromQ(footQ);
  const effH=S.charH*S.qscale;
  const hPx=effH*cosT*cal.ppu, wPx=hPx*S.charAspect;
  const sxToClip=wxc, syToClip=wyc;   // zoom-aware
  const zW=S.work.w/V2.zoom, zH=S.work.h/V2.zoom;

  gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);

  gl.useProgram(pShadow); bindQuad();
  const shW=wPx*1.15, shH=wPx*0.38;
  gl.uniform4f(gl.getUniformLocation(pShadow,'uRect'),
    sxToClip(fsx-shW/2), syToClip(fsy-shH/2), shW/zW*2, -(shH/zH*2));
  gl.uniform1f(gl.getUniformLocation(pShadow,'uStrength'),S.contact);
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);

  gl.useProgram(pChar); bindQuad();
  const u=n=>gl.getUniformLocation(pChar,n);
  gl.uniform4f(u('uRect'), sxToClip(fsx-wPx/2), syToClip(fsy-hPx), wPx/zW*2, -(hPx/zH*2));
  let unit=bindLightUniforms(pChar);              // probe/体素/开关那一组(三程序共用)
  for(const [nm,t] of [['uAlb',S.tex.alb],['uNrm',S.tex.nrm],['uDepthTex',S.tex.depth]]){
    gl.activeTexture(gl.TEXTURE0+unit); gl.bindTexture(gl.TEXTURE_2D,t);
    gl.uniform1i(u(nm),unit); unit++;
  }
  gl.uniform2i(u('uWork'),S.work.w,S.work.h);
  gl.uniform4f(u('uCal'),cal.ppu,0,cal.cx,cal.cy);
  gl.uniform3f(u('uFootQ'),footQ[0],footQ[1],footQ[2]);
  gl.uniform1f(u('uCharH'),effH);
  gl.uniform1f(u('uCharW'),wPx/cal.ppu);
  gl.uniform1f(u('uCosT'),cosT); gl.uniform1f(u('uSinT'),sinT);
  gl.uniform1i(u('uOccl'),S.dbg.occl); gl.uniform1i(u('uShowN'),S.dbg.normal);
  gl.uniform1f(u('uBeta'),Math.pow(2,S.beta));
  gl.uniform1f(u('uBulge'),S.bulge);
  gl.uniform1f(u('uFlatten'),S.flatten);
  gl.uniform1f(u('uPGain'),S.pgain);
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);

  if(S.polyPts&&S.polyPts.length){
    const seg=[];
    for(let i=0;i<S.polyPts.length;i++){
      const a=S.polyPts[i], b=S.polyPts[(i+1)%S.polyPts.length];
      seg.push([a[0],a[1],1,.9,.2],[b[0],b[1],1,.9,.2]);
      seg.push([a[0]-2,a[1],1,1,1],[a[0]+2,a[1],1,1,1]);
      seg.push([a[0],a[1]-2,1,1,1],[a[0],a[1]+2,1,1,1]);
    }
    drawL2(seg, gl.LINES);
  }
  const drawLineBuf=(buf,n)=>{
    gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    gl.useProgram(pL2);
    gl.uniform2i(gl.getUniformLocation(pL2,'uWork'),S.work.w,S.work.h);
    gl.uniform3f(gl.getUniformLocation(pL2,'uV2'),S.v2.ox,S.v2.oy,S.v2.zoom);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,20,0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,3,gl.FLOAT,false,20,8);
    gl.drawArrays(gl.LINES,0,n);
  };
  if(S.dbg.rays){ if(!S.rays) buildRays(); drawLineBuf(S.bufs.rays2,S.rays.n2); }
  if(S.selProbe!=null && S.pbRays && S.pbLines) drawLineBuf(S.bufs.pbRay2,S.pbLines.n2);
  gl.disable(gl.BLEND);
}
function drawL2(pts, prim){
  if(!pts.length) return;
  if(!S.bufs.tmp2) S.bufs.tmp2=gl.createBuffer();
  const f=new Float32Array(pts.flat());
  gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.tmp2);
  gl.bufferData(gl.ARRAY_BUFFER,f,gl.DYNAMIC_DRAW);
  gl.useProgram(pL2);
  gl.uniform2i(gl.getUniformLocation(pL2,'uWork'),S.work.w,S.work.h);
  gl.uniform3f(gl.getUniformLocation(pL2,'uV2'),S.v2.ox,S.v2.oy,S.v2.zoom);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,20,0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,3,gl.FLOAT,false,20,8);
  gl.drawArrays(prim,0,pts.length);
}

// --------------------------------------------------- 3D 全景 / 3D 角色 quad
/** 离 world 点最近的 probe(按规则格点找,= 插值真正会用到的那批格点)。 */
function nearestProbeIdx(X){
  const P=S.man.probes;
  const near=(arr,v)=>{ let bi=0,bd=1e18; for(let i=0;i<arr.length;i++){ const d=Math.abs(arr[i]-v);
    if(d<bd){bd=d;bi=i;} } return bi; };
  const i=near(P.gx,X[0]), j=near(P.gy,X[1]), k=near(P.gz,X[2]);
  return (i*P.ny+j)*P.nz+k;
}
/** 相机是否被钳出了 probe 盒(= 显示的不是你站的位置的真值,要标出来)。 */
function camClamped(){
  const wd=S.man.world, e=camEye();
  return (e[0]<wd.x0||e[0]>wd.x1||e[1]<wd.y0||e[1]>wd.y1||e[2]<wd.z0||e[2]>wd.z1)?1:0;
}
function drawPano(){
  const c=S.cam, man=S.man, wd=man.world;
  const eye=camEye(c), f=camForward(c), r=camRight(c);
  const up=cross3(r,f);                                  // 相机基(世界)
  // 插值关:视点换成"最近那颗 probe 的实际采样点",看单颗 probe 的真面目
  const one = S.pano.interp ? -1 : nearestProbeIdx(eye);
  const org = (one>=0) ? [S.probe.pos[one*3],S.probe.pos[one*3+1],S.probe.pos[one*3+2]] : eye;
  S.pano.activeProbe = one;
  const q = qFromWorld(org);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(pPano); bindQuad();
  const u=n=>gl.getUniformLocation(pPano,n);
  gl.uniform4f(u('uRect'),-1,-1,2,2);
  bindLightUniforms(pPano);
  // ①② 读的是 cache,②模式选 RT(0) 时没有对应的基——按⑥面板同一条规则退 L2。
  // (③④ 自己 march,不看 uMode)
  gl.uniform1i(u('uMode'), S.mode===0?2:S.mode);
  gl.uniform1i(u('uProbeOne'),one);
  gl.uniform3f(u('uEyeQ'),q[0],q[1],q[2]);
  gl.uniform3f(u('uCamR'),r[0],r[1],r[2]);
  gl.uniform3f(u('uCamU'),up[0],up[1],up[2]);
  gl.uniform3f(u('uCamF'),f[0],f[1],f[2]);
  const th=Math.tan(c.fov*Math.PI/360);
  gl.uniform2f(u('uTanHalf'),th*canvas.width/canvas.height,th);
  gl.uniform1f(u('uGain'),S.pbGain);                     // 与⑥面板同一根曝光
  gl.uniform1f(u('uAlpha'),1-S.pano.blend);              // 0=全是全景 1=全是 mesh
  gl.uniform1f(u('uMaxDist'),Math.hypot(wd.x1-wd.x0,wd.y1-wd.y0,wd.z1-wd.z0)*0.6);
  gl.uniform1i(u('uPanoMode'),S.pano.mode);
  gl.uniform1i(u('uClamped'),camClamped());
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  gl.disable(gl.BLEND);
  gl.enable(gl.DEPTH_TEST);
}
/** 3D 里画角色:直立 quad 的 4 个角在 q 空间算好,再转世界;逐像素走同一套着色。 */
function drawChar3D(mvp){
  const cal=S.man.cal, cosT=Math.cos(cal.theta), sinT=Math.sin(cal.theta);
  const wy=groundY(S.footW.x,S.footW.z);
  const fq=qFromWorld([S.footW.x,wy,S.footW.z]);
  const effH=S.charH*S.qscale, hPx=effH*cosT*cal.ppu;
  const wWu=(hPx*S.charAspect)/cal.ppu;                  // quad 宽(q 单位),与 2D 同式
  const corner=(sx,h)=>{
    const q=[fq[0]+sx*wWu*0.5, fq[1]+h*cosT, fq[2]-h*sinT];
    return {q, w:worldFromQ(q)};
  };
  const c00=corner(-1,0), c10=corner(1,0), c01=corner(-1,effH), c11=corner(1,effH);
  // 两个三角形:pos3 + q3 + uv2
  const v=[];
  const push=(c,u_,v_)=>v.push(c.w[0],c.w[1],c.w[2], c.q[0],c.q[1],c.q[2], u_,v_);
  push(c01,0,0); push(c11,1,0); push(c00,0,1);
  push(c11,1,0); push(c10,1,1); push(c00,0,1);
  if(!S.bufs.char3d) S.bufs.char3d=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.char3d);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(v),gl.DYNAMIC_DRAW);
  gl.useProgram(pChar3D);
  const u=n=>gl.getUniformLocation(pChar3D,n);
  gl.uniformMatrix4fv(u('uMVP'),false,mvp);
  let unit=bindLightUniforms(pChar3D);
  for(const [nm,t] of [['uAlb',S.tex.alb],['uNrm',S.tex.nrm]]){
    gl.activeTexture(gl.TEXTURE0+unit); gl.bindTexture(gl.TEXTURE_2D,t);
    gl.uniform1i(u(nm),unit); unit++;
  }
  gl.uniform1f(u('uBeta'),Math.pow(2,S.beta));
  gl.uniform1f(u('uBulge'),S.bulge); gl.uniform1f(u('uFlatten'),S.flatten);
  gl.uniform1f(u('uPGain'),S.pgain); gl.uniform1i(u('uShowN'),S.dbg.normal);
  const S32=32;
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,S32,0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,3,gl.FLOAT,false,S32,12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2,2,gl.FLOAT,false,S32,24);
  gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
  gl.drawArrays(gl.TRIANGLES,0,6);
  gl.disable(gl.BLEND);
  gl.disableVertexAttribArray(2);
}

// ------------------------------------------------------------- draw 3D
function draw3D(){
  gl.viewport(0,0,canvas.width,canvas.height);
  gl.clearColor(.05,.06,.08,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  const mvp=camMVP();       // 漫游=透视 / 轨道=正交(与游戏的正交伪世界对齐)
  // reconstruction: SCENE-SKINNED mesh (default) or point cloud
  if(S.meshMode && S.meshTris){
    gl.useProgram(pMesh);
    const um=n=>gl.getUniformLocation(pMesh,n);
    gl.uniformMatrix4fv(um('uMVP'),false,mvp);
    gl.uniform4f(um('uTagShow'),S.pcShow[0],S.pcShow[1],S.pcShow[2],1);
    const M=S.man.world.M, cal=S.man.cal;
    // uMinv = M^T (orthogonal); column-major upload of M^T == row-major M
    gl.uniformMatrix3fv(um('uMinv'),false,[M[0][0],M[0][1],M[0][2],M[1][0],M[1][1],M[1][2],M[2][0],M[2][1],M[2][2]]);
    gl.uniform4f(um('uCal'),cal.ppu,0,cal.cx,cal.cy);
    gl.uniform2i(um('uWork'),S.work.w,S.work.h);
    gl.uniform1f(um('uPGain'),S.pgain);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,S.tex.bg); gl.uniform1i(um('uBG'),0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D,S.tex.hidden); gl.uniform1i(um('uHid'),1);
    gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.meshV);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,16,0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,4,gl.UNSIGNED_BYTE,true,16,12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,S.bufs.meshI);
    gl.drawElements(gl.TRIANGLES,S.meshTris*3,gl.UNSIGNED_INT,0);
  }
  gl.useProgram(pP3);
  gl.uniformMatrix4fv(gl.getUniformLocation(pP3,'uMVP'),false,mvp);
  gl.uniform4f(gl.getUniformLocation(pP3,'uTagShow'),S.pcShow[0],S.pcShow[1],S.pcShow[2],1);
  gl.uniform1f(gl.getUniformLocation(pP3,'uPGain'),S.pgain);
  if(!(S.meshMode && S.meshTris)){
    gl.uniform1f(gl.getUniformLocation(pP3,'uPtSize'),2.2);
    gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.cloud);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,16,0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,4,gl.UNSIGNED_BYTE,true,16,12);
    gl.drawArrays(gl.POINTS,0,S.pointCount);
  }

  // ---- probe 全景:把可视化裹在相机周围(漫游模式才有意义,正交没有单一视点)
  if(S.pano.mode>=0 && S.cam.mode==='fly' && S.probe){
    drawPano();
  }

  // probes(专用程序:线性 E/π + probe 专属显示增益 + 选中环)
  if(S.dbg.probes && S.probe){
    gl.useProgram(pProbe);
    const up=n=>gl.getUniformLocation(pProbe,n);
    gl.uniformMatrix4fv(up('uMVP'),false,mvp);
    gl.uniform1f(up('uPtSize'),8.0);
    gl.uniform1f(up('uPtRef'),S.cam.mode==='fly'?S.cam.dist*0.35:1.0);
    gl.uniform1f(up('uGain'),S.probeGain);
    gl.uniform1i(up('uSel'),S.selProbe==null?-1:S.selProbe);
    gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.probePos);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,12,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.probeE);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,4,gl.FLOAT,false,16,0);
    gl.drawArrays(gl.POINTS,0,S.probeCount);
  }   // 后面的 char marker / 光源 / 射线块自己会 useProgram(pP3),uniform 是按程序存的

  // 角色 quad:立在伪世界里的直立四边形,与 2D 同一套着色(看光照对不对最直观)
  if(S.pano.drawChar && charReady) drawChar3D(mvp);

  // character marker: vertical line + foot cross
  const wy=groundY(S.footW.x,S.footW.z), effH=S.charH*S.qscale;
  const cm=[
    [S.footW.x,wy,S.footW.z, 1,.3,.9],[S.footW.x,wy+effH,S.footW.z, 1,.3,.9],
    [S.footW.x-.3,wy,S.footW.z, 1,.3,.9],[S.footW.x+.3,wy,S.footW.z, 1,.3,.9],
    [S.footW.x,wy,S.footW.z-.3, 1,.3,.9],[S.footW.x,wy,S.footW.z+.3, 1,.3,.9],
  ];
  if(!S.bufs.charM) S.bufs.charM=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.charM);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(cm.flat()),gl.DYNAMIC_DRAW);
  gl.useProgram(pP3);
  gl.uniform1f(gl.getUniformLocation(pP3,'uPtSize'),1.);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,24,0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,3,gl.FLOAT,false,24,12);
  // attrib 1 expects vec4; supply as float3 -> w defaults 1? safer: use separate program? reuse with tag>=4 shows always
  gl.drawArrays(gl.LINES,0,6);

  // light surfels in world (orange points)
  if(S.dbg.lights && S.lights.length){
    const lp=[];
    for(const L of S.lights) lp.push([L.world[0],L.world[1],L.world[2], 1,.7,.1]);
    if(!S.bufs.lights3) S.bufs.lights3=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.lights3);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(lp.flat()),gl.DYNAMIC_DRAW);
    gl.uniform1f(gl.getUniformLocation(pP3,'uPtSize'),9.0);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,24,0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,3,gl.FLOAT,false,24,12);
    gl.drawArrays(gl.POINTS,0,S.lights.length);
  }
  // rays in world
  if(S.dbg.rays){ if(!S.rays) buildRays();
    gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.rays3);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,24,0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,3,gl.FLOAT,false,24,12);
    gl.drawArrays(gl.LINES,0,S.rays.n3);
  }
  // 选中 probe 的采样射线(与⑥面板 ③④ 同一次追踪的稀疏可视化版)
  if(S.selProbe!=null && S.pbRays && S.pbLines){
    gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.pbRay3);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,24,0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,3,gl.FLOAT,false,24,12);
    gl.drawArrays(gl.LINES,0,S.pbLines.n3);
  }
  gl.disable(gl.DEPTH_TEST);
}

// ------------------------------------------------------------- main loop
let lastMove=performance.now();
function move(now){
  const dt=Math.min(.05,(now-lastMove)/1000); lastMove=now;
  const sp=2.2*dt*Math.max(S.qscale,0.5);      // world units / s
  let dx=0,dz=0;
  if(S.keys['ArrowLeft']||S.keys['a']) dx-=sp;
  if(S.keys['ArrowRight']||S.keys['d']) dx+=sp;
  if(S.keys['ArrowUp']||S.keys['w']) dz-=sp;      // world Z is right-handed now:
  if(S.keys['ArrowDown']||S.keys['s']) dz+=sp;    // screen-down == +Z (toward camera)
  if(!dx&&!dz) return;
  const nx=S.footW.x+dx, nz=S.footW.z+dz;
  if(!S.collide){
    const wd=S.man.world;
    S.footW.x=Math.max(wd.x0,Math.min(wd.x1,nx));
    S.footW.z=Math.max(wd.z0,Math.min(wd.z1,nz));
  }
  else if(walkableAt(nx,nz)){ S.footW.x=nx; S.footW.z=nz; }
  else if(walkableAt(nx,S.footW.z)) S.footW.x=nx;
  else if(walkableAt(S.footW.x,nz)) S.footW.z=nz;
  S.rays=null;
}
function canvasToWork(e){
  const r=canvas.getBoundingClientRect();
  const cx_=(e.clientX-r.left)/r.width*S.work.w;
  const cy_=(e.clientY-r.top)/r.height*S.work.h;
  return [cx_/S.v2.zoom+S.v2.ox, cy_/S.v2.zoom+S.v2.oy];
}
// 2D zoom (wheel, about the cursor) + pan (right-drag) + reset (double-click)
canvas.addEventListener('wheel', e=>{
  if(S.view!==0) return;   // 3D wheel handled by orbit zoom below
  e.preventDefault();
  const [wx,wy]=canvasToWork(e);
  const z2=Math.max(1,Math.min(8,S.v2.zoom*Math.pow(1.0015,-e.deltaY)));
  S.v2.ox=wx-(wx-S.v2.ox)*S.v2.zoom/z2;
  S.v2.oy=wy-(wy-S.v2.oy)*S.v2.zoom/z2;
  S.v2.zoom=z2;
  clamp2D();
},{passive:false});
function clamp2D(){
  const mw=S.work.w*(1-1/S.v2.zoom), mh=S.work.h*(1-1/S.v2.zoom);
  S.v2.ox=Math.max(0,Math.min(mw,S.v2.ox));
  S.v2.oy=Math.max(0,Math.min(mh,S.v2.oy));
}
let pan2d=false,plx=0,ply=0;
// 笔刷16(点选实例):2D 视图里悬停高亮、单击整块翻转。相机视角认得出「这是哪座楼」,
// 顶视认不出——所以点选放在 2D,圈选放在顶视,两边高亮联动。
canvas.addEventListener('mousemove',e=>{
  if(S.view!==0||S.brush!==16||!S.objIds) return;
  const [wx,wy]=canvasToWork(e);
  const x=Math.floor(wx), y=Math.floor(wy);
  if(x<0||y<0||x>=S.work.w||y>=S.work.h) return;
  const id=S.objIds[y*S.work.w+x]|0;
  if(id!==S.hotInstance){
    S.hotInstance=id; refreshEditOverlay();
    const m=id&&S.objMeta?S.objMeta.get(id):null;
    $('hud').textContent=m?`实例 #${id}  ${m.prompt}  ${m.score.toFixed(2)}  ${m.area}px`
                          :'(此处无实例)';
  }
});
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('mousedown',e=>{ if(S.view===0&&e.button===2){ pan2d=true; plx=e.clientX; ply=e.clientY; } });
window.addEventListener('mouseup',()=>pan2d=false);
window.addEventListener('mousemove',e=>{
  if(!pan2d||S.view!==0) return;
  const r=canvas.getBoundingClientRect();
  S.v2.ox-=(e.clientX-plx)/r.width*S.work.w/S.v2.zoom;
  S.v2.oy-=(e.clientY-ply)/r.height*S.work.h/S.v2.zoom;
  plx=e.clientX; ply=e.clientY; clamp2D();
});
canvas.addEventListener('dblclick',e=>{
  if(S.view===1){ if(S.man) fitCamera(); return; }               // 3D:双击=相机复位
  if(S.brush>=8&&S.brush<=11&&S.polyPts.length>=3){ polyApply(); return; }  // 多边形闭合优先
  S.v2={zoom:1,ox:0,oy:0};
});
// click-to-place: teleport to the ground point that projects nearest the click
canvas.addEventListener('click', e=>{
  if(S.view!==0||!S.man||!S.walk||S.brush>0) return;   // brush mode paints instead
  const [px,py]=canvasToWork(e);
  // 2D 里 probe 晶格投影很密,普通点击必须留给"点哪站哪";选 probe 用 Alt/Shift+点
  if(S.dbg.probes && (e.altKey||e.shiftKey) && pickProbe2D(px,py)) return;
  const w=S.walk; let best=null,bd=1e18;
  for(let z=0;z<w.nz;z++)for(let x=0;x<w.nx;x++){
    if(S.collide&&!w.mask[z*w.nx+x])continue;
    const wx=w.x0+x*w.dx, wz=w.z0+z*w.dz;
    const sp=screenFromQ(qFromWorld([wx,groundY(wx,wz),wz]));
    const d=(sp[0]-px)**2+(sp[1]-py)**2;
    if(d<bd){bd=d;best=[wx,wz];}
  }
  if(best){ S.footW={x:best[0],z:best[1]}; S.rays=null; }
  canvas.focus();
});
function draw(){
  requestAnimationFrame(draw);
  const now=performance.now(); S.frames++;
  if(now-S.tFPS>500){ S.fps=Math.round(S.frames*1000/(now-S.tFPS)); S.frames=0; S.tFPS=now; }
  if(!S.man) return;
  if(S.view===2||S.view===-1){ /* 顶视/图片查看:独立 2D 画布,不走 GL 主循环 */ }
  else if(S.view===0){ move(now); draw2D(); } else { moveCam(now); draw3D(); }
  const wy=S.walk?groundY(S.footW.x,S.footW.z):0;
  const c=S.cam, eye=camEye(c);
  const viewTxt=S.view
    ? (c.mode==='fly'?`3D 漫游(透视 ${c.fov|0}°·${c.speed.toFixed(1)}m/s)`:'3D 轨道(正交)')
    : '2D ×'+S.v2.zoom.toFixed(1);
  const posTxt=S.view
    ? `cam(${eye[0].toFixed(2)}, ${eye[1].toFixed(2)}, ${eye[2].toFixed(2)})`
    : `world(${S.footW.x.toFixed(2)}, ${wy.toFixed(2)}, ${S.footW.z.toFixed(2)})`;
  let panoTxt='';
  if(S.view===1 && S.pano.mode>=0 && c.mode==='fly'){
    const nm=['irradiance E(n)','亮度分层','射线命中','命中辐射 L(ω)'][S.pano.mode];
    panoTxt=`\n全景 ${nm} · ${S.pano.interp?'8角插值(游戏口径)':`只看 probe #${S.pano.activeProbe}`}`
      + (camClamped()?'  ⚠相机在 probe 盒外(已钳到边界,显示的不是本位置真值)':'');
  }else if(S.view===1 && S.pano.mode>=0){
    panoTxt='\n⚠ 全景只在「漫游」相机下有效——正交没有单一视点';
  }
  $('hud').textContent=
    `${['RT 实时追踪·每帧GPU重算','Cache·SH L1·预烘焙插值','Cache·SH L2·预烘焙插值','Cache·BIN·预烘焙插值'][S.mode]}  |  ${S.fps} fps  |  ${viewTxt}\n`+
    posTxt + (S.selProbe!=null?`   probe #${S.selProbe} 已选中`:'') + panoTxt;
}

// ------------------------------------------------------------- input
window.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT') return;
  if(e.key==='Tab'){ e.preventDefault(); setMode((S.mode+1)%4); return; }
  if(e.key>='1'&&e.key<='4'){ setMode(+e.key-1); return; }
  S.keys[e.key.toLowerCase()]=1; S.keys[e.key]=1;
  if(e.key.startsWith('Arrow')) e.preventDefault();
});
window.addEventListener('keyup',e=>{ delete S.keys[e.key.toLowerCase()]; delete S.keys[e.key]; });

// 3D 拖动:漫游=改朝向(原地转头) / 轨道=绕中心转;Shift 或右键=平移。
// 没拖动的那一下(位移 <5px)当作点击 → 拾取 probe。
let dragging=false,panMode=false,lx=0,ly=0,dragPx=0;
canvas.addEventListener('mousedown',e=>{ if(S.view!==1)return;
  dragging=true; panMode=e.shiftKey||e.button===2; lx=e.clientX; ly=e.clientY; dragPx=0;
  canvas.focus(); });      // 从右栏点回画布即可继续用键盘漫游
window.addEventListener('mouseup',e=>{
  if(dragging && S.view===1 && dragPx<5 && e.button===0) pickProbe3D(e);
  dragging=false;
});
window.addEventListener('mousemove',e=>{
  if(!dragging||S.view!==1) return;
  const dx=e.clientX-lx, dy=e.clientY-ly; lx=e.clientX; ly=e.clientY;
  dragPx+=Math.abs(dx)+Math.abs(dy);
  const c=S.cam, right=camRight(c);
  if(panMode){
    const s=(c.mode==='fly'?c.speed*0.004:c.dist*0.0016);
    if(c.mode==='fly'){
      c.pos[0]-=right[0]*dx*s; c.pos[2]-=right[2]*dx*s; c.pos[1]+=dy*s; clampCam();
    }else{
      c.tgt[0]-=right[0]*dx*s; c.tgt[2]-=right[2]*dx*s; c.tgt[1]+=dy*s;
    }
  }else{
    c.yaw-=dx*0.008; c.pitch=Math.max(-1.45,Math.min(1.45,c.pitch+dy*0.006));
  }
});
canvas.addEventListener('wheel',e=>{ if(S.view!==1)return; e.preventDefault();
  const c=S.cam;
  if(c.mode==='fly'){                       // 漫游:滚轮=沿视线进退(不是缩放)
    const f=camForward(c), k=-e.deltaY*0.0022*Math.max(c.speed,0.5);
    c.pos=[c.pos[0]+f[0]*k, c.pos[1]+f[1]*k, c.pos[2]+f[2]*k]; clampCam();
  }else{
    c.dist*=Math.pow(1.0015,e.deltaY); c.dist=Math.max(1,Math.min(400,c.dist));
  }
},{passive:false});

// ------------------------------------------------------------- UI
const MODE_INFO=[
  '实时光线追踪:每帧、每个角色像素发射 spp 条光线在辐射体素里步进。改任何参数立即反映。',
  'L1 cache:预烘焙 probe 一阶球谐(4系数),角色像素→世界坐标→三线性插值。方向感最弱、最便宜。',
  'L2 cache:预烘焙 probe 二阶球谐(9系数)。对漫反射近乎无损,应与 RT 几乎一致。',
  'BIN cache:预烘焙 probe 8×8 法线bin 纯数据,无球谐截断,是 cache 的上限参照。'];
function setMode(m){ S.mode=m;
  document.querySelectorAll('.modes button').forEach(b=>b.classList.toggle('on',+b.dataset.m===m));
  const mi=$('modeinfo'); if(mi) mi.textContent=MODE_INFO[m];
  if(S.selProbe!=null&&!S.pbBasisSel) renderProbePanel(); }   // ⑥「跟随②模式」时同步
document.querySelectorAll('.modes button').forEach(b=>b.onclick=()=>setMode(+b.dataset.m));
setMode(0);
function setView(v){ S.view=v;
  document.querySelectorAll('.views button').forEach(b=>b.classList.toggle('on',+b.dataset.v===v));
  const tv=$('topview'), th=$('topview_hint');
  const on=(v===2);
  tv.style.display=on?'block':'none'; th.style.display=on?'block':'none';
  $('hud').style.display=on?'none':'block';        // 顶视有自己的图例,HUD 会残留 3D 文案
  canvas.style.visibility=on?'hidden':'visible';
  S.topPoly=[];
  if(on) buildTopView();
}

// ---------------------------------------------------- 顶视编辑(世界 XZ 正投影)
// 相机视角下,楼后面的地看不见也点不到,而且屏幕多边形映射到世界依赖深度、本身有歧义。
// 顶视 XZ 里每个世界格恰好出现一次:无遮挡、无歧义,而且这就是行走网格与地形高度场
// 自己的坐标系——一个多边形同时把「地形该不该有这块」改对。
const TOP_SCALE=5;
/** 叠加画布自适应:交给 CSS(max-width/height 100% + 保持画布固有比例),**不做测量**。
 *  之前按 stage_main 包围盒算 CSS 尺寸,布局未稳时量到 0、甚至算出负值 →
 *  样式被丢弃 → 画面全黑而像素其实早画好了。测量本身就是不必要的脆弱点。 */
function fitOverlayCanvas(cv){
  cv.style.width='auto'; cv.style.height='auto';
  cv.style.maxWidth='100%'; cv.style.maxHeight='100%';
}
function topGeom(){
  const wk=S.walk, man=S.man;
  return {wk, M:man.world.M, cal:man.cal, TW:wk.nx*TOP_SCALE, TH:wk.nz*TOP_SCALE};
}
/** 工作分辨率像素 → 它脚下地面的世界 (X,Z) */
function groundXZ(sx, sy, i){
  const {M,cal}=topGeom();
  const d=S.walkD2?S.walkD2[i]:0;
  const qx=(sx-cal.cx)/cal.ppu, qy=(cal.cy-sy)/cal.ppu;
  return [M[0][0]*qx+M[0][1]*qy+M[0][2]*d, M[2][0]*qx+M[2][1]*qy+M[2][2]*d];
}
function buildTopView(){
  if(!S.man||!S.walk||!S.work) return;
  const {wk,TW,TH}=topGeom(), {w,h}=S.work;
  const cv=$('topview'); cv.width=TW; cv.height=TH;
  fitOverlayCanvas(cv);
  const cls=new Int8Array(wk.nx*wk.nz).fill(-1);
  const man=new Uint8Array(wk.nx*wk.nz);
  const hot=new Uint8Array(wk.nx*wk.nz);
  for(let sy=0;sy<h;sy++)for(let sx=0;sx<w;sx++){
    const i=sy*w+sx;
    const [X,Z]=groundXZ(sx,sy,i);
    const gx=Math.round((X-wk.x0)/wk.dx), gz=Math.round((Z-wk.z0)/wk.dz);
    if(gx<0||gx>=wk.nx||gz<0||gz>=wk.nz) continue;
    const kk=gz*wk.nx+gx, c=isObjectAt(i);
    if(c>cls[kk]) cls[kk]=c;                       // 物体盖住地面
    if(S.editObj&&S.editObj[i]) man[kk]=1;
    if(S.hotInstance&&S.objIds&&S.objIds[i]===S.hotInstance) hot[kk]=1;
  }
  const ctx=cv.getContext('2d');
  const img=ctx.createImageData(TW,TH);
  for(let gz=0;gz<wk.nz;gz++)for(let gx=0;gx<wk.nx;gx++){
    const kk=gz*wk.nx+gx, c=cls[kk];
    const walkable=S.walk.mask&&S.walk.mask[kk];
    let r,g,b;
    if(c<0){ r=26;g=30;b=36; }                                     // 无数据
    else if(c===1){ r=209;g=58;b=68; }                             // 物体
    else { r=walkable?74:52; g=walkable?222:150; b=walkable?128:96; } // 地形(亮=可走)
    if(man[kk]){ r=Math.min(255,r+60); g=Math.min(255,g+60); b=Math.min(255,b+60); }
    if(hot[kk]){ r=255; g=213; b=74; }             // 与 2D 视图同色的联动高亮
    for(let dy=0;dy<TOP_SCALE;dy++)for(let dx=0;dx<TOP_SCALE;dx++){
      const o=((gz*TOP_SCALE+dy)*TW+(gx*TOP_SCALE+dx))*4;
      img.data[o]=r; img.data[o+1]=g; img.data[o+2]=b; img.data[o+3]=255;
    }
  }
  ctx.putImageData(img,0,0);
  if(S.topPoly&&S.topPoly.length){                 // 正在画的多边形
    ctx.strokeStyle='#ffd54a'; ctx.fillStyle='#ffd54a'; ctx.lineWidth=2;
    ctx.beginPath(); S.topPoly.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));
    ctx.stroke();
    for(const [x,y] of S.topPoly) ctx.fillRect(x-2,y-2,4,4);
  }
}
/** 顶视多边形 → 世界 XZ 多边形 → 落到工作分辨率像素上写覆写层 */
function topPolyApply(){
  const pts=S.topPoly; if(!pts||pts.length<3){ S.topPoly=[]; return; }
  const {wk}=topGeom(), {w,h}=S.work;
  const wpts=pts.map(([x,y])=>[wk.x0+(x/TOP_SCALE)*wk.dx, wk.z0+(y/TOP_SCALE)*wk.dz]);
  const inside=(X,Z)=>{
    let c=false;
    for(let i=0,j=wpts.length-1;i<wpts.length;j=i++){
      const [xi,zi]=wpts[i],[xj,zj]=wpts[j];
      if(((zi>Z)!==(zj>Z)) && (X<(xj-xi)*(Z-zi)/(zj-zi)+xi)) c=!c;
    }
    return c;
  };
  if(S.brush<12||S.brush>15){                     // 防呆:没选地形笔刷就别乱改判定
    S.topPoly=[]; buildTopView();
    $('log').textContent='顶视圈选需要先把笔刷切到「地形:标为物体/地形」或「多边形:标为物体/地形」';
    return;
  }
  const val=(S.brush===15||S.brush===13)?2:1;      // 15/13=标为地形,其余=标为物体
  let n=0;
  for(let sy=0;sy<h;sy++)for(let sx=0;sx<w;sx++){
    const i=sy*w+sx;
    const [X,Z]=groundXZ(sx,sy,i);
    if(!inside(X,Z)) continue;
    S.editObj[i]=val; n++;
  }
  S.topPoly=[]; S.editDirty=true;
  refreshEditOverlay(); buildTopView();
  $('log').textContent=`✓ 顶视圈选:${n} 个像素标为${val===1?'物体':'地形'}——保存编辑后重烘生效`;
}
document.querySelectorAll('.views button').forEach(b=>b.onclick=()=>{ setView(+b.dataset.v); canvas.focus(); });

// 顶视画布:单击加顶点,双击闭合填充,Esc 取消(与 2D 视图多边形同手势)
(function(){
  const tv=$('topview');
  const toLocal=e=>{
    const r=tv.getBoundingClientRect();
    return [(e.clientX-r.left)/r.width*tv.width, (e.clientY-r.top)/r.height*tv.height];
  };
  tv.addEventListener('click',e=>{
    if(S.view!==2) return;
    S.topPoly.push(toLocal(e)); buildTopView();
  });
  // 右键=闭合并填充(双击那套要靠 pop() 补偿多出来的顶点,是将就写法,已去掉)
  tv.addEventListener('contextmenu',e=>{
    e.preventDefault();
    if(S.view!==2) return;
    if(S.topPoly.length>=3) topPolyApply();
    else { S.topPoly=[]; buildTopView(); }        // 不足三点=取消
  });
  window.addEventListener('keydown',e=>{
    if(S.view===2&&e.key==='Escape'){ S.topPoly=[]; buildTopView(); }
  });
  window.addEventListener('resize',()=>{
    if(S.view===2) buildTopView();
    else if(S.view===-1) fitOverlayCanvas(tv);
  });
})();

function bindSlider(id,key,fmt=v=>v,onchg){
  const el=$(id), lab=$(id+'_v');
  // 控件缺失只跳过这一根滑杆:浏览器缓存住旧 index.html、新 app.js 生效时,
  // 老写法会在这里抛异常把整个脚本打断(页面一片黑、场景列表都出不来)。
  if(!el){ console.warn('[viewer] 缺控件',id,'——请硬刷新页面(旧 HTML 被缓存)'); return; }
  const upd=()=>{ const v=parseFloat(el.value); if(key)S[key]=v; if(lab)lab.textContent=fmt(v); if(onchg)onchg(v); };
  el.addEventListener('input',upd); upd();
}
function setSlider(id,v){ const el=$(id); if(el){ el.value=v; el.dispatchEvent(new Event('input')); } }
const rayReset=()=>{ S.rays=null; };
bindSlider('pgain',null,v=>'2^'+v.toFixed(1),v=>{ S.pgain=Math.pow(2,v); });
bindSlider('spp','spp',v=>v.toFixed(0));
bindSlider('step','step',v=>v.toFixed(1),rayReset);
bindSlider('msteps','msteps',v=>v.toFixed(0),rayReset);
bindSlider('beta','beta',v=>'2^'+v.toFixed(1));
bindSlider('amb','amb',v=>v.toFixed(2),()=>probeRefresh());
bindSlider('contact','contact',v=>v.toFixed(2));
bindSlider('qscale','qscale',v=>'×'+v.toFixed(2),rayReset);
bindSlider('charh','charH',v=>v.toFixed(2),rayReset);
bindSlider('bulge','bulge',v=>v.toFixed(2));
bindSlider('flatten','flatten',v=>v.toFixed(2));
$('fold').addEventListener('change',e=>{ S.fold=e.target.checked?1:0; S.rays=null; });
$('missnorm').addEventListener('change',e=>{ S.missMode=e.target.checked?1:0; probeRefresh(); });
$('collide').addEventListener('change',e=>{ S.collide=e.target.checked?1:0; });
for(const k of ['walk','probes','occl','normal','rays','lights','terrain'])
  $('dbg_'+k).addEventListener('change',e=>{ S.dbg[k]=e.target.checked?1:0;
    if(k==='terrain') refreshEditOverlay(); });
$('nee').addEventListener('change',e=>{ S.nee=e.target.checked?1:0; probeRefresh(); });

// probe 显示(纯预览:不入数值、不重烘、不导出)
bindSlider('probegain',null,v=>'2^'+v.toFixed(2),v=>{ S.probeGain=Math.pow(2,v); });
// ⑥ probe 检视面板
bindSlider('pb_gain',null,v=>'2^'+v.toFixed(2),v=>{ S.pbGain=Math.pow(2,v);
  if(S.selProbe!=null) renderProbePanel(); });
$('pb_basis').addEventListener('change',e=>{ S.pbBasisSel=+e.target.value;
  if(S.selProbe!=null) renderProbePanel(); });
$('pb_rays').addEventListener('change',e=>{ S.pbRays=e.target.checked?1:0; });
$('pb_close').onclick=()=>selectProbe(null);
// 3D 相机
document.querySelectorAll('#cam_modes button').forEach(b=>
  b.onclick=()=>{ setCamMode(b.dataset.cm); canvas.focus(); });
bindSlider('camspeed',null,v=>v.toFixed(1)+'m/s',v=>{ S.cam.speed=v; });
bindSlider('camfov',null,v=>v.toFixed(0)+'°',v=>{ S.cam.fov=v; });
// probe 全景
function setPanoMode(m){
  S.pano.mode=m;
  document.querySelectorAll('#pano_modes button').forEach(b=>b.classList.toggle('on',+b.dataset.pm===m));
  if(m>=0 && S.cam.mode!=='fly') setCamMode('fly');     // 全景只在漫游下成立,顺手切过去
}
document.querySelectorAll('#pano_modes button').forEach(b=>
  b.onclick=()=>{ setPanoMode(+b.dataset.pm); canvas.focus(); });
bindSlider('pano_blend',null,v=>v.toFixed(2),v=>{ S.pano.blend=v; });
$('pano_interp').addEventListener('change',e=>{ S.pano.interp=e.target.checked?1:0; });
$('pano_char').addEventListener('change',e=>{ S.pano.drawChar=e.target.checked?1:0; });
S.bgview=0;
$('bgview').addEventListener('change',e=>{ S.bgview=+e.target.value; });
$('hdr_method').addEventListener('change',e=>{ S.hdrMethod=+e.target.value; if(S.man)refreshThumbs(); });
bindSlider('hdr_pa',null,v=>v.toFixed(2),v=>{ S.hdrPA=v; if(S.man)refreshThumbs(); });
[['pc_front',0],['pc_hidden',1],['pc_ground',2]].forEach(([id,i])=>
  $(id).addEventListener('change',e=>{ S.pcShow[i]=e.target.checked?1:0; }));
$('pc_mesh').addEventListener('change',e=>{ S.meshMode=e.target.checked?1:0; });

const RB_IDS=['rb_pitch','rb_az','rb_ppu','rb_dscale','rb_doff','rb_chlo','rb_chhi',
              'rb_ev','rb_gain','rb_tau','rb_relief','rb_px','rb_py','rb_pz','rb_band'];
$('rb_model').addEventListener('change',()=>{ if(S.man)markDirty(true); });
function markDirty(d){ $('rebuild').classList.toggle('dirty',d); }
RB_IDS.forEach(id=>bindSlider(id,null,v=>(''+v).slice(0,5),()=>{ if(S.man)markDirty(true); }));
// HDR最大EV 拖动即实时刷新 HDR/光源缩略图(只缩放已烘 gain 场,无需重烘)
$('rb_gain').addEventListener('input',()=>{ if(S.man)refreshThumbs(); });

function rbParams(){
  return {
    pitch_deg:$('rb_pitch').value, azimuth_deg:$('rb_az').value,
    ppu_ratio:$('rb_ppu').value, ev:$('rb_ev').value,
    depth_model:$('rb_model').value,
    depth_scale_adj:$('rb_dscale').value, depth_offset_adj:$('rb_doff').value,
    col_h_lo:$('rb_chlo').value, col_h_hi:$('rb_chhi').value,
    max_gain_ev:$('rb_gain').value, occluder_tau:$('rb_tau').value,
    relief:$('rb_relief').value, fold:$('rb_fold').checked?1:0,
    object_score_min:$('rb_objthr').value,
    semantic_gate:$('rb_sem').checked?1:0,
    // 当前选中的 HDR 恢复法/参数(④显示 的下拉与滑条)→ 烘焙用同一方法,预览即所烘
    hdr_method:S.hdrMethod??0, hdr_pa:S.hdrPA??0.7,
    probe_nx:$('rb_px').value, probe_ny:$('rb_py').value, probe_nz:$('rb_pz').value,
    probe_band:($('rb_band')||{value:1.6}).value};
}
// ---------------------------------------------------- 场景清单(扫游戏工程)
// 场景身份只认**游戏场景 id**(public/assets/scenes/<id>.json 的文件名):背景图、
// 烘焙目录、导照明、导深度四个落点全由它推出。曾经的「上传图片建新场景」按文件名
// 猜场景名,真把 teahouse 的背景烘成了叫 "background" 的假场景 —— 已废除。
function sceneMark(s){
  if(s.orphan) return '⚠孤儿';
  if(!s.bg_ok) return '⚠缺背景';
  if(s.bg_stale) return '⚠背景已变';
  if(!s.baked) return '○未烘焙';
  return s.lighting ? '✓已导出' : '✓已烘焙';
}
function sceneInfo(id){ return (S.gameScenes||[]).find(s=>s.id===id); }
function bakedManifest(id){ return (S.scenes||[]).find(m=>m.name===id); }
/** 拉全清单(游戏场景 × 实验室状态)并填下拉;返回应当选中的 id。 */
async function refreshSceneList(prefer){
  const [gs, baked]=await Promise.all([
    fetch('/api/game_scenes',{cache:'no-store'}).then(r=>r.json()),
    fetch('/api/scenes',{cache:'no-store'}).then(r=>r.json()),
  ]);
  S.gameScenes=gs; S.scenes=baked;
  $('scene').innerHTML=gs.map(s=>`<option value="${s.id}">${sceneMark(s)} ${s.id}</option>`).join('');
  const want=prefer||(S.man&&S.man.name);
  const cur=(gs.find(s=>s.id===want)||gs.find(s=>s.baked)||gs[0]||{}).id;
  if(cur) $('scene').value=cur;
  return cur;
}
/** 选中某场景:刷新状态行与主按钮语义;已烘过的返回它的 manifest。 */
function applySceneSelection(id){
  const g=sceneInfo(id), m=bakedManifest(id), btn=$('rebuild'), info=$('scene_info');
  btn.textContent=m ? '⟳ 应用上面参数:重建几何+重烘光照'
                    : '⤓ 首次烘焙此场景(自动取游戏背景)';
  if(info){
    if(!g){ info.textContent=''; }
    else if(g.orphan){
      info.innerHTML=`<span class="warn">⚠ 孤儿:游戏里没有 id=${g.id} 的场景</span>`+
        `——多半是历史错位命名,烘了也没法导出;去主编辑器建同名场景,或删掉 out/${g.id}/`;
    }else{
      const bits=[`背景 <b>${g.bg}</b>`, g.baked?'已烘焙':'<b>未烘焙</b>',
                  g.lighting?'已导照明':'未导照明', g.depth?'已有depthConfig':'无depthConfig'];
      info.innerHTML=bits.join(' · ')+
        (!g.bg_ok?'<br><span class="warn">⚠ 背景图不在盘上,无法烘焙</span>':'')+
        (g.bg_stale?'<br><span class="warn">⚠ 背景已重画,烘焙输入过期——需重烘并重新导出</span>':'');
    }
  }
  return m;
}

/** 导出/编辑类操作的闸门:必须有已加载场景,且下拉选的就是它(防"选了A导出了B")。 */
function activeScene(){
  if(!S.man){ $('log').textContent='✗ 还没有任何已烘焙的场景'; return null; }
  if($('scene').value!==S.man.name){
    $('log').textContent=`✗ 下拉选的是 ${$('scene').value}(未烘焙),画面上是 ${S.man.name}`+
      '——先把它烘出来,或切回已烘焙的场景再操作';
    return null;
  }
  return S.man.name;
}

const BAKE_BTNS=['rebuild','rebuild_all'];
async function watchJob(jobId, reloadName){
  BAKE_BTNS.forEach(id=>$(id).disabled=true);
  try{
    for(;;){
      const r=await (await fetch('/api/job?id='+jobId)).json();
      if(!r.ok){ $('log').textContent='✗ 任务丢失'; break; }
      const tail=(r.log||'').split('\n').slice(-7).join('\n');
      $('log').textContent=`[${r.label}] ${r.status}`+
        (r.queue_position?` (排队第 ${r.queue_position})`:'')+'\n'+tail;
      if(r.status==='done'||r.status==='failed'){
        $('log').textContent=(r.status==='done'?'✓ 完成\n':'✗ 失败\n')+tail;
        if(r.status==='done'){
          const cur=await refreshSceneList(reloadName);
          const target=applySceneSelection(cur);
          if(target) await loadScene(target);      // loadScene refreshes geo status
        }
        break;
      }
      await new Promise(res=>setTimeout(res,1200));
    }
  }catch(err){ $('log').textContent='✗ '+err; }
  BAKE_BTNS.forEach(id=>$(id).disabled=false);
}
$('rebuild').onclick=async()=>{
  const id=$('scene').value;
  if(!id) return;
  // 已烘过 = 重烘;没烘过 = 首次烘焙(服务端按场景 id 自动把游戏背景拷进 out/<id>/)
  const first=!bakedManifest(id);
  const q=new URLSearchParams({scene:id, ...rbParams()});
  const r=await (await fetch((first?'/api/import?':'/api/rebuild?')+q)).json();
  if(r.ok) watchJob(r.job, id); else $('log').textContent='✗ '+(r.err||'');
  markDirty(false);
};
$('rebuild_all').onclick=async()=>{
  const r=await (await fetch('/api/rebuild_all')).json();
  if(r.ok) watchJob(r.job, S.man&&S.man.name); else $('log').textContent='✗ '+(r.err||'');
};
$('export_rt').onclick=async()=>{
  const name=activeScene(); if(!name) return;
  // 面板当前非 bake 着色参数一并导出为场景配置(游戏 F2 打开即这些值)。
  // pgain(预览亮度)是实验室显示设施,刻意不导出——游戏侧角色曝光只认 β。
  const sh=new URLSearchParams({
    scene:name, mode:S.mode, spp:S.spp, step:S.step, msteps:S.msteps,
    fold:S.fold, miss_mode:S.missMode, nee:S.nee, beta:S.beta,
    amb:S.amb, bulge:S.bulge, flatten:S.flatten,
  });
  const r=await (await fetch('/api/export?'+sh)).json();
  $('log').textContent=r.ok?('✓ 已导出到游戏(含着色参数配置)\n'+r.dest):('✗ '+(r.err||''));
};
$('scene').addEventListener('change',async e=>{
  const m=applySceneSelection(e.target.value);
  if(m) await loadScene(m);
  else $('log').textContent='该场景还没烘焙——点上面橙色按钮「首次烘焙」即可(背景自动从工程取)';
  canvas.focus();
});

// ------------------------------------------------------------- boot
(async()=>{
  const cur=await refreshSceneList();
  const m=applySceneSelection(cur);
  if(m) await loadScene(m);
  canvas.focus();
  draw();
})();
