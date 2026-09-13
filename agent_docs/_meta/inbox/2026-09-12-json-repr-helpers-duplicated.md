---
target: numeric-roundtrip-fidelity
date: 2026-09-12
session: 手持光源（火把）编辑器侧
---

现象: 卡里只给了 `preserve_numeric_repr`（整 dict、不递归）与「种子快照法」的说法，但真实需要的两个配件——**单值版**的「相等就回吐原表示」和**按磁盘原序重排键**——库里没有出口，于是同一天被独立写了两份（`light_follow_ui._num_repr_like/_reorder_like` 与 `prop_preset_blocks.num_repr_like/reorder_like`）。
证据: `grep -n "_num_repr_like\|_reorder_like" tools/editor/editors/light_follow_ui.py` 与 `grep -n "num_repr_like\|reorder_like" tools/editor/editors/prop_preset_blocks.py`；两份逻辑逐字等价（都是三行纯函数）。
建议: 把这两个连同「嵌套 dict 逐层保真」的用法提到 `tools/editor/shared/numeric_roundtrip.py`（契约 4 键序那条正好缺一个可调用的出口），卡里点名该出口，两处改为引用。
