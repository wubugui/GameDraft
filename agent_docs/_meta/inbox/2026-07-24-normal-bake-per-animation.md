---
target: sprite-atlas-anim-contract
date: 2026-07-24
session: 法线烘焙进动画产线
---

现象: 法线烘焙从「全局 --downscale」升为 **per-animation 配置**:`anim.json` 新增可选字段 `normalBake: {enabled: bool, downscale: int}`（缺省=启用、1/4）。主编辑器动画面板(anim_editor)加「法线烘焙」勾选 + 「法线分辨率 1/N」框 + 「重烘本动画法线」按钮（先存盘再单烘）。bake 工具按每个动画的 normalBake 决定是否烘/分辨率:enabled=false 删除已有 normal.png(运行时回退平面法线);CLI --downscale 显式传时全局覆盖。另:默认降采样从 1/16 改为 **1/4**——1/16(每角色 ~13×12)导致动画帧间法线量化跳变、游戏里着色闪烁,1/4(~54×51)实测不闪。
证据: `tools/animation_pipeline/bake_normal_atlas.py`(resolve_bake_config + bake_one 读 normalBake + DEFAULT_DOWNSCALE=4 + --downscale None 哨兵);`tools/editor/editors/anim_editor.py`(控件 + _bake_field_for_save 往返保真只在 orig 有键或非默认时写 + _do_rebake_normal 按钮);测试 `test_anim_normal_bake_config.py`(5 例) + `test_anim_editor_save_fidelity.py`(3 例,normalBake 不破坏无编辑保真)。全绿:编辑器 12 测试 / validate-data 0 error / 素材审计 0 / 端到端(1/8、禁用删图、CLI 覆盖)验通。运行时无改动(anim.json 多个 key 被忽略,只认 normal.png 存在与否)。
建议: sprite-atlas-anim-contract 卡的 anim.json 字段/编辑边界补 `normalBake`(廉价参数,主面板可保真写回);animation-pipeline 卡补「法线烘焙 = bake-normals 读 per-anim normalBake、新增/重导图集后跑」。
