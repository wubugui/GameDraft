/* Character lighting tool viewer v2.
 * WORLD-space probes: quad pixels are transformed q->world in-shader and
 * trilinearly interpolated in a world-axis-aligned probe volume.
 * RT gather uses double-sided folding (A7): camera-side rays trace mirrored.
 * Collision lives on a WORLD ground grid, decoupled from screen occlusion.
 * 3D inspector: orbit view of point cloud + probes + character + rays.
 *
 * 2026-09-28 画面迁到引擎 RHI(只有 WebGPU),页面里不再有 WebGL / GLSL:
 *  - 2D 场景视图 = 游戏同一份角色受光(CharacterLightingSystem + CharacterLitSprite 的 WGSL)与深度遮挡
 *    (SceneDepthSystem / DepthOcclusionFilter),经 /gen/charlab.bundle.js 的 charLabView 拼;载荷是本机工作台
 *    按游戏格式现场变换的虚拟目录(serve /api/game_payload,见 game_payload.py)。背景视图 / 缩略图在 CPU 上算
 *    (labImages),标注线点画在叠在上面的 2D 画布(#gl,也是收事件、拿键盘焦点的那块)。
 *  - 3D 检视 = 接入层的 3D 调试件(#gl3d);角色 quad 贴的是 2D 那份游戏着色离屏画出来的图,全景是 CPU 算的经纬图贴在球上。
 */
'use strict';
const $ = id => document.getElementById(id);
const canvas = $('gl');            // 2D 标注层 + 事件 + 键盘焦点(像素尺寸 = 视口 CSS 尺寸 × 设备像素比)
const canvas3d = $('gl3d');        // 3D 调试件的 WebGPU 画布
const canvas2d = $('gpu2d');       // 2D 场景视图的 WebGPU 画布(游戏同一个渲染器)
const viewwrap = $('viewwrap');
const octx = canvas.getContext('2d');
/** GPU 侧句柄:rt = 包的命名空间;host / stage = 2D;g3 = 3D;err = 拿不到 WebGPU / 打包失败的人话原因 */
const V = { rt:null, host:null, stage:null, g3:null, err:'', err3:'', ready:false, W2:0, H2:0, dpr:1,
  bgTex:null, bgView:null, bgViewKey:'', ovTex:null, ovDirty:false, charTex:null, charNrm:null,
  t3:null, mesh3:null, sphere:null, sphereAt:null, pano:null, char3:null, char3Key:'', char3Busy:false, off:null,
  payloadKey:'', loadSeq:0, px:null };

// ------------------------------------------------------- 反馈通道(B-1 / B-3)
// 病灶:单个 #log 曾承载烘焙状态/导出成败/保存结果/闸门拒绝/异常全部消息,只靠 ✓✗
// 前缀区分,且后一条直接冲掉前一条 —— 错误一滚就没。
// 现在:分级着色 + 保留最近若干条;**err 常驻**,只会被下一条 err 顶掉。
const LOG_KEEP = 5;
const _logLines = [];                       // [{msg, kind}]
function setLog(msg, kind = 'info') {
  if (msg == null) return;
  _logLines.push({ msg: String(msg), kind });
  while (_logLines.length > LOG_KEEP) {     // 优先丢最老的非 err,全是 err 才丢最老的
    const i = _logLines.findIndex(l => l.kind !== 'err');
    _logLines.splice(i < 0 ? 0 : i, 1);
  }
  const box = $('log'); if (!box) return;
  box.textContent = '';
  for (const l of _logLines) {
    const el = document.createElement('span');
    el.className = 'l ' + l.kind;
    el.textContent = l.msg;
    box.appendChild(el);
  }
  box.scrollTop = box.scrollHeight;
}
// B-1:异步动作必须在**第一帧**就有反馈。原来 7 个动作按钮里 6 个要等网络往返
// 才改一个像素(导出照明写 ~25MB 期间界面完全静止)—— 那正是「看不出点没点」。
function busy(btn, msg) {
  if (btn) { btn.disabled = true; btn.dataset.busy = '1'; }
  setLog(msg, 'pending');
}
function idle(btn, msg, kind = 'ok') {
  if (btn) { btn.disabled = false; delete btn.dataset.busy; }
  if (msg != null) setLog(msg, kind);
}

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

// ------------------------------------------------------------- GPU(引擎 RHI,只有 WebGPU)
// 包:/gen/charlab.bundle.js(bundle.py 按需现打)。命名空间:workbenchRhi(2D 画布宿主)/ offscreenReadback /
// debug3d(3D 调试件)/ charLabView(游戏的角色受光与遮挡拼出的 2D 场景)/ labImages(纯工具视图的逐像素图)。
// 拿不到 WebGPU(离屏 Qt / 驱动不行)时:烘焙 / 导出 / 编辑 / 顶视 / probe 面板照常,画面区写原因,不回落任何别的 API。
async function initGpu(){
  try{
    const boot=await (await fetch('/api/boot',{cache:'no-store'})).json();
    if(boot.bundle&&!boot.bundle.ok) throw new Error('打包失败:'+(boot.bundle.err||'?'));
    V.rt=await import('/gen/charlab.bundle.js');
  }catch(e){ V.err='画面模块没装上:'+(e&&e.message||e); V.err3=V.err; return; }
  try{
    V.host=await V.rt.workbenchRhi.createCanvasHost(canvas2d,{background:0x0a0d0f});
    V.stage=new V.rt.charLabView.CharLabStage();
  }catch(e){ V.err=(e&&e.message)||String(e); V.host=null; V.stage=null; }
  try{
    V.g3=await V.rt.debug3d.createView(canvas3d,{background:[.05,.06,.08]});
  }catch(e){ V.err3=(e&&e.message)||String(e); V.g3=null; }
  // 角色图:与游戏同一条装载(颜色 = 动画图集那条;法线 = *.normal.png 那条不预乘通道)
  if(V.stage){
    try{
      const [c,n]=await Promise.all([V.rt.charLabView.loadColorTexture('/char/albedo.png'),
                                     V.rt.charLabView.loadNormalTexture('/char/normal.png')]);
      V.charTex=c; V.charNrm=n;
      V.stage.setCharacterTextures(c, n.source);
      S.charAspect=c.width/c.height;
      charReady=true;
    }catch(e){ V.err='角色图没装上:'+e; }
  }
  V.ready=true;
}
/** 画面区尺寸:逻辑宽 = 原生宽/2(与迁移前画布同),高按 work 比例;三块画布叠在一起、跟着显示尺寸走 */
function sizeViewport(){
  if(!S.man) return;
  const W2=Math.round(S.man.native.w/2), H2=Math.round(W2*S.work.h/S.work.w);
  V.W2=W2; V.H2=H2;
  const box=$('stage_main');
  const k=Math.min(1,(box.clientWidth||W2)/W2,(box.clientHeight||H2)/H2);
  const cw=Math.max(1,Math.floor(W2*k)), ch=Math.max(1,Math.floor(H2*k)), dpr=window.devicePixelRatio||1;
  if(viewwrap.style.width!==cw+'px') viewwrap.style.width=cw+'px';
  if(viewwrap.style.height!==ch+'px') viewwrap.style.height=ch+'px';
  V.dpr=dpr;
  const pw=Math.max(1,Math.round(cw*dpr)), ph=Math.max(1,Math.round(ch*dpr));
  if(canvas.width!==pw||canvas.height!==ph){ canvas.width=pw; canvas.height=ph; }
  if(canvas3d.width!==pw||canvas3d.height!==ph){ canvas3d.width=pw; canvas3d.height=ph; }
  if(V.host) V.host.resize(cw,ch,dpr);
}
/** 虚拟烘焙目录(工作台按游戏载荷格式现场变换,见 serve /api/game_payload):合成参数 = 固化进图集的 nee / amb */
function payloadBase(name){
  const k=`n${S.nee?1:0}-a${(+S.amb).toFixed(3)}`;
  return `/api/game_payload/${encodeURIComponent(name)}/${k}`;
}
/** 载荷(或它的合成参数)变了就重装:游戏的装载器 + 深度系统(换场景才重装深度) */
async function syncPayload(force){
  if(!V.stage||!S.man) return;
  const base=payloadBase(S.man.name), key=S.man.name+'|'+base;
  if(!force&&key===V.payloadKey) return;
  V.payloadKey=key;
  const seq=++V.loadSeq;
  const g=sceneInfo(S.man.name);
  const sceneOnly=force||!V.stage.loaded;
  const task=V.stage.load({sceneId:S.man.name, bgImage:(g&&g.bg)||'background.png', baseUrl:base,
    work:S.man.work, native:S.man.native, wuPerQUnit:S.man.cal.ppu}, {lightingOnly:!sceneOnly});
  V.payloadPending=task;              // 对照 / 自检等它装完
  const ok=await task;
  if(seq!==V.loadSeq) return;
  V.payloadPending=null;
  V.char3Key='';
  if(!ok) setLog('✗ 角色受光载荷没装上:'+(V.stage.lastProblem||'?'),'err');
}
let _payloadTimer=0;
/** nee / amb 拖动时别每一下都重装:停手 250ms 再装 */
function schedulePayload(){ clearTimeout(_payloadTimer); _payloadTimer=setTimeout(()=>syncPayload(false),250); }

// ---- CPU 图(纯工具视图):背景各视图 / 缩略图都从这几张原图的像素算
function imagePixels(img){
  const c=document.createElement('canvas'); c.width=img.naturalWidth||img.width; c.height=img.naturalHeight||img.height;
  const x=c.getContext('2d',{willReadFrequently:true}); x.drawImage(img,0,0);
  return {width:c.width,height:c.height,data:x.getImageData(0,0,c.width,c.height).data};
}
function curHdr(){
  const rbg=$('rb_gain');
  return {method:S.hdrMethod??0, pa:S.hdrPA??0.7,
    maxGain: rbg?parseFloat(rbg.value):(S.man.params.max_gain_ev??3.32)};
}
/** 2D 背景:原画且预览亮度 1 → 直接用原画纹理;其余视图在 CPU 上逐像素算一张(参数不变就不重算) */
function currentBgTexture(){
  if(!V.rt||!V.px) return null;
  const mode=S.bgview|0;
  if(mode===0&&Math.abs(S.pgain-1)<1e-9) return V.bgTex;
  const h=curHdr();
  const key=[S.man.name,mode,S.pgain,h.method,h.pa,h.maxGain,V.W2,V.H2].join('|');
  if(key!==V.bgViewKey){
    const img=V.rt.labImages.bgViewPixels({mode, width:V.W2, height:V.H2, bg:V.px.bg, gain:V.px.gain,
      depth:{data:S.frontD,w:S.work.w,h:S.work.h}, pgain:S.pgain, ...h});
    if(V.bgView){ V.stage.setBackground(null); V.bgView.destroy(true); }
    V.bgView=V.rt.charLabView.textureFromPixels(img.width,img.height,img.data,{nearest:mode===3});
    V.bgViewKey=key;
  }
  return V.bgView;
}
/** 常驻缩略图:恢复的 HDR 场景 + 分割出的光源 + 提升场(CPU 逐像素;场景 load / HDR 参数变时调) */
function refreshThumbs(){
  if(!S.man||!V.rt||!V.px) return;
  const aw=S.work.w, ah=S.work.h;
  const W=200, H=Math.max(60,Math.round(W*ah/aw));
  const imgs=V.rt.labImages.thumbPixels({width:W,height:H,bg:V.px.bg,gain:V.px.gain,mask:V.px.mask,...curHdr()});
  ['thumb_hdr','thumb_lights','thumb_gain'].forEach((cid,mode)=>{
    const cv=document.getElementById(cid); if(!cv) return;
    cv.width=W; cv.height=H;
    const ctx=cv.getContext('2d');
    const img=ctx.createImageData(W,H); img.data.set(imgs[mode].data);
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
  });
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

// ------------------------------------------------------------- state
const S = {
  scenes:[], man:null, view:0, mode:1,   // 进入默认 L1 cache(RT 实时追踪太吃 GPU,留作手动对比)
  spp:64, step:0.9, msteps:160, beta:0, amb:1, contact:0.55, eChroma:0,
  qscale:1, charH:1.5, bulge:0.22, flatten:0, fold:1, missMode:0, collide:1, nee:0,
  lights:[], pgain:1, hdrMethod:0, hdrPA:0.7, v2:{zoom:1, ox:0, oy:0},
  dbg:{depth:0,walk:0,probes:0,occl:1,normal:0,rays:0,gain:0,lights:0,terrain:0},
  brush:0, brushR:12, brushS:0.15,
  editDepth:null, editDepthBaked:null, editCol:null, editDirty:false, geoStale:false,
  // 物体/地形判定:objAuto=SAM 自动结果(按分数门槛), editObj=人工覆写(1=物体 2=地形)
  objAuto:null, editObj:null, objIds:null, objMeta:null, objScoreMin:0.35, topPoly:[],
  hotInstance:0,                                   // 悬停/选中的实例(两视图联动高亮)
  objBBox:null,                                    // id → [x0,y0,x1,y1],脏矩形用(A-5)
  hoverInfo:'',                                    // 悬停实例读数:并进 HUD 合成
  //  ⚠ 原来悬停时直接写 $('hud').textContent,而 draw() 每帧无条件重写 HUD
  //    → 读数下一帧就被冲掉,等于看不见。现在走状态,由 HUD 合成统一输出。
  cursorW:{x:0,y:0,on:0},                          // 光标(工作分辨率坐标),笔刷圆环用(D-4)
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
  pano:{mode:-1, blend:0.35, interp:1, drawChar:1, fold:0, activeProbe:-1},
  probeCount:0, pointCount:0,
  cloud:null,                 // 点云 CPU 源:{pos:Float32Array, rgb:Uint8Array, tag:Uint8Array}
  meshSrc:null,               // 重建网格 CPU 源(3D 调试件按层拆成三份贴图网格)
  fps:0, frames:0, tFPS:performance.now(),
};

// no-store:重烘后同名 .bin 被覆盖,浏览器启发式缓存会喂旧字节(3D 几何不更新的元凶)→ 强制绕缓存。
async function fetchBin(u){ const r=await fetch(u,{cache:'no-store'}); if(!r.ok) throw new Error(u); return r.arrayBuffer(); }
function loadImg(u){ return new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=u; }); }

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
/** 某场景烘焙产物的 URL 根。服务端回带 `dir`(= out/<场景>/<背景基名>),
 *  因为 2026-08-30 起同一场景的每张背景各有一个工作目录 —— 前端再按
 *  `/out/<场景名>/` 硬拼就是整片 404(画布空白、地形图打不开)。 */
