"""挂点动作在 ActionEditor 里的往返与控件契约。

钉死：
- `attachToSocket` 的 target / socket / image / images 都不是裸 QLineEdit（§3 选择器铁律）；
- `images` 列表能读入、能改、能写回，且**空列表不写键**（纯静态图不该留空数组）；
- 「打开→不动→保存」逐值不变（往返保真）；
- `images` 的路径进得了素材存在性审计（写错路径不能全绿）。
"""
from __future__ import annotations

import sys
import unittest

from PySide6.QtWidgets import QApplication, QLineEdit

from tools.editor.shared.action_editor import ActionEditor
from tools.editor.shared.asset_reference_audit import _is_media_key, _walk_json
from tools.editor.shared.image_path_picker import CutsceneImagePathRow


class SocketActionParamTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, actions: list[dict]) -> ActionEditor:
        ed = ActionEditor("Actions")
        ed.set_data(actions)
        return ed

    def test_roundtrip_static_image(self) -> None:
        src = [{
            "type": "attachToSocket",
            "params": {
                "target": "player", "socket": "right_hand",
                "image": "/resources/runtime/images/props/dao.png",
                "scale": 1.0, "mirror": True,
            },
        }]
        out = self._editor(src).to_list()
        self.assertEqual(out[0]["type"], "attachToSocket")
        p = out[0]["params"]
        self.assertEqual(p["target"], "player")
        self.assertEqual(p["socket"], "right_hand")
        self.assertEqual(p["image"], "/resources/runtime/images/props/dao.png")
        self.assertNotIn("images", p, "没给多帧列表时不该凭空写出 images 键")

    def test_roundtrip_images_list_preserves_order(self) -> None:
        """顺序即帧号（images[frame]），往返必须逐项保序。"""
        urls = [f"/resources/runtime/images/props/fire_{i}.png" for i in range(3)]
        src = [{
            "type": "attachToSocket",
            "params": {"target": "npc_a", "socket": "lantern", "images": list(urls)},
        }]
        out = self._editor(src).to_list()
        self.assertEqual(out[0]["params"]["images"], urls)

    def test_empty_images_not_written(self) -> None:
        src = [{"type": "attachToSocket", "params": {"target": "player", "socket": "h"}}]
        out = self._editor(src).to_list()
        self.assertNotIn("images", out[0]["params"])

    def test_images_can_be_edited_through_widget(self) -> None:
        """从最外层入口改：拿到控件 → 加一帧 → to_list 里就该多一项。"""
        src = [{
            "type": "attachToSocket",
            "params": {"target": "player", "socket": "h", "images": ["/a.png"]},
        }]
        ed = self._editor(src)
        row = ed._rows[0]
        field = row._param_widgets["images"]
        self.assertTrue(hasattr(field, "to_list"), "images 必须是列表控件，不是裸输入框")
        field._add("/b.png")
        self.assertEqual(ed.to_list()[0]["params"]["images"], ["/a.png", "/b.png"])

    def test_no_bare_line_edit_on_reference_params(self) -> None:
        """§3 铁律：id 引用与资源路径禁裸 QLineEdit。"""
        ed = self._editor([{
            "type": "attachToSocket",
            "params": {"target": "player", "socket": "h", "image": "/a.png"},
        }])
        widgets = ed._rows[0]._param_widgets
        self.assertNotIsInstance(widgets["target"], QLineEdit, "target 是实体引用，必须用选择器")
        self.assertIsInstance(widgets["image"], CutsceneImagePathRow, "image 是资源路径，必须用图片选择器")
        self.assertNotIsInstance(widgets["socket"], QLineEdit, "socket 是受约束名，必须可选可补全")

    def test_detach_params_are_selectors_too(self) -> None:
        ed = self._editor([{
            "type": "detachFromSocket", "params": {"target": "player", "socket": "h"},
        }])
        widgets = ed._rows[0]._param_widgets
        self.assertNotIsInstance(widgets["target"], QLineEdit)
        self.assertNotIsInstance(widgets["socket"], QLineEdit)
        out = ed.to_list()[0]["params"]
        self.assertEqual((out["target"], out["socket"]), ("player", "h"))

    def test_open_and_save_injects_nothing(self) -> None:
        """最小形态打开再保存必须逐值不变。

        这条是真 bug 的护栏（2026-08-04）：泛型控件会把 anchorX/anchorY 注入成 0，
        那不是格式漂移而是**改行为**——支点从图心跳到贴图左上角；
        同理 lit/mirror 被注入 false 会关掉光照与翻面。打开一个过场就毁掉全项目挂件。
        """
        src = {"target": "player", "socket": "right_hand", "image": "/a.png"}
        out = self._editor([{"type": "attachToSocket", "params": dict(src)}]).to_list()
        self.assertEqual(out[0]["params"], src)

    def test_prop_only_form_stays_prop_only(self) -> None:
        """贴图由预设提供时，不许顺手补一个 image:""。"""
        src = {"target": "player", "socket": "h", "prop": "taomu_jian"}
        out = self._editor([{"type": "attachToSocket", "params": dict(src)}]).to_list()
        self.assertEqual(out[0]["params"], src)

    def test_explicit_zero_anchor_is_authorable(self) -> None:
        """支点 0（贴图左/上边缘）是合法值，不能因为"看着像空"被剔掉。"""
        src = {"target": "p", "socket": "s", "image": "/a.png", "anchorX": 0, "anchorY": 0}
        out = self._editor([{"type": "attachToSocket", "params": dict(src)}]).to_list()
        self.assertEqual(out[0]["params"], src)

    def test_mirror_and_lit_roundtrip_as_real_booleans(self) -> None:
        """运行时默认 true，所以 false 必须配得出来、且落库是真 bool 不是 "false"。"""
        src = {"target": "p", "socket": "s", "prop": "x", "mirror": False, "lit": True}
        out = self._editor([{"type": "attachToSocket", "params": dict(src)}]).to_list()
        p = out[0]["params"]
        self.assertIs(p["mirror"], False)
        self.assertIs(p["lit"], True)

    def test_scoped_omit_does_not_leak_to_other_actions(self) -> None:
        """image 在 attachToSocket 是可选、在 showOverlayImage 是必填——按名剔除会误伤。"""
        src = {"id": "a", "image": "/x.png", "xPercent": 50, "yPercent": 50, "widthPercent": 30}
        out = self._editor([{"type": "showOverlayImage", "params": dict(src)}]).to_list()
        self.assertEqual(out[0]["params"], src)

    def test_images_entries_reach_asset_audit(self) -> None:
        """列表元素本身没有键名——父键继承必须生效，否则写错路径收尾校验全绿。"""
        doc = {"actions": [{"type": "attachToSocket",
                            "params": {"images": ["/resources/runtime/images/props/a.png"]}}]}
        hits = [(path, key, val) for path, key, val in _walk_json(doc)
                if isinstance(val, str) and _is_media_key(key)]
        self.assertTrue(hits, "images 里的路径必须被媒体键遍历捞到")
        self.assertEqual(hits[0][2], "/resources/runtime/images/props/a.png")


if __name__ == "__main__":
    unittest.main()
