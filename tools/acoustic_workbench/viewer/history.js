'use strict';
/* 声学工作台 · 撤销/重做（与轨迹工作台同一份快照式实现）。
 * 文档很小（几十个反射面 + 参数），每次提交整份 JSON 串；拖拽期间只在开始/结束各拍一次
 * （中间的连续变动合成一条记录）。`commit` 落在拖拽里时不单独入栈，归到那次拖拽。 */

class History {
  constructor(opts) {
    this.get = opts.get;            // () → doc
    this.set = opts.set;            // (doc) → void（调用方负责重画 / 重算）
    this.onChange = opts.onChange;  // 栈变了（按钮态、状态栏）
    this.limit = opts.limit || 200;
    this.undoStack = [];
    this.redoStack = [];
    this._drag = null;
  }
  snapshot() { return JSON.stringify(this.get()); }
  /** 一次原子改动。返回是否真的改了什么。 */
  commit(label, fn) {
    if (this._drag) { fn(); return true; }
    const before = this.snapshot();
    fn();
    const after = this.snapshot();
    if (before === after) return false;
    this._push({ label, before, after });
    return true;
  }
  beginDrag(label) { if (this._drag) return; this._drag = { label, before: this.snapshot() }; }
  inDrag() { return !!this._drag; }
  relabel(label) { if (this._drag) this._drag.label = label; }
  endDrag() {
    const d = this._drag; this._drag = null;
    if (!d) return false;
    const after = this.snapshot();
    if (after === d.before) return false;
    this._push({ label: d.label, before: d.before, after });
    return true;
  }
  cancelDrag() {
    const d = this._drag; this._drag = null;
    if (d) this.set(JSON.parse(d.before));
  }
  /** 丢掉进行中的拖拽但**不**回滚 doc（doc 本身正在被整份换掉时用） */
  discardDrag() { this._drag = null; }
  _push(e) {
    this.undoStack.push(e);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    if (this.onChange) this.onChange();
  }
  undo() {
    if (this._drag) this.cancelDrag();
    const e = this.undoStack.pop();
    if (!e) return null;
    this.set(JSON.parse(e.before));
    this.redoStack.push(e);
    if (this.onChange) this.onChange();
    return e.label;
  }
  redo() {
    if (this._drag) this.cancelDrag();
    const e = this.redoStack.pop();
    if (!e) return null;
    this.set(JSON.parse(e.after));
    this.undoStack.push(e);
    if (this.onChange) this.onChange();
    return e.label;
  }
  clear() { this.undoStack.length = 0; this.redoStack.length = 0; this._drag = null; if (this.onChange) this.onChange(); }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  peekUndo() { return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : ''; }
  peekRedo() { return this.redoStack.length ? this.redoStack[this.redoStack.length - 1].label : ''; }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { History };
