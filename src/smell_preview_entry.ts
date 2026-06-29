/**
 * 气味 Profile 预览入口（编辑器 QtWebEngine 嵌这个页面）。
 * β 严格一致：跑的是和游戏 HUD **同一个** SmellIndicatorRenderer —— 编辑器所见即实机所见。
 * 编辑器经 window.__setProfiles / __setScent / __sniff 注入当前编辑的 profile 与状态。
 */
import { Application, Container } from 'pixi.js';
import { SmellIndicatorRenderer, type SmellProfilesRaw } from './ui/smell/SmellIndicatorRenderer';

type PreviewWin = {
  __setProfiles?: (data: SmellProfilesRaw) => void;
  __setScent?: (scent: string, intensity?: number, dir?: number, flicker?: boolean) => void;
  __sniff?: () => void;
  __previewReady?: boolean;
};

async function main(): Promise<void> {
  const app = new Application();
  await app.init({ width: 260, height: 220, background: 0x15171d, antialias: true });
  document.body.appendChild(app.canvas);

  const root = new Container();
  root.x = 130;
  root.y = 170;
  app.stage.addChild(root);

  let renderer: SmellIndicatorRenderer | null = null;
  let curScent = 'powder';
  let curIntensity = 92;
  let curDir = 0;
  let curFlicker = false;

  const rebuild = (data: SmellProfilesRaw): void => {
    if (renderer) renderer.destroy();
    renderer = new SmellIndicatorRenderer(root, data, { x: 0, y: 0 });
    renderer.setState({ scent: curScent, intensity: curIntensity, dir: curDir, flicker: curFlicker });
  };

  app.ticker.add((tk) => { renderer?.update(Math.min(0.05, ((tk.deltaMS as number) || 16) / 1000)); });

  const w = window as unknown as PreviewWin;
  w.__setProfiles = (data) => rebuild(data);
  w.__setScent = (scent, intensity, dir, flicker) => {
    curScent = scent || '';
    if (intensity !== undefined) curIntensity = intensity;
    if (dir !== undefined) curDir = dir;
    if (flicker !== undefined) curFlicker = !!flicker;
    renderer?.setState({ scent: curScent, intensity: curIntensity, dir: curDir, flicker: curFlicker });
  };
  w.__sniff = () => renderer?.pulseBoost();
  // 隐藏页时 PixiJS rAF 会被节流 → 提供手动推进+渲染钩子，供截图核验（编辑器实际可见时不需要）。
  (w as unknown as { __force?: (steps?: number) => void }).__force = (steps?: number) => {
    const n = steps ?? 90;
    for (let i = 0; i < n; i++) renderer?.update(0.033);
    app.render();
  };

  // 默认：加载真实 profiles 先展示香粉味（非空白）；编辑器随后会 __setProfiles 覆盖。
  try {
    const def = (await fetch('/assets/data/smell_profiles.json').then((r) => r.json())) as SmellProfilesRaw;
    rebuild(def);
  } catch {
    /* 等编辑器注入 */
  }
  w.__previewReady = true;
}

void main();
