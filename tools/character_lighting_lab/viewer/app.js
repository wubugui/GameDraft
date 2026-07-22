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

const BG_FS = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 frag;
uniform sampler2D uBG, uDepth, uGain;
uniform ivec2 uWork; uniform int uDbgDepth, uDbgGain, uDbgHDR;
uniform float uPGain, uMaxGain;
${COMMON}
vec3 ramp(float t){
  vec3 s0=vec3(.06,.06,.24),s1=vec3(.16,.35,.78),s2=vec3(.12,.78,.82),s3=vec3(.9,.86,.16),s4=vec3(.86,.16,.12);
  t=clamp(t,0.,1.)*4.; int i=int(t); float f=fract(t);
  if(i==0)return mix(s0,s1,f); if(i==1)return mix(s1,s2,f); if(i==2)return mix(s2,s3,f); return mix(s3,s4,f);
}
void main(){
  vec3 c = texture(uBG, vUV).rgb;
  if(uDbgHDR==1){
    // reconstructed HDR radiance = linear(bg) * 2^(gain01*maxGain); tone via preview gain
    float g01 = texture(uGain, vUV).r;
    vec3 L = srgb2lin(c) * exp2(g01*uMaxGain);
    frag = vec4(lin2srgb(L*uPGain), 1.); return;
  }
  if(uDbgDepth==1){ float d=texelFetch(uDepth, ivec2(vUV*vec2(uWork)),0).r; c=ramp(fract(d*.35)); }
  if(uDbgGain==1){ float g=texture(uGain, vUV).r; c=mix(c, ramp(g), smoothstep(.02,.25,g)); }
  frag=vec4(lin2srgb(srgb2lin(c)*uPGain),1.);
}`;

const CHAR_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUV; out vec4 frag;
uniform sampler2D uAlb, uNrm, uValid, uDepthTex;
// probe atlases: columns [0,K)=base+cov | [K,2K)=amb | [2K,3K)=emit | [3K,4K)=nee
uniform sampler2D uPL1, uPL2, uPBin;
uniform sampler3D uVolEmit;
uniform int uNEE, uLightCount;
uniform vec4 uLightQ[48];                 // q pos + area
uniform vec4 uLightE[48];                 // emissive radiance rgb
uniform vec4 uLightN[48];                 // normal in q
uniform sampler3D uVol;
uniform ivec2 uWork;
uniform vec3 uFootQ;
uniform float uCharH, uCharW, uCosT, uSinT;
uniform vec4 uCal;               // ppu,_,cx,cy
uniform vec3 uQMin, uQMax;
uniform ivec3 uVolN;
uniform mat3 uM;                 // q -> world
uniform vec3 uWMin, uWScale;     // probe grid: t=(Xw-uWMin)*uWScale  in [0,PN-1]
uniform ivec3 uPN;
uniform vec3 uAmbSH[9];
uniform int uMode, uSpp, uMSteps, uOccl, uFold, uShowN, uMissMode;
uniform float uStep, uBeta, uAmb, uBulge, uFlatten, uPGain;
${COMMON}
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
    vec3 dIdx=normalize(dir*scaleIdx)*uStep;
    vec3 p=p0+dIdx*1.5;
    bool hit=false; vec3 Li=vec3(0.);
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
vec3 probeE(vec3 q, vec3 n){
  vec3 Xw = uM * q;                              // -> WORLD, interp axes are world
  vec3 t = clamp((Xw-uWMin)*uWScale, vec3(0.), vec3(uPN)-1.001);
  ivec3 b0=ivec3(t); vec3 f=t-vec3(b0);
  vec3 Esum=vec3(0.); float wsum=0.;
  vec2 ouv; ivec2 ob0; vec2 of;
  if(uMode==3){
    ouv=octaEnc(n)*8.-.5;
    ob0=ivec2(clamp(floor(ouv),vec2(0.),vec2(6.)));
    of=clamp(ouv-vec2(ob0),0.,1.);
  }
  float covSum=0.; vec3 Asum=vec3(0.); vec3 EEsum=vec3(0.); vec3 NNsum=vec3(0.);
  for(int c=0;c<8;c++){
    ivec3 off=ivec3(c&1,(c>>1)&1,(c>>2)&1);
    ivec3 pi=min(b0+off,uPN-1);
    float w=mix(1.-f.x,f.x,float(off.x))*mix(1.-f.y,f.y,float(off.y))*mix(1.-f.z,f.z,float(off.z));
    int flat_=pi.x*(uPN.y*uPN.z)+pi.y*uPN.z+pi.z;
    w*=step(.002, texelFetch(uValid, ivec2(flat_,0),0).r);
    if(w<1e-5) continue;
    vec3 E=vec3(0.); vec3 Ea=vec3(0.); vec3 Ee=vec3(0.); vec3 En=vec3(0.); float cov=0.;
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
    Esum+=max(E,vec3(0.))*w; Asum+=max(Ea,vec3(0.))*w;
    EEsum+=max(Ee,vec3(0.))*w; NNsum+=max(En,vec3(0.))*w;
    covSum+=cov*w; wsum+=w;
  }
  if(wsum<1e-4) return ambIrr(n);
  vec3 Ebase=Esum/wsum, Eamb=Asum/wsum, Eemit=EEsum/wsum, Enee=NNsum/wsum;
  float cov01=clamp(covSum/wsum/3.14159265, 0., 1.);
  // ray-gathered parts (base, and emit when NEE off) obey the miss policy;
  // the analytic NEE term is exact direct light and joins untouched.
  vec3 Eray = Ebase + (uNEE==0 ? Eemit : vec3(0.));
  vec3 E_ = (uMissMode==1) ? Eray/max(cov01,.06) : Eray + Eamb*uAmb;
  if(uNEE==1) E_ += Enee;
  return E_;
}
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
  // OCCLUSION uses the camera-parallel BILLBOARD quad (whole sprite at foot
  // depth -- the game's sprite-sorting convention); SHADING keeps the upright
  // world-vertical quad position q. Splitting the two proxies kills the
  // upper-body pop-through artifacts of depth-testing a tilted quad.
  if(uOccl==1 && dFront<uFootQ.z-.045) discard;
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
  lights:[], pgain:1, v2:{zoom:1, ox:0, oy:0},
  dbg:{depth:0,walk:0,probes:0,occl:1,normal:0,rays:0,gain:0,lights:0},
  pcShow:[1,1,1], meshMode:1, meshTris:0,
  footW:{x:0,z:0},           // WORLD position
  keys:{},
  work:{w:512,h:288}, charAspect:0.5,
  walk:null,                  // {nx,nz,x0,z0,dx,dz,y:Float32Array,mask:Uint8Array}
  M:null,                     // world matrix rows (3x3, q->world)
  occCPU:null,                // volume occupancy for CPU ray viz
  rays:null,                  // {q:Float32Array lines, w:Float32Array, col:...}
  cam:{yaw:-0.7,pitch:0.45,dist:10,tgt:[0,0,0]},
  tex:{}, bufs:{}, probeCount:0, pointCount:0,
  fps:0, frames:0, tFPS:performance.now(),
};

async function fetchBin(u){ const r=await fetch(u); if(!r.ok) throw new Error(u); return r.arrayBuffer(); }
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
  const W=man.work.w, H=man.work.h;
  S.work={w:W,h:H};
  const [bgImg,walkImg,gainImg,front,walky,vol,l1,l2,bins,l1a,l2a,binsa,valid,ppos,points,meshv,meshi,
         volE,l1e,l2e,binse,l1n,l2n,binsn]=await Promise.all([
    loadImg(`${base}/background.png`), loadImg(`${base}/walk_mask.png`), loadImg(`${base}/gain.png`),
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
  S.tex.hidden=texImg(await loadImg(`${base}/hidden.png`),gl.LINEAR);
  S.tex.depth=tex2D(new Float32Array(front),W,H,gl.R32F,gl.RED,gl.FLOAT);
  S.v2={zoom:1, ox:0, oy:0};

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

  // probe cloud (positions + colour from L2 coeff0)
  const pp=new Float32Array(ppos), l2u=new Uint16Array(l2);
  const pcloud=new Float32Array(Pn*3), pcol=new Uint8Array(Pn*4);
  for(let i=0;i<Pn;i++){
    pcloud[i*3]=pp[i*3]; pcloud[i*3+1]=pp[i*3+1]; pcloud[i*3+2]=pp[i*3+2];
    for(let c=0;c<3;c++){
      const v=f16(l2u[(i*9+0)*4+c])*0.9;      // coeff0 of E_hit (layout (P,9,4))
      pcol[i*4+c]=Math.max(30,Math.min(255,Math.round(Math.pow(Math.max(v,0),1/2.2)*255)));
    }
    pcol[i*4+3]=3;                             // tag 3: probes (always shown when enabled)
  }
  S.bufs.probePos=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.probePos); gl.bufferData(gl.ARRAY_BUFFER,pcloud,gl.STATIC_DRAW);
  S.bufs.probeCol=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.probeCol); gl.bufferData(gl.ARRAY_BUFFER,pcol,gl.STATIC_DRAW);

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

  // 3D camera fit
  const wd=man.world;
  S.cam.tgt=[(wd.x0+wd.x1)/2,(wd.y0+wd.y1)/2,(wd.z0+wd.z1)/2];
  S.cam.dist=Math.max(wd.x1-wd.x0, wd.z1-wd.z0)*1.1;

  spawnWorld();
  S.rays=null;
  const sel=$('scene'); if(sel&&sel.value!==man.name) sel.value=man.name;
  setSlider('rb_pitch',man.params.pitch_deg); setSlider('rb_ppu',man.params.ppu_ratio);
  setSlider('rb_ev',man.params.ev); setSlider('rb_tau',man.params.occluder_tau);
  setSlider('rb_gain',man.params.max_gain_ev??3.32);
  setSlider('rb_relief',man.params.relief??1.8);
  const rbf=$('rb_fold'); if(rbf) rbf.checked=!!(man.params.fold??1);
  const rbs=$('rb_sem'); if(rbs) rbs.checked=!!(man.params.semantic_gate??1);
  const rf=$('fold'); if(rf){ rf.checked=!!(man.params.fold??1); S.fold=rf.checked?1:0; }
  setSlider('rb_px',man.params.probe_nx); setSlider('rb_py',man.params.probe_ny);
  setSlider('rb_pz',man.params.probe_nz);
  markDirty(false);
  renderHDRPanel();
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
    let d=[r*Math.cos(ph), r*Math.sin(ph), -Math.sqrt(Math.max(0,1-u1))];   // around n=(0,0,-1)
    let cls=0, folded=0;
    if(S.fold&&d[2]<0){ d=[d[0],d[1],-d[2]]; folded=1; }
    const di=norm3([d[0]*scale[0],d[1]*scale[1],d[2]*scale[2]]);
    let p=[...p0], hit=null;
    for(let s=0;s<S.msteps;s++){
      p=[p[0]+di[0]*S.step, p[1]+di[1]*S.step, p[2]+di[2]*S.step];
      if(p[0]<0||p[1]<0||p[2]<0||p[0]>V.Nx-1||p[1]>V.Ny-1||p[2]>V.Nz-1){ break; }
      const xi=Math.round(p[0]), yi=Math.round(p[1]), zi=Math.round(p[2]);
      if(S.occCPU[(zi*V.Ny+yi)*V.Nx+xi]){ hit=p; break; }
    }
    cls=hit?(folded?1:0):2;
    const pe=hit||p;
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

// ------------------------------------------------------------- char assets
let charReady=false;
(async()=>{
  const [alb,nrm]=await Promise.all([loadImg('/char/albedo.png'),loadImg('/char/normal.png')]);
  S.tex.alb=texImg(alb); S.tex.nrm=texImg(nrm);
  S.charAspect=alb.width/alb.height;
  charReady=true;
})();

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
  gl.uniform1f(gl.getUniformLocation(pBG,'uMaxGain'),S.man.params.max_gain_ev??3.32);
  gl.uniform1f(gl.getUniformLocation(pBG,'uPGain'),S.pgain);
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
    // world regular grid positions projected
    for(let i=0;i<P.nx;i++)for(let j=0;j<P.ny;j++)for(let k=0;k<P.nz;k++){
      const X=[P.gx[i],P.gy[j],P.gz[k]];
      const sp=screenFromQ(qFromWorld(X));
      pts.push([...sp,0.3,1,0.5]);
    }
    drawL2(pts, gl.POINTS);
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
  const binds=[['uAlb',S.tex.alb,gl.TEXTURE_2D],['uNrm',S.tex.nrm,gl.TEXTURE_2D],
    ['uDepthTex',S.tex.depth,gl.TEXTURE_2D],['uVol',S.tex.vol,gl.TEXTURE_3D],
    ['uPL1',S.tex.l1,gl.TEXTURE_2D],['uPL2',S.tex.l2,gl.TEXTURE_2D],
    ['uPBin',S.tex.bins,gl.TEXTURE_2D],['uValid',S.tex.valid,gl.TEXTURE_2D],
    ['uVolEmit',S.tex.volEmit,gl.TEXTURE_3D]];
  binds.forEach(([nm,t,tt],i)=>{ gl.activeTexture(gl.TEXTURE0+i); gl.bindTexture(tt,t); gl.uniform1i(u(nm),i); });
  gl.uniform2i(u('uWork'),S.work.w,S.work.h);
  gl.uniform4f(u('uCal'),cal.ppu,0,cal.cx,cal.cy);
  const V=man.vol;
  gl.uniform3f(u('uQMin'),V.qx_min,V.qy_min,V.qz_min);
  gl.uniform3f(u('uQMax'),V.qx_max,V.qy_max,V.qz_max);
  gl.uniform3i(u('uVolN'),V.Nx,V.Ny,V.Nz);
  const M=man.world.M;
  gl.uniformMatrix3fv(u('uM'),false,[M[0][0],M[1][0],M[2][0],M[0][1],M[1][1],M[2][1],M[0][2],M[1][2],M[2][2]]);
  const wd=man.world, P=man.probes;
  gl.uniform3f(u('uWMin'),wd.x0,wd.y0,wd.z0);
  gl.uniform3f(u('uWScale'),(P.nx-1)/Math.max(wd.x1-wd.x0,1e-5),(P.ny-1)/Math.max(wd.y1-wd.y0,1e-5),(P.nz-1)/Math.max(wd.z1-wd.z0,1e-5));
  gl.uniform3i(u('uPN'),P.nx,P.ny,P.nz);
  const amb=man.ambient.sh;
  for(let k=0;k<9;k++) gl.uniform3f(u(`uAmbSH[${k}]`),amb[k*3],amb[k*3+1],amb[k*3+2]);
  gl.uniform3f(u('uFootQ'),footQ[0],footQ[1],footQ[2]);
  gl.uniform1f(u('uCharH'),effH);
  gl.uniform1f(u('uCharW'),wPx/cal.ppu);
  gl.uniform1f(u('uCosT'),cosT); gl.uniform1f(u('uSinT'),sinT);
  gl.uniform1i(u('uMode'),S.mode); gl.uniform1i(u('uSpp'),S.spp);
  gl.uniform1i(u('uMSteps'),S.msteps); gl.uniform1i(u('uOccl'),S.dbg.occl);
  gl.uniform1i(u('uFold'),S.fold); gl.uniform1i(u('uShowN'),S.dbg.normal);
  gl.uniform1i(u('uMissMode'),S.missMode);
  gl.uniform1i(u('uNEE'),S.nee);
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
  gl.uniform1f(u('uStep'),S.step); gl.uniform1f(u('uBeta'),Math.pow(2,S.beta));
  gl.uniform1f(u('uAmb'),S.amb); gl.uniform1f(u('uBulge'),S.bulge);
  gl.uniform1f(u('uFlatten'),S.flatten);
  gl.uniform1f(u('uPGain'),S.pgain);
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);

  if(S.dbg.rays){ if(!S.rays) buildRays();
    gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.rays2);
    gl.useProgram(pL2);
    gl.uniform2i(gl.getUniformLocation(pL2,'uWork'),S.work.w,S.work.h);
    gl.uniform3f(gl.getUniformLocation(pL2,'uV2'),S.v2.ox,S.v2.oy,S.v2.zoom);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,20,0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,3,gl.FLOAT,false,20,8);
    gl.drawArrays(gl.LINES,0,S.rays.n2);
  }
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

// ------------------------------------------------------------- draw 3D
function draw3D(){
  gl.viewport(0,0,canvas.width,canvas.height);
  gl.clearColor(.05,.06,.08,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  const c=S.cam;
  const eye=[c.tgt[0]+c.dist*Math.cos(c.pitch)*Math.sin(c.yaw),
             c.tgt[1]+c.dist*Math.sin(c.pitch),
             c.tgt[2]+c.dist*Math.cos(c.pitch)*Math.cos(c.yaw)];
  // ORTHOGRAPHIC camera: matches the game's orthographic pseudo-world.
  // c.dist doubles as the ortho half-height (wheel = zoom).
  const hh=c.dist*0.42, hw=hh*canvas.width/canvas.height;
  const mvp=m4mul(m4ortho(hw,hh,0.02,c.dist*12),
                  m4lookAt(eye,c.tgt,[0,1,0]));
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

  // probes
  if(S.dbg.probes){
    gl.uniform1f(gl.getUniformLocation(pP3,'uPtSize'),7.0);
    gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.probePos);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,12,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,S.bufs.probeCol);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,4,gl.UNSIGNED_BYTE,true,4,0);
    gl.drawArrays(gl.POINTS,0,S.probeCount);
  }

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
canvas.addEventListener('dblclick',e=>{ if(S.view===0){ S.v2={zoom:1,ox:0,oy:0}; } });
// click-to-place: teleport to the ground point that projects nearest the click
canvas.addEventListener('click', e=>{
  if(S.view!==0||!S.man||!S.walk) return;
  const [px,py]=canvasToWork(e);
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
  if(S.view===0) move(now);
  if(S.view===0) draw2D(); else draw3D();
  const wy=S.walk?groundY(S.footW.x,S.footW.z):0;
  $('hud').textContent=
    `${['RT 实时追踪·每帧GPU重算','Cache·SH L1·预烘焙插值','Cache·SH L2·预烘焙插值','Cache·BIN·预烘焙插值'][S.mode]}  |  ${S.fps} fps  |  ${S.view?'3D 检视(正交)':'2D ×'+S.v2.zoom.toFixed(1)}\n`+
    `world(${S.footW.x.toFixed(2)}, ${wy.toFixed(2)}, ${S.footW.z.toFixed(2)})`;
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

// 3D orbit
let dragging=false,panMode=false,lx=0,ly=0;
canvas.addEventListener('mousedown',e=>{ if(S.view!==1)return; dragging=true; panMode=e.shiftKey; lx=e.clientX; ly=e.clientY; });
window.addEventListener('mouseup',()=>dragging=false);
window.addEventListener('mousemove',e=>{
  if(!dragging||S.view!==1) return;
  const dx=e.clientX-lx, dy=e.clientY-ly; lx=e.clientX; ly=e.clientY;
  const c=S.cam;
  if(panMode){
    const s=c.dist*0.0016;
    const fwd=[Math.sin(c.yaw),0,Math.cos(c.yaw)], right=[fwd[2],0,-fwd[0]];
    c.tgt[0]-=right[0]*dx*s; c.tgt[2]-=right[2]*dx*s; c.tgt[1]+=dy*s;
  }else{
    c.yaw-=dx*0.008; c.pitch=Math.max(-1.4,Math.min(1.5,c.pitch+dy*0.006));
  }
});
canvas.addEventListener('wheel',e=>{ if(S.view!==1)return; e.preventDefault();
  S.cam.dist*=Math.pow(1.0015,e.deltaY); S.cam.dist=Math.max(1,Math.min(200,S.cam.dist)); },{passive:false});

// ------------------------------------------------------------- UI
const MODE_INFO=[
  '实时光线追踪:每帧、每个角色像素发射 spp 条光线在辐射体素里步进。改任何参数立即反映。',
  'L1 cache:预烘焙 probe 一阶球谐(4系数),角色像素→世界坐标→三线性插值。方向感最弱、最便宜。',
  'L2 cache:预烘焙 probe 二阶球谐(9系数)。对漫反射近乎无损,应与 RT 几乎一致。',
  'BIN cache:预烘焙 probe 8×8 法线bin 纯数据,无球谐截断,是 cache 的上限参照。'];
function setMode(m){ S.mode=m;
  document.querySelectorAll('.modes button').forEach(b=>b.classList.toggle('on',+b.dataset.m===m));
  const mi=$('modeinfo'); if(mi) mi.textContent=MODE_INFO[m]; }
document.querySelectorAll('.modes button').forEach(b=>b.onclick=()=>setMode(+b.dataset.m));
setMode(0);
function setView(v){ S.view=v;
  document.querySelectorAll('.views button').forEach(b=>b.classList.toggle('on',+b.dataset.v===v)); }
document.querySelectorAll('.views button').forEach(b=>b.onclick=()=>{ setView(+b.dataset.v); canvas.focus(); });

function bindSlider(id,key,fmt=v=>v,onchg){
  const el=$(id), lab=$(id+'_v');
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
bindSlider('amb','amb',v=>v.toFixed(2));
bindSlider('contact','contact',v=>v.toFixed(2));
bindSlider('qscale','qscale',v=>'×'+v.toFixed(2),rayReset);
bindSlider('charh','charH',v=>v.toFixed(2),rayReset);
bindSlider('bulge','bulge',v=>v.toFixed(2));
bindSlider('flatten','flatten',v=>v.toFixed(2));
$('fold').addEventListener('change',e=>{ S.fold=e.target.checked?1:0; S.rays=null; });
$('missnorm').addEventListener('change',e=>{ S.missMode=e.target.checked?1:0; });
$('collide').addEventListener('change',e=>{ S.collide=e.target.checked?1:0; });
for(const k of ['walk','probes','occl','normal','rays','lights'])
  $('dbg_'+k).addEventListener('change',e=>{ S.dbg[k]=e.target.checked?1:0; });
$('nee').addEventListener('change',e=>{ S.nee=e.target.checked?1:0; });
S.bgview=0;
$('bgview').addEventListener('change',e=>{ S.bgview=+e.target.value; });
[['pc_front',0],['pc_hidden',1],['pc_ground',2]].forEach(([id,i])=>
  $(id).addEventListener('change',e=>{ S.pcShow[i]=e.target.checked?1:0; }));
$('pc_mesh').addEventListener('change',e=>{ S.meshMode=e.target.checked?1:0; });

const RB_IDS=['rb_pitch','rb_ppu','rb_ev','rb_gain','rb_tau','rb_relief','rb_px','rb_py','rb_pz'];
function markDirty(d){ $('rebuild').classList.toggle('dirty',d); }
RB_IDS.forEach(id=>bindSlider(id,null,v=>(''+v).slice(0,5),()=>{ if(S.man)markDirty(true); }));

function rbParams(){
  return {
    pitch_deg:$('rb_pitch').value, ppu_ratio:$('rb_ppu').value, ev:$('rb_ev').value,
    max_gain_ev:$('rb_gain').value, occluder_tau:$('rb_tau').value,
    relief:$('rb_relief').value, fold:$('rb_fold').checked?1:0,
    semantic_gate:$('rb_sem').checked?1:0,
    probe_nx:$('rb_px').value, probe_ny:$('rb_py').value, probe_nz:$('rb_pz').value};
}
const BAKE_BTNS=['rebuild','build_new','rebuild_all'];
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
          const ms=await (await fetch('/api/scenes')).json();
          S.scenes=ms;
          $('scene').innerHTML=ms.map(m=>`<option>${m.name}</option>`).join('');
          const target=ms.find(m=>m.name===(reloadName||S.man.name))||ms[0];
          if(target) await loadScene(target);
        }
        break;
      }
      await new Promise(res=>setTimeout(res,1200));
    }
  }catch(err){ $('log').textContent='✗ '+err; }
  BAKE_BTNS.forEach(id=>$(id).disabled=false);
}
$('rebuild').onclick=async()=>{
  const name=S.man.name;
  const q=new URLSearchParams({scene:name, ...rbParams()});
  const r=await (await fetch('/api/rebuild?'+q)).json();
  if(r.ok) watchJob(r.job, name); else $('log').textContent='✗ '+(r.err||'');
  markDirty(false);
};
$('rebuild_all').onclick=async()=>{
  const r=await (await fetch('/api/rebuild_all')).json();
  if(r.ok) watchJob(r.job, S.man&&S.man.name); else $('log').textContent='✗ '+(r.err||'');
};
$('export_rt').onclick=async()=>{
  const r=await (await fetch('/api/export?scene='+encodeURIComponent(S.man.name))).json();
  $('log').textContent=r.ok?('✓ 已导出到游戏\n'+r.dest):('✗ '+(r.err||''));
};
$('build_new').onclick=()=>$('new_file').click();
$('new_file').addEventListener('change',async e=>{
  const f=e.target.files[0]; if(!f) return;
  e.target.value='';
  const name=f.name.replace(/\.[^.]+$/,'');
  const q=new URLSearchParams({name, ...rbParams()});
  $('log').textContent=`上传 ${f.name}…`;
  const r=await (await fetch('/api/build_new?'+q,{method:'POST',body:await f.arrayBuffer()})).json();
  if(r.ok) watchJob(r.job, r.scene); else $('log').textContent='✗ '+(r.err||'');
});

$('scene').addEventListener('change',async e=>{
  const m=S.scenes.find(x=>x.name===e.target.value);
  if(m) await loadScene(m);
  canvas.focus();
});

// ------------------------------------------------------------- boot
(async()=>{
  S.scenes=await (await fetch('/api/scenes')).json();
  $('scene').innerHTML=S.scenes.map(m=>`<option>${m.name}</option>`).join('');
  if(S.scenes.length) await loadScene(S.scenes[0]);
  canvas.focus();
  draw();
})();