function outBase(nameOrMan){
  const man=(typeof nameOrMan==='string')
    ? ((S.scenes||[]).find(m=>m.name===nameOrMan)||{name:nameOrMan}) : nameOrMan;
  const d=man.dir||man.name;
  return '/out/'+String(d).split('/').map(encodeURIComponent).join('/');
}
async function loadScene(man){
  S.man=man;
  V.sceneReady='';               // 整个场景(含角色受光载荷)装完才置回场景名:对照 / 自检等它
  const base=outBase(man);
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
  // CPU 像素(背景各视图 / 缩略图 / 3D 贴图都从这里算);语义 mask 旧场景可以没有
  let maskImg=null, hidImg=null;
  try{ maskImg=await loadImg(`${base}/mask.png${cb}`); }catch(e){ maskImg=null; }
  try{ hidImg=await loadImg(`${base}/hidden.png${cb}`); }catch(e){ hidImg=null; }
  V.px={bg:imagePixels(bgImg), gain:imagePixels(gainImg), mask:maskImg?imagePixels(maskImg):null,
        hidden:hidImg?imagePixels(hidImg):null};
  V.bgImg=bgImg; V.hidImg=hidImg;
  V.bgViewKey='';
  S.v2={zoom:1, ox:0, oy:0};
  sizeViewport();
  // 2D 背景纹理:与游戏装图同一条(engine2d Assets.load);换之前先让精灵不再引用旧的
  if(V.rt&&V.stage){
    const url=`${base}/background.png${cb}`;
    try{
      const t=await V.rt.workbenchRhi.loadTexture(url);
      V.stage.setBackground(t);
      if(V.bgTexUrl) V.rt.workbenchRhi.unloadTexture(V.bgTexUrl);
      V.bgTex=t; V.bgTexUrl=url;
    }catch(e){ setLog('✗ 背景纹理没装上:'+e,'err'); }
  }
  drop3DScene();

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
    // A-5:每个实例的包围盒只算这一次。悬停高亮/整块翻转靠它做**脏矩形**更新,
    // 不再为了给一块着色就重建整张叠加层(那是 15-20 万次循环 + 0.6MB 上传)。
    S.objBBox=new Map();
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const id=S.objIds[y*W+x]; if(!id) continue;
      const b=S.objBBox.get(id);
      if(!b) S.objBBox.set(id,[x,y,x,y]);
      else{ if(x<b[0])b[0]=x; if(y<b[1])b[1]=y; if(x>b[2])b[2]=x; if(y>b[3])b[3]=y; }
    }
    recomputeObjAuto();
  }catch(e){ S.objMeta=null; S.objBBox=null; }      // 尚未跑过物体识别的旧场景
  await tryEdit(`${base}/object_edit.png`, d=>{
    for(let i=0;i<W*H;i++) S.editObj[i]=d[i*4]; });
  S.editDepthBaked=S.editDepth.slice();
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

  // CPU occupancy + 体素辐射(射线可视化 / probe 面板 / 全景 ③④ 取命中处的辐射)
  const Vv=man.vol;
  const volU16=new Uint16Array(vol);
  const nvox=Vv.Nx*Vv.Ny*Vv.Nz;
  const occ=new Uint8Array(nvox);
  for(let i=0;i<nvox;i++) occ[i]=volU16[i*4+3]>=0x3800?1:0;   // a>=0.5-ish
  S.occCPU=occ;
  S.volU16=volU16; S.volEmitU16=new Uint16Array(volE);
  S.shK=(man.probes&&man.probes.sh_k)||9;       // 'l2' 槽列数(L2=9 / L4=25),老工作台没记就是 9
  S.binOb=(man.probes&&man.probes.bin_ob)||8;   // 八面体边长(8/16)
  // light list in q space (positions AND directions transform by M^T)
  S.lights=(man.lights||[]).map(li=>{
    const q=qFromWorld(li.pos);
    const nq=qFromWorld(li.normal);   // linear transform, ok for directions
    return {q, nq, e:li.radiance, area:li.area, power:li.power, world:li.pos};
  });
  const P=man.probes, Pn=P.nx*P.ny*P.nz;
  S.probeCount=Pn;

  // CPU 侧留一份 probe 全量(四分账 × 三基 + 位置/有效位):点云配色、⑥检视面板与全景都从这里读
  // (与工作台同布局:l1/l2/bins 每格 4 通道含 cov,amb/emit/nee 每格 3 通道)。
  S.probe={ Pn, nx:P.nx, ny:P.ny, nz:P.nz, gx:P.gx, gy:P.gy, gz:P.gz,
    pos:new Float32Array(ppos), valid:new Uint8Array(valid),
    l1:new Uint16Array(l1), l2:new Uint16Array(l2), bins:new Uint16Array(bins),
    l1a:new Uint16Array(l1a), l2a:new Uint16Array(l2a), binsa:new Uint16Array(binsa),
    l1e:new Uint16Array(l1e), l2e:new Uint16Array(l2e), binse:new Uint16Array(binse),
    l1n:new Uint16Array(l1n), l2n:new Uint16Array(l2n), binsn:new Uint16Array(binsn) };
  S.probeDC=new Float32Array(Pn*4);
  PB.any.clear();
  selectProbe(null);
  recomputeProbeDC();
  autoProbeGain();

  // point cloud interleaved (16B: 3f32 pos, 3u8 rgb, 1u8 tag) → CPU 源;3D 调试件逐点画
  S.pointCount=man.point_count;
  {
    const n=Math.floor(points.byteLength/16), f=new Float32Array(points), u=new Uint8Array(points);
    const pos=new Float32Array(n*3), rgb=new Uint8Array(n*3), tag=new Uint8Array(n);
    for(let i=0;i<n;i++){ pos[i*3]=f[i*4]; pos[i*3+1]=f[i*4+1]; pos[i*3+2]=f[i*4+2];
      rgb[i*3]=u[i*16+12]; rgb[i*3+1]=u[i*16+13]; rgb[i*3+2]=u[i*16+14]; tag[i]=u[i*16+15]; }
    S.cloud={pos,rgb,tag,n};
  }
  // triangulated mesh (same 16B vertex layout + uint32 indices) → CPU 源;3D 调试件按层拆三份贴图网格
  S.meshTris=(man.mesh?man.mesh.tris:0);
  S.meshSrc={verts:meshv, idx:meshi};

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
  const rbc=$('rb_calib'); if(rbc){ rbc.value=man.params.calibration||'level'; syncCalibLock(); }
  setSlider('rb_ev',man.params.ev); setSlider('rb_tau',man.params.occluder_tau);
  setSlider('rb_gain',man.params.max_gain_ev??3.32);
  setSlider('rb_relief',man.params.relief??1.8);
  setSlider('rb_objthr',man.params.object_score_min??0.35);
  S.objScoreMin=+(man.params.object_score_min??0.35);
  const rbs=$('rb_sem'); if(rbs) rbs.checked=!!(man.params.semantic_gate??1);
  // HDR 恢复方法/参数:同步到烘焙值(否则 reload 后下拉回 method0,看着像"白改了")
  const hm=$('hdr_method'); if(hm){ S.hdrMethod=man.params.hdr_method??0; hm.value=String(S.hdrMethod); }
  setSlider('hdr_pa',man.params.hdr_pa??0.7); S.hdrPA=man.params.hdr_pa??0.7;
  const rf=$('fold'); if(rf){ rf.checked=!!(man.params.fold??1); S.fold=rf.checked?1:0; }
  // probe 分布:2026-09-01 起 nx/ny/nz 与 band 全部由**角色实高**推出,
  // 面板上留的是密度/盒高/采样数这三个真正被消费的旋钮。
  setSlider('rb_cxz',man.params.probe_cells_per_char_xz??4);
  setSlider('rb_cy',man.params.probe_cells_per_char_y??4);
  setSlider('rb_hch',man.params.probe_height_chars??2);
  setSlider('rb_spp',man.params.probe_spp??256);
  refreshDirtyMarks();     // 控件刚与已烘参数对齐 → 清掉全部改动标记与计数
  renderHDRPanel();
  refreshThumbs();   // 底部常驻 HDR 场景 + 光源分割条(与 trace 同源)
  // 着色参数(非 bake)不在 manifest 里,得从**已导出的载荷**读回,否则面板显示的是
  // 写死初值 → 既看不到真值,存盘时还会把之前调好的覆盖掉。nee / amb 决定虚拟载荷的合成,所以先读回再装载荷。
  const had=await syncShadingFromExport(man.name);
  setLog(had ? `已同步 ${man.name} 已导出的着色参数(β/E色度/模式等)`
             : `${man.name} 尚未导出照明,着色参数用缺省值`, 'info');
  // 角色受光:游戏的装载器吃虚拟烘焙目录(工作台按游戏格式现场变换)
  await syncPayload(true);
  if(S.man===man) V.sceneReady=man.name;
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
  // CPU 线段表:2D = (x,y,r,g,b)×2 画在标注层,3D = (x,y,z,r,g,b)×2 交 3D 调试件
  S.rays={l2:new Float32Array(lines2.flat()), l3:new Float32Array(lines3.flat())};
}

// ============================================================= ⑥ probe 检视
// 选中一颗 probe → ①把它存的 irradiance cache 展开成经纬图 ②按 EV 分带看动态范围
// ③④按烘焙同参现场重追它的射线,对账「cache 说的」与「射线真看见的」。
// 全部纯可视化:不改任何烘焙数值、不重烘、不导出;解码/合成一律照抄 CHAR_FS::probeE。
const PB={ irrW:160, irrH:80, rayW:128, rayH:64,
           trace:null, traceKey:'', arrays:null, arraysKey:'', any:new Map(),
           Ec:null, EcKey:'', EcEV:[0,0] };

