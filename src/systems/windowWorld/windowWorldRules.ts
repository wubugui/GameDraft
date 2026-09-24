/**
 * 窥夜的 gameplay 规则层 —— **窗与主世界之间唯一的出口，且是单向的**。
 *
 * 窗里的实体不驱动任何玩法：是本层在**外面**算「谁落在楔形里、看了多久」，再把结果
 * 送进主世界既有的通道。窗里的东西永远拿不到写存档的权力，不是靠它自觉，是
 * **结构上没有那条路**（玩法清单 F.5）。
 *
 * 三条出口，全部复用现成机制、不另立数值：
 *
 * 1. **阳气损耗** → `HealthSystem.applyDamage({kind:'yin'})`，照走防护与死亡系绳。
 * 2. **三把火显现** → 与「进入阴间威胁范围」同一个显示请求（G.5：开窗即过界）。
 * 3. **它记住你了** → `emitNarrativeSignal`。⚠ 这里**绝不写 flag**：进度/门控/"做过没有"
 *    一律走叙事状态机（编排铁律，有 hook 强制拦）。
 *
 * ## 信号名怎么来
 *
 * 代码里不出现任何具体实体名（架构铁律 4：数据驱动）。发出去的是
 * `<rememberSignalPrefix>:<实体 id>` 这种**派生信号**——与叙事脊椎里
 * `state:<图id>:<末态>` 的派生法同构，内容侧在叙事图里监听它。
 * 前缀是数据，缺省只是个中性 token。
 */

/** 作者可配的规则（编辑器写、法宝数据带）。 */
export interface WindowWorldRules {
  /** 被至少一只对面的东西看着时，每秒扣多少阳气。0 = 不扣。 */
  drainPerSecond: number;
  /**
   * 距离衰减：顶点处按满额扣，到楔形远端降到这个倍率。
   * 1 = 不衰减（远近一个样）；0 = 远端完全不扣。
   */
  drainFalloffAtFar: number;
  /** 同一只东西连续看够这么多秒 = 它记住你了，发一次信号。0 = 不发。 */
  rememberSeconds: number;
  /** 派生信号前缀；实发 `<prefix>:<实体 id>`。 */
  rememberSignalPrefix: string;
  /** 扣血的来源 id（防护匹配 / 死亡说明用），内容侧可改。 */
  damageSourceId: string;
}

export const DEFAULT_WINDOW_RULES: WindowWorldRules = {
  drainPerSecond: 2,
  drainFalloffAtFar: 0.25,
  rememberSeconds: 1.5,
  rememberSignalPrefix: 'peek_seen',
  damageSourceId: 'peek_window',
};

/** 本层往主世界发东西的三个口，由 Game 组装层注入。 */
export interface WindowWorldRuleDeps {
  applyYinDamage: (amount: number, sourceId: string) => void;
  emitSignal: (signal: string, entityId: string) => void;
  /** 窗开着 = 过界：与「进入阴间威胁范围」同一个三把火显示请求。 */
  setYinActive: (active: boolean) => void;
}

/** 一只对面实体这一帧的观察结果。 */
export interface SeenSample {
  entityId: string;
  /** 它落在楔形里的程度 0..1（与背景用的是同一个楔形）。 */
  mask: number;
  /** 它到顶点的水平距离（wu），用来算衰减。 */
  distWu: number;
}

export class WindowWorldRuleRunner {
  private readonly deps: WindowWorldRuleDeps;
  private rules: WindowWorldRules = { ...DEFAULT_WINDOW_RULES };
  /** 每只东西被连续看了多久（秒）。离开楔形即归零——"连续"是字面意思。 */
  private seenSeconds = new Map<string, number>();
  /** 已经记住你的那些：一次 fork 生命周期内只发一次信号。 */
  private remembered = new Set<string>();
  private yinActive = false;

  constructor(deps: WindowWorldRuleDeps) {
    this.deps = deps;
  }

  applyRules(partial: Partial<WindowWorldRules>): void {
    this.rules = { ...this.rules, ...partial };
  }

  get current(): Readonly<WindowWorldRules> {
    return this.rules;
  }

  /** 调试 / 取证用：谁被看了多久、谁已经记住你了。 */
  get debugState(): { seen: Record<string, number>; remembered: string[] } {
    return {
      seen: Object.fromEntries([...this.seenSeconds].map(([k, v]) => [k, +v.toFixed(2)])),
      remembered: [...this.remembered],
    };
  }

  /**
   * 推进一帧。`samples` 为空或窗没开时按"没人看你"处理。
   *
   * 扣血取**最厉害的那一只**而不是累加：三只东西一起看着不该是三倍伤害，
   * 那会让"多配几个夜实体"变成难度调节旋钮，与 G.5 按距离与攻击力结算的口径也不合。
   */
  update(dt: number, open: boolean, farWu: number, samples: readonly SeenSample[]): void {
    const active = open && samples.length > 0;
    if (this.yinActive !== active) {
      this.yinActive = active;
      this.deps.setYinActive(active);
    }
    if (!open) {
      // 收窗 = 断开视线：连续计时归零，但"已经记住你"不撤（那是既成事实）。
      this.seenSeconds.clear();
      return;
    }

    let worst = 0;
    const seenThisFrame = new Set<string>();
    for (const s of samples) {
      if (s.mask <= 0.002) continue;
      seenThisFrame.add(s.entityId);
      const t = (this.seenSeconds.get(s.entityId) ?? 0) + dt;
      this.seenSeconds.set(s.entityId, t);

      const far = Math.max(farWu, 1e-6);
      const k = Math.min(1, Math.max(0, s.distWu / far));
      const falloff = 1 + (this.rules.drainFalloffAtFar - 1) * k;
      worst = Math.max(worst, s.mask * falloff);

      if (
        this.rules.rememberSeconds > 0
        && t >= this.rules.rememberSeconds
        && !this.remembered.has(s.entityId)
      ) {
        this.remembered.add(s.entityId);
        this.deps.emitSignal(
          `${this.rules.rememberSignalPrefix}:${s.entityId}`, s.entityId,
        );
      }
    }
    // 这一帧没被看见的，连续计时清零
    for (const id of [...this.seenSeconds.keys()]) {
      if (!seenThisFrame.has(id)) this.seenSeconds.delete(id);
    }

    if (worst > 0 && this.rules.drainPerSecond > 0) {
      this.deps.applyYinDamage(this.rules.drainPerSecond * worst * dt, this.rules.damageSourceId);
    }
  }

  /** 切场景 / 销毁：三把火那条请求必须撤，否则窗没了火还亮着。 */
  reset(): void {
    this.seenSeconds.clear();
    this.remembered.clear();
    if (this.yinActive) {
      this.yinActive = false;
      this.deps.setYinActive(false);
    }
  }
}
