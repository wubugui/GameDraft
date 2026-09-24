/**
 * 动作「串」：同一件事引出的全部动作——一批、它嵌套的容器、它开出去的脱手演出、一整段过场——
 * 共用一个串 id，最后一处占用放掉时发一次「这一串结束了」。
 *
 * **只给旁听者用**（世界脑靠它把一张雷符引出的压暗、闷雷、闪白、落雷拼成一件事，
 * 按"串结束"判事平息，不靠时间窗口去猜）。执行语义一概不看它：串随执行作用域
 * （`ActionExecScope.run`）显式线程化，与来源上下文同一个理由——不用共享栈。
 */

/** 这一串是谁起的头。`kind` 是来源的种类，`id` 是那个来源自己的 id（物品 id、热区 id、过场 id…）。 */
export interface ActionRunInitiator {
  /**
   * `item`（背包里用物品）/ `rule` / `shop` / `mapTravel` / `cutscene` / `zone` / `signalCue` /
   * `playerAction` / `encounter` / `day` / `health` / `pressureHold` / `debug`，
   * 或来源上下文里的叙事 owner 种类（`hotspot` / `npc` / `quest` / `scene` / `minigame` / 叙事图 owner…）；
   * 说不上来的是 `unknown`。
   */
  readonly kind: string;
  readonly id?: string;
}

export interface ActionRunInfo {
  /** 本局内递增，不进存档；只拿来分串，不拿来排序以外的任何事 */
  readonly id: number;
  readonly initiator: ActionRunInitiator;
}

export interface ActionRunEnd {
  readonly run: ActionRunInfo;
  /** 中途被收掉（脱手演出被打断 / 死亡读档作废剩下的动作 / 过场被跳过），不是自然走完 */
  readonly interrupted: boolean;
}

const UNKNOWN_INITIATOR: ActionRunInitiator = Object.freeze({ kind: 'unknown' });

/**
 * 占用计数：每一处还在跑这一串的地方（批、单条动作、脱手演出会话、过场）各占一份，
 * 最后一份放掉就是这一串结束。放掉之后又被占（极少见：谁把作用域留着晚些再用）＝同一串重新开张，
 * 再放完再发一次结束——对旁听者就是"这件事又冒了一下"。
 */
export class ActionRun implements ActionRunInfo {
  readonly id: number;
  readonly initiator: ActionRunInitiator;
  private holds = 0;
  private cut = false;
  private readonly onEnd: (end: ActionRunEnd) => void;

  constructor(id: number, initiator: ActionRunInitiator | undefined, onEnd: (end: ActionRunEnd) => void) {
    this.id = id;
    this.initiator = initiator ?? UNKNOWN_INITIATOR;
    this.onEnd = onEnd;
  }

  /** 占住这一串。返回的放手函数**幂等**（finally 里放、异常里再放一次都无妨）。 */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      if (this.holds > 0) return;
      const interrupted = this.cut;
      this.cut = false;
      this.onEnd({ run: this, interrupted });
    };
  }

  /** 标记这一串是被收掉的（下一次结束通知带 `interrupted: true`） */
  markInterrupted(): void {
    this.cut = true;
  }

  /** 还有没有地方在跑它（测试 / 调试用） */
  get active(): boolean {
    return this.holds > 0;
  }
}

/** 从来源上下文推发起方：zone 优先（进出区域是它起的头），其次叙事 owner。 */
export function initiatorFromOrigin(
  origin: { zoneId?: string; ownerType?: string; ownerId?: string } | null | undefined,
): ActionRunInitiator | undefined {
  if (!origin) return undefined;
  const zone = String(origin.zoneId ?? '').trim();
  if (zone) return { kind: 'zone', id: zone };
  const kind = String(origin.ownerType ?? '').trim();
  if (!kind) return undefined;
  const id = String(origin.ownerId ?? '').trim();
  return id ? { kind, id } : { kind };
}
