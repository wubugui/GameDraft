/**
 * 鸟群 / 虫群模拟内核（纯数学，不碰 Pixi、不碰事件总线；玩法定义见玩法文档 B5）。
 *
 * ## 坐标：模拟平面 ≠ 场景平面
 *
 * 场景的 (x, y) 是斜俯视的地面：y 既是屏幕纵向也是"远近"。一圈真正的圆在这种视角下
 * 看起来是**扁椭圆**——所以模拟不直接在场景平面上算，而是在一个"俯视的模拟平面"
 * (x, z) 上算，z = 场景 y / {@link SwarmSimConfig.depthSquash}。分离/对齐/聚拢/盘旋
 * 全部在模拟平面上按真圆算，渲染时再压回去：
 *
 *   worldX = x,  worldY = z · depthSquash,  屏幕 y = worldY − h（h 为离地高度，世界单位）。
 *
 * 前后排序用的"脚下落点"就是 (worldX, worldY)，影子也落在那里。
 *
 * ## 行为
 *
 * 每只鸟是一个 boid：三条经典群体规则 + 一条"绕中心盘旋"的目标（切向速度 + 径向回拉）
 * + 高度弹簧。恐惧是**连续量** fear∈[0,1]：虫在恐惧半径内就涨（近得越多涨得越快），
 * 没虫时按固定速率退。fear 混进一切参数——盘旋半径与高度外扩、限速抬高、分离权重加大、
 * 聚拢权重减小、并叠加一条离开虫群的斥力——于是"惊飞 / 拉远 / 散开 / 慢慢回来"是同一套
 * 公式的连续输出，没有状态机、没有硬切。
 *
 * 扑翼是每只鸟自己的相位：平静时扑翼与滑翔交替（随机时长），惊时只扑不滑、频率抬高。
 *
 * 随机数一律经注入的 {@link SwarmRng}，单测用可复现序列。
 */

export interface SwarmRng {
  /** [0, 1) */
  next(): number;
}

/** 简单可复现 RNG（mulberry32）。运行时也用它——只要种子随机就够了，不需要 crypto 级别。 */
export function createSeededRng(seed: number): SwarmRng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export interface SwarmSimConfig {
  /** 场景 y 相对模拟平面 z 的压扁比（斜俯视下一圈真圆看起来的纵横比） */
  depthSquash: number;

  /** 盘旋圈半径（模拟平面，世界单位） */
  orbitRadius: number;
  /** 盘旋离地高度（世界单位；角色身高 150 恒定，鸟在头顶上方） */
  orbitHeight: number;
  /** 平静巡航速度 / 惊飞速度（世界单位每秒） */
  calmSpeed: number;
  panicSpeed: number;
  /** 转向能力：每秒最多改变多少速度（越大越灵活；太大会抖） */
  maxTurnAccel: number;

  /** 群体规则的感知半径与分离半径 */
  neighborRadius: number;
  separationRadius: number;

  /** 恐惧：虫在此半径内开始生效 */
  fearRadius: number;
  /** 满暴露时每秒涨多少恐惧 */
  fearRise: number;
  /** 没虫时每秒退多少恐惧 */
  fearDecay: number;
  /** fear=1 时盘旋半径 / 高度额外外扩多少 */
  panicRadiusExtra: number;
  panicHeightExtra: number;

  /** 高度弹簧刚度与阻尼 */
  heightStiffness: number;
  heightDamping: number;
  /** 离地最低高度（防扎地） */
  minHeight: number;

  /** 扑翼基础频率（Hz），惊时抬高 */
  flapHz: number;

  /** 虫：初速区间、空气阻力、扰动、寿命区间、起始高度 */
  bugSpeedMin: number;
  bugSpeedMax: number;
  bugDrag: number;
  bugJitter: number;
  bugLifeMin: number;
  bugLifeMax: number;
  bugStartHeight: number;
}