// —— 与着色器(charLightCommon.wgsl)同式的小工具(面板和着色器必须读同一份数字,不许各写一套) ——
function shYJ(k,n){
  const x=n[0], y=n[1], z=n[2];
  if(k===0) return .282095;
  if(k===1) return .488603*y; if(k===2) return .488603*z; if(k===3) return .488603*x;
  if(k===4) return 1.092548*x*y; if(k===5) return 1.092548*y*z;
  if(k===6) return .315392*(3*z*z-1);
  if(k===7) return 1.092548*x*z; if(k===8) return .546274*(x*x-y*y);
  const x2=x*x, y2=y*y, z2=z*z;
  if(k===9)  return .590044*y*(3*x2-y2);
  if(k===10) return 2.890611*x*y*z;
  if(k===11) return .457046*y*(5*z2-1);
  if(k===12) return .373176*z*(5*z2-3);
  if(k===13) return .457046*x*(5*z2-1);
  if(k===14) return 1.445306*z*(x2-y2);
  if(k===15) return .590044*x*(x2-3*y2);
  if(k===16) return 2.503343*x*y*(x2-y2);
  if(k===17) return 1.770131*y*z*(3*x2-y2);
  if(k===18) return .946175*x*y*(7*z2-1);
  if(k===19) return .669047*y*z*(7*z2-3);
  if(k===20) return .105786*(35*z2*z2-30*z2+3);
  if(k===21) return .669047*x*z*(7*z2-3);
  if(k===22) return .473087*(x2-y2)*(7*z2-1);
  if(k===23) return 1.770131*x*z*(x2-3*y2);
  return .625836*(x2*x2-6*x2*y2+y2*y2);
}
/** 八面体接缝环绕(与着色器 octaIdx / python octa_wrap 同规则)。 */
function octaIdxJ(x,y,ob){
  if(x<0){ x=0; y=ob-1-y; } else if(x>ob-1){ x=ob-1; y=ob-1-y; }
  if(y<0){ y=0; x=ob-1-x; } else if(y>ob-1){ y=ob-1; x=ob-1-x; }
  return y*ob+x;
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
  const D=S.probe, K=basis===1?4:basis===2?(S.shK||9):(S.binOb||8)*(S.binOb||8);
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
/** 单颗 probe 在方向 n 上的原始四分账(与迁移前 LIGHT_FNS::probeFetch 同式;L1 在系数域先合成、只给 E 与 cov)。 */
function probeFetchJ(A,n){
  const base=[0,0,0], amb=[0,0,0], emi=[0,0,0], nee=[0,0,0];
  let cov=0;
  const acc=(k,w)=>{
    for(let c=0;c<3;c++){ base[c]+=A.m[k*4+c]*w; amb[c]+=A.a[k*3+c]*w;
                          emi[c]+=A.e[k*3+c]*w; nee[c]+=A.n[k*3+c]*w; }
    cov+=A.m[k*4+3]*w;
  };
  if(A.basis===3){                        // BIN:八面体双线性,与着色器同一套取样
    const ob=S.binOb||8;
    const uv=octaEncJ(n), ou=uv[0]*ob-.5, ov=uv[1]*ob-.5;
    const x0=Math.floor(ou), y0=Math.floor(ov);       // 越界交给 octaIdxJ 环绕
    const fx=Math.max(0,Math.min(1,ou-x0)), fy=Math.max(0,Math.min(1,ov-y0));
    acc(octaIdxJ(x0,y0,ob),(1-fx)*(1-fy)); acc(octaIdxJ(x0+1,y0,ob),fx*(1-fy));
    acc(octaIdxJ(x0,y0+1,ob),(1-fx)*fy); acc(octaIdxJ(x0+1,y0+1,ob),fx*fy);
    cov*=Math.PI;                         // bins 存的是 cov/π
  }else if(A.basis===1){                 // L1 = Geomerics 非线性(与着色器 mode 1 同式)
    const out1=[0,0,0];
    for(let k=0;k<4;k++) cov+=A.m[k*4+3]*shYJ(k,n);
    for(let c=0;c<3;c++){
      const ck=k=>A.m[k*4+c]+(S.nee?A.n[k*3+c]:A.e[k*3+c])+A.a[k*3+c]*S.amb;   // 系数域合成
      const R0=Math.max(ck(0)*.282095,1e-12);
      const R1=[.5*.488603*ck(3), .5*.488603*ck(1), .5*.488603*ck(2)];
      const len=Math.hypot(R1[0],R1[1],R1[2])+1e-12;
      const q=Math.max(0,Math.min(1,.5*(1+(R1[0]*n[0]+R1[1]*n[1]+R1[2]*n[2])/len)));
      const r=Math.min(len/R0,.9999), p=1+2*r, a=(1-r)/(1+r);
      out1[c]=R0*(a+(1-a)*(p+1)*Math.pow(q,p));
    }
    return {E:out1, Ea:[0,0,0], Ee:[0,0,0], En:[0,0,0], cov};
  }else{
    for(let k=0;k<A.K;k++) acc(k,shYJ(k,n));
  }
  return {E:base, Ea:amb, Ee:emi, En:nee, cov};
}
/** 四分账 → 最终 E(与迁移前 LIGHT_FNS::probeCompose 同式:base/emit 走 miss 策略,NEE 是解析直射直接加)。 */
function probeComposeJ(r){
  const cov01=Math.max(0,Math.min(1,r.cov/Math.PI));
  const out=[0,0,0];
  for(let c=0;c<3;c++){
    let E=Math.max(r.E[c],0)+(S.nee?0:Math.max(r.Ee[c],0));
    E=(S.missMode===1) ? E/Math.max(cov01,.06) : E+Math.max(r.Ea[c],0)*S.amb;
    if(S.nee) E+=Math.max(r.En[c],0);
    out[c]=E;
  }
  return out;
}
/** 单颗 probe 的 E(n):解码 + 四分账合成(⑥面板与全景「插值关」共用)。 */
function probeEvalDir(A,n){ return probeComposeJ(probeFetchJ(A,n)); }
/** 同 probeBasisArrays,但按 (probe, 基) 多条缓存(全景八角插值每个纹素要 8 颗,单条缓存会来回抖)。 */
function probeBasisArraysAny(i,basis){
  const key=i+'|'+basis;
  let hit=PB.any.get(key);
  if(hit) return hit;
  if(PB.any.size>4096) PB.any.clear();
  const keep=[PB.arrays,PB.arraysKey];
  hit=probeBasisArrays(i,basis);
  PB.arrays=keep[0]; PB.arraysKey=keep[1];
  PB.any.set(key,hit);
  return hit;
}
/** 点云配色用的 DC(各方向平均)E/π,合成规则同上,只取 L2 的 k=0 项。 */
function recomputeProbeDC(){
  const D=S.probe; if(!D||!S.probeDC) return;
  const Y0=.282095, iPI=1/Math.PI, out=S.probeDC;
  const KS=S.shK||9;                       // 'l2' 槽每颗 K 系数(L2=9 / L4=25)
  for(let i=0;i<D.Pn;i++){
    const o=i*KS*4, o3=i*KS*3;
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

/** 射线-体素盒求交,与 pipeline._ray_box_enter / 着色器 boxEnter 同式。 */
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
  S.pbLines={l2:new Float32Array(l2.flat()), l3:new Float32Array(l3.flat())};
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
  const KS=S.shK||9, o3=i*KS*3, Y0=.282095;
  const acc=(buf,off)=>lumaJ([0,1,2].map(c=>Math.max(f16(buf[off+c])*Y0,0)))*iPI;
  const covDC=Math.max(0,Math.min(1,f16(D.l2[i*KS*4+3])*Y0*iPI));   // cov 的 DC = 命中立体角占比
  const bn=['—','L1(4)',`SH(${KS}${KS===25?',L4':',L2'})`,`BIN(${S.binOb||8}×${S.binOb||8})`][basis];
  $('pb_title').textContent=`#${i}`;
  $('pb_info').textContent=
    `格点(${gi},${gj},${gk})  ${D.valid[i]>2?'有效':'⚠无效(不参与插值)'}`+
    `  ${snap>1e-3?`吸附 ${snap.toFixed(2)}m`:'未吸附'}\n`+
    `world(${wpos[0].toFixed(2)}, ${wpos[1].toFixed(2)}, ${wpos[2].toFixed(2)})   基=${bn}\n`+
    `E/π 平均 ${dcL.toExponential(2)} (${(dcL>0?Math.log2(dcL):-99).toFixed(1)} EV)`+
    `   展开图跨度 ${evMin>1e8?'—':evMin.toFixed(1)}…${evMax<-1e8?'—':evMax.toFixed(1)} EV\n`+
    `分账DC  base ${acc(D.l2,i*KS*4).toExponential(1)}`+
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
  const bb=instBBox(id);                           // A-5:只刷这枚实例的包围盒
  if(bb) refreshEditOverlay(bb[0],bb[1],bb[2],bb[3]); else refreshEditOverlay();
  if(S.view===2) buildTopView();
  const m=S.objMeta&&S.objMeta.get(id);
  setLog(`✓ 实例 #${id}${m?`(${m.prompt} ${m.score.toFixed(2)})`:''} `+
    `${n} 像素翻为${val===1?'物体':'地形'}——保存编辑后重烘生效`,'ok');
  return n;
}

/** 最终判定:人工覆写优先(1=物体 2=地形),否则听自动 */
function isObjectAt(i){
  const e=S.editObj?S.editObj[i]:0;
  if(e===1) return 1; if(e===2) return 0;
  return S.objAuto?S.objAuto[i]:0;
}

// ============================================================ 编辑叠加层(A-4)
// 病灶:本函数原来每次调用都 `new Uint8Array(w*h*4)`(0.6-0.8MB)+ 全图 15-20 万次
// 循环 + 整张 texImage2D 上传,而它被挂在**涂抹的 mousemove** 上 —— 60Hz 下等于每秒
// 900 万次循环 + 36MB/s 上传 + 每秒 60 次 GC 压力,全压在 34fps 基线的 rAF 循环上。
// 现在:① 缓冲复用(只在分辨率变化时重新分配);② 支持脏矩形 + texSubImage2D,
// 半径≤48 的一笔最多 97×97=9.4k 像素,较全图省约 20 倍。
// 迁到 RHI 后:叠加层是一张 work 分辨率的不预乘 RGBA(`_ovBuf`,CPU 常驻),交给 2D 场景当普通精灵画
// (最近邻、alpha × 0.75,与旧 BG_FS 的 mix(c, e.rgb, e.a*.75) 同一个混合)。涂抹只改脏矩形那一块 CPU 字节,
// 纹理每帧最多整张上传一次(V.ovDirty)。
let _ovBuf=null, _ovW=0, _ovH=0;
function _ovTexInit(w,h){
  if(_ovW!==w||_ovH!==h||!_ovBuf){                 // 只有换场景/换分辨率才重新分配
    _ovW=w; _ovH=h; _ovBuf=new Uint8Array(w*h*4);
    if(V.ovTex){ if(V.stage) V.stage.setOverlay(null); V.ovTex.destroy(true); V.ovTex=null; }
  }
  if(!V.ovTex&&V.rt) V.ovTex=V.rt.charLabView.textureFromPixels(w,h,_ovBuf,{straight:true,nearest:true});
}
/** 单像素叠加色 —— 逐行照搬旧逻辑,只是抽出来给全图/脏矩形两条路共用 */
function _ovPixel(i,out,o){
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
    r=255; g=213; b=74; a=210;                     // 联动高亮:两视图同一枚实例
  } else if(S.dbg.terrain){                        // 地形判定:绿=地形 红=物体,人工覆写更亮
    const o2=isObjectAt(i), manual=S.editObj&&S.editObj[i]!==0;
    const rr=o2?210:30, gg=o2?40:210, bb=o2?60:110;
    const aa=manual?190:110;
    if(aa>a){ r=rr; g=gg; b=bb; a=aa; }
  }
  out[o]=r; out[o+1]=g; out[o+2]=b; out[o+3]=a;
}
/** 不传参数=全图重建;传 (x0,y0,x1,y1) 只更新这块(含端点)。 */
function refreshEditOverlay(x0,y0,x1,y1){
  if(!S.editDepth||!S.work) return;
  const {w,h}=S.work;
  _ovTexInit(w,h);
  x0=Math.max(0,Math.floor(x0==null?0:x0));
  y0=Math.max(0,Math.floor(y0==null?0:y0));
  x1=Math.min(w-1,Math.ceil(x1==null?w-1:x1));
  y1=Math.min(h-1,Math.ceil(y1==null?h-1:y1));
  if(x1<x0||y1<y0) return;
  for(let y=y0;y<=y1;y++){
    let i=y*w+x0;
    for(let x=x0;x<=x1;x++,i++) _ovPixel(i,_ovBuf,i*4);
  }
  V.ovDirty=true;
}
/** 某个实例的包围盒(A-5 脏矩形用);没有就返回 null 表示"整张" */
function instBBox(id){ return (id&&S.objBBox)?S.objBBox.get(id):null; }
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
  return [x0,y0,x1,y1];        // A-4:把这一笔的包围盒交给调用方做脏矩形更新
}
// ---- polygon region tool: 左键加顶点, 右键闭合填充, Esc 取消(2D 与顶视手势一致)
/** D-3:多边形类笔刷判定。⚠ 14/15(多边形:标为物体/地形)曾是**死控件** —— polyApply()
 *  里 case 14/15 的逻辑本来就写好了,但顶点收集与闭合两处谓词写死 `>=8&&<=11`,
 *  把它们挡在门外:2D 里选中后单击无反应,双击反而触发画布缩放复位。 */
const isPolyBrush=b=>(b>=8&&b<=11)||b===14||b===15;
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
  refreshEditOverlay(x0,y0,x1,y1);          // A-4:只刷多边形包围盒
}
async function refreshGeoStatus(name){
  try{
    const r=await (await fetch('/api/geo_status?scene='+encodeURIComponent(name))).json();
    S.geoStale=!!(r.ok&&r.stale);
  }catch(e){ S.geoStale=false; }
  $('geo_warn').style.display=S.geoStale?'block':'none';
  refreshDirtyMarks();     // 几何过期与"参数未应用"合成同一个 dirty 信号
  syncFieldsStale();       // 几何场过期是**另一条**线(深度导出的下游),按场景跟随
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
  const btn=$('terrain_recalc');
  busy(btn,'重算地形中…');
  $('terrain_stats').textContent='重算中…';
  try{
    if(S.editDirty){                                // 覆写层在内存里,先落盘服务端才读得到
      const [bd,bc,bo]=await encodeEditPngs();
      for(const [k,b] of [['depth',bd],['collision',bc],['object',bo]])
        await fetch(`/api/save_edit?scene=${encodeURIComponent(name)}&kind=${k}`,{method:'POST',body:b});
      S.editDirty=false;
    }
    const r=await (await fetch('/api/terrain?scene='+encodeURIComponent(name))).json();
    if(!r.ok){ $('terrain_stats').textContent='✗ '+(r.err||''); idle(btn,'✗ 重算地形:'+(r.err||''),'err'); return; }
    const s2=r.stats;
    $('terrain_stats').textContent=
      `站位体检(脚下是可见地面的点 ${s2.samples}):\n`+
      `  全遮挡 ${(s2.full_occluded*100).toFixed(1)}%  重度>50% ${(s2.heavy*100).toFixed(1)}%  中位 ${s2.median.toFixed(3)}\n`+
      `地面掩膜 ${(s2.ground_mask*100).toFixed(1)}%  物体 ${(s2.objects*100).toFixed(1)}%  地形高度 p95 ${s2.terrain_p95.toFixed(3)}\n`+
      `注意:可走掩膜/碰撞图不在快通道里,仍需完整重烘`;
    S.terrainReady=true;
    idle(btn,'✓ 地形已重算,已切到体检图','ok');
    showTerrainImage(0);
  }catch(e){ $('terrain_stats').textContent='✗ '+e; idle(btn,'✗ 重算地形失败:'+e,'err'); }
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
    th.innerHTML=`${labels[terrainImgIdx]} · 再点「查看地形图」切换另一张`;
    viewwrap.style.visibility='hidden'; $('hud').style.display='none';
    // E-3:图片查看态原来把画布和 HUD 全藏了,视图按钮行**一个都不高亮**,
    // 出口只写在一行小字里 —— 人会以为卡在这张图里出不去。给一个明确的返回按钮。
    $('img_exit').style.display='block';
    S.view=-1;                                     // 图片查看态:不走 GL 主循环也不吃多边形
    updateKeyHelp();                               // 这条路径不经过 setView,提示要自己刷
  };
  img.onerror=()=>{ setLog('✗ 还没有这张图,先点「重算地形+体检」','warn'); };
  img.src=`${outBase(name)}/${files[terrainImgIdx]}?t=`+Date.now();
}
$('terrain_show').onclick=()=>{ showTerrainImage(terrainImgIdx+1); };
$('img_exit').onclick=()=>{ setView(0); canvas.focus(); };

