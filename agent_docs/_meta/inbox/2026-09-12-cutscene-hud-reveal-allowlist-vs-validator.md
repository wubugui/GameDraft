---
target: content-expression-channels
date: 2026-09-12
session: 路遇私铸钱改过场（主线_铜钱脱落滚走）
---

现象: `src/data/cutscene_action_allowlist.json` 放行了 `setThreeFiresVisible` / `setSmellVisible`（运行时过场里真能执行，无头实测三把火 debut 在过场中正常登场），但 `tools/editor/validator.py` 按 `ACTION_PERSISTENCE=="save"` 一刀切报 ERR「会修改全局存档状态，必须放到 startCutscene 外层」——两处口径打架，只是之前没有任何过场用过这两个动作所以没人撞上。`showSystemNote`（说明卡）不在白名单，过场中段弹引导卡纯数据做不到。
证据: validate-data 对该过场报 step #36 / #51.3 两条 ERR；白名单与 `_CUTSCENE_STAGING_SAVE_ACTIONS`（validator.py ~8355）对照即见。
建议: 由制作人审定——HUD 首现类（三把火/气味显隐 + 说明卡）是否与 persist* 一样列为过场可用的存档写入；定了之后白名单、validator 豁免、`CUTSCENE_FAST_FORWARD_SKIP_ACTIONS`（说明卡要等点击）三处一起改。