export const DEFAULT_SWARM_CONFIG: SwarmSimConfig = {
  depthSquash: 0.42,
  orbitRadius: 150,
  orbitHeight: 190,
  calmSpeed: 130,
  panicSpeed: 330,
  maxTurnAccel: 420,
  neighborRadius: 70,
  separationRadius: 28,
  fearRadius: 150,
  fearRise: 2.2,
  fearDecay: 0.22,
  panicRadiusExtra: 320,
  panicHeightExtra: 120,
  heightStiffness: 9,
  heightDamping: 4.5,
  minHeight: 40,
  flapHz: 5.5,
  bugSpeedMin: 40,
  bugSpeedMax: 130,
  bugDrag: 1.1,
  bugJitter: 260,
  bugLifeMin: 4,
  bugLifeMax: 7.5,
  bugStartHeight: 70,
};

export interface Bird {
  /** 模拟平面位置 */
  x: number;
  z: number;
  /** 离地高度 */
  h: number;
  vx: number;
  vz: number;
  vh: number;
  /** 恐惧 0..1 */
  fear: number;
  /** 扑翼相位（弧度，单调递增） */
  flapPhase: number;
  /** true=正在滑翔（翅膀展平不扑） */
  gliding: boolean;
  /** 当前扑翼/滑翔段剩余秒数 */
  wingTimer: number;
  /** 朝向：+1 向右，−1 向左（带滞回，避免抖） */
  facing: 1 | -1;
  /** 个体差异：速度倍率、高度偏置、高度起伏相位 */
  speedMul: number;
  heightBias: number;
  bobPhase: number;
}

export interface Bug {
  x: number;
  z: number;
  h: number;
  vx: number;
  vz: number;
  vh: number;
  age: number;
  life: number;
  /** 个体扑翅相位（渲染闪翅用） */
  wingPhase: number;
}

export interface SwarmCenter {
  /** 模拟平面中心（= 玩家脚点换算） */
  x: number;
  z: number;
}

/** 场景脚点 → 模拟平面 */
export function toSimPlane(worldX: number, worldY: number, cfg: SwarmSimConfig): SwarmCenter {
  return { x: worldX, z: worldY / cfg.depthSquash };
}