$('edit_save').onclick=async()=>{
  const name=activeScene(); if(!name) return;
  const btn=$('edit_save');
  busy(btn,'保存编辑中…');                          // B-1:第一帧就有反馈
  try{
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
      idle(btn,`✗ 这些层没存上:${bad.join('/')}(服务端不认该 kind?`+
        ` 改过 serve.py 要重启实验室服务)——编辑仍在内存里,别关页面`,'err');
      return;
    }
    S.editDirty=false;
    idle(btn,'✓ 编辑已保存——需重烘生效','ok');
    refreshGeoStatus(name);
  }catch(err){ idle(btn,'✗ 保存编辑失败:'+err,'err'); }
};
$('edit_clear').onclick=async()=>{
  const name=activeScene(); if(!name) return;
  // E-1:清除是不可逆的(删掉本场景全部笔刷编辑),先确认
  if(!confirm(`清除「${name}」的全部笔刷编辑?\n\n`+
              `深度 / 碰撞 / 地形三层覆写会被一起删除,且无法撤销。\n`+
              `清除后需要重烘才会反映到几何上。`)) return;
  const btn=$('edit_clear');
  busy(btn,'清除编辑中…');
  try{
    S.editDepth.fill(0); S.editCol.fill(0); if(S.editObj) S.editObj.fill(0); S.editDirty=false;
    refreshEditOverlay();
    for(const k of ['depth','collision','object'])
      await fetch(`/api/save_edit?scene=${encodeURIComponent(name)}&kind=${k}`,{method:'POST',body:'CLEAR'});
    idle(btn,'✓ 编辑已清除——需重烘生效','ok');
    refreshGeoStatus(name);
  }catch(err){ idle(btn,'✗ 清除编辑失败:'+err,'err'); }
};
$('export_depth').onclick=async()=>{
  const name=activeScene(); if(!name) return;
  // E-1:破坏性写盘,改写游戏工程里的场景 JSON,不可撤销 → 必须确认
  if(!confirm(`即将覆盖游戏场景深度\n\n`+
              `场景:${name}\n`+
              `写入:public/assets/scenes/${name}.json 的 depthConfig\n`+
              `　　  + 同场景 runtime 目录的深度图(RG16)与碰撞图\n\n`+
              `遮挡 / 阴影 / 碰撞将全部改用实验室重建结果。此操作不可撤销,确认?`)) return;
  const btn=$('export_depth');
  busy(btn,'导出场景深度中…');
  try{
    const r=await (await fetch('/api/export_depth?scene='+encodeURIComponent(name))).json();
    idle(btn, r.ok?'✓ 场景深度已导出(depthConfig+RG16+碰撞已写入游戏)':('✗ '+(r.err||'')),
         r.ok?'ok':'err');
    // 服务端回带的 fields_stale:几何场读的是**刚被换掉的**那份深度,现在对不上了。
    // 不在导出里同步重烘(那会让这个按钮卡上几分钟),改成把作者领到下一个按钮跟前。
    if(r.ok&&r.fields_stale){
      markFieldsStale(name);
      setLog('⚠ 几何场(法线/天穹可见性/3D网格/GI命中图)还是按旧深度烘的,运行时会拿它去照新深度——'+
             '点下面「烘几何场」重烘一次(每张时段原画约 3 分钟)','warn');
    }
  }catch(err){ idle(btn,'✗ 导出场景深度失败:'+err,'err'); }
};

// ------------------------------------------------- 几何场(深度的下游产物)
// 顺序是硬的:几何场读的是**已导出的** raw_depth_rg.png + depthConfig,所以必须
// 「先导出深度、再烘几何场」。反过来就是拿旧深度烘新场,运行时不报错、只是光走向错。
// 过期标记只活在本次会话(刷新即忘)——它是**提醒**,不是权威;权威是载荷里的
// depth_sha1 防腐门。所以宁可少提醒一次,也不在这里假装自己知道磁盘上的真实状态。
const _fieldsStale=new Set();
function markFieldsStale(name){ _fieldsStale.add(name); syncFieldsStale(); }
function syncFieldsStale(){
  const cur=S.man&&S.man.name;
  const stale=!!(cur&&_fieldsStale.has(cur));
  const btn=$('bake_fields'); if(btn) btn.classList.toggle('dirty',stale);
  const w=$('fields_warn'); if(w) w.style.display=stale?'block':'none';
}
$('bake_fields').onclick=async()=>{
  const name=activeScene(); if(!name) return;
  const btn=$('bake_fields');
  // B-1:这个端口是**同步**的(服务端故意不开线程:并发烘同一场景会互相覆盖产物),
  // 单张原画约 3 分钟 —— 不提前说清楚,任何人第一次点都会以为页面死了。
  busy(btn,`烘 ${name} 的几何场中 —— 全部时段原画各烘一套,每张约 3 分钟,期间此按钮不可点`);
  try{
    const r=await (await fetch('/api/bake_fields?scene='+encodeURIComponent(name))).json();
    if(r.ok){
      _fieldsStale.delete(name);
      const rows=r.result||[];
      idle(btn,`✓ 几何场已烘(${rows.length} 张时段原画)\n`+rows.map(x=>
        `  ${x.key}:天穹可见性均 ${x.skyvis_px.mean.toFixed(2)}`+
        ` · GI命中率 ${(x.gi.hit_rate*100).toFixed(0)}%`+
        ` · ${Math.round(x.bytes/1024)} KB`+
        (x.albedo_map.authored?' · albedo 作者手改,已保留':'')).join('\n'),'ok');
    }else{
      idle(btn,'✗ 烘几何场失败:'+(r.err||''),'err');
    }
  }catch(err){ idle(btn,'✗ 烘几何场失败:'+err,'err'); }
  syncFieldsStale();
};
$('brush').addEventListener('change',e=>{
  S.brush=+e.target.value;
  S.polyPts=[];                                     // 换笔刷时丢掉画了一半的多边形
  // D-4:圆刷模式下用我们自己画的圆环当光标,藏掉系统箭头(免得两个光标打架)
  canvas.style.cursor=(S.brush>0&&S.brush!==16&&!isPolyBrush(S.brush))?'none'
                     :(S.brush?'crosshair':'default');
  updateKeyHelp();                                  // E-4:提示跟着笔刷类型走
});
bindSlider('rb_objthr',null,v=>(+v).toFixed(2),v=>{
  S.objScoreMin=+v;
  if(!S.work||!S.objIds) return;                    // bindSlider 会在载场景前先跑一次
  recomputeObjAuto(); refreshEditOverlay();
  if(S.view===2) buildTopView();
  refreshDirtyMarks();                              // 门槛进 rbParams,重烘才正式生效
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
  if(isPolyBrush(S.brush)){                         // 多边形:左键加顶点(右键闭合)
    const [wx,wy]=canvasToWork(e);
    S.polyPts.push([wx,wy]);
    return;
  }
  painting=true;
  const [wx,wy]=canvasToWork(e);
  const bb=paintAt(wx,wy); refreshEditOverlay(bb[0],bb[1],bb[2],bb[3]);   // A-4 脏矩形
});
window.addEventListener('mousemove',e=>{
  if(!painting||S.view!==0||S.brush===0||isPolyBrush(S.brush)||S.brush===16) return;
  const [wx,wy]=canvasToWork(e);
  const bb=paintAt(wx,wy); refreshEditOverlay(bb[0],bb[1],bb[2],bb[3]);   // A-4 脏矩形
});
window.addEventListener('mouseup',()=>{ painting=false; });
window.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&S.polyPts.length){ S.polyPts=[]; }
});

// ------------------------------------------------------------- char assets
// 角色图在 initGpu 里装(与游戏同一条装载:颜色 = 动画图集那条,法线 = *.normal.png 的不预乘通道);没有 GPU 就没有角色。
let charReady=false;

// ------------------------------------------------------------- draw 2D
/** 2D 视图的世界容器:场景点 p(work px)画在 p·scale + (x, y)(CSS 像素)——游戏的 worldContainer 同一个变换 */
function camera2D(){
  const cw=viewwrap.clientWidth||V.W2||S.work.w;
  const s=S.v2.zoom*cw/S.work.w;
  return {scale:s, x:-S.v2.ox*s, y:-S.v2.oy*s};
}
/** 脚点(work px,= 场景世界)与角色 quad 高(work px):与迁移前 CHAR_FS 摆 quad 的同一套式子 */
function footScene(){
  const cal=S.man.cal, cosT=Math.cos(cal.theta);
  const wy=groundY(S.footW.x,S.footW.z);
  const [fsx,fsy]=screenFromQ(qFromWorld([S.footW.x,wy,S.footW.z]));
  return {x:fsx, y:fsy, hPx:S.charH*S.qscale*cosT*cal.ppu};
}
/** 面板 → 游戏着色参数(与游戏 F2 同义的原样过去;预览亮度走显示 EV) */
function labShading(){
  return {mode:S.mode, spp:S.spp, step:S.step, msteps:S.msteps, fold:!!S.fold, missMode:!!S.missMode, nee:!!S.nee,
    beta:S.beta, amb:S.amb, bulge:S.bulge, flatten:S.flatten, eChroma:S.eChroma, showNormals:!!S.dbg.normal,
    previewGain:S.pgain, skyao:!!S.skyao};
}
function labFrame(){
  const f=charReady?footScene():null;
  return {camera:camera2D(), foot:f?{x:f.x,y:f.y}:null, heightPx:f?f.hPx:0,
    occlusion:!!S.dbg.occl, contact:S.contact, shading:labShading()};
}
function draw2D(){
  sizeViewport();
  if(V.stage&&V.host&&V.px){
    V.stage.setBackground(currentBgTexture());
    _ovTexInit(S.work.w,S.work.h);
    if(V.ovTex){
      if(V.ovDirty){ V.ovTex.source.update(); V.ovDirty=false; }
      V.stage.setOverlay((S.brush>0||S.editDirty||S.dbg.terrain)?V.ovTex:null);
    }
    V.stage.sync(labFrame());
    V.host.render(V.stage.root);
  }
  drawAnnotations2D();
}
/** 画面区正中写一句原因(拿不到 WebGPU / 打包失败):视图逻辑、编辑、烘焙照常 */
function drawGpuNote(msg){
  const c=octx, W=canvas.width, H=canvas.height;
  c.fillStyle='#0a0d10'; c.fillRect(0,0,W,H);
  c.fillStyle='#e0a83a'; c.font=`${Math.round(13*V.dpr)}px sans-serif`; c.textAlign='center';
  c.fillText('画面不可用:'+msg, W/2, H/2);
  c.fillStyle='#98a2ad'; c.font=`${Math.round(11*V.dpr)}px sans-serif`;
  c.fillText('烘焙 / 导出 / 编辑 / 顶视 / probe 面板照常;画面要 WebGPU(真显卡的 Chrome / Edge,或 WebView2 宿主)', W/2, H/2+18*V.dpr);
  c.textAlign='left';
}
const _rgb=(r,g,b,a=1)=>`rgba(${Math.round(Math.min(1,Math.max(0,r))*255)},${Math.round(Math.min(1,Math.max(0,g))*255)},${Math.round(Math.min(1,Math.max(0,b))*255)},${a})`;
/**
 * 2D 标注(可走点 / probe 点 / 光源十字 / 多边形 / 笔刷圈 / 射线):画在叠在 GPU 画面上的 2D 画布(#gl)。
 * 与迁移前 L2 线点程序同色同尺寸(点 4 设备像素方块;线 1 设备像素;前三类不透明、后三类 0.85)。
 * 差别:迁移前可走 / probe / 光源画在角色之下,现在整层在角色之上(标注层只有一张)。
 */
