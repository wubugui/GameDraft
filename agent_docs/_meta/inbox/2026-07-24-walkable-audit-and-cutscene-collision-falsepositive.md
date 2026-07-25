---
target: asset-pipeline
date: 2026-07-24
session: 28 场景全量重烘 + 走位体检工具 audit-walkable
---

现象: 给一张**原本没有碰撞**的场景导出 depthConfig = 第一次给它装墙。老的出生点坐标可能正好
落在新墙里，运行时**不报错**，只表现为"玩家生成后卡住不动"。本轮 13 张孤儿场景首次获得碰撞，
婆子家院 spawn(330,660) 实测被困（四向都迈不出）→ 挪到最近可走点(320,678)后可走，真机验通。

证据/工具: 新增 `./dev.sh audit-walkable`（反投影逐行对齐 SceneDepthSystem.isCollision，
拿运行时 13 点对过逐点一致）+ `--suggest`（最近可走点）+ `--fix-spawns[=apply] --max-move=N`
（只挪出生点、NPC 不动、大于阈值的保留待人工）。本轮修了全部 ≤80 单位的阻挡出生点（含所有
孤儿场景回归），5 个 >80 的大移动（test_room_a×1、雾津街头×4，均**烘前就已阻挡**、非本次回归）
保留待人工复核语义。

⚠ **重要纠错（否则会一直误报）**: 一度给 audit-walkable 加了「扫全库 moveEntityTo、查目标是否
落在阻挡格」的逻辑，立意抓"过场走不到位卡死"。**这是假阳性**——读源码确认 `Player.cutsceneUpdate`
与 `Npc.cutsceneUpdate` **完全不查碰撞**（直接 `x += nx*step` 朝目标走），过场位移目标落在阻挡格
里演员照样直达、根本不卡。已整段删除。**判据**：过场（cutscene）位移不受碰撞约束；只有走**普通
update** 的位移（玩家自由移动、NPC 巡逻、反应式移动）才查 `collidesAt`。要审"位移会不会卡"，
对象是后者不是 cutscene moveEntityTo。

建议: 机制卡记两条——①「新增/重导碰撞图」必须连带跑 audit-walkable，出生点落在墙里是硬 bug
（玩家冻结），NPC 落在墙里通常是有意（室内坐桌/靠柜/装饰，**不要动**）；②运行时"位移是否受碰撞
约束"分两条路：cutsceneUpdate 不查、普通 update 查——任何"过场会不会走不到"的分析先认这条，
否则必成假阳性（本文件就是活例，也是 README「完全可信但完全错误」那条的实证）。
