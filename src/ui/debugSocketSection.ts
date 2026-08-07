import { Rectangle, Sprite, Texture } from 'pixi.js';
import type { AssetManager } from '../core/AssetManager';
import type { SpriteEntity } from '../rendering/SpriteEntity';
import type { DebugSectionContent } from './DebugPanelUI';
import type { SocketFramePose, SocketSetDef } from '../data/types';
import type { SocketAttachment } from '../rendering/SpriteEntity';
import { propPresetImages, type PropPresetTable } from '../data/propPresets';

/**
 * F2「挂点」页：不写盘就能把挂点系统跑起来看一眼。
 *
 * 存在的理由：sockets.json 是人工逐帧标的，**现在一个包都还没标**，
 * 所以"挂上去看看对不对"这件事在没有本页之前根本做不了——只能先花几小时标完再看。
 * 本页注入一个**内存里的临时挂点**（覆盖全部图集槽位、不落盘），
 * 于是位姿/镜像/前后/透视/跳跃跟随这些几何当场就能目验。
 */

const TEMP_SOCKET = '__debug_temp__';

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 预设挂件：都用仓库里现成的图，不新增素材 */
const PROP_PRESETS: { label: string; url: string }[] = [
  { label: '桃木剑', url: '/resources/runtime/images/icons/taomu_sword.png' },
  { label: '灯笼', url: '/resources/runtime/images/ui/icons/lantern.png' },
  { label: '伞', url: '/resources/runtime/images/ui/icons/umbrella.png' },
  { label: '符', url: '/resources/runtime/images/icons/talisman.png' },
];

/** 多帧挂件：从鸡的图集裁一串格子，演示「挂点驱动帧号」——手上的鸡随角色帧扑腾 */
const CHICKEN_ATLAS = '/resources/runtime/animation/chicken_anim/atlas.png';
const CHICKEN_GRID = { cols: 8, rows: 9, cellW: 243, cellH: 227 };
/** 取 wing_flap 那一行的前 6 格（够看出在动就行） */
const CHICKEN_SLOTS = [24, 25, 26, 27, 28, 29];

export interface DebugSocketDeps {
  assetManager: AssetManager;
  /** 重渲染本区块（选挂点后要刷新高亮与读数） */
  refresh: () => void;
  /** 当前要试挂的目标精灵；没有（未加载/无场景）返回 null */
  getTargetSprite: () => SpriteEntity | null;
  /** 目标名（读数里显示） */
  getTargetLabel: () => string;
  /** 工程里登记的挂件预设（prop_presets.json）——按预设挂才是内容真正走的那条路 */
  getPropPresets: () => PropPresetTable;
  log: (message: string) => void;
}

interface TempState {
  x: number;
  y: number;
  angle: number;
  front: boolean;
  injected: boolean;
  /** 已挂上去的显示对象，卸载时要 destroy（纹理留给 AssetManager 缓存） */
  view: Sprite | null;
  propLabel: string;
  /**
   * 往哪个挂点上挂。**默认挂真挂点**——临时挂点是恒定位姿，
   * 拿它测"逐帧标注动没动"永远是静止的（2026-08-04 实测踩到）。
   */
  target: string;
  lit: boolean;
  /** 挂件参数：调好了直接抄进 attachToSocket 的 params */
  propScale: number;
  anchorX: number;
  anchorY: number;
  rotation: number;
  /** 当前挂着的那个 attachment 对象；改它的字段 SpriteEntity 下一帧就吃到，不用重挂 */
  live: SocketAttachment | null;
}

export interface DebugSocketSectionHandle {
  build: () => DebugSectionContent;
  /** 面板销毁/切场景时收干净 */
  dispose: () => void;
}

