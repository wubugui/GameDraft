import type { SceneData } from '../../data/types';
import { daylightPhaseIds, type ResolvedPhase } from '../../utils/dayTime';
import { resolveSceneAppearance } from '../../utils/sceneAppearance';

/**
 * 窗户世界「看的是哪一段」——**对面那一段**的解析（纯函数）。
 *
 * 法宝「窥夜」的语义是对称的：白天举起来看见夜，夜里举起来看见白天（玩法清单 F.5）。
 * 所以目标时段不是玩家选的，是从「此刻用的是哪套外观」推出来的一次查表。
 *
 * ## ⚠ 为什么这里一个时段 id 都不许写死
 *
 * 这个坑 2026-08-18 已经吃过一次：代码里曾有 `NPC_DEFAULT_PHASES = ['day']`，
 * 从缺省时段表里抠了一个 id 硬写进代码。而那张表**会被内容侧整表替换**（本作换成了
 * `辰/午/暮/夜`），表一换，`'day'` 指向一个不存在的时段，判定恒假——雾津街头整条街
 * 一个人都没有，且没有任何报错（见 `dayTime.daylightPhaseIds` 的文件注释）。
 *
 * 所以这里只问**语义角色**（时段表里的 `daylight` 标记），不问名字。
 * 时段叫什么、分几段、几点切换、什么语言，本文件一概不知道，也就再没法对不上。
 *
 * ## 解析分两步（顺序不能换）
 *
 * 1. 先定这个场景的「夜画」：非 daylight 的时段里、配了变体且**换了主背景图**的那一段。
 * 2. 对面 = 白日基底与夜画两张里，**不是眼前这张**的那一张。
 *
 * 第二步的判据是「眼前显示的是哪张画」，不是时段标记 —— 理由见函数体里那段注释，
 * 两种想当然的写法都会造成**不报错的静默失效**（傍晚无效 / 看见另一张白天）。
 *
 * ## 「换了背景图」这条判据兼做可用性闸
 *
 * 只配了 bgm / 环境音的时段变体**不算另一副样子**——窗里会和窗外一模一样，法宝等于没效果。
 * 要求对面那套必须换了主背景图，于是「这个场景能不能用法宝」与「这个场景有没有夜原画」
 * 成为同一件事，不必另立一张可用场景白名单（那种名单一定会和数据漂开）。
 */

/** 一次解析的结果。`usable === false` 时法宝在这个场景没有东西可看。 */
export interface WindowWorldTarget {
  /** 对面那一段的时段 id；空串 = 顶层基底（白日那套）。 */
  phase: string;
  /** 对面那套外观的主背景图名——烘焙产物按它索引。 */
  backgroundImage: string;
  /** 此刻这一侧用的时段 id（空串 = 基底）。留着给日志与判据用。 */
  currentPhase: string;
  /** 这个场景此刻能不能开窗（有没有另一副真的不一样的样子）。 */
  usable: boolean;
}

/**
 * 求 `scene` 在当前时刻 `currentPhase` 下，窗里该显示哪一套外观。
 *
 * `phases` 是当前生效的时段表（由 DayManager 解析好传进来），本函数只读它的
 * `id` 顺序与 `daylight` 标记，不认任何具体名字。
 *
 * 场景没开日夜、或没有配出另一副样子时返回 `usable: false`——调用方据此让法宝无反应，
 * **不要在这里抛错**：没配夜原画是合法的场景状态，不是错误。
 */
export function resolveWindowWorldTarget(
  scene: SceneData,
  currentPhase: string,
  phases: readonly ResolvedPhase[],
): WindowWorldTarget {
  const here = resolveSceneAppearance(scene, currentPhase);
  const unusable: WindowWorldTarget = {
    phase: '',
    backgroundImage: here.primaryBackgroundImage,
    currentPhase: here.phase,
    usable: false,
  };

  // 没开日夜 = 整套时段归属不生效，与 SceneManager.entityInPhase 的首行同口径。
  if (scene.dayNight?.enabled !== true) return unusable;

  // ── 第一步：这个场景的「夜画」是哪一张 ──────────────────────────────
  //
  // 判据 = 非 daylight 的时段里、配了变体且**换了主背景图**的那一段。
  // 按**时段表的顺序**取第一个，不按对象键序：键序是 JSON 的书写顺序、没有语义，
  // 两段都合格时会让「看到哪一段」随着有人重排 JSON 而悄悄变。
  const dayIds = new Set(daylightPhaseIds(phases));
  const configured = scene.timeVariants ?? {};
  const baseImage = resolveSceneAppearance(scene, '').primaryBackgroundImage;
  let nightPhase = '';
  let nightImage = '';
  for (const p of phases) {
    if (dayIds.has(p.id)) continue;
    if (!(p.id in configured)) continue;
    const other = resolveSceneAppearance(scene, p.id);
    if (other.phase !== p.id) continue;
    if (other.primaryBackgroundImage === baseImage) continue;
    nightPhase = p.id;
    nightImage = other.primaryBackgroundImage;
    break;
  }
  // 没有夜画 = 这个场景没画过夜，法宝在此无东西可看（合法状态，不是错误）。
  if (!nightImage) return unusable;

  // ── 第二步：对面 = 两张画里**不是眼前这张**的那一张 ────────────────────
  //
  // ⚠ 判据是「此刻显示的是哪张画」，不是「此刻这一段的 daylight 标记」，也不是
  //   「此刻落没落在某个变体上」。两个看似等价的写法都错，且错法相反：
  //
  //   · 按 daylight 标记分 —— 本作 `暮` 并**没有**标 daylight（它的语义是"街上没人了"），
  //     但 `暮` 没配变体，画面显示的仍是白天那张基底画。按标记判会认定"你已经在夜那一侧"、
  //     于是把基底当成对面 —— 和眼前一模一样，**傍晚举法宝静默无效**。
  //   · 按「在不在变体上」分 —— 场景可以给某个 daylight 段单配一张自己的白天图
  //     （数据里崖墓入口与跑马梁已经有 `午` 这一档变体）。那样午时举法宝会看见
  //     **另一张白天**，同样白举。
  //
  //   两条都是不报错的静默失效，只能靠"眼前这张是不是夜画"这个直接判据挡掉。
  if (here.primaryBackgroundImage === nightImage) {
    return {
      phase: '',
      backgroundImage: baseImage,
      currentPhase: here.phase,
      usable: baseImage !== nightImage,
    };
  }
  return {
    phase: nightPhase,
    backgroundImage: nightImage,
    currentPhase: here.phase,
    usable: true,
  };
}