function drawAnnotations2D(){
  const c=octx;
  c.setTransform(1,0,0,1,0,0);
  c.clearRect(0,0,canvas.width,canvas.height);
  if(!S.man) return;
  if(!V.stage||!V.host){ drawGpuNote(V.err||'画面准备中…'); }
  const cam=camera2D(), k=cam.scale*V.dpr, ox=cam.x*V.dpr, oy=cam.y*V.dpr;
  const man=S.man;
  const pts=(list)=>{ for(const p of list){ c.fillStyle=_rgb(p[2],p[3],p[4]);
    c.fillRect(Math.round(p[0]*k+ox)-2, Math.round(p[1]*k+oy)-2, 4, 4); } };
  /** 线段表(每两点一段,点 = [x,y,r,g,b] 或交错 Float32Array stride 5),按颜色成批描 */
  const segs=(list,alpha,stride)=>{
    const by=new Map();
    const n=stride?Math.floor(list.length/stride):list.length;
    const at=(i)=>stride?[list[i*stride],list[i*stride+1],list[i*stride+2],list[i*stride+3],list[i*stride+4]]:list[i];
    for(let i=0;i+1<n;i+=2){ const a=at(i), b=at(i+1), key=_rgb(a[2],a[3],a[4],alpha);
      let arr=by.get(key); if(!arr){ arr=[]; by.set(key,arr); } arr.push(a[0],a[1],b[0],b[1]); }
    c.lineWidth=1;
    for(const [col,arr] of by){ c.strokeStyle=col; c.beginPath();
      for(let i=0;i<arr.length;i+=4){ c.moveTo(arr[i]*k+ox+.5, arr[i+1]*k+oy+.5); c.lineTo(arr[i+2]*k+ox+.5, arr[i+3]*k+oy+.5); }
      c.stroke(); }
  };
  if(S.dbg.walk&&S.walk){
    const w=S.walk, list=[];
    for(let z=0;z<w.nz;z+=2) for(let x=0;x<w.nx;x+=2){
      if(!w.mask[z*w.nx+x]) continue;
      const wx=w.x0+x*w.dx, wz=w.z0+z*w.dz;
      const sp=screenFromQ(qFromWorld([wx,groundY(wx,wz),wz]));
      list.push([...sp,0.1,0.9,0.35]);
    }
    pts(list);
  }
  if(S.dbg.probes&&S.probe){
    const P=man.probes, list=[];
    // world regular grid positions projected;颜色=该 probe 的 E/π × probe 专属显示增益
    for(let i=0;i<P.nx;i++)for(let j=0;j<P.ny;j++)for(let kk=0;kk<P.nz;kk++){
      const sp=screenFromQ(qFromWorld([P.gx[i],P.gy[j],P.gz[kk]]));
      list.push([...sp,...probeDotColor((i*P.ny+j)*P.nz+kk)]);
    }
    pts(list);
    if(S.selProbe!=null){                       // 选中的那颗:洋红十字,和 3D 的洋红环呼应
      const D=S.probe, sp=screenFromQ(qFromWorld([D.pos[S.selProbe*3],D.pos[S.selProbe*3+1],D.pos[S.selProbe*3+2]]));
      const r=6/S.v2.zoom+2;
      segs([[sp[0]-r,sp[1],1,.35,.85],[sp[0]+r,sp[1],1,.35,.85],[sp[0],sp[1]-r,1,.35,.85],[sp[0],sp[1]+r,1,.35,.85]],1);
    }
  }
  if(S.dbg.lights&&S.lights.length){
    const seg=[];
    for(const L of S.lights){
      const sp=screenFromQ(L.q);
      const r=3+Math.min(9,Math.sqrt(L.power)*160);
      seg.push([sp[0]-r,sp[1],1,.75,.1],[sp[0]+r,sp[1],1,.75,.1]);
      seg.push([sp[0],sp[1]-r,1,.75,.1],[sp[0],sp[1]+r,1,.75,.1]);
    }
    segs(seg,1);
  }
  if(S.polyPts&&S.polyPts.length){
    const seg=[];
    for(let i=0;i<S.polyPts.length;i++){
      const a=S.polyPts[i], b=S.polyPts[(i+1)%S.polyPts.length];
      seg.push([a[0],a[1],1,.9,.2],[b[0],b[1],1,.9,.2]);
      seg.push([a[0]-2,a[1],1,1,1],[a[0]+2,a[1],1,1,1]);
      seg.push([a[0],a[1]-2,1,1,1],[a[0],a[1]+2,1,1,1]);
    }
    segs(seg,.85);
  }
  // D-4:圆刷光标环(画在工作分辨率坐标系里,2D 放大后仍与实际影响范围严格重合)
  if(S.brush>0 && S.brush!==16 && !isPolyBrush(S.brush) && S.cursorW.on){
    const seg=[], N=48, R=S.brushR, cx=S.cursorW.x, cy=S.cursorW.y;
    for(let i=0;i<N;i++){
      const a0=i/N*6.2831853, a1=(i+1)/N*6.2831853;
      seg.push([cx+Math.cos(a0)*R, cy+Math.sin(a0)*R, 1,.84,.29]);
      seg.push([cx+Math.cos(a1)*R, cy+Math.sin(a1)*R, 1,.84,.29]);
    }
    seg.push([cx-1.5,cy,1,1,1],[cx+1.5,cy,1,1,1]);      // 中心十字,便于对位
    seg.push([cx,cy-1.5,1,1,1],[cx,cy+1.5,1,1,1]);
    segs(seg,.85);
  }
  if(S.dbg.rays){ if(!S.rays) buildRays(); segs(S.rays.l2,.85,5); }
  if(S.selProbe!=null && S.pbRays && S.pbLines) segs(S.pbLines.l2,.85,5);
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
/**
 * 八角三线性 probe E(与迁移前 PANO_FS::probeE 同式:世界轴格点、valid 权重、四分账先加权平均再合成;
 * 全部 valid 为 0 → 环境 SH 余弦卷积)。基 = 当前③模式(RT 时退 L2,与⑥面板同一条)。
 */
function probeEInterp(qPos, n, basis){
  const P=S.man.probes, wd=S.man.world, D=S.probe;
  const X=worldFromQ(qPos);
  const sc=[(P.nx-1)/Math.max(wd.x1-wd.x0,1e-5),(P.ny-1)/Math.max(wd.y1-wd.y0,1e-5),(P.nz-1)/Math.max(wd.z1-wd.z0,1e-5)];
  const t=[Math.min(Math.max((X[0]-wd.x0)*sc[0],0),P.nx-1.001),
           Math.min(Math.max((X[1]-wd.y0)*sc[1],0),P.ny-1.001),
           Math.min(Math.max((X[2]-wd.z0)*sc[2],0),P.nz-1.001)];
  const b0=t.map(Math.floor), f=t.map((v,i)=>v-b0[i]);
  const acc={E:[0,0,0],Ea:[0,0,0],Ee:[0,0,0],En:[0,0,0],cov:0}; let wsum=0;
  for(let c=0;c<8;c++){
    const o=[c&1,(c>>1)&1,(c>>2)&1];
    const pi=[Math.min(b0[0]+o[0],P.nx-1),Math.min(b0[1]+o[1],P.ny-1),Math.min(b0[2]+o[2],P.nz-1)];
    let w=(o[0]?f[0]:1-f[0])*(o[1]?f[1]:1-f[1])*(o[2]?f[2]:1-f[2]);
    const flat=pi[0]*(P.ny*P.nz)+pi[1]*P.nz+pi[2];
    if(!(D.valid[flat]/255>=.002)) w=0;
    if(w<1e-5) continue;
    const r=probeFetchJ(probeBasisArraysAny(flat,basis),n);
    for(let ch=0;ch<3;ch++){ acc.E[ch]+=Math.max(r.E[ch],0)*w; acc.Ea[ch]+=Math.max(r.Ea[ch],0)*w;
      acc.Ee[ch]+=Math.max(r.Ee[ch],0)*w; acc.En[ch]+=Math.max(r.En[ch],0)*w; }
    acc.cov+=r.cov*w; wsum+=w;
  }
  if(wsum<1e-4) return ambIrrJ(n);
  const d=(v)=>v.map(x=>x/wsum);
  return probeComposeJ({E:d(acc.E),Ea:d(acc.Ea),Ee:d(acc.Ee),En:d(acc.En),cov:acc.cov/wsum});
}
/** 环境 SH 余弦卷积(旧 LIGHT_FNS::ambIrr):所有 8 角都无效时的回落 */
function ambIrrJ(n){
  const A=[3.141593,2.094395,2.094395,2.094395,.785398,.785398,.785398,.785398,.785398];
  const sh=S.man.ambient.sh, E=[0,0,0];
  for(let k=0;k<9;k++){ const y=A[k]*shYJ(k,n); for(let c=0;c<3;c++) E[c]+=sh[k*3+c]*y; }
  return E.map(v=>Math.max(v,0)*S.amb);
}
/**
 * 全景经纬图(CPU):每个纹素 = 一个**世界**方向(dirFromLatLong,u 绕竖轴、u=.5 朝 −z),按迁移前 PANO_FS 四种可视化逐个算,
 * 贴到以视点为心的经纬球上(3D 调试件,不测深度、按 1 − 全景↔mesh 混合)。①② 走 probe(插值开 = 八角三线性,
 * 关 = 最近那一颗);③④ 用⑥面板同一个体素行进(最近邻占据,旧着色器是 3D 纹理线性取样 α > .45,边缘差一两格)。
 */
function panoMapPixels(q, one, W, H){
  const out=new Uint8ClampedArray(W*H*4), g=S.pbGain, mode=S.pano.mode, wd=S.man.world;
  const basis=S.mode===0?2:S.mode;
  const V_=S.man.vol;
  const sc=[(V_.Nx-1)/(V_.qx_max-V_.qx_min),(V_.Ny-1)/(V_.qy_max-V_.qy_min),(V_.Nz-1)/(V_.qz_max-V_.qz_min)];
  const p0=[(q[0]-V_.qx_min)*sc[0],(q[1]-V_.qy_min)*sc[1],(q[2]-V_.qz_min)*sc[2]];
  const maxDist=Math.hypot(wd.x1-wd.x0,wd.y1-wd.y0,wd.z1-wd.z0)*0.6;
  const A=one>=0?probeBasisArraysAny(one,basis):null;
  const put=(i,c)=>{ out[i]=Math.round(Math.min(1,Math.max(0,c[0]))*255); out[i+1]=Math.round(Math.min(1,Math.max(0,c[1]))*255);
    out[i+2]=Math.round(Math.min(1,Math.max(0,c[2]))*255); out[i+3]=255; };
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    const i=(y*W+x)*4;
    const dW=dirFromLatLong((x+.5)/W,(y+.5)/H);
    const d=norm3(qFromWorld(dW));
    if(mode<=1){
      const E=(A?probeEvalDir(A,d):probeEInterp(q,d,basis)).map(v=>v/Math.PI);
      if(mode===0) put(i,E.map(v=>lin2srgbJ(v*g)));
      else put(i,zoneJ(Math.log2(Math.max(lumaJ(E)*g,1e-9))).map(lin2srgbJ));
      continue;
    }
    const r=marchQ(p0,sc,d,S.pano.fold,S.step,S.msteps);
    if(mode===2){
      if(r.hit<0){ put(i,[.08,.14,.34]); continue; }
      let c=rampJ(1-Math.min(1,Math.max(0,r.dist/Math.max(maxDist,1e-3))));
      if(r.folded && ((x+y)&1)===0) c=c.map(v=>v*.72);
      put(i,c); continue;
    }
    let L;
    if(r.hit>=0){ L=[0,1,2].map(ch=>{ let v=f16(S.volU16[r.hit*4+ch]); if(!S.nee) v+=f16(S.volEmitU16[r.hit*4+ch]); return v; }); }
    else L=ambRadJ(r.dir);
    put(i,L.map(v=>lin2srgbJ(v*g)));
  }
  return out;
}
/** 全景:视点变了就把球挪过去;可视化输入变了就重算经纬图(③④ 行进贵,移动中最多约 7 次/秒) */
function updatePano(){
  const g=V.g3, eye=camEye(S.cam);
  const one=S.pano.interp?-1:nearestProbeIdx(eye);
  S.pano.activeProbe=one;
  const org=one>=0?[S.probe.pos[one*3],S.probe.pos[one*3+1],S.probe.pos[one*3+2]]:eye;
  if(!V.sphere||!V.sphereAt||Math.hypot(eye[0]-V.sphereAt[0],eye[1]-V.sphereAt[1],eye[2]-V.sphereAt[2])>1e-9){
    const s=V.rt.labImages.latLongSphere(1);
    for(let i=0;i<s.vertices.length;i+=5){ s.vertices[i]+=eye[0]; s.vertices[i+1]+=eye[1]; s.vertices[i+2]+=eye[2]; }
    if(V.sphere) V.sphere.destroy();
    V.sphere=g.createMesh({vertices:s.vertices,indices:s.indices,label:'全景球'});
    V.sphereAt=eye.slice();
  }
  const key=[S.man.name,S.pano.mode,one,one<0?org.map(v=>v.toFixed(4)).join(','):'',S.mode===0?2:S.mode,
    S.nee,S.missMode,S.amb,S.pano.fold,S.pbGain,S.step,S.msteps].join('|');
  const now=performance.now();
  // 渐进:输入一变先出一张粗图(移动中最多约 7~16 次/秒),停手 300ms 再补一张细图(静看时与迁移前逐像素算的清晰度相当)
  const march=S.pano.mode>=2;
  let W;
  if(!V.pano||V.pano.key!==key){
    if(V.pano&&V.pano.tex&&now-V.pano.t<(march?150:60)) return;
    W=march?192:256;
  }else{
    if(V.pano.fine||now-V.pano.t<300) return;
    W=512;
  }
  const H=W/2;
  const px=panoMapPixels(qFromWorld(org),one,W,H);
  const tex=g.createTexture(new ImageData(px,W,H),'全景');
  if(V.pano&&V.pano.tex) V.pano.tex.destroy();
  V.pano={key,tex,t:performance.now(),fine:W>=512};
}
/**
 * 3D 里的角色 quad:贴图 = 2D 视图那份**游戏着色**按当前这一帧离屏画出来(直立 quad 的受光只看它在伪世界里的位置,
 * 与看它的相机无关——贴到同一个直立 quad 上就是游戏的着色)。输入没变不重画;异步回读回来再换贴图。
 */
function updateChar3(){
  if(!V.stage||!V.host||!V.g3||V.char3Busy||!V.stage.loaded) return;
  const f=footScene();
  const key=[V.payloadKey,V.stage.mode,f.x,f.y,f.hPx,S.beta,S.eChroma,S.bulge,S.flatten,S.nee,S.amb,S.missMode,
    S.fold,S.spp,S.step,S.msteps,S.dbg.normal,S.pgain,S.skyao].join('|');
  if(key===V.char3Key) return;
  V.stage.sync(labFrame());
  const H=256, W=Math.max(1,Math.round(H*S.charAspect));
  const root=V.stage.characterRoot(W,H);
  if(!root) return;
  if(!V.off||V.off.width!==W||V.off.height!==H){ if(V.off) V.off.destroy(); V.off=V.rt.offscreenReadback.createOffscreenTarget(V.host,W,H); }
  V.char3Busy=true;
  V.off.capture(root).then(px=>{
    // 离屏纹理的字节是预乘的;3D 调试件的贴图按不预乘上传、源 alpha 混合 → 还原成不预乘
    const s=px.data, d=new Uint8ClampedArray(s.length);
    for(let i=0;i<s.length;i+=4){ const a=s[i+3]; d[i+3]=a;
      if(a){ d[i]=Math.min(255,Math.round(s[i]*255/a)); d[i+1]=Math.min(255,Math.round(s[i+1]*255/a)); d[i+2]=Math.min(255,Math.round(s[i+2]*255/a)); } }
    const t=V.g3.createTexture(new ImageData(d,px.width,px.height),'角色');
    if(V.char3) V.char3.destroy();
    V.char3=t; V.char3Key=key;
  }).catch(e=>{ console.warn('[viewer] 角色贴图回读失败',e); V.char3Key=key; })
    .finally(()=>{ V.char3Busy=false; });
}
/** 3D 角色 quad 的四个角(世界):与迁移前 drawChar3D 同式(q 空间直立 quad → 世界) */
function char3Corners(){
  const cal=S.man.cal, cosT=Math.cos(cal.theta), sinT=Math.sin(cal.theta);
  const wy=groundY(S.footW.x,S.footW.z);
  const fq=qFromWorld([S.footW.x,wy,S.footW.z]);
  const effH=S.charH*S.qscale, hPx=effH*cosT*cal.ppu;
  const wWu=(hPx*S.charAspect)/cal.ppu;
  const corner=(sx,h)=>worldFromQ([fq[0]+sx*wWu*0.5, fq[1]+h*cosT, fq[2]-h*sinT]);
  return [corner(-1,effH), corner(1,effH), corner(1,0), corner(-1,0)];   // 左上 右上 右下 左下(= uv 缺省顺序)
}

