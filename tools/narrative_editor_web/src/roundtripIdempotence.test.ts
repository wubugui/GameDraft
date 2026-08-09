/**
 * 往返字节级幂等护栏（对着**真实的** public/assets/data/narrative_graphs.json）。
 *
 * 为什么要对真文件而不是构造样本：归一化的坑全在真数据的边角上——某个元素没有 meta、
 * 某个状态的 id 与键名不一致、某个数值是 int 还是 float。构造样本只会证明构造样本没问题。
 *
 * 为什么用 `?raw` 而不是 `import ... json`：要比的是**磁盘字节**。`import json` 拿到的是
 * 解析后的对象，再序列化回去只能证明 `JSON.stringify(JSON.parse(x))` 自洽——
 * 缩进、键序、非 ASCII 转义、末尾换行这些真正会变的东西一个都测不到。
 *
 * 落盘格式的权威在 Python `tools/editor/file_io._json_text`：
 * `json.dumps(ensure_ascii=False, indent=2)` + 保证末尾换行 + 不排序键。
 * JS 侧 `JSON.stringify(x, null, 2) + '\n'` 与之逐字节一致（本文件第一条用例就在锁这件事）。
 */
import { describe, expect, it } from 'vitest';
import rawNarrativeGraphs from '../../../public/assets/data/narrative_graphs.json?raw';
import { normalizeFile } from './editorModel';
import type { NarrativeGraphsFileDef } from './types';

/** 与 Python `_json_text` 同口径的落盘序列化。 */
function toDiskText(data: unknown): string {
  const txt = JSON.stringify(data, null, 2);
  return txt.endsWith('\n') ? txt : `${txt}\n`;
}

describe('narrative_graphs.json 往返字节级幂等', () => {
  it('原始文本本身就是 _json_text 口径（缩进 2 / 不转义非 ASCII / 末尾换行 / 不排序键）', () => {
    // 这条先立住"比较的尺子"：尺子不对，后面那条绿了也没意义
    expect(toDiskText(JSON.parse(rawNarrativeGraphs))).toBe(rawNarrativeGraphs);
  });

  it('归一化后逐字节等于原文（打开→不动→保存不得改一个字节）', () => {
    const normalized = normalizeFile(JSON.parse(rawNarrativeGraphs) as NarrativeGraphsFileDef);
    expect(toDiskText(normalized)).toBe(rawNarrativeGraphs);
  });

  it('探针：抠掉一个归一化会补回的键，比对必须失败', () => {
    // 没有这条自检，上面那条"全绿"完全可能是因为它根本没在比东西
    // （比如 raw 导入拿到空串、或者两边都被同一个 stringify 洗过一遍）。
    const wounded = JSON.parse(rawNarrativeGraphs) as NarrativeGraphsFileDef;
    const element = (wounded.compositions ?? [])
      .flatMap((comp) => comp.elements ?? [])
      .find((el) => Array.isArray(el.meta?.emits));
    expect(element, '真实数据里必须有带 meta.emits 的元素，否则这条探针形同虚设').toBeTruthy();
    delete element!.meta!.emits;

    // 抠掉之后：直接序列化必然不等于原文（键少了）
    expect(toDiskText(wounded)).not.toBe(rawNarrativeGraphs);
    // 归一化会把 meta.emits 补成 []，与原文那条非空数组仍然不同 → 比对照样失败。
    // 两个方向都断言，是为了区分"探针触发了"与"归一化恰好把伤口治回原样了"。
    expect(toDiskText(normalizeFile(wounded))).not.toBe(rawNarrativeGraphs);
  });

  it('探针：私有信号的 scope 键进出都不许被归一化动', () => {
    const doc = JSON.parse(rawNarrativeGraphs) as NarrativeGraphsFileDef;
    const row = (doc.signals ?? [])[0];
    expect(row, '真实数据里必须有信号注册行').toBeTruthy();
    row!.scope = 'private';
    const normalized = normalizeFile(doc);
    expect(normalized.signals?.[0]?.scope).toBe('private');
    // 反过来：没写 scope 的行归一化后**不许**被补上默认值（补了就是往 JSON 塞噪声）
    expect(Object.prototype.hasOwnProperty.call(normalized.signals![1]!, 'scope')).toBe(false);
  });
});
