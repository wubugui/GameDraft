import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PRIVATE_SIGNAL_HINT, SignalPickerModal } from './SignalPickerModal';
import type { NarrativeGraphsFileDef } from '../types';

const data = {
  schemaVersion: 3,
  signals: [
    { id: 'box_open', label: '开箱', scope: 'private' },
    { id: 'main_go', label: '主线推进' },
  ],
  compositions: [{
    id: 'comp',
    mainGraph: {
      id: 'flow', ownerType: 'flow', initialState: 'a',
      states: { a: { id: 'a' } }, transitions: [],
    },
    elements: [],
  }],
} as unknown as NarrativeGraphsFileDef;

function render() {
  return renderToStaticMarkup(
    <SignalPickerModal
      open
      data={data}
      currentSignal="main_go"
      onClose={() => {}}
      onSelect={() => {}}
      onDataChange={() => {}}
    />,
  );
}

describe('信号登记表的私有勾选', () => {
  it('私有信号行带徽章与 private 类名，全局行两样都没有', () => {
    const html = render();
    expect(html).toContain('🔒私有');
    expect(html).toContain('signal-row-wrap private');
    // 全局行不该被误标：整份 markup 里 private 类名只出现在私有那一行上
    expect(html.match(/signal-row-wrap private/g)).toHaveLength(1);
    expect(html).toContain('只投给发射方 owner 的 wrapper');
  });

  it('作者信号每行都给「私有」勾选框，私有行是勾上的', () => {
    const html = render();
    // 两条作者信号 → 两个行内勾选框，加上新建表单里那个 = 3
    expect(html.match(/signal-row-scope-toggle/g)).toHaveLength(3);
    expect(html).toContain('checked=""');
  });

  it('tooltip 说清语义：只投给发射方 owner 的 wrapper 图、主线听不到', () => {
    expect(PRIVATE_SIGNAL_HINT).toContain('发射方 owner');
    expect(PRIVATE_SIGNAL_HINT).toContain('永远收不到');
    expect(PRIVATE_SIGNAL_HINT).toContain('不写 scope 键');
    expect(render()).toContain('发射方 owner');
  });

  it('派生信号不给勾选框（没有注册行，谈不上投递面）', () => {
    const withDerived = {
      ...data,
      compositions: [{
        id: 'comp',
        mainGraph: {
          id: 'flow', ownerType: 'flow', initialState: 'a',
          states: { a: { id: 'a', broadcastOnEnter: true } }, transitions: [],
        },
        elements: [],
      }],
    } as unknown as NarrativeGraphsFileDef;
    const html = renderToStaticMarkup(
      <SignalPickerModal
        open
        data={withDerived}
        currentSignal="state:flow:a"
        onClose={() => {}}
        onSelect={() => {}}
        onDataChange={() => {}}
      />,
    );
    expect(html).toContain('state:flow:a');
    // 两条作者信号 + 新建表单 = 3；派生那条不加
    expect(html.match(/signal-row-scope-toggle/g)).toHaveLength(3);
  });
});