// ------------------------------------------------------------- draw 3D
/** 3D 调试件用的常驻资源(按场景):背景 / 补全层 / 地面延拓贴图、按层拆开的重建网格 */
function ensure3DScene(){
  const g=V.g3; if(!g||!S.man||!V.px) return false;
  if(!V.t3){
    V.t3={bg:g.createTexture(V.bgImg,'背景'), hid:V.hidImg?g.createTexture(V.hidImg,'补全层'):null, hidG:null};
    if(V.px.hidden){ const t=V.rt.labImages.tintGround(V.px.hidden);
      V.t3.hidG=g.createTexture(new ImageData(new Uint8ClampedArray(t.data),t.width,t.height),'地面延拓'); }
  }
  if(!V.mesh3&&S.meshSrc&&S.meshTris){
    const r=V.rt.labImages.meshLayers(S.meshSrc.verts,S.meshSrc.idx,S.man.world.M,S.man.cal,S.work);
    V.mesh3=r.layers.map((L,i)=>L.indices.length?g.createMesh({vertices:L.vertices,indices:L.indices,label:'重建网格·'+i}):null);
    V.meshMixed=r.mixed;
  }
  return true;
}
function drop3DScene(){
  if(V.t3){ for(const t of Object.values(V.t3)) if(t) t.destroy(); V.t3=null; }
  if(V.mesh3){ for(const m of V.mesh3) if(m) m.destroy(); V.mesh3=null; }
  if(V.sphere){ V.sphere.destroy(); V.sphere=null; V.sphereAt=null; }
  if(V.pano&&V.pano.tex) V.pano.tex.destroy();
  V.pano=null;
  if(V.char3){ V.char3.destroy(); V.char3=null; }
  V.char3Key='';
}
/** probe 点(旧 PB_FS:线性 E/π × probe 显示增益 → sRGB;无效 = 暗红;暗边;选中 = 洋红环;漫游时近大远小)。
 *  3D 调试件的点是屏幕方片:圆点 + 暗边 / 选中环改成「外方片 + 内方片」两层。 */
function drawProbeDots3D(d,mvp){
  const D=S.probe, C=S.probeDC, fly=S.cam.mode==='fly', ref=fly?S.cam.dist*0.35:1, g=S.probeGain;
  for(let i=0;i<D.Pn;i++){
    const X=[D.pos[i*3],D.pos[i*3+1],D.pos[i*3+2]];
    const w=mvp[3]*X[0]+mvp[7]*X[1]+mvp[11]*X[2]+mvp[15];
    const ps=8*Math.min(3.5,Math.max(.45,ref/Math.max(w,1e-3)));
    const sel=(i===S.selProbe);
    if(C[i*4+3]<.5){ d.points(X,{color:[.42,.10,.10,1],size:ps*(sel?2.2:1)}); continue; }
    const c=[lin2srgbJ(C[i*4]*g),lin2srgbJ(C[i*4+1]*g),lin2srgbJ(C[i*4+2]*g)].map(v=>Math.min(1,v));
    if(sel){ d.points(X,{color:[1,.35,.85,1],size:ps*2.2}); d.points(X,{color:[c[0],c[1],c[2],1],size:ps*2.2*.62}); }
    else{ d.points(X,{color:[c[0]*.32,c[1]*.32,c[2]*.32,1],size:ps}); d.points(X,{color:[c[0],c[1],c[2],1],size:ps*.82}); }
  }
}
/** 交错线段表(x,y,z,r,g,b)按颜色成批交给 3D 调试件(颜色乘预览亮度的 sRGB 倍率 k) */
function lines3ByColor(d,l3,k){
  const by=new Map();
  for(let i=0;i+11<l3.length;i+=12){
    const key=l3[i+3]+','+l3[i+4]+','+l3[i+5];
    let a=by.get(key); if(!a){ a=[]; by.set(key,a); }
    a.push(l3[i],l3[i+1],l3[i+2],l3[i+6],l3[i+7],l3[i+8]);
  }
  for(const [key,a] of by){ const c=key.split(',').map(Number);
    d.lines(a,{color:[c[0]*k,c[1]*k,c[2]*k,1]}); }
}
function draw3D(){
  sizeViewport();
  const mvp=camMVP();       // 漫游=透视 / 轨道=正交(与游戏的正交伪世界对齐)
  const c=octx; c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,canvas.width,canvas.height);
  const g=V.g3;
  if(!g||!V.rt){ drawGpuNote(V.err3||'3D 画面准备中…'); return; }
  if(!ensure3DScene()) return;
  const k=V.rt.labImages.previewTint(S.pgain);
  const panoOn=S.pano.mode>=0&&S.cam.mode==='fly'&&!!S.probe;
  if(panoOn) updatePano();
  const charOn=!!S.pano.drawChar&&charReady;
  if(charOn) updateChar3();
  const wy=groundY(S.footW.x,S.footW.z), effH=S.charH*S.qscale;
  g.render(mvp,(d)=>{
    // reconstruction: SCENE-SKINNED mesh (default) or point cloud
    if(S.meshMode&&S.meshTris&&V.mesh3){
      const texs=[V.t3.bg,V.t3.hid,V.t3.hidG];
      for(let t=0;t<3;t++) if(V.mesh3[t]&&S.pcShow[t]&&texs[t]) d.mesh(V.mesh3[t],{texture:texs[t],tint:[k,k,k,1]});
    }else if(S.cloud){
      const C=S.cloud;
      for(let i=0;i<C.n;i++){ const t=C.tag[i]; if(t<3&&!S.pcShow[t]) continue;
        d.points([C.pos[i*3],C.pos[i*3+1],C.pos[i*3+2]],{color:[C.rgb[i*3]/255*k,C.rgb[i*3+1]/255*k,C.rgb[i*3+2]/255*k,1],size:2.2}); }
    }
    // ---- probe 全景:把可视化裹在相机周围(漫游模式才有意义,正交没有单一视点)
    if(panoOn&&V.pano&&V.pano.tex&&V.sphere)
      d.mesh(V.sphere,{texture:V.pano.tex,tint:[1,1,1,1-S.pano.blend],depth:'off',blend:true});
    if(S.dbg.probes&&S.probe) drawProbeDots3D(d,mvp);
    // character marker: vertical line + foot cross
    d.lines([S.footW.x,wy,S.footW.z, S.footW.x,wy+effH,S.footW.z,
             S.footW.x-.3,wy,S.footW.z, S.footW.x+.3,wy,S.footW.z,
             S.footW.x,wy,S.footW.z-.3, S.footW.x,wy,S.footW.z+.3],{color:[1*k,.3*k,.9*k,1]});
    // light surfels in world (orange points)
    if(S.dbg.lights&&S.lights.length){
      const lp=[]; for(const L of S.lights) lp.push(L.world[0],L.world[1],L.world[2]);
      d.points(lp,{color:[1*k,.7*k,.1*k,1],size:9});
    }
    if(S.dbg.rays){ if(!S.rays) buildRays(); lines3ByColor(d,S.rays.l3,k); }
    // 选中 probe 的采样射线(与⑥面板 ③④ 同一次追踪的稀疏可视化版)
    if(S.selProbe!=null&&S.pbRays&&S.pbLines) lines3ByColor(d,S.pbLines.l3,k);
    // 角色 quad 最后画、只测不写深度:透明处不挡后面(旧着色器 alpha<.03 直接丢片元,效果相同)
    if(charOn&&V.char3) d.quad(char3Corners(),{texture:V.char3,color:[1,1,1,1],depth:'test'});
  },{pixelRatio:V.dpr});
  // 相机被钳进 probe 盒/体素盒时,屏幕四边描红——"这不是你站的位置的真值"
  if(panoOn&&camClamped()){
    const W=canvas.width, H=canvas.height, bx=Math.max(1,Math.round(W*.012)), by=Math.max(1,Math.round(H*.012));
    c.fillStyle='rgba(242,51,38,.85)';
    c.fillRect(0,0,W,by); c.fillRect(0,H-by,W,by); c.fillRect(0,0,bx,H); c.fillRect(W-bx,0,bx,H);
  }
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
let pan2d=false,plx=0,ply=0,panPx=0;
// 笔刷16(点选实例):2D 视图里悬停高亮、单击整块翻转。相机视角认得出「这是哪座楼」,
// 顶视认不出——所以点选放在 2D,圈选放在顶视,两边高亮联动。
canvas.addEventListener('mousemove',e=>{
  if(S.view!==0) return;
  const [wx,wy]=canvasToWork(e);
  S.cursorW.x=wx; S.cursorW.y=wy; S.cursorW.on=1;   // D-4:笔刷圆环跟随光标
  if(S.brush!==16||!S.objIds) return;
  const x=Math.floor(wx), y=Math.floor(wy);
  if(x<0||y<0||x>=S.work.w||y>=S.work.h) return;
  const id=S.objIds[y*S.work.w+x]|0;
  if(id!==S.hotInstance){
    const prev=S.hotInstance;
    S.hotInstance=id;
    // A-5:只刷「旧实例」+「新实例」两个包围盒。原来为了给一块换个颜色就重建整张
    // 叠加层(全图循环 + 全纹理上传),划过画面时每变一次实例就来一发。
    for(const q of [instBBox(prev), instBBox(id)])
      if(q) refreshEditOverlay(q[0],q[1],q[2],q[3]);
    const m=id&&S.objMeta?S.objMeta.get(id):null;
    S.hoverInfo=m?`实例 #${id}  ${m.prompt}  ${m.score.toFixed(2)}  ${m.area}px`
                 :(id?`实例 #${id}`:'');
  }
});
canvas.addEventListener('mouseleave',()=>{ S.cursorW.on=0; });
// D-3:2D 也用**右键闭合**多边形,与顶视完全一致。原来 2D 用双击、顶视用右键,同一个
// 动作两种手势;而且双击会先派发两次 mousedown 多塞两个顶点(顶视注释自承是"将就写法")。
// 右键与"右键拖动=平移"共存靠位移判据:没拖动(<5px)才当作闭合。
canvas.addEventListener('contextmenu',e=>{
  e.preventDefault();
  if(S.view!==0||panPx>=5) return;
  if(!isPolyBrush(S.brush)||!S.polyPts.length) return;
  if(S.polyPts.length>=3) polyApply();
  else S.polyPts=[];                                // 不足三点=取消
});
canvas.addEventListener('mousedown',e=>{ if(S.view===0&&e.button===2){ pan2d=true; plx=e.clientX; ply=e.clientY; panPx=0; } });
window.addEventListener('mouseup',()=>pan2d=false);
window.addEventListener('mousemove',e=>{
  if(!pan2d||S.view!==0) return;
  const r=canvas.getBoundingClientRect();
  const dx=e.clientX-plx, dy=e.clientY-ply;
  panPx+=Math.abs(dx)+Math.abs(dy);
  S.v2.ox-=dx/r.width*S.work.w/S.v2.zoom;
  S.v2.oy-=dy/r.height*S.work.h/S.v2.zoom;
  plx=e.clientX; ply=e.clientY; clamp2D();
});
canvas.addEventListener('dblclick',e=>{
  if(S.view===1){ if(S.man) fitCamera(); return; }               // 3D:双击=相机复位
  // D-3:多边形闭合已统一到**右键**(与顶视一致)。双击在 2D 专职"缩放复位",
  // 语义不再重载 —— 双击本来就会先派发两次 mousedown,拿它闭合必然多塞两个顶点。
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
  if(S.view===2||S.view===-1){ /* 顶视/图片查看:独立 2D 画布,不走 GPU 主循环 */ }
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
      + (S.pano.mode>=2&&S.pano.fold?'  ⚠③④折叠开:朝相机侧是镜像回来的假世界,不是真周围':'')
      + (S.pano.mode<=1?'  (①②的A7折叠已烘进系数,去不掉)':'')
      + (camClamped()?'  ⚠相机在 probe 盒外(已钳到边界,显示的不是本位置真值)':'');
  }else if(S.view===1 && S.pano.mode>=0){
    panoTxt='\n⚠ 全景只在「漫游」相机下有效——正交没有单一视点';
  }
  // A-3:键盘焦点在哪必须写出来 —— 画布是 WASD/方向键/Tab 的唯一接收方,
  //      从右栏拖完滑杆后按 WASD 人不动,原来界面上没有任何线索。
  const kbd=(document.activeElement===canvas)?'画布':'面板';
  const txt=
    `${['RT 实时追踪·每帧GPU重算','Cache·SH L1·预烘焙插值','Cache·SH L2·预烘焙插值','Cache·BIN·预烘焙插值'][S.mode]}  |  ${S.fps} fps  |  ${viewTxt}  |  键盘:${kbd}\n`+
    posTxt + (S.selProbe!=null?`   probe #${S.selProbe} 已选中`:'') + panoTxt +
    (S.hoverInfo?'\n'+S.hoverInfo:'');
  // A-6:原来每帧无条件写 DOM(连顶视态 hud 已 display:none 时也照写),
  //      每帧都触发一次 style 重算。现在只在字符串真变了才写。
  if(txt!==_hudLast){ _hudLast=txt; $('hud').textContent=txt; }
}
let _hudLast='';

