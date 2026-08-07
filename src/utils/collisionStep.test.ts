import { stepWithCollision } from './collisionStep';

/** x >= 100 的半平面是墙。 */
const wallAtX100 = (x: number, _y: number) => x >= 100;
/** y >= 100 的半平面是墙。 */
const wallAtY100 = (_x: number, y: number) => y >= 100;

describe('stepWithCollision', () => {
  it('未注入碰撞判据时两轴无条件推进（既有 NPC 的现状行为）', () => {
    expect(stepWithCollision(0, 0, 3, 4, null)).toEqual({ x: 3, y: 4, moved: true });
    expect(stepWithCollision(0, 0, 3, 4, undefined)).toEqual({ x: 3, y: 4, moved: true });
  });

  it('零位移不算 moved —— 否则站着不动会把卡住计时器一直清零', () => {
    expect(stepWithCollision(5, 5, 0, 0, null)).toEqual({ x: 5, y: 5, moved: false });
  });

  it('单轴被挡时另一轴照走（贴墙滑行，不是整体停死）', () => {
    // 斜向撞 x=100 的墙：X 被挡、Y 仍推进
    const r = stepWithCollision(99, 0, 5, 5, wallAtX100);
    expect(r).toEqual({ x: 99, y: 5, moved: true });

    // 换一面墙，反过来同理
    const r2 = stepWithCollision(0, 99, 5, 5, wallAtY100);
    expect(r2).toEqual({ x: 5, y: 99, moved: true });
  });

  it('两轴都被挡时 moved=false —— 调用方据此封口 Promise', () => {
    const corner = (x: number, y: number) => x >= 100 || y >= 100;
    expect(stepWithCollision(99, 99, 5, 5, corner)).toEqual({ x: 99, y: 99, moved: false });
  });

  it('Y 轴以**已提交的** X 为基准判定（拐出墙角后同一帧就能走 Y，不多挡一帧）', () => {
    // 只有 (0,*) 这一列在 y>=10 时是墙；x 推进到 5 之后该列的限制就不适用了。
    const narrowWall = (x: number, y: number) => x < 1 && y >= 10;
    // 从 (0,9) 斜向走：X 先推进到 5，Y 再判定时用的是 x=5（不是 x=0），故 Y 可通过。
    expect(stepWithCollision(0, 9, 5, 5, narrowWall)).toEqual({ x: 5, y: 14, moved: true });
    // 反证：若 Y 用原点 x=0 判定，会被 narrowWall 挡住而停在 y=9（多挡一帧，走起来发涩）。
    // 与 Player.update 同基准，两边一致。
  });

  it('moved 判的是"坐标真变了"，不是"判据没拦"', () => {
    // 这条是回归锚：早先版本把 moved 写成"任一轴没被拦"，导致斜向贴墙滑行时恒为 true，
    // 依赖它兜底的 moveTo Promise 永不封口。
    const wall = (x: number, _y: number) => x >= 100;
    // X 被墙拦下、Y 的步长是 0 → 坐标一点没变 → 必须是 false
    expect(stepWithCollision(99, 50, 5, 0, wall)).toEqual({ x: 99, y: 50, moved: false });
  });

  it('一轴被挡、另一轴自由时 moved=true（贴墙滑行仍在动）', () => {
    // 提醒：这里 moved 名副其实为 true，但实体离"墙那边的目标"并没有更近多少。
    // 谁要判"走不走得到"，判据必须在推进量上，不能是这个布尔。
    const wall = (x: number, _y: number) => x >= 100;
    const r = stepWithCollision(99.7, 0, 5, 5, wall);
    expect(r.x).toBe(99.7);
    expect(r.y).toBe(5);
    expect(r.moved).toBe(true);
  });

  it('只有被挡的那一轴保持原值，不会被写成 NaN 或回退', () => {
    const r = stepWithCollision(50, 50, -80, 10, (x) => x < 0);
    expect(r.x).toBe(50);
    expect(r.y).toBe(60);
    expect(r.moved).toBe(true);
  });
});

describe('回归锚：未注入碰撞时与朴素积分**逐位相同**', () => {
  /**
   * 自行走位（`Npc.steerBy` / 将来收编的 `Player.update`）在**没有**碰撞判据时，
   * 必须与朴素的 `x += stepX` / `y += stepY` 浮点结果**逐位**一致（不是"近似相等"）——
   * 差一个 ulp 累积几百帧就是可见的走位偏移。
   */
  const oldFormula = (x: number, y: number, sx: number, sy: number) => ({ x: x + sx, y: y + sy });

  it('多段折线 + 透视步长补偿下逐帧比对，坐标位级相同', () => {
    const segments = [
      { tx: 733.17, ty: 412.9, speed: 61.3 },
      { tx: 120.05, ty: 908.44, speed: 24 },
      { tx: -55.5, ty: 3.14159, speed: 137.77 },
      { tx: 0, ty: 0, speed: 47.5 },
    ];
    let ax = 13.7, ay = -8.25;   // 新实现
    let bx = 13.7, by = -8.25;   // 改动前公式
    const dt = 1 / 60;

    for (const seg of segments) {
      for (let i = 0; i < 400; i++) {
        // 透视系数逐帧变化（affectsSpeed 场景），把补偿也纳入比对
        const f = 0.35 + 0.6 * Math.abs(Math.sin((ay + i) / 97));
        const step = seg.speed * f * dt;

        const adx = seg.tx - ax, ady = seg.ty - ay;
        const adist = Math.sqrt(adx * adx + ady * ady);
        if (adist <= step) break;
        const a = stepWithCollision(ax, ay, (adx / adist) * step, (ady / adist) * step, null);
        ax = a.x; ay = a.y;

        const bdx = seg.tx - bx, bdy = seg.ty - by;
        const bdist = Math.sqrt(bdx * bdx + bdy * bdy);
        const b = oldFormula(bx, by, (bdx / bdist) * step, (bdy / bdist) * step);
        bx = b.x; by = b.y;

        // toBe 是 Object.is：位级相同，不是 toBeCloseTo
        expect(ax).toBe(bx);
        expect(ay).toBe(by);
      }
    }
  });

  it('负步长 / 极小步长 / 零步长下同样逐位相同', () => {
    const cases: Array<[number, number, number, number]> = [
      [0, 0, -1e-12, 1e-12],
      [1e15, -1e15, 1, -1],
      [7.7, 7.7, 0, 0],
      [-0.1, 0.3, -0.30000000000000004, 0.1],
    ];
    for (const [x, y, sx, sy] of cases) {
      const a = stepWithCollision(x, y, sx, sy, null);
      const b = oldFormula(x, y, sx, sy);
      expect(a.x).toBe(b.x);
      expect(a.y).toBe(b.y);
    }
  });
});
