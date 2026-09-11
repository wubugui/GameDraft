/**
 * 气味 Profile 预览入口（编辑器 QtWebEngine 嵌这个页面）。
 * β 严格一致：跑的是和游戏 HUD **同一个** SmellIndicatorRenderer —— 编辑器所见即实机所见。
 * 编辑器经 window.__setProfiles / __setScent / __sniff 注入当前编辑的 profile 与状态。
 * `?grid=1`：九宫格对照（G.6 飘向：横向 × 纵深各 -1/0/+1），调幅度、给制作人看用。
 */
import { Application, Container, Text } from 'pixi.js';
import { SmellIndicatorRenderer, type SmellProfilesRaw } from './ui/smell/SmellIndicatorRenderer';
import { fetchAsset } from './core/assetPath';
import { TEXT_URLS } from './core/projectPaths';

type PreviewWin = {
  __setProfiles?: (data: SmellProfilesRaw) => void;
  __setScent?: (scent: string, intensity?: number, dir?: number, flicker?: boolean, dirDepth?: number) => void;
  __sniff?: () => void;
  __previewReady?: boolean;
  __force?: (steps?: number) => void;
  __grid?: (scent?: string, intensity?: number) => void;
  __setForm?: (key: string, value: number) => void;
};

const CELL_W = 220;
const CELL_H = 230;

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const gridMode = params.has('grid');
  const app = new Application();
  await app.init({
    width: gridMode ? CELL_W * 3 : 260,
    height: gridMode ? CELL_H * 3 : 220,
    background: 0x15171d,
    antialias: true,
  });
  document.body.appendChild(app.canvas);

  const root = new Container();
  root.x = 130;
  root.y = 170;
  app.stage.addChild(root);

  let renderer: SmellIndicatorRenderer | null = null;
  let profiles: SmellProfilesRaw | null = null;
  let curScent = 'powder';
  let curIntensity = 92;
  let curDir = 0;
  let curDepth = 0;
  let curFlicker = false;
  /** 九宫格模式下的 9 个渲染器（与 renderer 互斥） */
  let grid: SmellIndicatorRenderer[] = [];
  const gridRoot = new Container();
  app.stage.addChild(gridRoot);

  const rebuild = (data: SmellProfilesRaw): void => {
    profiles = data;
    if (renderer) renderer.destroy();
    renderer = new SmellIndicatorRenderer(root, data, { x: 0, y: 0 });
    renderer.setState({ scent: curScent, intensity: curIntensity, dir: curDir, dirDepth: curDepth, flicker: curFlicker });
  };

  /** 九宫格：行 = 纵深（上：源在后/朝镜头扑来 +1；中 0；下：源在前/吹向深处 -1），列 = 横向（左：源在右 -1；中 0；右：源在左 +1） */
  const buildGrid = (scent: string, intensity: number): void => {
    if (!profiles) return;
    for (const r of grid) r.destroy();
    grid = [];
    gridRoot.removeChildren().forEach((c) => c.destroy({ children: true }));
    if (renderer) { renderer.destroy(); renderer = null; }
    const depths = [1, 0, -1];
    const dirs = [-1, 0, 1];
    const rowLabel = ['源在后（烟朝镜头扑来）', '源在同一排', '源在前（烟被吹向深处）'];
    const colLabel = ['源在右', '源正对', '源在左'];
    for (let ri = 0; ri < 3; ri++) {
      for (let ci = 0; ci < 3; ci++) {
        const cell = new Container();
        cell.x = ci * CELL_W;
        cell.y = ri * CELL_H;
        gridRoot.addChild(cell);
        const holder = new Container();
        holder.x = CELL_W / 2;
        holder.y = CELL_H - 50;
        cell.addChild(holder);
        const r = new SmellIndicatorRenderer(holder, profiles, { x: 0, y: 0 });
        r.setState({ scent, intensity, dir: dirs[ci], dirDepth: depths[ri], flicker: false });
        grid.push(r);
        const cap = new Text({
          text: `${rowLabel[ri]} · ${colLabel[ci]}\ndir ${dirs[ci] >= 0 ? '+' : ''}${dirs[ci]}  depth ${depths[ri] >= 0 ? '+' : ''}${depths[ri]}`,
          style: { fontFamily: 'sans-serif', fontSize: 11, fill: 0xb9b3a6, align: 'center', lineHeight: 15 },
        });
        cap.anchor.set(0.5, 0);
        cap.x = CELL_W / 2;
        cap.y = 8;
        cell.addChild(cap);
      }
    }
  };

  app.ticker.add((tk) => {
    const dt = Math.min(0.05, ((tk.deltaMS as number) || 16) / 1000);
    renderer?.update(dt);
    for (const r of grid) r.update(dt);
  });

  const w = window as unknown as PreviewWin;
  w.__setProfiles = (data) => rebuild(data);
  w.__setScent = (scent, intensity, dir, flicker, dirDepth) => {
    curScent = scent || '';
    if (intensity !== undefined) curIntensity = intensity;
    if (dir !== undefined) curDir = dir;
    if (flicker !== undefined) curFlicker = !!flicker;
    if (dirDepth !== undefined) curDepth = dirDepth;
    renderer?.setState({ scent: curScent, intensity: curIntensity, dir: curDir, dirDepth: curDepth, flicker: curFlicker });
  };
  w.__sniff = () => renderer?.pulseBoost();
  w.__grid = (scent, intensity) => buildGrid(scent ?? curScent, intensity ?? curIntensity);
  w.__setForm = (key, value) => {
    renderer?.setFormParam(key as never, value);
    for (const r of grid) r.setFormParam(key as never, value);
  };
  // 隐藏页时 PixiJS rAF 会被节流 → 提供手动推进+渲染钩子，供截图核验（编辑器实际可见时不需要）。
  w.__force = (steps?: number) => {
    const n = steps ?? 90;
    for (let i = 0; i < n; i++) {
      renderer?.update(0.033);
      for (const r of grid) r.update(0.033);
    }
    app.render();
  };

  // 默认：加载真实 profiles 先展示香粉味（非空白）；编辑器随后会 __setProfiles 覆盖。
  try {
    const def = (await fetchAsset(TEXT_URLS.smellProfiles).then((r) => r.json())) as SmellProfilesRaw;
    rebuild(def);
    if (gridMode) buildGrid(params.get('scent') || 'baozi', Number(params.get('intensity') || 60));
  } catch {
    /* 等编辑器注入 */
  }
  w.__previewReady = true;
}

void main();