// ------------------------------------------------------------- input
window.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT') return;
  if(e.key==='Tab'){ e.preventDefault(); setMode((S.mode+1)%4); return; }
  if(e.key==='?'||e.key==='/'){ _keyFull=!_keyFull; updateKeyHelp(); return; }   // E-4
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
setMode(1);   // 进入默认 L1(与 S.mode 初值一致);RT 仍可 Tab/点按钮手动切
function setView(v){ S.view=v;
  // ⚠ 必须作用域到 #view_tabs:`.views` 这个类同时给 #cam_modes / #pano_modes 用作样式,
  // 老写法 `.views button` 会把那两组按钮的 .on 一起清掉 —— 切一次视图,「漫游/轨道」和
  // 「全景」的高亮就没了,而 setCamMode 有 `if(m===c.mode) return` 守卫,再也回不来。
  document.querySelectorAll('#view_tabs button').forEach(b=>b.classList.toggle('on',+b.dataset.v===v));
  const tv=$('topview'), th=$('topview_hint');
  const on=(v===2);
  tv.style.display=on?'block':'none'; th.style.display=on?'block':'none';
  $('hud').style.display=on?'none':'block';        // 顶视有自己的图例,HUD 会残留 3D 文案
  viewwrap.style.visibility=on?'hidden':'visible';
  // 2D / 3D 各一块 WebGPU 画布(各自一台设备):只显示当前视图那块;标注层 #gl 两个视图共用
  canvas2d.style.display=(v===1)?'none':'block';
  canvas3d.style.display=(v===1)?'block':'none';
  $('img_exit').style.display='none';              // E-3:离开图片查看态就收起返回按钮
  S.topPoly=[]; S.polyPts=[];
  updateKeyHelp();
  if(on) buildTopView();
}
// E-4:快捷键提示随视图上下文变化,常驻画面左下。原来只有面板**最底部**一小块静态
// 文字,一整套 Tab/WASD/QE/Alt+点/Esc 全靠翻到底才看得见。
let _keyFull=false;
const KEY_HELP={
  0:'<b>2D</b>:点击瞬移 · 滚轮缩放 · 右键拖平移 · 双击复位 · Tab/1234 切照明模式 · Alt/Shift+点选 probe',
  1:'<b>3D 漫游</b>:WASD 平移 · Q/E 升降 · Shift 加速 · 左键拖看向 · 右键或 Shift+拖平移 · 滚轮进退 · 双击复位 · 点圆点选 probe',
  2:'<b>顶视</b>:左键加顶点 · 右键闭合并填充 · Esc 取消(需先选「地形/物体」类笔刷)',
  '-1':'<b>图片查看</b>:点右上角「← 返回 2D」退出',
};
function updateKeyHelp(){
  const el=$('keyhelp'); if(!el) return;
  let s=KEY_HELP[String(S.view)]||'';
  if(S.view===0&&S.brush>0){
    s+= isPolyBrush(S.brush) ? '<br><b>多边形</b>:左键加顶点 · <b>右键闭合填充</b> · Esc 取消'
      : (S.brush===16 ? '<br><b>点选</b>:单击整枚实例翻转 地形↔物体'
                      : '<br><b>圆刷</b>:按住左键涂抹 · 圆环=实际影响范围');
  }
  if(_keyFull) s=Object.values(KEY_HELP).join('<br>');
  s+='　<span style="opacity:.6">[? 全部]</span>';
  el.innerHTML=s;
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
    setLog('顶视圈选需要先把笔刷切到「地形:标为物体/地形」或「多边形:标为物体/地形」','warn');
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
  setLog(`✓ 顶视圈选:${n} 个像素标为${val===1?'物体':'地形'}——保存编辑后重烘生效`,'ok');
}
document.querySelectorAll('#view_tabs button').forEach(b=>b.onclick=()=>{ setView(+b.dataset.v); canvas.focus(); });

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
// D-2:折叠状态跨会话保持。原生 <details> 本身零动画(铁律 1),这里只管记忆开合。
// 默认全折叠 —— 首屏可见控件从 84 个降到 30 出头,专家参数一键就能展开。
(function(){
  const KEY='clab.folds';
  let saved={};
  try{ saved=JSON.parse(localStorage.getItem(KEY)||'{}'); }catch(e){ saved={}; }
  document.querySelectorAll('details.fold').forEach(d=>{
    if(saved[d.id]) d.open=true;
    d.addEventListener('toggle',()=>{
      saved[d.id]=d.open;
      try{ localStorage.setItem(KEY,JSON.stringify(saved)); }catch(e){}
    });
  });
})();
const rayReset=()=>{ S.rays=null; };
bindSlider('pgain',null,v=>'2^'+v.toFixed(1),v=>{ S.pgain=Math.pow(2,v); });
bindSlider('spp','spp',v=>v.toFixed(0));
bindSlider('step','step',v=>v.toFixed(1),rayReset);
bindSlider('msteps','msteps',v=>v.toFixed(0),rayReset);
bindSlider('beta','beta',v=>'2^'+v.toFixed(1));
bindSlider('echroma','eChroma',v=>v.toFixed(2));
// amb / nee 固化进 probe 图集(导出照明时合成):改它们 = 虚拟载荷换一份合成,游戏装载器重装(停手 250ms)
bindSlider('amb','amb',v=>v.toFixed(2),()=>{ probeRefresh(); schedulePayload(); });
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
$('nee').addEventListener('change',e=>{ S.nee=e.target.checked?1:0; probeRefresh(); schedulePayload(); });
S.skyao=1;
$('skyao').addEventListener('change',e=>{ S.skyao=e.target.checked?1:0; });

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
$('pano_fold').addEventListener('change',e=>{ S.pano.fold=e.target.checked?1:0; });
S.bgview=0;
$('bgview').addEventListener('change',e=>{ S.bgview=+e.target.value; });
$('hdr_method').addEventListener('change',e=>{ S.hdrMethod=+e.target.value;
  if(S.man){ refreshThumbs(); refreshDirtyMarks(); } });
bindSlider('hdr_pa',null,v=>v.toFixed(2),v=>{ S.hdrPA=v;
  if(S.man){ refreshThumbs(); refreshDirtyMarks(); } });
[['pc_front',0],['pc_hidden',1],['pc_ground',2]].forEach(([id,i])=>
  $(id).addEventListener('change',e=>{ S.pcShow[i]=e.target.checked?1:0; }));
$('pc_mesh').addEventListener('change',e=>{ S.meshMode=e.target.checked?1:0; });

const RB_IDS=['rb_pitch','rb_az','rb_ppu','rb_dscale','rb_doff','rb_chlo','rb_chhi',
              'rb_ev','rb_gain','rb_tau','rb_relief','rb_cxz','rb_cy','rb_hch','rb_spp'];
// E-2:控件 → 已烘 manifest 里的参数键。有了它就能回答两个问题:
//   ①「N 项参数未应用」到底是哪几项(给 label 打左边框,一眼定位);
//   ② 折叠块里藏着几项改动(summary 上的静态计数,免得"折起来就忘了")。
const RB_PARAM_KEY={
  rb_pitch:'pitch_deg', rb_az:'azimuth_deg', rb_ppu:'ppu_ratio', rb_ev:'ev',
  rb_model:'depth_model', rb_calib:'calibration', rb_dscale:'depth_scale_adj', rb_doff:'depth_offset_adj',
  rb_chlo:'col_h_lo', rb_chhi:'col_h_hi', rb_gain:'max_gain_ev', rb_tau:'occluder_tau',
  rb_relief:'relief', rb_objthr:'object_score_min', rb_sem:'semantic_gate',
  hdr_method:'hdr_method', hdr_pa:'hdr_pa',
  rb_cxz:'probe_cells_per_char_xz', rb_cy:'probe_cells_per_char_y',
  rb_hch:'probe_height_chars', rb_spp:'probe_spp',
};
function _ctlValue(el){
  if(el.type==='checkbox') return el.checked?1:0;
  const n=parseFloat(el.value);
  return Number.isFinite(n)?n:el.value;
}
/** 与已烘参数逐项比对 → 打标记 + 计数 + 决定重烘按钮是否 dirty。 */
function refreshDirtyMarks(){
  const baked=(S.man&&S.man.params)||null;
  const perFold={}; const changed=[];
  for(const [id,key] of Object.entries(RB_PARAM_KEY)){
    const el=$(id); if(!el) continue;
    const lab=el.closest('label');
    let diff=false;
    if(baked && key in baked){
      const cur=_ctlValue(el), was=baked[key];
      const wasN=parseFloat(was);
      // 容差 = 半个 step:滑条只能停在 step 的整数倍上,比它还小的差**表达不出来**,
      // 算成"未应用"就是永远消不掉的假警报(实测:HDR最大EV 烘的是 log2(10)=3.3219,
      // 滑条 step 0.25 只能停 3.25,于是每个场景一进来就挂着「1 项参数未应用」)。
      const st=parseFloat(el.step), tol=Number.isFinite(st)&&st>0?st/2:1e-9;
      diff=(typeof cur==='number'&&Number.isFinite(wasN))
            ? Math.abs(cur-wasN)>tol
            : String(cur)!==String(was);
    }
    if(lab) lab.classList.toggle('touched',diff);
    if(diff){
      changed.push((lab&&lab.querySelector('.k')?lab.querySelector('.k').textContent:id));
      const fold=el.closest('details.fold');
      if(fold) perFold[fold.id]=(perFold[fold.id]||0)+1;
    }
  }
  document.querySelectorAll('details.fold').forEach(f=>{
    const c=f.querySelector('summary .cnt'); if(!c) return;
    c.textContent=perFold[f.id]?String(perFold[f.id]):'';
  });
  const note=$('dirty_note');
  if(note) note.textContent=changed.length
    ? `${changed.length} 项参数未应用:${changed.join('、')}` : '';
  markDirty(changed.length>0||S.geoStale);
  return changed.length;
}
$('rb_model').addEventListener('change',()=>{ if(S.man)refreshDirtyMarks(); });
/** 「按圈的路 + 竖直崖壁」标定:俯角与起伏增益由拟合自己定,两根滑条置灰(它们送过去也不生效)。 */
function syncCalibLock(){
  const structure=$('rb_calib')&&$('rb_calib').value==='structure';
  for(const id of ['rb_pitch','rb_relief']){
    const el=$(id); if(!el) continue;
    el.disabled=structure;
    const lab=el.closest('label'); if(lab) lab.style.opacity=structure?'0.45':'';
  }
}
$('rb_calib').addEventListener('change',()=>{ syncCalibLock(); if(S.man)refreshDirtyMarks(); });
function markDirty(d){ $('rebuild').classList.toggle('dirty',d); }
RB_IDS.forEach(id=>bindSlider(id,null,v=>(''+v).slice(0,5),()=>{ if(S.man)refreshDirtyMarks(); }));
for(const id of ['rb_sem'])
  $(id).addEventListener('change',()=>{ if(S.man)refreshDirtyMarks(); });
// HDR最大EV 拖动即实时刷新 HDR/光源缩略图(只缩放已烘 gain 场,无需重烘)
$('rb_gain').addEventListener('input',()=>{ if(S.man)refreshThumbs(); });

function rbParams(){
  return {
    pitch_deg:$('rb_pitch').value, azimuth_deg:$('rb_az').value,
    ppu_ratio:$('rb_ppu').value, ev:$('rb_ev').value,
    depth_model:$('rb_model').value, calibration:$('rb_calib').value,
    depth_scale_adj:$('rb_dscale').value, depth_offset_adj:$('rb_doff').value,
    col_h_lo:$('rb_chlo').value, col_h_hi:$('rb_chhi').value,
    max_gain_ev:$('rb_gain').value, occluder_tau:$('rb_tau').value,
    relief:$('rb_relief').value,
    object_score_min:$('rb_objthr').value,
    semantic_gate:$('rb_sem').checked?1:0,
    // 当前选中的 HDR 恢复法/参数(④显示 的下拉与滑条)→ 烘焙用同一方法,预览即所烘
    hdr_method:S.hdrMethod??0, hdr_pa:S.hdrPA??0.7,
    // ⚠ 不送 probe_band:它缺省由**角色实高**推出(char_wu*1.15)。写死 1.6 是
    //   「角色高 1.5 wu」的遗留假设,实测角色 0.17~0.97 wu —— 送过去就是 6 层里
    //   5 层烘在够不着的空中。probe_nx/ny/nz 同理,已无消费者。
    probe_cells_per_char_xz:$('rb_cxz').value, probe_cells_per_char_y:$('rb_cy').value,
    probe_height_chars:$('rb_hch').value, probe_spp:$('rb_spp').value};
}
// ---------------------------------------------------- 场景清单(扫游戏工程)
// 场景身份只认**游戏场景 id**(public/assets/scenes/<id>.json 的文件名):背景图、
// 烘焙目录、导照明、导深度四个落点全由它推出。曾经的「上传图片建新场景」按文件名
// 猜场景名,真把 teahouse 的背景烘成了叫 "background" 的假场景 —— 已废除。
function sceneMark(s){
  // 两级状态,两个概念劈开(制作人 2026-09-01):
  //   baked   = **这台机器的实验室工作台**(out/<id>/,本机产物、不进 git)
  //   lighting= **游戏运行时载荷**(runtime/scenes/<id>/lighting/,游戏真读的那份)
  // 旧文案只显示 baked,一换机器全场「未烘焙」,看着像游戏数据丢了 —— 其实
  // 载荷都在,缺的只是本机工作台。
  if(s.orphan) return '⚠孤儿';
  if(!s.bg_ok) return '⚠缺背景';
  if(s.bg_stale) return '⚠背景已变';
  if(!s.baked) return s.lighting ? '◐载荷在·无工作台' : '○全未烘';
  return s.lighting ? '✓已导出' : '◑工作台在·未导出';
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
  // C-2:去 emoji,统一动词。UI 文案里不再出现「重建」——只留「重烘」(跑完整管线)
  // 与「重算地形」(秒级快通道)两个词,免得三个近义动词混着记。
  btn.textContent=m ? '应用参数:重烘此场景'
                    : '构建本机工作台(全管线,约 4~5 分钟;不动游戏载荷)';
  if(info){
    if(!g){ info.textContent=''; }
    else if(g.orphan){
      info.innerHTML=`<span class="warn">⚠ 孤儿:游戏里没有 id=${g.id} 的场景</span>`+
        `——多半是历史错位命名,烘了也没法导出;去主编辑器建同名场景,或删掉 out/${g.id}/`;
    }else{
      const bits=[`背景 <b>${g.bg}</b>`,
                  g.baked?'本机工作台:已构建':'<b>本机工作台:未构建</b>',
                  g.lighting?'游戏载荷:已导出':'<b>游戏载荷:未导出</b>',
                  g.depth?'已有depthConfig':'无depthConfig'];
      info.innerHTML=bits.join(' · ')+
        (!g.bg_ok?'<br><span class="warn">⚠ 背景图不在盘上,无法烘焙</span>':'')+
        (g.bg_stale?'<br><span class="warn">⚠ 背景已重画,烘焙输入过期——需重烘并重新导出</span>':'')+
        (!g.baked&&g.lighting?'<br><span class="warn">画布无内容:本机没有该场景的实验室工作台'+
          '(out/ 是逐机器的本地产物)。游戏载荷完好,游戏不受影响;'+
          '要在实验室里查看/调参,先点上面的「构建本机工作台」。</span>':'');
    }
  }
  return m;
}

/** 导出/编辑类操作的闸门:必须有已加载场景,且下拉选的就是它(防"选了A导出了B")。 */
function activeScene(){
  if(!S.man){ setLog('✗ 还没有任何已烘焙的场景','err'); return null; }
  if($('scene').value!==S.man.name){
    setLog(`✗ 下拉选的是 ${$('scene').value}(未烘焙),画面上是 ${S.man.name}`+
      '——先把它烘出来,或切回已烘焙的场景再操作','err');
    return null;
  }
  return S.man.name;
}

