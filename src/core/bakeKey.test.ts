import { describe, expect, it } from 'vitest';

import { bakeKeyFromBackground, sceneBakeDirUrl } from './projectPaths';

/**
 * 「场景背景与烘焙数据绑死」的路径契约（制作人 2026-08-30 定）。
 *
 * 规矩本身一句话：**运行时拿当前生效的背景图名当 key，去同场景目录下找同名 bake**。
 * 它要解决的现实问题是：烘焙产物原来一个场景只有一份、目录名写死 `lighting`，
 * 于是「白天一张图、夜里另一张图」根本没有地方放第二份 —— 换背景必然错配。
 */
describe('bakeKeyFromBackground：图名 → 烘焙基名', () => {
  it('去扩展名，纯文件名原样保留', () => {
    expect(bakeKeyFromBackground('background.png')).toBe('background');
  });

  it('中文与下划线不动 —— 目录名就是它', () => {
    expect(bakeKeyFromBackground('background_relight_夜.png')).toBe('background_relight_夜');
  });

  it('带子目录时只取文件名那一段', () => {
    expect(bakeKeyFromBackground('layers/bg_main.png')).toBe('bg_main');
    expect(bakeKeyFromBackground('layers\\bg_main.png')).toBe('bg_main');
  });

  it('多个点只切最后一个', () => {
    expect(bakeKeyFromBackground('bg.v2.final.png')).toBe('bg.v2.final');
  });

  it('没有扩展名就是它自己', () => {
    expect(bakeKeyFromBackground('background')).toBe('background');
  });

  it('空值必须响，不许静默给个空目录', () => {
    // 静默返回 '' 会让 URL 变成 `<scene>/lighting/`，恰好命中**旧的扁平布局**，
    // 于是"图名错了"会伪装成"加载成功"——正是最难查的那种。
    expect(() => bakeKeyFromBackground('')).toThrow();
    expect(() => bakeKeyFromBackground('   ')).toThrow();
  });
});

describe('sceneBakeDirUrl：两套烘焙产物按同一个 key 分', () => {
  it('lighting（角色 probe 载荷）', () => {
    expect(sceneBakeDirUrl('雾津街头', 'background.png', 'lighting'))
      .toBe('/resources/runtime/scenes/雾津街头/lighting/background');
  });

  it('lighting2（几何场）—— 与 lighting 同一个 key', () => {
    // 两者是**同一张背景图**的派生物（实测两边 lighting.json / meta.json 的
    // background_sha1 逐字相同），所以必须按同一个名字分，不能各分各的。
    expect(sceneBakeDirUrl('雾津街头', 'background.png', 'lighting2'))
      .toBe('/resources/runtime/scenes/雾津街头/lighting2/background');
  });

  it('换背景 = 换目录（这条就是整个设计的目的）', () => {
    const day = sceneBakeDirUrl('雾津街头', 'background.png', 'lighting');
    const night = sceneBakeDirUrl('雾津街头', 'background_relight_夜.png', 'lighting');
    expect(day).not.toBe(night);
    expect(night).toBe('/resources/runtime/scenes/雾津街头/lighting2/background_relight_夜'
      .replace('lighting2', 'lighting'));
  });
});
