"""全量复扫：逐个 action 用「manifest 最小形态」过 ActionEditor 往返，报凭空长出来的键。

跑法（仓库根）::

    sh scripts/py.sh -m tools.editor.tests.scan_action_minimal_roundtrip

判据（与 [[numeric-roundtrip-fidelity]] 硬契约 1 同源）：只填 `actionParamManifest.ts` 的
required/nonEmpty，**可选参数一律不写**，`ActionEditor.set_data → to_list` 之后 params 里
不得多出任何键。多出来的键分两档：

- **行为级**：控件中性值 ≠ 运行时默认（写 0 把"沿用默认"翻成"钉死成 0"），或空串被运行时
  当成"填了但解析不出"（位置引用 `at`）。修法进 `_ACTION_PARAM_RUNTIME_DEFAULTS`
  （按运行时默认 seed 控件 + 缺键且仍为默认时不回写）。
- **格式级**：空串/空列表在运行时同义于缺键，只是往返改字节。修法进
  `_ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT`。

⚠ 参数名通用的（x/y/at/surface/kind/seed/strength/count*/title/actions…）**必须走作用域表**，
进按名的全局表 `_OMIT_WHEN_ABSENT_AND_DEFAULT` 会误伤别的 action。

⚠ 本脚本不是 pytest 用例：探针值是按类型猜的（required 参数填 `probe_<名>`/1/1.0/True），
个别 action 的最小形态可能构造不出合法值——那类只会落进末尾的"构造/往返报错"清单，
不是漂移证据。收口后的回归锁在 `test_action_condition_data_safety.py`
（`test_<action>_minimal_form_does_not_grow_*` 一族）。
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared.action_editor import (  # noqa: E402
    ACTION_TYPES,
    _PARAM_SCHEMAS,
    ActionEditor,
)

# manifest 明确不收录的（见 actionParamManifest.ts 头注释：未在 ActionExecutor 注册 handler，
# 只有调试通道用）——不是漏登记，别报。
_MANIFEST_EXEMPT = {"setNarrativeState"}

# 子动作列表 / 条件树这类结构参数：探针给空壳即可（值本身不是扫描对象）。
_LIST_PARAMS = {
    "actions", "elseActions", "aboveActions", "belowActions", "options", "slots", "lines", "images",
}


def _manifest_entries() -> dict[str, dict[str, set[str]]]:
    """解析 actionParamManifest.ts（只读权威）：type → {required, nonEmpty, optional}。"""
    text = (REPO / "src/core/actionParamManifest.ts").read_text("utf-8")
    out: dict[str, dict[str, set[str]]] = {}
    for m in re.finditer(r"^\s{2}([A-Za-z][A-Za-z0-9]*)\s*:\s*\{", text, re.MULTILINE):
        name = m.group(1)
        i = m.end() - 1  # 指向 '{'
        depth = 0
        j = i
        while j < len(text):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        block = text[i:j + 1]
        buckets: dict[str, set[str]] = {"required": set(), "nonEmpty": set(), "optional": set()}
        for key in buckets:
            km = re.search(key + r"\s*:\s*\[([^\]]*)\]", block)
            if km:
                buckets[key] = set(re.findall(r"'([^']+)'", km.group(1)))
        out[name] = buckets
    return out


def _probe_value(pname: str, ptype: str | None) -> object:
    if pname in _LIST_PARAMS:
        return []
    if pname == "condition":
        return {"timePhase": "夜"}
    if ptype == "int":
        return 1
    if ptype in ("float",):
        return 1.0
    if ptype in ("bool", "flag_val"):
        return True
    return f"probe_{pname}"


def _minimal_params(act: str, entry: dict[str, set[str]]) -> dict:
    schema = dict(_PARAM_SCHEMAS.get(act, []))
    return {
        pname: _probe_value(pname, schema.get(pname))
        for pname in sorted(entry["required"] | entry["nonEmpty"])
    }


def main() -> int:
    app = QApplication.instance() or QApplication([])
    model = ProjectModel()
    model.load_project(REPO)
    scenes = model.all_scene_ids()
    scene_id = scenes[0] if scenes else None
    man = _manifest_entries()

    grown: dict[str, dict] = {}
    errors: dict[str, str] = {}
    for act in ACTION_TYPES:
        if act in _MANIFEST_EXEMPT:
            continue
        entry = man.get(act)
        if entry is None:
            errors[act] = "manifest 缺该 action（parity 破了，见 test_action_manifest_parity）"
            continue
        prm = _minimal_params(act, entry)
        try:
            ed = ActionEditor("scan")
            ed.set_project_context(model, scene_id)
            ed.set_data([{"type": act, "params": json.loads(json.dumps(prm))}])
            out = ed.to_list()[0]
            ed.deleteLater()
        except Exception as exc:  # noqa: BLE001
            errors[act] = f"{type(exc).__name__}: {exc}"
            continue
        extra = {k: v for k, v in (out.get("params") or {}).items() if k not in prm}
        if extra:
            grown[act] = extra
    app.processEvents()

    print(f"扫了 {len(ACTION_TYPES) - len(_MANIFEST_EXEMPT)} 个 action；凭空长键的 {len(grown)} 个"
          + ("：" if grown else "（干净）"))
    for act, extra in sorted(grown.items()):
        print(f"  {act}: {json.dumps(extra, ensure_ascii=False)}")
    if errors:
        print(f"\n最小形态构造/往返报错 {len(errors)} 个（探针值不合法，非漂移证据）：")
        for act, msg in sorted(errors.items()):
            print(f"  {act}: {msg}")
    return 1 if grown else 0


if __name__ == "__main__":
    raise SystemExit(main())