// 重烘队列跑起来时要压住的按钮。**不含 bake_fields**:重烘写的是 out/<场景>/(实验室
// 工作台),几何场读写的是游戏侧已导出的深度与 lighting/<背景基名>/,两者不碰同一个文件;
// 而把它列进来反倒会出事——watchJob 收尾会无条件放开这一组,正在跑的几何场烘焙会被
// 重新点亮,于是同一场景并发烘两遍、互相覆盖产物。
const BAKE_BTNS=['rebuild','rebuild_all'];
// B-2:阶段清单标签。渲染成静态勾选行 —— 已过=✓绿,当前=▸橙,未到=○灰,
// 越过但没出现(如无编辑时的 edit)=· 跳过。全程没有任何东西在动,变的只有数据。
const STAGE_LABEL={depth:'深度推理',objects:'物体识别',calib:'标定',hdr:'HDR恢复',
  edit:'笔刷编辑',voxel:'体素化',bounds:'世界边界',lights:'光源提取',ambient:'环境闭合',
  probes:'probe烘焙',walk:'可走/碰撞',mesh:'网格',char:'角色贴图',done:'写盘'};
function renderStages(r){
  const box=$('bake_stages'); if(!box) return;
  if(!r||!r.stage_order||r.status==='done'||r.status==='failed'){ box.style.display='none'; return; }
  const order=r.stage_order, seen=new Set(r.stages||[]), cur=r.stage;
  const curIdx=order.indexOf(cur);
  let html=`<span class="el">${r.scene||''} · 已用 ${Math.round(r.elapsed||0)}s`+
           (r.queue_position?` · 排队第 ${r.queue_position}`:'')+`</span>`;
  for(let i=0;i<order.length;i++){
    const t=order[i], nm=STAGE_LABEL[t]||t;
    let cls='', mark='○';
    if(t===cur){ cls='cur'; mark='▸'; }
    else if(seen.has(t)){ cls='done'; mark='✓'; }
    else if(curIdx>=0&&i<curIdx){ mark='·'; }      // 越过了但没出现 = 本次跳过
    html+=`<span class="sg ${cls}">${mark}${nm}</span>`;
  }
  box.innerHTML=html; box.style.display='block';
}
async function watchJob(jobId, reloadName){
  BAKE_BTNS.forEach(id=>{ const b=$(id); b.disabled=true; b.dataset.busy='1'; });
  try{
    for(;;){
      const r=await (await fetch('/api/job?id='+jobId)).json();
      if(!r.ok){ setLog('✗ 任务丢失(服务重启过?)','err'); break; }
      renderStages(r);
      if(r.status==='done'||r.status==='failed'){
        renderStages(null);
        const tail=(r.log||'').split('\n').filter(s=>s.trim()).slice(-4).join('\n');
        if(r.status==='done'){
          setLog(`✓ ${r.label} 完成(用时 ${Math.round(r.elapsed||0)}s)`,'ok');
          const cur=await refreshSceneList(reloadName);
          const target=applySceneSelection(cur);
          if(target) await loadScene(target);      // loadScene refreshes geo status
        }else{
          setLog(`✗ ${r.label} 失败\n${tail}`,'err');
        }
        break;
      }
      await new Promise(res=>setTimeout(res,1200));
    }
  }catch(err){ setLog('✗ 烘焙任务中断:'+err,'err'); renderStages(null); }
  BAKE_BTNS.forEach(id=>{ const b=$(id); b.disabled=false; delete b.dataset.busy; });
}
$('rebuild').onclick=async()=>{
  const id=$('scene').value;
  if(!id) return;
  // 已烘过 = 重烘;没烘过 = 首次烘焙(服务端按场景 id 自动把游戏背景拷进 out/<id>/)
  const first=!bakedManifest(id);
  const btn=$('rebuild');
  // B-2:首烘含深度推理 + SAM3 语义门控,实测 4~5 分钟 —— 必须提前说,
  // 否则任何人第一次点都会以为卡死了。
  busy(btn, first?`首次烘焙 ${id} 已入队 —— 含深度推理 + SAM3 语义门控,约需 4~5 分钟`
                 :`重烘 ${id} 已入队…`);
  markDirty(false);
  try{
    const q=new URLSearchParams({scene:id, ...rbParams()});
    const r=await (await fetch((first?'/api/import?':'/api/rebuild?')+q)).json();
    if(r.ok) watchJob(r.job, id);
    else idle(btn,'✗ '+(r.err||'入队失败'),'err');
  }catch(err){ idle(btn,'✗ 入队失败:'+err,'err'); }
};
$('rebuild_all').onclick=async()=>{
  const n=(S.scenes||[]).length;
  if(!confirm(`重烘全部已烘场景?\n\n`+
              `共 ${n} 个场景,按各自已保存的参数逐个排队执行。\n`+
              `耗时可能很长(每场景约 10 秒起,含首次推理的更久)。\n`+
              `期间可以离开页面,任务在服务端继续跑。`)) return;
  const btn=$('rebuild_all');
  busy(btn,`重烘全部 ${n} 个场景已入队…`);
  try{
    const r=await (await fetch('/api/rebuild_all')).json();
    if(r.ok) watchJob(r.job, S.man&&S.man.name);
    else idle(btn,'✗ '+(r.err||'入队失败'),'err');
  }catch(err){ idle(btn,'✗ 入队失败:'+err,'err'); }
};
// 面板当前非 bake 着色参数 → 场景配置(游戏 F2 打开即这些值);两个导出按钮共用一处构造,
// 免得漂移。pgain(预览亮度)是实验室显示设施,刻意不导出——游戏侧角色曝光只认 β。
function shQuery(name){
  return new URLSearchParams({
    scene:name, mode:S.mode, spp:S.spp, step:S.step, msteps:S.msteps,
    fold:S.fold, miss_mode:S.missMode, nee:S.nee, beta:S.beta,
    amb:S.amb, bulge:S.bulge, flatten:S.flatten, eChroma:S.eChroma,
  });
}
// ---------------------------------------------------- 读回已导出的着色参数
// ⚠ 这是补的一个**真会丢数据**的洞:查看器原来从不读回 lighting.json 的 shading 块,
// 面板上的 β/E色度/隆起/压平 永远是 HTML 里那个写死的初值。于是——
//   ① 你看不到这个场景当前实际生效的值(调好 β=3.0 存进游戏,刷新页面又显示 0.0);
//   ② 更要命:刷新或切场景后再点「只存着色参数」,会拿面板上的默认值把之前调好的
//      **悄悄覆盖掉**(teahouse 的 eChroma 被写回 0.0 就是这么来的)。
// 现在:载场景时同步一次真值;该场景没导出过就回落到与服务端 SHADING_DEFAULTS 同源的缺省。
const SHADING_UI_DEFAULTS={mode:2,spp:64,step:0.9,msteps:160,fold:1,miss_mode:0,nee:0,
                           beta:0,amb:1,bulge:0.22,flatten:0,eChroma:0};
function applyShadingConfig(sh){
  const v={...SHADING_UI_DEFAULTS, ...(sh||{})};
  setMode(Math.max(0,Math.min(3,+v.mode|0)));
  setSlider('spp',v.spp); setSlider('step',v.step); setSlider('msteps',v.msteps);
  setSlider('beta',v.beta); setSlider('amb',v.amb);
  setSlider('bulge',v.bulge); setSlider('flatten',v.flatten);
  setSlider('echroma',v.eChroma);
  for(const [id,on] of [['fold',+v.fold>0],['missnorm',+v.miss_mode>0],['nee',+v.nee>0]]){
    const el=$(id); if(!el) continue;
    if(el.checked!==on){ el.checked=on; el.dispatchEvent(new Event('change')); }
  }
}
async function syncShadingFromExport(sceneId){
  try{
    const r=await (await fetch('/api/shading?scene='+encodeURIComponent(sceneId),
                               {cache:'no-store'})).json();
    applyShadingConfig(r && r.ok ? r.shading : null);
    return !!(r && r.ok && r.shading);
  }catch(e){ applyShadingConfig(null); return false; }
}
// 「不进游戏」的旋钮统一用 ◌ 角标**静态标出**(见 index.html 的 .tm.lab),不做任何
// 存盘时的弹窗/警告——反复提示比标记烦得多,而且标记是常驻的、调之前就看得见。
//   · 接触阴影:实验室合成预览;游戏侧接触阴影来自场景环境配置 env.ao.contact
//     (src/core/Game.ts:2489),不走照明载荷;
//   · 预览亮度/probe亮度:纯显示增益(导出会破坏"人:背景"比例,游戏亮度只认 β);
//   · 碰撞/整体缩放/身高:实验室摆位设施,游戏用角色自身尺寸与场景碰撞。
/** 存盘后回报**实际写进去的值** —— 一行回执,不是警告。 */
function reportShadingWritten(){
  const names=['RT','L1','L2','BIN'];
  setLog(`实际写入:模式 ${names[S.mode]} · β ${(+S.beta).toFixed(2)}EV · E色度 ${(+S.eChroma).toFixed(2)}`
    + ` · 隆起 ${(+S.bulge).toFixed(2)} · 压平 ${(+S.flatten).toFixed(2)}`,'info');
}
$('export_rt').onclick=async()=>{
  const name=activeScene(); if(!name) return;
  // E-1:破坏性写盘(~25MB 进游戏工程),不可撤销 → 必须确认
  if(!confirm(`即将把照明载荷写进游戏工程\n\n`+
              `场景:${name}\n`+
              `写入:public/resources/runtime/scenes/${name}/lighting/\n`+
              `内容:probe 图集(L1/L2/BIN)+ 地面场 + 标定 + 当前着色参数,约 25MB\n\n`+
              `会覆盖该场景已有的照明载荷。此操作不可撤销,确认?`)) return;
  const btn=$('export_rt');
  busy(btn,'导出照明中(重新产出 probe 数据,约 25MB)…');
  try{
    const r=await (await fetch('/api/export?'+shQuery(name))).json();
    idle(btn, r.ok?('✓ 已导出到游戏(probe 数据+着色参数)\n'+r.dest):('✗ '+(r.err||'')),
         r.ok?'ok':'err');
  }catch(err){ idle(btn,'✗ 导出照明失败:'+err,'err'); }
};
// 只补 lighting.json 的 shading 块,不重跑数据通道(秒存)。nee/amb/miss_mode 已固化进
// 图集,服务端会拒绝并提示改走「导出照明」——不静默写出与图集不符的参数。
$('export_params').onclick=async()=>{
  const name=activeScene(); if(!name) return;
  const btn=$('export_params');
  busy(btn,'保存着色参数中…');
  try{
    const r=await (await fetch('/api/export_params?'+shQuery(name))).json();
    idle(btn, r.ok?('✓ 已存着色参数(未动 probe 图集)\n'+r.dest):('✗ '+(r.err||'')),
         r.ok?'ok':'err');
    if(r.ok) reportShadingWritten();     // 回报真写进去的值 + 警告不导出的旋钮
  }catch(err){ idle(btn,'✗ 保存着色参数失败:'+err,'err'); }
};
$('scene').addEventListener('change',async e=>{
  const id=e.target.value;
  const m=applySceneSelection(id);
  if(m){
    // B-4:loadScene 并发 ~24 个二进制 fetch,原来全程零反馈,切场景时画面直接冻住
    setLog(`载入 ${id}…`,'pending');
    try{ await loadScene(m); setLog(`✓ 已载入 ${id}`,'ok'); }
    catch(err){ setLog(`✗ 载入 ${id} 失败:${err}(该场景产物可能不全,重烘一次)`,'err'); }
  }
  else setLog('该场景还没烘焙——点上面橙色按钮「首次烘焙」即可(背景自动从工程取)','warn');
  canvas.focus();
});

// ------------------------------------------------------------- boot
(async()=>{
  setView(0);
  const gpu=initGpu();          // 与拉场景清单并行;拿不到 WebGPU 不挡别的
  // B-4:启动路径原来没有 try/catch,Promise.all 里任一文件缺失就整体 reject →
  // 页面静默黑屏,连场景下拉都出不来。现在保证「列表可用 + 错误说人话」。
  try{
    const cur=await refreshSceneList();
    const m=applySceneSelection(cur);
    await gpu;
    if(V.err) setLog('✗ '+V.err,'err');
    if(m){
      setLog(`载入 ${cur}…`,'pending');
      try{ await loadScene(m); setLog(`✓ 已载入 ${cur}`,'ok'); }
      catch(err){ setLog(`✗ 载入 ${cur} 失败:${err}\n该场景产物不全,换个场景或重烘一次`,'err'); }
    }else{
      setLog('还没有已烘焙的场景——选一个场景后点橙色按钮开始首次烘焙','warn');
    }
  }catch(err){
    setLog('✗ 拉场景清单失败:'+err+'(实验室服务没起来?)','err');
  }
  await gpu;
  updateKeyHelp();
  canvas.focus();
  draw();
  window.__ready=true;
})();
/** 冒烟(真 Chrome):拿到 WebGPU、载荷装上、2D 画面非空且角色确实画出来了、没有设备诊断错误(画布回读是异步的) */
window.__rhiSmoke=async()=>{
  if(!V.ready) return {ok:false, detail:'还在初始化'};
  if(!V.host||!V.stage) return {ok:false, detail:V.err||'没有 2D 渲染器'};
  if(!S.man) return {ok:false, detail:'没有已载入的场景'};
  draw2D();                      // 回读读的是最近一次 render:先在这个任务里画一帧(拷贝在调用当下提交)
  const drawn=await V.host.countDrawnPixels();
  const total=canvas2d.width*canvas2d.height;
  const detail={scene:S.man.name, loaded:V.stage.loaded, mode:V.stage.mode, drawn, total,
    err:V.host.lastError||'', problem:V.stage.lastProblem||'', g3:!!V.g3, err3:V.err3||''};
  return {ok:V.stage.loaded&&drawn>total*0.5&&!V.host.lastError&&!!V.g3, detail};
};
