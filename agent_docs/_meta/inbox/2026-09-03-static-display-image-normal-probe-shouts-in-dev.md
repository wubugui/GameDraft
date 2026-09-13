---
target: optional-asset-probe
date: 2026-09-03
session: 实体轨迹动画 · 第 11 步（首个验证用例：铜钱）
---

# displayImage 的法线 sidecar 走的是纹理预载，不是 loadOptionalJson —— 没烘过就在 dev 弹红条

- 现象：给 NPC 配 `displayImage`（静态贴图实体）后，`SceneManager` 无条件把
  `normalAtlasUrlFor(image)` 也加进预载清单。这个 sidecar 是**可选**的（取不到就走平面法线），
  但它走的是纹理加载而不是卡里说的 `loadOptionalJson`，而本仓库 dev server 对不存在的文件
  返回 **200 + HTML**，于是 Pixi 拿 HTML 去解码，抛
  `InvalidStateError: The source image could not be decoded`，dev 页面顶部弹一条红色错误浮层
  （`#gamedraft-dev-error-overlay`），整段演出的截图都被它盖住。功能不受影响，只是噪音。
- 证据：`src/systems/SceneManager.ts` 预载分支 `add({type:'texture', path: normalAtlasUrlFor(...)})`
  （热点展示图分支与 NPC 静态贴图分支各一处）；`src/rendering/spriteNormalAtlas.ts`。
  实测：新增 `/resources/runtime/images/props/copper_coin.png`（没有对应 `.normal.png`）后，
  `?mode=dev` 进场即弹红条；既有的热点展示图（如 `hs_淹尸` 的尸体图）同样成立，不是新引入的。
- 建议：`optional-asset-probe` 卡目前只讲了 JSON sidecar 那一路，补一句**纹理型可选 sidecar
  也吃同一个坑，且它的失败是"红条 + 控制台异常"而不是静默回落**；顺带说明无头验证取证时
  要先把 `#gamedraft-dev-error-overlay` 藏掉再截图。真要治本，预载侧对法线图应当先探
  content-type 再入队。

## 后续(2026-09-12)

- 铜钱这一例的**真实根因**不在探测方式,在**烘焙的发现口径**:`bake_normal_atlas.py` 只扫
  `hotspots[].displayImage`,`npcs[].displayImage`(静态贴图实体)整类在口径外 → 那张图永远
  烘不出来 → 预载必然撞 200+HTML。已改 `discover_display_images` 覆盖两类,并把
  「发现口径 == 运行时预载口径」写进 [动画产物契约](../../asset-pipeline/mechanisms/sprite-atlas-anim-contract.md),
  测试 `tools/animation_pipeline/tests/test_normal_bake_discovery.py`。全量扫过一遍:
  18 个展示图实体只欠铜钱这一张,已烘。
- **仍然成立的部分**:纹理型可选 sidecar 的失败是"红条 + 控制台异常"而不是静默回落,
  `optional-asset-probe` 卡该补这一句;无头取证前仍要先藏 `#gamedraft-dev-error-overlay`。
  口径对齐之后这类红条只会在"图刚加进场景、还没跑 bake-normals"的窗口里出现。
