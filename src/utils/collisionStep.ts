/**
 * 分轴碰撞推进：自行走位实体（玩家 / 跟随中的同伴）每帧位移的唯一算法。
 *
 * 为什么分轴而不是整体判定：整体判定在斜向撞墙时会**整体停死**，玩家表现为"贴着墙就
 * 一动不动"；分轴判定下被挡的那一轴不动、另一轴照走，就是熟悉的"贴墙滑行"手感。
 * 分轴基准与 `Player.update` 一致（Y 轴用**已提交的** X 判定）。
 *
 * **只服务"自行走位"这一类路径**（`Player.update` 的自由移动、`Npc.steerBy` 的跟随），
 * 编排位移（`moveTo` / `jumpTo`）与瞬移一律不吃碰撞 —— 2026-08-06 拍板与 Player 对齐，
 * 否则 `'player'` 变成受控者别名后，同一条 `moveEntityTo` 会因"当前受控的是谁"而表现不同。
 *
 * ⚠ `moved` 只说明这一帧挪了，**不代表离某个目标更近了**（贴墙斜向滑行时两者会背离：
 * 坐标每帧都变，距离却只在渐近收敛）。要判"走不走得到"必须另用推进量判据，别用这个布尔。
 *
 * ⚠ 尚未收编 `Player.update`：Player 每轴还额外判 `isOutOfBounds`（世界边界）。
 * 收编要等受控角色槽（P1）落地后一次性做，届时删掉本注释。
 * **在那之前不要声称"两边已统一"。**
 */

/** 世界坐标上的碰撞判据：该点是否不可站立。 */
export type CollisionPredicate = (worldX: number, worldY: number) => boolean;

export interface CollisionStepResult {
  x: number;
  y: number;
  /**
   * 坐标**是否真的变了**（不是"判据有没有拦"）。
   *
   * 两者的区别是踩过的坑：早先版本把它写成"任一轴没被拦"，结果斜向贴墙滑行时
   * 恒为 true，依赖它兜底的 Promise 永不封口。要判"走不走得到"，用调用方的推进量判据，
   * 不要用这个布尔。
   */
  moved: boolean;
}

/**
 * @param collides 缺省 / null = 不参与碰撞，两轴无条件推进（既有 NPC 的现状行为）
 */
export function stepWithCollision(
  x: number,
  y: number,
  stepX: number,
  stepY: number,
  collides?: CollisionPredicate | null,
): CollisionStepResult {
  let nx = x;
  let ny = y;

  // 逐轴以**已提交的**坐标为基准试探（先 X 后 Y）：X 走成了，Y 就在新的 X 上判定，
  // 这样贴着斜墙滑行才连续。两轴都拿原点判定会在拐角处多挡一帧、走起来发涩。
  if (stepX !== 0 && !(collides?.(x + stepX, y) ?? false)) {
    nx = x + stepX;
  }
  if (stepY !== 0 && !(collides?.(nx, y + stepY) ?? false)) {
    ny = y + stepY;
  }

  return { x: nx, y: ny, moved: nx !== x || ny !== y };
}
