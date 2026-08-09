---
target: narrative-state-editor
date: 2026-08-09
session: 私有信号 + 画布自动分组
---

现象: 叙事编辑器画布里「框类节点」的清单是**三处手工镜像**，没有任何 parity 测试盯着：`canvas/edgeRouting` 的 `FOUR_WAY_PORT_NODE_TYPES`、`canvas/transitionAnchorLayout` 的 `nodeLayoutSize` 框类分支（框按 `style` 取尺寸而非 `measured`）、`canvas/flowNodes` 的 `flowNodeTypes` 注册。新增一种框类节点时三处都要改,漏任一处的症状各不相同且都不报错：漏路由清单 → 边接到框中心或触发 React Flow error008;漏 `nodeLayoutSize` → 框尺寸按未 measured 的 0 算,边飘到左上角;漏注册 → 节点直接不渲染。
证据: 2026-08-09 新增 `wrapperGroupFrame`（wrapper 图自动分组的折叠框）时三处都补了才正常,任一处不补都能跑起来但表现异常。同类问题卡内已有先例（硬契约 6 的 wrapper owner 双注册表、2026-08-09 另一条记录里的 element kind 三登记面）。
建议: 卡里补一条「框类节点三处镜像」,并把它与 `isElementKind` 白名单一起列进镜像 parity 门的固定检查项——现在这类清单已经攒到第三组了,值得一次性做一个「清单对账」测试模板,而不是每次新增再手工提醒。
