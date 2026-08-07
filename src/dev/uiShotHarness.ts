import { Rectangle } from 'pixi.js';
import type { Game } from '../core/Game';

/**
 * **DEV 专用**的 UI 取景台：把游戏摆成一组固定的「姿势」（每个姿势 = 一块面板 + 一份样本数据），
 * 再按全分辨率抓帧 POST 到本地收图服务，供人和审查 agent 与设计稿逐张比对。
 *
 * 为什么要有这层：浏览器 MCP 的截图只有 800x450，木纹、金细线、字距这些
 * 恰好是本轮观感改造的全部内容，在那个分辨率下一律看不见；而手工一条条
 * 敲 `togglePanel` 每次热重载都要重来，审查循环根本跑不动。
 *
 * ⚠ 只在 `import.meta.env.DEV` 下装配，prod 构建里这些入口不存在。
 * ⚠ 姿势会真的改存档态（发物品、开任务）——它是给取景用的，不要在正常游玩流程里调。
 */

const SHOT_ENDPOINT = 'http://127.0.0.1:8123/shot';

/**
 * 取景默认落脚的场景。
 *
 * 必须挑一个**没有 `onEnter` 开场演出**的真实场景：茶馆一进去就起说书过场，
 * 状态卡在 Cutscene、屏幕被过场占着，面板取景全是废片。城门口是有背景的正经场景
 * 且 onEnter 干净，比 dev_room 的空网格更能看出面板压在画面上的实际观感。
 * （`public/assets/scenes/` 里 onEnter 干净的还有 temple / temple_exterior / 破屋 等。）
 */
const SHOT_SCENE = '城门口';

type PoseFn = (g: Game) => Promise<void> | void;

/** Game 上取景要用到的内部件。这里刻意收窄成"取景需要的最小面"，不图省事写 any。 */
interface GameInternals {
  renderer: { app: { stage: unknown; renderer: { extract: { base64(o: unknown): Promise<string> } } }; screenWidth: number; screenHeight: number };
  stateController: { currentState: string; closeAllPanels(): void; togglePanel(name: string): void };
  actionExecutor: { executeBatchAwait(actions: unknown[]): Promise<void> };
  sceneManager: {
    currentSceneData?: { id?: string } | null;
    transitionOverlay?: unknown;
    switchScene(targetSceneId: string, spawnPointId?: string): Promise<void>;
  };
  cutsceneManager?: { isPlaying: boolean; skip(): void };
  menuUI: { openMainMenu?(): void; openPauseMenu?(): void; open?(): void };
  encounterUI: { isOpen: boolean };
}

function internals(g: Game): GameInternals {
  return g as unknown as GameInternals;
}

/**
 * 挪到取景场景。开场无论从哪条路进来都可能落在带开场演出的场景（茶馆），
 * 那里状态卡 Cutscene、屏幕被过场占着，取景全是废片。
 */
async function gotoShotScene(g: Game): Promise<string> {
  const gi = internals(g);
  if (gi.sceneManager?.currentSceneData?.id === SHOT_SCENE) return await ready(g);
  // ⚠ `switchScene` 走 sceneSwitchTail 串行、尾部还有按 rAF 计时的淡入：
  // 隐藏标签页里一旦卡住就是**永不 resolve**（不是超时），整个取景脚本就此吊死。
  // 所以给它套一个赛跑超时——超时了也继续往下等就绪，让 ready() 去报真实状态，
  // 总比调用方拿不到任何返回强。
  await Promise.race([
    gi.sceneManager.switchScene(SHOT_SCENE),
    wait(15000),
  ]).catch((err) => { console.warn('[uiShot] 切到取景场景失败', err); });
  return await ready(g);
}

