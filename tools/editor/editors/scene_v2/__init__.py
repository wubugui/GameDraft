"""新场景画布（Document–View–Command）。

架构出处：Tiled 编辑器（`mapeditor/tiled`）的 Document / ChangeEvent / QUndoCommand
三层，以及它所基于的 Qt Undo Framework。**不是自创范式** —— 详见
`artifact/Design/场景画布重建-方案书-2026-08-23.md` §2。

一句话分工，没有一条反向箭头::

    Tool（手势）──构造──► Command（唯一能写的东西）──► Document（唯一数据 + 撤销栈）
                                                            │
                                              changed(ChangeEvent) ◄┘
                                                            ▼
                                              View（画布图元 / 覆盖物 / 属性面板）

- **View 与 Tool 对数据只读**：它们不持有可写引用，写入只能经 Command。
- **写哪一份由 Document 唯一裁决**（:meth:`SceneDocument.write_target`），
  不许调用方自己判断 —— 老画布正是把这个判断散进了几十处手势代码，
  于是"写错副本 / 半份写入"成了一条要在各处记住的口头约定。
- **撤销与重做发同一个变更事件**，所以"正着改能刷新、撤回来不刷新"写不出来。
"""
