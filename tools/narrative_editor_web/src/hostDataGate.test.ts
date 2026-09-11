import { describe, expect, it } from 'vitest';
import { EMPTY_FALLBACK_SOURCE, isHostDataLoaded } from './bridge';

/**
 * 2026-09-09 事故护栏：宿主（PySide 壳）只能在真数据灌进 React state 之后才看得到
 * window.__narrativeEditor。挂载瞬间来源为空、加载失败兜底是 `empty fallback`——两种
 * 情况下画布里都是空白初始文档，被宿主 Save All 收走就等于把全部编排抹掉。
 */
describe('isHostDataLoaded（宿主可见门）', () => {
  it('还没加载完（来源为空）：不对宿主暴露', () => {
    expect(isHostDataLoaded('')).toBe(false);
  });

  it('加载失败兜底（empty fallback）：那份仍是空白文档，不对宿主暴露', () => {
    expect(isHostDataLoaded(EMPTY_FALLBACK_SOURCE)).toBe(false);
    expect(EMPTY_FALLBACK_SOURCE).toBe('empty fallback');
  });

  it('真实来源（工程模型 / 本地草稿 / 运行时文件）：允许宿主读走', () => {
    for (const source of ['ProjectModel', 'local draft', 'runtime file']) {
      expect(isHostDataLoaded(source)).toBe(true);
    }
  });
});