export function createDebugSocketSection(deps: DebugSocketDeps): DebugSocketSectionHandle {
  const st: TempState = {
    x: 0.68, y: 0.45, angle: 0, front: true, injected: false, view: null, propLabel: '',
    target: '', lit: true,
    propScale: 0.5, anchorX: 0.5, anchorY: 0.5, rotation: 0, live: null,
  };

  /** 当前要挂的挂点：优先用户选的真挂点，其次包里第一个，最后才落到临时挂点 */
  function activeSocket(sprite: SpriteEntity): string {
    const real = sprite.listSocketNames().filter((n) => n !== TEMP_SOCKET);
    if (st.target && (st.target === TEMP_SOCKET || real.includes(st.target))) return st.target;
    return real[0] ?? TEMP_SOCKET;
  }

  /**
   * 造一份覆盖全部槽位的临时挂点集：每一帧都有标注，所以随便播哪个动作都看得见。
   *
   * **在已标挂点之上叠加，不替换**——`setSockets` 是整份替换语义，直接塞一份只含临时挂点的
   * 集合会把包里真标好的挂点从运行内存里抹掉（页面上表现为"本包还没有 sockets.json"，
   * 而且真挂件当场掉线）。所以这里先把现有的抄下来再加一个。
   */
  function buildTempSockets(sprite: SpriteEntity): SocketSetDef {
    const slots = sprite.debugAtlasSlotCount();
    const poses: Record<string, SocketFramePose> = {};
    for (let i = 0; i < Math.max(1, slots); i++) {
      const pose: SocketFramePose = { x: st.x, y: st.y };
      if (st.angle !== 0) pose.angle = st.angle;
      if (st.front) pose.front = true;
      // 帧号跟着槽位走：多帧挂件（鸡）于是会随角色动画一起翻页
      pose.frame = i;
      poses[String(i)] = pose;
    }
    const existing = sprite.debugSocketSet();
    return {
      schemaVersion: 1,
      atlas: sprite.debugAtlasFingerprint(),
      sockets: {
        ...(existing?.sockets ?? {}),
        [TEMP_SOCKET]: { label: '调试临时挂点', poses },
      },
    };
  }

  function reinject(): void {
    const sprite = deps.getTargetSprite();
    if (!sprite) return;
    // stale=false：指纹就是从这个精灵现取的，必然对得上
    sprite.setSockets({ set: buildTempSockets(sprite), stale: false });
    st.injected = true;
  }

  function detach(): void {
    const sprite = deps.getTargetSprite();
    if (sprite) for (const n of [...sprite.listSocketNames(), TEMP_SOCKET]) sprite.detachFromSocket(n);
    if (st.view) {
      st.view.destroy({ children: true });
      st.view = null;
    }
    st.live = null;
    st.propLabel = '';
  }

  async function attachProp(label: string, urls: string[]): Promise<void> {
    const sprite = deps.getTargetSprite();
    if (!sprite) {
      deps.log('挂点调试：当前没有可挂的目标');
      return;
    }
    const socket = activeSocket(sprite);
    if (socket === TEMP_SOCKET && !st.injected) reinject();
    detach();
    const textures: Texture[] = [];
    for (const u of urls) {
      try {
        textures.push(await deps.assetManager.loadTexture(u));
      } catch (e) {
        deps.log(`挂点调试：贴图加载失败 ${u} — ${String(e)}`);
      }
    }
    if (textures.length === 0) return;
    const view = new Sprite(textures[0]);
    view.anchor.set(0.5, 0.5);
    st.view = view;
    st.propLabel = label;
    const at: SocketAttachment = {
      view,
      frameTextures: textures.length > 1 ? textures : undefined,
      scale: st.propScale,
      anchorX: st.anchorX,
      anchorY: st.anchorY,
      rotationOffsetDeg: st.rotation,
      lit: st.lit,
    };
    st.live = at;
    sprite.attachToSocket(socket, at);
    deps.log(`挂点调试：已挂「${label}」到挂点 ${socket}`);
  }

  /**
   * 按工程里的挂件预设挂——与 attachToSocket 的 prop 参数同一条路。
   * 上面那几个 `挂桃木剑` 用的是硬编码 demo 图，验的是几何；
   * 这个验的是**策划在「挂件预设」页调的那组数进游戏对不对**。
   */
  async function attachPreset(id: string): Promise<void> {
    const def = deps.getPropPresets()[id];
    if (!def) {
      deps.log(`挂点调试：挂件预设「${id}」不在 prop_presets.json 里`);
      return;
    }
    const urls = propPresetImages(def);
    if (urls.length === 0) {
      deps.log(`挂点调试：挂件预设「${id}」还没配贴图`);
      return;
    }
    // 预设值同步进滑条，于是"挂上来 → 接着微调 → 抄回编辑器"是连着的
    st.propScale = def.scale ?? 1;
    st.anchorX = def.anchorX ?? 0.5;
    st.anchorY = def.anchorY ?? 0.5;
    st.rotation = def.rotation ?? 0;
    st.lit = def.lit !== false;
    await attachProp(def.label || id, urls);
  }

  /** 从鸡的图集裁格子当多帧挂件（第二档演示） */
  async function attachChicken(): Promise<void> {
    let base: Texture;
    try {
      base = await deps.assetManager.loadTexture(CHICKEN_ATLAS);
    } catch (e) {
      deps.log(`挂点调试：鸡图集加载失败 — ${String(e)}`);
      return;
    }
    const sprite = deps.getTargetSprite();
    if (!sprite) return;
    const socket = activeSocket(sprite);
    if (socket === TEMP_SOCKET && !st.injected) reinject();
    detach();
    const { cols, cellW, cellH } = CHICKEN_GRID;
    const frames = CHICKEN_SLOTS.map((slot) => new Texture({
      source: base.source,
      frame: new Rectangle((slot % cols) * cellW, Math.floor(slot / cols) * cellH, cellW, cellH),
    }));
    const view = new Sprite(frames[0]);
    view.anchor.set(0.5, 0.5);
    st.view = view;
    st.propLabel = '鸡（多帧）';
    const at: SocketAttachment = {
      view, frameTextures: frames,
      scale: st.propScale, anchorX: st.anchorX, anchorY: st.anchorY,
      rotationOffsetDeg: st.rotation, lit: st.lit,
    };
    st.live = at;
    sprite.attachToSocket(socket, at);
    deps.log('挂点调试：已挂「鸡」——帧号由挂点标注驱动，不是它自己的时钟');
  }

  function slider(
    label: string, min: number, max: number, step: number,
    get: () => number, set: (v: number) => void,
    reinjectOnChange = true,
  ): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0;';
    const name = document.createElement('span');
    name.textContent = label;
    name.style.cssText = 'min-width:44px;opacity:.8;';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(get());
    input.style.flex = '1';
    const val = document.createElement('span');
    val.textContent = get().toFixed(2);
    val.style.cssText = 'min-width:48px;text-align:right;';
    input.addEventListener('input', () => {
      const v = Number(input.value);
      set(v);
      val.textContent = v.toFixed(2);
      // 临时挂点的位姿要重注入才生效；挂件参数走 live 引用，已在 set 里改完，这里不重复
      if (st.injected && reinjectOnChange) reinject();
    });
    row.appendChild(name);
    row.appendChild(input);
    row.appendChild(val);
    return row;
  }

  function build(): DebugSectionContent {
    const sprite = deps.getTargetSprite();
    const lines: string[] = [`目标：${deps.getTargetLabel()}`];
    if (!sprite) {
      return { text: `${lines[0]}\n（精灵未就绪）` };
    }
    const real = sprite.listSocketNames().filter((n) => n !== TEMP_SOCKET);
    const socket = activeSocket(sprite);
    lines.push(real.length
      ? `本包已标挂点：${real.join('、')}`
      : '本包还没有 sockets.json（正常——挂点是人工在动画编辑器里逐帧标的）');
    lines.push(`当前挂到：${socket === TEMP_SOCKET ? '临时挂点（恒定位姿，测不出逐帧动没动）' : socket}`);
    if (st.propLabel) lines.push(`挂着：${st.propLabel}　光照：${st.lit ? '吃' : '不吃（自发光）'}`);

    const pose = sprite.getSocketPose(socket);
    if (pose) {
      lines.push(
        `当前槽位 #${sprite.debugCurrentAtlasSlot() ?? '—'}　`
        + `局部 x=${pose.x.toFixed(1)} y=${pose.y.toFixed(1)}　`
        + `角度 ${pose.angleDeg.toFixed(0)}°　`
        + `${pose.front ? '身前' : '身后'}　朝向 ${pose.facing > 0 ? '右' : '左'}　`
        + `透视 ×${pose.scale.toFixed(2)}`,
      );
    }

    const extra = document.createElement('div');
    // 挂点选择：真挂点在前，临时挂点垫底
    const pick = document.createElement('div');
    pick.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 6px;';
    for (const name of [...real, TEMP_SOCKET]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = name === TEMP_SOCKET ? '临时挂点' : name;
      b.style.cssText = `padding:2px 8px;${name === socket ? 'outline:1px solid #ffc454;' : ''}`;
      b.addEventListener('click', () => { st.target = name; deps.refresh(); });
      pick.appendChild(b);
    }
    extra.appendChild(pick);

    // —— 挂件参数：改的是 live attachment 的字段，SpriteEntity 下一帧就吃到，不用重挂 ——
    const propHdr = document.createElement('div');
    propHdr.textContent = '挂件（调好抄进 attachToSocket）';
    propHdr.style.cssText = 'margin:6px 0 2px;opacity:.75;';
    extra.appendChild(propHdr);
    const live = (fn: (a: SocketAttachment) => void) => { if (st.live) fn(st.live); };
    extra.appendChild(slider('缩放', 0.05, 3, 0.01, () => st.propScale,
      (v) => { st.propScale = v; live((a) => { a.scale = v; }); }, false));
    extra.appendChild(slider('支点x', 0, 1, 0.01, () => st.anchorX,
      (v) => { st.anchorX = v; live((a) => { a.anchorX = v; }); }, false));
    extra.appendChild(slider('支点y', 0, 1, 0.01, () => st.anchorY,
      (v) => { st.anchorY = v; live((a) => { a.anchorY = v; }); }, false));
    extra.appendChild(slider('自转', -180, 180, 1, () => st.rotation,
      (v) => { st.rotation = v; live((a) => { a.rotationOffsetDeg = v; }); }, false));

    // 抄走用：调好的参数直接就是 action 的 params
    const snip = document.createElement('div');
    snip.style.cssText = 'margin:6px 0 2px;opacity:.75;';
    snip.textContent = 'params: '
      + JSON.stringify({
        socket, scale: round2(st.propScale), anchorX: round2(st.anchorX),
        anchorY: round2(st.anchorY), rotation: Math.round(st.rotation),
        ...(st.lit ? {} : { lit: false }),
      });
    extra.appendChild(snip);

    const tmpHdr = document.createElement('div');
    tmpHdr.textContent = '临时挂点位姿（只影响临时挂点）';
    tmpHdr.style.cssText = 'margin:6px 0 2px;opacity:.55;';
    extra.appendChild(tmpHdr);
    extra.appendChild(slider('x', 0, 1, 0.01, () => st.x, (v) => { st.x = v; }));
    extra.appendChild(slider('y', 0, 1, 0.01, () => st.y, (v) => { st.y = v; }));
    extra.appendChild(slider('角度', -180, 180, 1, () => st.angle, (v) => { st.angle = v; }));

    const presetIds = Object.keys(deps.getPropPresets());
    const actions: { label: string; fn: () => void; noRefresh?: boolean }[] = [
      { label: st.injected ? '重注入临时挂点' : '注入临时挂点', fn: () => reinject() },
      // 工程里真有的挂件预设排在前面——它们才是内容侧会用的东西
      ...presetIds.map((id) => ({
        label: `预设：${deps.getPropPresets()[id]?.label || id}`,
        fn: () => { void attachPreset(id); },
      })),
      ...PROP_PRESETS.map((p) => ({
        label: `挂${p.label}`,
        fn: () => { void attachProp(p.label, [p.url]); },
      })),
      { label: '挂鸡（多帧）', fn: () => { void attachChicken(); } },
      {
        label: st.front ? '临时挂点改身后' : '临时挂点改身前',
        fn: () => { st.front = !st.front; if (st.injected) reinject(); },
      },
      {
        label: st.lit ? '改成不吃光照' : '改成吃光照',
        fn: () => { st.lit = !st.lit; },
      },
      { label: '卸下', fn: () => detach() },
    ];
    return { text: lines.join('\n'), actions, extra };
  }

  return {
    build,
    dispose: () => {
      detach();
      // 临时挂点是内存注入的，切场景/重载动画包会自然消失；这里只收显示对象
      st.injected = false;
    },
  };
}
