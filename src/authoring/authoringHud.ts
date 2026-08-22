import './authoring-overlay.css';

import { CHARACTER_HEIGHT_WU } from '../rendering/lighting/lightPacking';
import type { Vec3 } from './lightSpace';

/**
 * 运行时编辑模式的画面 HUD（DOM）。只读显示，**不吃指针事件**——
 * 所有操作都在 canvas 上，HUD 一旦可点就会挡住底下那盏灯。
 *
 * 参数表刻意不在这儿重做一遍：强度/色温/range/锥角那一整套仍在 F2「光影」页，
 * 两边同一份 `sceneLighting.params`，改哪边都立刻反映到画面上。
 */

export interface AuthoringHudSelection {
  id: string;
  kind: string;
  heightWu: number;
  world: Vec3;
  /**
   * 形状参数的读数（聚光/面光才有）。画面上拖的同时要能看见**数** ——
   * 「大概这么大」在两台机器上不是同一个值，交接的时候得说得出来。
   */
  shape?: string | null;
}

export interface AuthoringHudState {
  sceneId: string;
  /** 可摆的灯数（不含 directional——日月没有位置） */
  placeableCount: number;
  directionalCount: number;
  selected: AuthoringHudSelection | null;
  /** 有摆过、还没被编辑器拉走的改动 */
  pending: boolean;
  /** 与编辑器的同步状态（一行）。断线要一眼看得见——"以为在同步"是最贵的坏。 */
  syncStatus: string;
  /** 最近一次操作的反馈 */
  message: string | null;
  messageIsError: boolean;
}

const KEYS = [
  '拖灯 = 沿地面移动（保持高度） · 拖顶部方块 = 只改高度 · Shift 精调',
  '聚光：拖十字靶点 = 改照射方向 · 拖锥口实心点 = 外角、空心点 = 内角',
  '面光：拖方块 = 宽/高 · 拖空心圆 = 自转 · 拖白菱形 = 换朝向（单面光背面不发光）',
  '中键/空格拖 = 平移视角 · 滚轮 = 缩放 · F = 聚焦选中',
  'Ctrl+N 新建点光 · Delete 删除 · Ctrl+Z 撤销 · Esc 退出',
].join('\n');

/** 用"几个人高"给高度一个能对着画面估的读数（角色高 150 wu，28 个场景恒定）。 */
function heightLabel(wu: number): string {
  return `${wu.toFixed(0)} wu（≈${(wu / CHARACTER_HEIGHT_WU).toFixed(2)} 个人高）`;
}

export class AuthoringHud {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLParagraphElement;
  private readonly scene: HTMLSpanElement;
  private readonly dirtyMark: HTMLSpanElement;
  private readonly body: HTMLParagraphElement;
  private readonly sync: HTMLParagraphElement;
  private readonly msg: HTMLParagraphElement;

  constructor(mount: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'authoring-hud';

    this.title = document.createElement('p');
    this.title.className = 'authoring-hud__title';
    this.title.appendChild(document.createTextNode('编辑模式 · 灯'));
    this.scene = document.createElement('span');
    this.scene.className = 'authoring-hud__scene';
    this.title.appendChild(this.scene);
    this.dirtyMark = document.createElement('span');
    this.dirtyMark.className = 'authoring-hud__dirty';
    this.title.appendChild(this.dirtyMark);
    this.root.appendChild(this.title);

    this.body = document.createElement('p');
    this.body.className = 'authoring-hud__row';
    this.root.appendChild(this.body);

    this.sync = document.createElement('p');
    this.sync.className = 'authoring-hud__sync';
    this.root.appendChild(this.sync);

    this.msg = document.createElement('p');
    this.msg.className = 'authoring-hud__msg';
    this.root.appendChild(this.msg);

    const keys = document.createElement('p');
    keys.className = 'authoring-hud__muted';
    keys.textContent = KEYS;
    this.root.appendChild(keys);

    const warn = document.createElement('p');
    warn.className = 'authoring-hud__warn';
    // 游戏侧不写盘（工程只能有一个写盘出口）——人得知道东西最后从哪落盘。
    warn.textContent = '⚠ 本模式不写盘。摆好后去编辑器：场景页 → 统一光影 →「从运行时拉取灯位」，'
      + '再 Save All。切场景 / 放弃退出会把还没拉走的改动丢掉。';
    this.root.appendChild(warn);

    mount.appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('is-visible', visible);
  }

  update(state: AuthoringHudState): void {
    this.scene.textContent = state.sceneId || '(无场景)';
    this.dirtyMark.textContent = state.pending ? '● 待拉取' : '';

    const lines: string[] = [
      `灯 ${state.placeableCount} 盏可摆`
      + (state.directionalCount > 0 ? ` · ${state.directionalCount} 盏平行光（无位置，不在画面上）` : ''),
    ];
    if (state.selected) {
      const s = state.selected;
      lines.push(`选中 ${s.id} [${s.kind}]`);
      lines.push(`离地 ${heightLabel(s.heightWu)}`);
      lines.push(`pos [${s.world.map((v) => v.toFixed(1)).join(', ')}]`);
      if (s.shape) lines.push(s.shape);
    } else {
      lines.push('未选中（点画面上的灯选中；点空白取消）');
    }
    this.body.textContent = lines.join('\n');

    this.sync.textContent = state.syncStatus || '';
    this.sync.classList.toggle('is-bad', state.syncStatus.startsWith('⚠'));
    this.msg.textContent = state.message ?? '';
    this.msg.classList.toggle('is-error', state.messageIsError);
  }

  destroy(): void {
    this.root.remove();
  }
}
