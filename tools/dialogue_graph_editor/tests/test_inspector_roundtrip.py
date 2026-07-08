"""编辑器级往返探针：保证 NodeInspector「set_node → get_node」对真实图数据语义零变化。

黄金往返（test_canvas_roundtrip_safety）只在 model 层 serialize，不经过 inspector 的表单
收集，抓不到「打开某节点 → 表单重建 → getter 回写」过程中的字段丢失 / 归一化。本探针补这个盲区：
逐个真实 graphs/*.json 的每个节点喂给 inspector 再取回，断言与原始节点深度相等。

这正是 CLAUDE.md「数据严格保存不丢失、数据格式不变」对图对话编辑器的可执行护栏。
"""
from __future__ import annotations

import copy
import json
import os
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from tools.dialogue_graph_editor.graph_document import graphs_dir
from tools.dialogue_graph_editor.node_inspector import NodeInspector
from tools.editor.project_model import ProjectModel

_PROJECT_ROOT = Path(__file__).resolve().parents[3]


def _iter_graph_files() -> list[Path]:
    d = graphs_dir(_PROJECT_ROOT)
    if not d.is_dir():
        return []
    return sorted(d.glob("*.json"), key=lambda p: p.name.lower())


class InspectorRoundtripTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        # 与真实编辑器一致：inspector 需要一个已加载工程的 ProjectModel，否则 ActionEditor 等
        # 依赖 id 选择器的控件无法回填，会误报为「丢参数」。
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def _roundtrip_node(self, inspector: NodeInspector, nid: str, node: dict) -> dict:
        inspector.set_node(nid, copy.deepcopy(node))
        return inspector.get_node()

    def test_every_shipped_node_roundtrips_without_loss(self) -> None:
        files = _iter_graph_files()
        self.assertTrue(files, "未找到任何 graphs/*.json，探针无数据可验")

        mismatches: list[str] = []
        for path in files:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as e:  # pragma: no cover - 数据损坏才触发
                mismatches.append(f"{path.name}: 无法解析 ({e})")
                continue
            nodes = data.get("nodes")
            if not isinstance(nodes, dict):
                continue
            node_ids = list(nodes.keys())
            graph_id = str(data.get("id", "") or "").strip()
            inspector = NodeInspector(
                lambda ids=node_ids: list(ids),
                project_root=_PROJECT_ROOT,
                project_model_getter=lambda: self._pm,
                dialogue_graph_id_getter=lambda gid=graph_id: gid,
            )
            for nid, node in nodes.items():
                if not isinstance(node, dict):
                    continue
                original = copy.deepcopy(node)
                try:
                    got = self._roundtrip_node(inspector, nid, node)
                except Exception as e:  # noqa: BLE001 - 任何 getter 异常都是 bug
                    mismatches.append(f"{path.name} / {nid} ({node.get('type')}): getter 抛异常 {e!r}")
                    continue
                if got != original:
                    mismatches.append(
                        f"{path.name} / {nid} ({node.get('type')}):\n"
                        f"  原始: {json.dumps(original, ensure_ascii=False, sort_keys=True)}\n"
                        f"  往返: {json.dumps(got, ensure_ascii=False, sort_keys=True)}"
                    )
            inspector.deleteLater()

        if mismatches:
            head = mismatches[:40]
            extra = f"\n…共 {len(mismatches)} 处不一致" if len(mismatches) > 40 else ""
            self.fail(
                f"inspector 往返丢失/改写了 {len(mismatches)} 个节点的数据：\n"
                + "\n".join(head)
                + extra
            )


if __name__ == "__main__":
    unittest.main()