/** 摆姿势之间必须先收干净，否则上一块面板会叠在这一块下面进画。 */
async function reset(g: Game): Promise<void> {
  await gotoShotScene(g);
  const gi = internals(g);
  gi.stateController.closeAllPanels();
  await wait(60);
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 等到真的能取景为止。
 *
 * **固定 sleep 一律不够**：开场要装场景、跑直达路由、还可能播序章过场，
 * 拍早了就拍到一整屏切场黑幕 + 进度条（审查 agent 会拿这张黑图去"改设计"）。
 * 这里盯三个真实信号：状态回到 Exploring、场景已装、切场遮幕已撤。
 */
async function ready(g: Game, timeoutMs = 90000): Promise<string> {
  const t0 = Date.now();
  let skipped = false;
  for (;;) {
    const gi = internals(g);
    const st = gi.stateController.currentState;
    // 开场演出会把状态钉在 Cutscene，`togglePanel` 此时直接被拒、屏幕也被过场占着。
    // 取景不关心演出，跳掉它（只跳一次，免得跟正常结束打架）。
    if (st === 'Cutscene' && !skipped && gi.cutsceneManager?.isPlaying) {
      skipped = true;
      try { gi.cutsceneManager.skip(); } catch (err) { console.warn('[uiShot] 跳过过场失败', err); }
    }
    const scene = gi.sceneManager?.currentSceneData?.id;
    const covered = !!gi.sceneManager?.transitionOverlay;
    if (st === 'Exploring' && scene && !covered) return `ready:${scene}`;
    if (Date.now() - t0 > timeoutMs) return `timeout:${st}/${scene ?? '-'}/covered=${covered}`;
    await wait(250);
  }
}

/** 给面板灌一份样本数据：空面板看不出行距、选中态、徽章这些恰恰要审的东西。 */
async function seed(g: Game): Promise<void> {
  const gi = internals(g);
  // ⚠ `ActionDef` 的形状是 `{type, params}`，**不是把参数摊在顶层**；`giveItem` 的
  // 参数键叫 `id` 不是 `itemId`。写错第一条就抛错、被 catch 吞掉，取景拿到的
  // 是空包袱 + 0 铜钱（照着空面板去评设计，等于白评）。
  // 选的 id 都是**有图标**的，否则格子里只剩文字回落、看不出网格观感。
  await gi.actionExecutor.executeBatchAwait([
    { type: 'giveCurrency', params: { amount: 128 } },
    { type: 'giveItem', params: { id: 'copper_coins', count: 99 } },
    { type: 'giveItem', params: { id: 'taomu_sword', count: 1 } },
    { type: 'giveItem', params: { id: 'old_cloth_pouch', count: 1 } },
    { type: 'giveItem', params: { id: 'temple_notes', count: 1 } },
    { type: 'giveItem', params: { id: 'talisman', count: 3 } },
    { type: 'giveItem', params: { id: 'joss_paper', count: 5 } },
  ]).catch((err) => { console.warn('[uiShot] 样本数据灌注失败', err); });
}

const POSES: Record<string, PoseFn> = {
  hud: async (g) => { await reset(g); await seed(g); },
  inventory: async (g) => { await reset(g); await seed(g); internals(g).stateController.togglePanel('inventory'); },
  quest: async (g) => { await reset(g); internals(g).stateController.togglePanel('quest'); },
  rules: async (g) => { await reset(g); internals(g).stateController.togglePanel('rules'); },
  bookshelf: async (g) => { await reset(g); internals(g).stateController.togglePanel('bookshelf'); },
  map: async (g) => { await reset(g); internals(g).stateController.togglePanel('map'); },
  dialogueLog: async (g) => { await reset(g); internals(g).stateController.togglePanel('dialogueLog'); },
  menu: async (g) => { await reset(g); internals(g).stateController.togglePanel('menu'); },
};

/**
 * 隐藏标签页里的 rAF 补泵。
 *
 * **这是取景台能不能用的关键**：浏览器在标签页不可见时会把 `requestAnimationFrame`
 * 整个停掉。于是首场景装完、状态已经回到 Exploring，切场遮幕的淡出（走 rAF 计时）
 * 却永远走不完——取景拍到的就是一整屏黑幕加进度条。多开审查时只有一个标签页在前台，
 * 其余全中招。
 *
 * 做法：把 rAF 包一层，页面不可见且有回调积压时用 `setInterval` 顶上跑一轮
 * （隐藏页的 interval 会被节流到 ~1s，动画因此不平滑——取景不在乎平滑，只在乎跑完）。
 * 页面可见时是纯透传，不改任何时序。
 */
function installHiddenTabRafPump(): void {
  const raf = window.requestAnimationFrame.bind(window);
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 1;

  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = nextId++;
    pending.set(id, cb);
    raf((t) => { if (pending.delete(id)) cb(t); });
    return id;
  };
  window.cancelAnimationFrame = (id: number): void => { pending.delete(id); };

  window.setInterval(() => {
    if (!document.hidden || pending.size === 0) return;
    const batch = [...pending.values()];
    pending.clear();
    const now = performance.now();
    for (const cb of batch) {
      try { cb(now); } catch (err) { console.warn('[uiShot] rAF 补泵回调抛错', err); }
    }
  }, 250);
}

export function installUIShotHarness(game: Game): void {
  const w = window as unknown as Record<string, unknown>;
  if (!w.__uiRafPumpInstalled) {
    installHiddenTabRafPump();
    w.__uiRafPumpInstalled = true;
  }

  w.__uiShot = async (name: string, rect?: [number, number, number, number]): Promise<string> => {
    const gi = internals(game);
    const app = gi.renderer.app;
    const frame = rect
      ? new Rectangle(rect[0], rect[1], rect[2], rect[3])
      : new Rectangle(0, 0, gi.renderer.screenWidth, gi.renderer.screenHeight);
    const url = await app.renderer.extract.base64({ target: app.stage, format: 'png', frame, resolution: 2 });
    await fetch(`${SHOT_ENDPOINT}?name=${encodeURIComponent(name)}`, { method: 'POST', body: url });
    return name;
  };

  /**
   * 取景前必调：挪到无开场演出的取景场景 + 等到真的能拍（状态 Exploring、场景已装、切场遮幕已撤）。
   * **别用固定 sleep 赌**——开场要装场景、跑直达路由、还可能播序章。
   */
  w.__uiReady = (timeoutMs?: number): Promise<string> => {
    void timeoutMs;
    return gotoShotScene(game);
  };

  /** 只等就绪、不换场景（自己起对话/遭遇的调用方用）。 */
  w.__uiWaitReady = (timeoutMs?: number): Promise<string> => ready(game, timeoutMs);

  w.__uiPose = async (name: string): Promise<string> => {
    const pose = POSES[name];
    if (!pose) return `no pose: ${name} (有 ${Object.keys(POSES).join(',')})`;
    await pose(game);
    await wait(220);
    return name;
  };

  /** 一次跑完全部姿势并逐张出图，审查循环的主入口。 */
  w.__uiShotAll = async (prefix = ''): Promise<string[]> => {
    const done: string[] = [];
    for (const name of Object.keys(POSES)) {
      await (w.__uiPose as (n: string) => Promise<string>)(name);
      await (w.__uiShot as (n: string) => Promise<string>)(`${prefix}${name}`);
      done.push(name);
    }
    await reset(game);
    return done;
  };

  /** 把开发期的 DOM 调试坞与错误浮层收掉，免得盖住取景。 */
  w.__uiClean = (): string => {
    document.querySelectorAll('#debug-dock,#gamedraft-dev-error-overlay').forEach((el) => {
      (el as HTMLElement).style.display = 'none';
    });
    window.dispatchEvent(new Event('resize'));
    return 'cleaned';
  };
}
