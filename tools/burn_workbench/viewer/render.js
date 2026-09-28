'use strict';
/* WebGPU preview of the legacy tool: direct template UV, straight-alpha sampling, one material/glow pass.
 * BurnStage shares runtime simulation/frame/shade functions; tests/parity keeps the old BurnGL oracle.
 * No WebGPU fallback. The tool owns its straight-alpha textures independently of Assets. */

class BurnGpu {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.err = '';
    this.host = null;
    this.stage = null;
    /** url → { tex, err, pending }（工具独占的直通 alpha 纹理，不进 Assets 共享缓存） */
    this.textures = new Map();
    this.pendingTextures = 0;
    this.items = [];
    this.bg = null;
    this.cssWidth = 1;
    this.cssHeight = 1;
  }

  /** 建渲染器（异步：要 WebGPU 适配器与设备）。失败把人话原因写进 `err` */
  async init(rt) {
    if (!rt || !rt.workbenchRhi || !rt.burnView) { this.err = '运行时包没装上：着色预览画不了'; return false; }
    try {
      this.host = await rt.workbenchRhi.createCanvasHost(this.canvas, { background: [0.067, 0.067, 0.075, 1], antialias: true });
      this.stage = new rt.burnView.BurnStage();
      this.ok = true;
      this.err = '';
    } catch (e) {
      this.ok = false;
      this.err = `着色预览画不了：${(e && e.message) || e}`;
    }
    return this.ok;
  }

  resize(cssW, cssH, dpr) {
    // Legacy BurnGL keeps original CSS uScreen even when css*dpr rounds to integral pixels.
    // engine2d.screen is rounded pixels / DPR and would shift both artwork and the burn field.
    this.cssWidth = Math.max(1, cssW);
    this.cssHeight = Math.max(1, cssH);
    if (this.ok) this.host.resize(cssW, cssH, dpr);
  }

  /** 一帧开始：相机 + 清掉上一帧的实例清单 */
  begin(k, ox, oy) {
    if (!this.ok) return false;
    this.stage.setCamera(k, ox, oy);
    this.items = [];
    this.bg = null;
    return true;
  }

  /** 纹理：还没装到 = null（装到后自己请求重画） */
  texture(url) {
    const r = this.textureEntry(url);
    return r ? r.tex : null;
  }
  /** 纹理装好（或装失败）时落定；没有 GPU = 立刻落定 */
  textureReady(url) {
    const r = this.textureEntry(url);
    return r ? r.promise : Promise.resolve();
  }
  textureEntry(url) {
    if (!this.ok || !url) return null;
    let r = this.textures.get(url);
    if (!r) {
      r = { dropped: false, tex: null, err: '', pending: true, promise: null };
      this.textures.set(url, r);
      this.pendingTextures++;
      r.promise = S.rt.burnView.loadPreviewTexture(url).then((t) => { if (r.dropped) t.destroy(true); else r.tex = t; }, (e) => { r.err = String((e && e.message) || e); })
        .finally(() => { r.pending = false; this.pendingTextures--; requestDraw(); });
    }
    return r;
  }
  textureError(url) {
    const r = url && this.textures.get(url);
    return r ? r.err : '';
  }
  /** 放掉不再用的纹理（场景背景每次开都是新地址）。先让舞台不再引用它（绑定已销毁的纹理 = 那一帧抛错），再卸载 */
  dropTexture(url) {
    const r = this.textures.get(url);
    if (!r) return;
    this.textures.delete(url);
    r.dropped = true;
    if (this.bg && this.bg.tex === r.tex) this.bg = null;
    if (this.ok) this.stage.forgetTexture(r.tex);
    if (r.tex) r.tex.destroy(true);
  }

  /** 这一帧的背景（没调 = 这一帧没有背景） */
  background(url, w, h) {
    const tex = url ? this.texture(url) : null;
    this.bg = tex ? { tex, w, h, url } : null;
  }

  /** 热点实例（原画视图的那张图 / 场景视图里的热点）：`def` = 热点摆放字段 + 展示图（模板图与世界尺寸） */
  hotspot(key, def, url, burn, perspective) {
    const tex = this.texture(url);
    if (!tex) return false;
    this.items.push({ key, kind: 'hotspot', def, texture: tex, perspective: perspective || null, burn, url });
    return true;
  }

  /** 按实例帧平贴的实例（场景视图里的 NPC） */
  framed(key, frame, url, burn) {
    const tex = this.texture(url);
    if (!tex) return false;
    this.items.push({ key, kind: 'frame', frame, texture: tex, burn, url });
    return true;
  }

  end() {
    if (!this.ok) return;
    try {
      this.stage.setBackground(this.bg ? this.bg.tex : null, this.bg ? this.bg.w : 0, this.bg ? this.bg.h : 0);
      this.stage.setScreen(this.cssWidth, this.cssHeight);
      this.stage.sync(this.items, performance.now());
      this.host.render(this.stage.root);
      this.err = this.host.lastError ? `GPU：${this.host.lastError}` : '';
    } catch (e) {
      this.err = `着色预览这一帧画坏了：${(e && e.message) || e}`;
    }
  }

  /** 只留下 key 满足条件的实例（切视图 / 关场景时放掉另一个视图的燃烧着色资源） */
  retain(keep) {
    if (this.ok) this.stage.retain(keep);
  }

  /** 这个实例此刻挂着燃烧着色吗（自检用） */
  burning(key) {
    return this.ok && this.stage.burning(key);
  }

  /** 读一个屏幕 CSS 点的像素 `[r, g, b, a]`（异步：RHI 纹理回读最近一次画出的画面，不经上屏 / 合成） */
  readPixel(cx, cy) {
    return this.ok ? this.host.readPixel(cx, cy) : Promise.resolve([0, 0, 0, 0]);
  }
}
