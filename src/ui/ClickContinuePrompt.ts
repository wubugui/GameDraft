import { Container, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { InputManager } from '../core/InputManager';
import { UITheme } from './UITheme';

const BOTTOM_MARGIN = 28;

function layoutHintText(t: Text, renderer: Renderer): void {
  t.x = renderer.screenWidth / 2;
  t.y = renderer.screenHeight - BOTTOM_MARGIN;
}

/**
 * 在屏幕正下方显示无背景提示，订阅任意键/鼠标一次后移除并 resolve（与过场 wait_click 同款防抖）。
 */
export function waitClickContinueWithHint(
  renderer: Renderer,
  inputManager: InputManager,
  label: string,
): Promise<void> {
  const container = new Container();
  const t = new Text({
    text: label,
    style: {
      fontSize: 16,
      fill: UITheme.colors.subtle,
      fontFamily: UITheme.fonts.ui,
    },
  });
  t.anchor.set(0.5, 1);
  layoutHintText(t, renderer);
  container.addChild(t);
  renderer.uiLayer.addChild(container);

  const unresize = renderer.subscribeAfterResize(() => layoutHintText(t, renderer));

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
