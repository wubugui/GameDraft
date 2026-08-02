import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ReferencePickerModal,
  filterReferenceEntries,
  findReferenceEntry,
} from './ReferencePickerModal';
import type { ReferenceCatalogEntryDef } from '../types';
import { dialogueStubIdError, ParamField, templateReferenceEntries } from '../TemplatesPanel';
import { EntityNarrativeInspector } from '../NarrativeEditorApp';
import { emptyCatalog } from '../editorModel';

const entries: ReferenceCatalogEntryDef[] = [
  {
    kind: 'npc',
    id: 'npc_guard',
    qualifiedId: 'dock:npc_guard',
    label: '守门官差',
  },
  {
    kind: 'sceneGroup',
    id: 'dock:guards',
    qualifiedId: 'dock:guards',
    label: '官差组',
  },
];

describe('ReferencePickerModal', () => {
  it('filters by type, qualified id, label and legacy alias', () => {
    expect(filterReferenceEntries(entries, 'sceneGroup 官差')).toEqual([entries[1]]);
    expect(filterReferenceEntries(entries, 'dock:npc')).toEqual([entries[0]]);
    expect(filterReferenceEntries(entries, '守门')).toEqual([entries[0]]);
    expect(filterReferenceEntries(entries, 'npc_guard')).toEqual([entries[0]]);
  });

  it('recognises a legacy alias without rewriting it', () => {
    expect(findReferenceEntry(entries, 'npc_guard')).toBe(entries[0]);
    expect(findReferenceEntry(entries, 'dangling_old_value')).toBeUndefined();
  });

  it('renders an independent searchable dialog with type, qualified id and label', () => {
    const html = renderToStaticMarkup(
      <ReferencePickerModal
        open
        title="选择绑定对象"
        entries={entries}
        currentValue="dangling_old_value"
        onClose={() => undefined}
        onSelect={() => undefined}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('type="search"');
    expect(html).toContain('sceneGroup');
    expect(html).toContain('dock:guards');
    expect(html).toContain('官差组');
    expect(html).toContain('未登记旧值');
  });

  it('offers an explicit ID definition flow for open namespaces', () => {
    const html = renderToStaticMarkup(
      <ReferencePickerModal
        open
        title="定义系统归属"
        entries={[]}
        currentValue=""
        allowCustom
        onClose={() => undefined}
        onSelect={() => undefined}
      />,
    );
    expect(html).toContain('定义开放命名空间 ID');
    expect(html).toContain('定义并选用');
    expect(html).toContain('aria-label="定义引用 ID"');
  });

  it('renders template references as popup pickers and keeps an explicit new-stub flow', () => {
    const catalog = {
      ...emptyCatalog,
      sceneIds: ['dock', 'mountain'],
      dialogueGraphIds: ['talk_existing'],
    };
    expect(templateReferenceEntries('sceneRef', catalog).map((row) => row.id)).toEqual(['dock', 'mountain']);

    const sceneHtml = renderToStaticMarkup(
      <ParamField
        param={{ name: 'scene', type: 'sceneRef', required: true }}
        value="dock"
        catalog={catalog}
        onChange={() => undefined}
      />,
    );
    expect(sceneHtml).toContain('选择…');
    expect(sceneHtml).not.toContain('<select');

    const dialogueHtml = renderToStaticMarkup(
      <ParamField
        param={{ name: 'dialogue', type: 'dialogueRef' }}
        value="new_missing_stub"
        catalog={catalog}
        onChange={() => undefined}
      />,
    );
    expect(dialogueHtml).toContain('新建对话桩引用…');
    expect(dialogueHtml).toContain('new_missing_stub');
    expect(dialogueHtml).not.toContain('<datalist');
    expect(dialogueStubIdError('../escape')).not.toBe('');
    expect(dialogueStubIdError('寻狗_新对话')).toBe('');
  });

  it('renders the entity overview owner as a popup picker instead of a long select', () => {
    const html = renderToStaticMarkup(
      <EntityNarrativeInspector
        index={{
          owners: [{
            ownerType: 'npc',
            ownerId: 'npc_guard',
            ownerKey: 'npc:npc_guard',
            wrappers: [],
          }],
        }}
        selectedOwnerKey="npc:npc_guard"
        onSelectOwnerKey={() => undefined}
        setCompositionId={() => undefined}
        setGraphRef={() => undefined}
        setSelectedId={() => undefined}
        setSelectedJson={() => undefined}
        setFitTargetNodeIds={() => undefined}
        setFitViewRev={() => undefined}
      />,
    );
    expect(html).toContain('npc:npc_guard');
    expect(html).toContain('选择…');
    expect(html).not.toContain('<select');
  });
});
