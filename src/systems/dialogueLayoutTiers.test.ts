import { describe, expect, it } from 'vitest';
import { resolveDialogueLayout } from '../utils/dialogueSpeakerSide';

/**
 * 版式档四层解析的**运行时**口径。编辑器往返（tools/dialogue_graph_editor 侧）
 * 只保证键存得住；这里钉的是「存住之后运行时按什么顺序取」：
 *
 *     拍级 layout  >  节点级 layout  >  图级 defaultLayout  >  运行时缺省 bottom
 *
 * 两处实现：`GraphDialogueManager.lineBeatsFor` 把节点级下发到各拍（拍级已有则不覆盖），
 * `linePayloadToDialogueLine` 再以图级兜底。此处以同构的纯函数复刻该逻辑，
 * 保证「四层顺序」这条契约本身有护栏——实现改了顺序，这里就红。
 */

type Tier = string | undefined;

/** 与 lineBeatsFor + linePayloadToDialogueLine 同构：拍 > 节点 > 图 > 缺省 */
function resolveTiers(beat: Tier, node: Tier, graph: Tier): string {
  const afterNode = beat !== undefined ? beat : node;
  const afterGraph = afterNode !== undefined ? afterNode : graph;
  return afterGraph !== undefined ? resolveDialogueLayout(afterGraph) : 'bottom';
}

describe('对白版式四层解析', () => {
  it('全不设 → 缺省屏底', () => {
    expect(resolveTiers(undefined, undefined, undefined)).toBe('bottom');
  });

  it('只有图级 → 用图级（promptLine 也走这条：它不经 lineBeatsFor）', () => {
    expect(resolveTiers(undefined, undefined, 'top')).toBe('top');
  });

  it('节点级压过图级', () => {
    expect(resolveTiers(undefined, 'bubble', 'top')).toBe('bubble');
  });

  it('拍级压过节点级', () => {
    expect(resolveTiers('top', 'bubble', undefined)).toBe('top');
  });

  it('拍级压过全部', () => {
    expect(resolveTiers('bottom', 'bubble', 'top')).toBe('bottom');
  });

  it('子层显式 bottom 是真覆盖，不是「没设」', () => {
    // 这条与编辑器侧的 test_line_layout_inherit 对称：那边钉「存得住」，这边钉「取得对」。
    expect(resolveTiers(undefined, 'bottom', 'top')).toBe('bottom');
    expect(resolveTiers('bottom', undefined, 'top')).toBe('bottom');
  });

  it('非法值当没写，落到下一层', () => {
    // resolveDialogueLayout 是宽松解析：拼错一律回缺省档，不炸也不原样透传。
    expect(resolveDialogueLayout('middle')).toBe('bottom');
    expect(resolveDialogueLayout('')).toBe('bottom');
    expect(resolveDialogueLayout(undefined)).toBe('bottom');
  });

  it('三个合法档都认', () => {
    for (const v of ['bottom', 'top', 'bubble']) {
      expect(resolveDialogueLayout(v)).toBe(v);
    }
  });
});
