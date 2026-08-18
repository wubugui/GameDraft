---
target: missing
date: 2026-08-17
session: 物件自身用途 ItemDef.use 落地
---

现象: `[tag:…]` 的保存期引用校验对**动作树内的玩家可见文本**只覆盖一张动作白名单（`playScriptedDialogue.lines[].text/speaker`、`chooseAction.prompt/options[].text`、`removeCurrency.amount` + 四个嵌套容器），`showNotification.text` 这类同样是玩家可见文案的参数不在其中——打错的 `[tag:item:xxx]` 存得下去，运行时静默渲染成兜底串。这是**全项目所有动作树**共有的缺口（任务/场景/遭遇/物件用途都经同一只 walker），库内没有卡说明这条边界。
证据: `tools/editor/shared/ref_validator.py::walk_action_defs_embedded_refs` 的 `if/elif` 链即全部覆盖面；`tools/editor/tests/test_item_use_and_tags.py::ItemUseEmbeddedRefTests::test_dangling_ref_inside_use_actions_is_caught` 的注释记了取样理由（用 chooseAction 而非 showNotification 才测得出接线）。
建议: 要么按 `actionParamManifest` 里"哪些参数是玩家可见文本"驱动扫描（消灭白名单这份手工镜像），要么至少建一张卡写明"参数级覆盖是白名单，不是全量"，免得后来者像我一样先以为自己漏接了线。
