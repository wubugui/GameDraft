import { describe, expect, it } from 'vitest';
import type { CanvasNode } from '../types';
import {
  buildNoteNodes,
  groupNote,
  newNote,
  newNoteId,
  normalizeAnnotationsFile,
  noteNodeId,
  notesForCanvas,
  parseNoteNodeId,
  reconcileNoteNodes,
  setGroupNote,
  setNotesForCanvas,
  setStateNote,
  setTransitionNote,
  stateNote,
  transitionNote,
} from './annotations';

describe('normalizeAnnotationsFile', () => {
  it('tolerates garbage, prunes empty levels and blank notes', () => {
    expect(normalizeAnnotationsFile(null)).toEqual({ schemaVersion: 1, states: {}, transitions: {}, groups: {}, notes: {} });
    const out = normalizeAnnotationsFile({
      states: { g: { a: '  ', b: '注意这拍' }, '': { x: 'y' } },
      transitions: { g: { t1: 3 } },
      groups: { comp: { main: { g_1: '' } } },
      notes: { comp: { main: { n_1: { x: 1.4, y: '2', width: 10, height: 'nope', text: 'hi', color: 'red' } } } },
    });
    expect(out.states).toEqual({ g: { b: '注意这拍' } });
    expect(out.transitions).toEqual({});
    expect(out.groups).toEqual({});
    expect(out.notes.comp!.main!.n_1).toEqual({ x: 1, y: 2, width: 120, height: 120, text: 'hi', color: '#f5d76e' });
  });

  it('keeps author line breaks inside a note (only all-blank notes are dropped)', () => {
    const out = setStateNote({}, 'g', 'a', '第一行\n  第二行');
    expect(stateNote(out, 'g', 'a')).toBe('第一行\n  第二行');
  });
});

describe('set / get', () => {
  it('state and transition notes are keyed by graph and pruned when emptied', () => {
    let file = setStateNote({}, 'g', 'a', '甲');
    file = setTransitionNote(file, 'g', 't1', '走这条');
    expect(stateNote(file, 'g', 'a')).toBe('甲');
    expect(transitionNote(file, 'g', 't1')).toBe('走这条');
    file = setStateNote(file, 'g', 'a', '');
    expect(file.states).toEqual({});
    expect(file.transitions).toEqual({ g: { t1: '走这条' } });
  });

  it('group notes live under composition and canvas', () => {
    let file = setGroupNote({}, 'comp', 'main', 'g_1', '这一组是教学');
    expect(groupNote(file, 'comp', 'main', 'g_1')).toBe('这一组是教学');
    expect(groupNote(file, 'comp', 'element:x', 'g_1')).toBe('');
    file = setGroupNote(file, 'comp', 'main', 'g_1', '   ');
    expect(file.groups).toEqual({});
  });

  it('sticky notes: ids do not collide, canvas layer is pruned when empty', () => {
    const first = newNote({}, 10, 20, 'a');
    let file = setNotesForCanvas({}, 'comp', 'main', { [newNoteId({})]: first });
    const notes = notesForCanvas(file, 'comp', 'main');
    expect(Object.keys(notes)).toEqual(['n_1']);
    expect(newNoteId(notes)).toBe('n_2');
    expect(notes.n_1!.color).toBe('#f5d76e');
    expect(newNote(notes, 0, 0).color).toBe('#f7b267');
    file = setNotesForCanvas(file, 'comp', 'main', {});
    expect(file.notes).toEqual({});
  });
});

describe('note nodes', () => {
  it('builds non-deletable annotation nodes and reconciles in place', () => {
    const notes = { n_1: newNote({}, 5, 6, '便签') };
    const built = buildNoteNodes(notes);
    expect(built[0]!.id).toBe(noteNodeId('n_1'));
    expect(parseNoteNodeId(built[0]!.id)).toBe('n_1');
    expect(built[0]!.deletable).toBe(false);
    expect(built[0]!.data.kind).toBe('annotationNote');

    const other: CanvasNode = { id: 'state:a', type: 'state', position: { x: 0, y: 0 }, data: { label: 'a', subtitle: '', kind: 'state' } };
    const nodes = [other, ...built];
    // 没变：同一引用
    expect(reconcileNoteNodes(nodes, notes)).toBe(nodes);
    // 改了正文：就地更新，别的节点引用不变
    const changed = reconcileNoteNodes(nodes, { n_1: { ...notes.n_1!, text: '改了' } });
    expect(changed[0]).toBe(other);
    expect(changed[1]!.data.noteText).toBe('改了');
    // 删了：节点消失
    expect(reconcileNoteNodes(nodes, {})).toEqual([other]);
    // 新增：节点出现
    expect(reconcileNoteNodes([other], notes)).toHaveLength(2);
  });
});