/** 模拟平面 → 场景脚点 y */
export function simZToWorldY(z: number, cfg: SwarmSimConfig): number {
  return z * cfg.depthSquash;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function randRange(rng: SwarmRng, a: number, b: number): number {
  return a + (b - a) * rng.next();
}

/** 在盘旋圈上撒一群鸟，初速沿切向（整群同一旋向）。 */
export function createFlock(
  count: number,
  center: SwarmCenter,
  cfg: SwarmSimConfig,
  rng: SwarmRng,
  orbitDir: 1 | -1,
): Bird[] {
  const birds: Bird[] = [];
  const n = Math.max(0, Math.floor(count));
  for (let i = 0; i < n; i++) {
    const ang = (i / Math.max(n, 1)) * Math.PI * 2 + randRange(rng, -0.3, 0.3);
    const r = cfg.orbitRadius * randRange(rng, 0.8, 1.2);
    const x = center.x + Math.cos(ang) * r;
    const z = center.z + Math.sin(ang) * r;
    // 切向：绕 center 逆/顺时针
    const tx = -Math.sin(ang) * orbitDir;
    const tz = Math.cos(ang) * orbitDir;
    const speedMul = randRange(rng, 0.88, 1.12);
    const sp = cfg.calmSpeed * speedMul;
    birds.push({
      x,
      z,
      h: cfg.orbitHeight + randRange(rng, -25, 25),
      vx: tx * sp,
      vz: tz * sp,
      vh: 0,
      fear: 0,
      flapPhase: rng.next() * Math.PI * 2,
      gliding: false,
      wingTimer: randRange(rng, 0.6, 2.0),
      facing: tx >= 0 ? 1 : -1,
      speedMul,
      heightBias: randRange(rng, -30, 30),
      bobPhase: rng.next() * Math.PI * 2,
    });
  }
  return birds;
}

/** 从中心放出一把虫：各向随机散开，初速随机，寿命随机。 */
export function spawnBugs(
  count: number,
  center: SwarmCenter,
  cfg: SwarmSimConfig,
  rng: SwarmRng,
): Bug[] {
  const bugs: Bug[] = [];
  const n = Math.max(0, Math.floor(count));
  for (let i = 0; i < n; i++) {
    const ang = rng.next() * Math.PI * 2;
    const sp = randRange(rng, cfg.bugSpeedMin, cfg.bugSpeedMax);
    bugs.push({
      x: center.x + randRange(rng, -6, 6),
      z: center.z + randRange(rng, -6, 6),
      h: cfg.bugStartHeight + randRange(rng, -10, 10),
      vx: Math.cos(ang) * sp,
      vz: Math.sin(ang) * sp,
      vh: randRange(rng, -10, 40),
      age: 0,
      life: randRange(rng, cfg.bugLifeMin, cfg.bugLifeMax),
      wingPhase: rng.next() * Math.PI * 2,
    });
  }
  return bugs;
}

/**
 * 推进虫群一帧：阻力减速 + 布朗扰动 + 轻微上浮再飘落；寿命到了就地移除（返回存活数组）。
 */
export function stepBugs(bugs: Bug[], dt: number, cfg: SwarmSimConfig, rng: SwarmRng): Bug[] {
  if (dt <= 0) return bugs;
  const alive: Bug[] = [];
  const drag = Math.exp(-cfg.bugDrag * dt);
  const jitter = cfg.bugJitter * Math.sqrt(dt);
  for (const b of bugs) {
    b.age += dt;
    if (b.age >= b.life) continue;
    b.vx = b.vx * drag + (rng.next() - 0.5) * jitter;
    b.vz = b.vz * drag + (rng.next() - 0.5) * jitter;
    // 高度：先有一点上浮，后半程慢慢落回，但不落到地面以下
    const lifeT = b.age / b.life;
    const targetH = cfg.bugStartHeight * (1 - lifeT * 0.6) + 20;
    b.vh += ((targetH - b.h) * 3 - b.vh * 2) * dt + (rng.next() - 0.5) * jitter * 0.4;
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.h = Math.max(6, b.h + b.vh * dt);
    b.wingPhase += dt * 60;
    alive.push(b);
  }
  return alive;
}

/** 虫的渲染透明度：末 1 秒淡出。 */
export function bugAlpha(b: Bug): number {
  const remain = b.life - b.age;
  return clamp01(remain / 1.0);
}

/**
 * 推进鸟群一帧。center 为当前玩家脚点换算到模拟平面的位置；bugs 为当前存活的虫。
 * 就地修改 birds。
 */
export function stepFlock(
  birds: Bird[],
  bugs: readonly Bug[],
  center: SwarmCenter,
  dt: number,
  cfg: SwarmSimConfig,
  rng: SwarmRng,
  orbitDir: 1 | -1,
  timeSec: number,
): void {
  if (dt <= 0 || birds.length === 0) return;
  const nR2 = cfg.neighborRadius * cfg.neighborRadius;
  const sR2 = cfg.separationRadius * cfg.separationRadius;
  const fR2 = cfg.fearRadius * cfg.fearRadius;

  for (const b of birds) {
    // ---- 恐惧：暴露度 = 半径内各虫的 (1 − d/R) 之和，饱和到 1 ----
    let exposure = 0;
    let fleeX = 0;
    let fleeZ = 0;
    for (const g of bugs) {
      const dx = b.x - g.x;
      const dz = b.z - g.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= fR2) continue;
      const d = Math.sqrt(d2) + 1e-3;
      const w = 1 - d / cfg.fearRadius;
      exposure += w;
      // 离虫越近斥力越大（1/d 型），方向背离
      fleeX += (dx / d) * w * w;
      fleeZ += (dz / d) * w * w;
    }
    exposure = clamp01(exposure);
    if (exposure > 0) {
      b.fear = clamp01(b.fear + exposure * cfg.fearRise * dt);
    } else {
      b.fear = clamp01(b.fear - cfg.fearDecay * dt);
    }
    const fear = b.fear;

    // ---- 三条群体规则 ----
    let sepX = 0;
    let sepZ = 0;
    let aliX = 0;
    let aliZ = 0;
    let cohX = 0;
    let cohZ = 0;
    let nCount = 0;
    for (const o of birds) {
      if (o === b) continue;
      const dx = b.x - o.x;
      const dz = b.z - o.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= nR2) continue;
      nCount++;
      aliX += o.vx;
      aliZ += o.vz;
      cohX += o.x;
      cohZ += o.z;
      if (d2 < sR2 && d2 > 1e-6) {
        const inv = 1 / d2;
        sepX += dx * inv;
        sepZ += dz * inv;
      }
    }
    // 离盘旋圈越远飞得越快（追上走开的玩家 / 惊飞后从远处赶回来都靠这一项），最多 ×2.6
    const rxPre = b.x - center.x;
    const rzPre = b.z - center.z;
    const orbitR = cfg.orbitRadius + cfg.panicRadiusExtra * fear;
    const farRatio = Math.max(0, Math.min(2, (Math.hypot(rxPre, rzPre) - orbitR) / orbitR));
    const maxSpeed = lerp(cfg.calmSpeed, cfg.panicSpeed, fear) * b.speedMul * (1 + 0.8 * farRatio);

    let steerX = 0;
    let steerZ = 0;
    if (nCount > 0) {
      // 对齐：邻居平均速度方向
      const aLen = Math.hypot(aliX, aliZ);
      if (aLen > 1e-6) {
        steerX += ((aliX / aLen) * maxSpeed - b.vx) * 0.8;
        steerZ += ((aliZ / aLen) * maxSpeed - b.vz) * 0.8;
      }
      // 聚拢：朝邻居质心（惊时几乎不聚）
      const cx = cohX / nCount - b.x;
      const cz = cohZ / nCount - b.z;
      const cLen = Math.hypot(cx, cz);
      if (cLen > 1e-6) {
        const wCoh = 0.6 * (1 - fear);
        steerX += ((cx / cLen) * maxSpeed - b.vx) * wCoh;
        steerZ += ((cz / cLen) * maxSpeed - b.vz) * wCoh;
      }
    }
    // 分离：惊时加大
    const sLen = Math.hypot(sepX, sepZ);
    if (sLen > 1e-6) {
      const wSep = 1.6 + 2.4 * fear;
      steerX += ((sepX / sLen) * maxSpeed - b.vx) * wSep;
      steerZ += ((sepZ / sLen) * maxSpeed - b.vz) * wSep;
    }

    // ---- 盘旋：切向 + 径向回拉，半径随恐惧外扩 ----
    const R = orbitR;
    const rx = rxPre;
    const rz = rzPre;
    const d = Math.hypot(rx, rz) + 1e-3;
    const ux = rx / d;
    const uz = rz / d;
    const tx = -uz * orbitDir;
    const tz = ux * orbitDir;
    // 径向误差归一到半径量级；远了拉回、近了推开
    const radialErr = (R - d) / R;
    const kr = 1.6;
    let dx = tx + ux * radialErr * kr;
    let dz = tz + uz * radialErr * kr;
    const dLen = Math.hypot(dx, dz) || 1;
    dx /= dLen;
    dz /= dLen;
    const wOrbit = 1.2;
    steerX += (dx * maxSpeed - b.vx) * wOrbit;
    steerZ += (dz * maxSpeed - b.vz) * wOrbit;

    // ---- 逃离虫群 ----
    const fLen = Math.hypot(fleeX, fleeZ);
    if (fLen > 1e-6) {
      const wFlee = 3.5 * Math.max(fear, exposure);
      steerX += ((fleeX / fLen) * maxSpeed - b.vx) * wFlee;
      steerZ += ((fleeZ / fLen) * maxSpeed - b.vz) * wFlee;
    }

    // ---- 限制转向加速度，积分 ----
    const maxAccel = cfg.maxTurnAccel * (1 + 1.5 * fear);
    const aLen2 = Math.hypot(steerX, steerZ);
    if (aLen2 > maxAccel) {
      steerX = (steerX / aLen2) * maxAccel;
      steerZ = (steerZ / aLen2) * maxAccel;
    }
    b.vx += steerX * dt;
    b.vz += steerZ * dt;
    const sp = Math.hypot(b.vx, b.vz);
    const minSpeed = maxSpeed * 0.45;
    if (sp > maxSpeed) {
      b.vx = (b.vx / sp) * maxSpeed;
      b.vz = (b.vz / sp) * maxSpeed;
    } else if (sp < minSpeed && sp > 1e-6) {
      b.vx = (b.vx / sp) * minSpeed;
      b.vz = (b.vz / sp) * minSpeed;
    }
    b.x += b.vx * dt;
    b.z += b.vz * dt;

    // ---- 高度：弹簧到目标高度（个体偏置 + 慢起伏 + 恐惧拉高）----
    const bob = Math.sin(timeSec * 0.9 + b.bobPhase) * 18;
    const targetH = cfg.orbitHeight + b.heightBias + bob + cfg.panicHeightExtra * fear;
    b.vh += ((targetH - b.h) * cfg.heightStiffness - b.vh * cfg.heightDamping) * dt;
    b.h += b.vh * dt;
    if (b.h < cfg.minHeight) {
      b.h = cfg.minHeight;
      if (b.vh < 0) b.vh = 0;
    }

    // ---- 扑翼 / 滑翔 ----
    b.wingTimer -= dt;
    if (b.wingTimer <= 0) {
      if (b.gliding || fear > 0.35) {
        b.gliding = false;
        b.wingTimer = randRange(rng, 0.8, 2.2);
      } else {
        // 平静时有约 45% 的段落转为滑翔
        b.gliding = rng.next() < 0.45;
        b.wingTimer = b.gliding ? randRange(rng, 0.5, 1.4) : randRange(rng, 0.8, 2.2);
      }
    }
    if (fear > 0.35) b.gliding = false;
    if (!b.gliding) {
      const hz = cfg.flapHz * (0.85 + 0.9 * fear) * Math.sqrt(Math.max(sp, 1) / cfg.calmSpeed);
      b.flapPhase += hz * Math.PI * 2 * dt;
    } else {
      // 滑翔：相位缓缓收敛到"展平"（sin=0 附近）
      const target = Math.round(b.flapPhase / Math.PI) * Math.PI;
      b.flapPhase += (target - b.flapPhase) * Math.min(1, 8 * dt);
    }

    // ---- 朝向滞回 ----
    if (b.vx > 12) b.facing = 1;
    else if (b.vx < -12) b.facing = -1;
  }
}

/** 扑翼帧：把相位映射到 [0, frames) 的整数帧（sin 波形：0=展平 → 上扬 → 展平 → 下压）。 */
export function flapFrameIndex(phase: number, frames: number): number {
  const t = (phase / (Math.PI * 2)) % 1;
  const u = t < 0 ? t + 1 : t;
  return Math.min(frames - 1, Math.floor(u * frames));
}

/** 群体统计（调试面板 / 单测用）：平均恐惧、到中心平均距离、平均高度。 */
export function flockStats(birds: readonly Bird[], center: SwarmCenter): {
  meanFear: number;
  meanDist: number;
  meanHeight: number;
} {
  if (birds.length === 0) return { meanFear: 0, meanDist: 0, meanHeight: 0 };
  let f = 0;
  let d = 0;
  let h = 0;
  for (const b of birds) {
    f += b.fear;
    d += Math.hypot(b.x - center.x, b.z - center.z);
    h += b.h;
  }
  const n = birds.length;
  return { meanFear: f / n, meanDist: d / n, meanHeight: h / n };
}
