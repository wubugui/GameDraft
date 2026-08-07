import { Container, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { InputManager } from '../core/InputManager';
import { UITheme } from './UITheme';
import { ContinueIndicator, CONTINUE_MARK_SIZE } from './components/ContinueIndicator';
import { createStyledText } from '../core/styledText';

/** 底边净空：走间距令牌拼出原先的 28px，不再是裸魔数 */
const BOTTOM_MARGIN = UITheme.spacing.xl + UITheme.spacing.sm;

function layoutHintText(t: Text, renderer: Renderer, bottomInset: number): void {
  t.x = Math.round(renderer.screenWidth / 2);
  t.y = renderer.screenHeight - BOTTOM_MARGIN - bottomInset;
}

/**
 * 在屏幕正下方显示无背景提示，订阅任意键/鼠标一次后移除并 resolve（与过场 wait_click 同款防抖）。
 * 刻意**不加底框**（不走 PanelSkin）：它是贴着画面底边的裸提示，加底会变成一块面板，破坏演出。
 */
export function waitClickContinueWithHint(
  renderer: Renderer,
  inputManager: InputManager,
  label: string,
  /**
   * 屏底被占掉的高度。**过场对白框在场时必须给**：提示语按屏底定位，
   * 而对白框正好占着屏底那一条，不让开就会横穿它的木框（审查实拍抓到「点击继续」
   * 被底部金线从字腰穿过去）。调用方给不出就是 0，与历史行为一致。
   */
  bottomInset: number = 0,
): Promise<void> {
  const container = new Container();
  const t = createStyledText({
    text: label,
    style: {
      // 「点击继续」是**推进提示，不是内容**：玩家扫一眼就按键，不会读它几秒。
      // 之前吃 bodyLarge（25）跟台词一样大，一句提示语横在屏幕底下比戏还响。
      // 退到 body：一行提示该有的量级，配字距仍然在满屏黑场里立得住。
      fontSize: UITheme.fontSize.body,
      fill: UITheme.colors.bodyMuted,
      fontFamily: UITheme.fonts.ui,
      // 设计稿里贴屏底的提示语都是拉开字距的一小行，不拉字距会缩成一团
      letterSpacing: UITheme.letterSpacing.title,
    },
  });
  t.anchor.set(0.5, 1);
  layoutHintText(t, renderer, bottomInset);
  container.addChild(t);

  // 提示语右侧跟一枚「继续」点捺——与对话框/遭遇框同一个件，四处推进提示长一个样。
  // 它一出现就在等玩家，所以直接显示（这里本来就只在等待时才存在）。
  const mark = new ContinueIndicator();
  container.addChild(mark.container);
  mark.setVisible(true);
  const placeMark = (): void => {
    mark.setPosition(
      t.x + t.width / 2 + UITheme.spacing.md + CONTINUE_MARK_SIZE.width / 2,
      t.y - t.height / 2 - CONTINUE_MARK_SIZE.height / 2,
    );
  };
  placeMark();
  container.alpha = 0;
  renderer.uiLayer.addChild(container);
  // 提示须压在之后打开的面板之上（Pixi v8 写 zIndex 会自动打开父容器 sortableChildren；
  // 其余 uiLayer 子节点 zIndex 为 0，稳定排序下相对顺序不变）
  container.zIndex = UITheme.z.toast;

  // 进场淡入：motion 的「提示进出」档 + easeOut。**不做出场淡出**——finish() 要在
  // 玩家按下的那一帧就 resolve（过场 wait_click 靠它续演），拖个出场动画等于推迟推进。
  // 进场淡入 + 点捺浮动共用一条 rAF 链：淡入完成后**不停表**，继续喂点捺的浮动，
  // 直到容器销毁。两件事分两条 rAF 只会多一条要记得拆的链。
  const fadeInStart = performance.now();
  let lastT = fadeInStart;
  const tick = () => {
    if (container.destroyed) return;
    const now = performance.now();
    const p = Math.min(1, (now - fadeInStart) / UITheme.motion.normal);
    container.alpha = UITheme.motion.easeOut(p);
    mark.update((now - lastT) / 1000);
    lastT = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const unresize = renderer.subscribeAfterResize(() => { layoutHintText(t, renderer, bottomInset); placeMark(); });

  return new Promise(resolve => {
    let unsubInput: (() => void) | null = null;
    const finish = () => {
      unresize();
      if (unsubInput) unsubInput();
      unsubInput = null;
      if (container.parent) container.parent.removeChild(container);
      container.destroy({ children: true });
      resolve();
    };
    const arm = () => {
      const notBefore = performance.now() + 120;
      unsubInput = inputManager.subscribeAnyInput(() => {
        if (performance.now() < notBefore) return;
        finish();
      });
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(arm);
    });
  });
}
