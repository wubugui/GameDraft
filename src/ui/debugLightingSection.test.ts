import { describe, expect, it } from 'vitest';

import PANEL_UI from './DebugPanelUI.ts?raw';
import SECTION from './debugLightingSection.ts?raw';
import DEFAULTS from '../rendering/lighting/lightDefaults.ts?raw';

/**
 * F2「光影」页的结构契约。
 *
 * 制作人 2026-08-21:「给我在 F2 里搞个独立的 tab 面板,**不是 section**!
 * 我在这面板里面可以创建和操作任意类型的灯光,让我自己来验收」。
 *
 * 这份锁的是那句话里能机械验的部分:①它确实是一个 tab 不是 section 列表里的一块;
 * ②四种灯型都能新建;③灯的每个字段都有入口。UI 长什么样不在这里管——
 * 那是真机的事,这里只保证"接线没断"。
 */

describe('是独立 tab，不是「工具」页里的一块', () => {
  it('注册了 lighting tab 与它的面板容器', () => {
    expect(PANEL_UI).toContain("const TAB_LIGHTING = 'lighting';");
    expect(PANEL_UI).toContain("mkTab(TAB_LIGHTING, '光影');");
    expect(PANEL_UI).toContain("this.panelLighting = this.mkPanel('lighting-panel');");
    expect(PANEL_UI).toContain("this.panelLighting.classList.toggle('is-active', id === TAB_LIGHTING);");
  });

  it('两个光影 section 都被判为「独占 tab」——不许漏进「工具」页', () => {
    // isDedicatedTabSection 返回 false 的 section 会被 appendSectionBlocks 收进工具页，
    // 于是同一块内容在两页各出现一次，改一处另一处不同步。
    const i = PANEL_UI.indexOf('function isDedicatedTabSection');
    const j = PANEL_UI.indexOf('}', PANEL_UI.indexOf('return (', i));
    const body = PANEL_UI.slice(i, j);
    expect(body).toContain('LIGHTING_DEBUG_SECTION_ID');
    expect(body).toContain('LIGHTING_SCENE_SECTION_ID');
  });

  it('renderLighting 把两块都收进同一页（灯的工作台 + 场景参数）', () => {
    expect(PANEL_UI).toContain(
      '(id) => id === LIGHTING_DEBUG_SECTION_ID || id === LIGHTING_SCENE_SECTION_ID,');
    expect(PANEL_UI).toContain('this.renderLighting();');
  });
});

describe('四种灯型都能建、都能改', () => {
  it('新建按钮覆盖四种', () => {
    expect(SECTION).toContain("(['point', 'spot', 'area', 'directional'] as LightKind[]).forEach");
    for (const label of ['点光', '聚光', '面光', '平行光']) {
      expect(SECTION).toContain(label);
    }
  });

  it('灯型专属字段各有入口', () => {
    // spot
    expect(SECTION).toContain('innerAngleDeg');
    expect(SECTION).toContain('outerAngleDeg');
    // area
    expect(SECTION).toContain('twoSided');
    expect(SECTION).toContain("put({ size: [v, sz[1]] })");
    // directional
    expect(SECTION).toContain('elevationDeg');
    expect(SECTION).toContain('azimuthDeg');
    // 通用
    for (const f of ['intensity', 'kelvin', 'range', 'softeningRadius', 'castShadow', 'pos']) {
      expect(SECTION).toContain(f);
    }
  });

  it('换灯型会摘掉对新型无意义的字段（留着是静默失效）', () => {
    // 新建/换型的缺省值住在 lightDefaults：画面上摆灯那条入口（authoring/）用的是同一份，
    // 两个作者面新建出来的灯必须一模一样，这段不许再复制回本页。
    expect(DEFAULTS).toContain('export function retype(');
    // retype 从 makeLight 起手，所以新型的必需字段一定齐；旧型的多余字段不会被带过去
    expect(DEFAULTS).toContain('const fresh = makeLight([], kind);');
    expect(SECTION).toContain("from '../rendering/lighting/lightDefaults';");
  });
});

describe('独奏是临时视图状态，不许写进数据', () => {
  it('导出时把独奏修回去，而不是去动运行时视图', () => {
    // 落盘收回了编辑器（它拉走 params 再 Save All），所以"别把独奏当作者意图"
    // 这件事发生在**导出那一刻**：`exportFixup` 只修交出去的那份 def，
    // 不去改屏幕上正看着的状态（退独奏会让画面当场跳一下，那是副作用不是修复）。
    expect(SECTION).toContain('isSoloActive: () => solo !== null,');
    expect(SECTION).toContain('exportFixup: (def) => {');
    // 没在独奏就原样交出去，不做任何多余改写
    expect(SECTION).toContain('if (!solo || !preSolo) return def;');
  });

  it('修回去的是每盏灯原来的开关，而不是一律点亮', () => {
    expect(SECTION).toContain('preSolo!.get(l.id) ?? true');
  });

  it('导出通道确实调了 exportFixup（不调 = 把"只亮这盏"当数据交出去）', async () => {
    const SYNC = (await import('../dev/runtimeLightingSync.ts?raw')).default;
    expect(SYNC).toContain('this.deps.exportFixup(params)');
  });

  it('游戏侧不再有写盘通道', () => {
    // 2026-08-21 拍板：工程只能有一个写盘出口（编辑器 save_all）。
    // 这两个字一旦回来，就是又多了一条能与编辑器互相覆盖的路。
    expect(SECTION).not.toContain('scene-lighting');
    expect(SECTION).not.toContain('deps.save');
  });
});

describe('单位与尺度锚', () => {
  it('缺省值直接引运行时常量，不写死数字', () => {
    expect(SECTION).toContain("} from '../rendering/lighting/lightPacking';");
    expect(SECTION).toContain('DEFAULT_LIGHT_RANGE_WU');
    expect(SECTION).toContain('DEFAULT_LAMP_RADIUS_WU');
    expect(SECTION).toContain('CHARACTER_HEIGHT_WU');
    expect(SECTION).toContain('SHADOW_LIGHT_BUDGET');
  });

  it('面板里不出现「米」这个不存在的单位', () => {
    const code = (SECTION + '\n' + DEFAULTS).split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toContain('Meters');
    expect(code).not.toContain('metersPerWu');
  });
});
