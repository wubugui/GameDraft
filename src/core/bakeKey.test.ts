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

describe('sceneBakeDirUrl：一张背景图 = 一个烘焙目录', () => {
  it('probe 载荷与几何场同住一个目录', () => {
    // 2026-08-31 收束：probe 图集/体素卷（角色受光）与法线/天穹可见性（场景受光）
    // 都是**同一张背景图**的派生物（实测两边 background_sha1 逐字相同），
    // 由同一个工具（character_lighting_lab）产出，所以住同一个目录。
    // 此前几何场另住 `lighting2/`，是同一份东西被切成两半放。
    expect(sceneBakeDirUrl('雾津街头', 'background.png'))
      .toBe('/resources/runtime/scenes/雾津街头/lighting/background');
  });

  it('换背景 = 换目录（这条就是整个设计的目的）', () => {
    const day = sceneBakeDirUrl('雾津街头', 'background.png');
    const night = sceneBakeDirUrl('雾津街头', 'background_relight_夜.png');
    expect(day).not.toBe(night);
    expect(night).toBe('/resources/runtime/scenes/雾津街头/lighting/background_relight_夜');
  });
});
