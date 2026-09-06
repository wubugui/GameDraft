现象：物件检视可运行和校验，但 ProjectModel 原先只加载，主编辑器没有物件检视页面与保存桶；实际使用 C03 时触及内容往返盲区。
处理：新增物件检视属性表单与热区预览、统一 object_examine 保存桶、主窗导航；信号重构和 narrative_xref 从只读改为可保存来源，保留未来只读来源的拒绝护栏。
证据：tools/editor/tests/test_object_examine_editor.py 与 test_signal_refactor.py；本轮完整收尾状态见 artifact/OpenWorld/IMPLEMENTATION.md，不能将局部检查当作全目标完成。
