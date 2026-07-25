---
target: entity-lighting
date: 2026-07-24
session: probe 固化 v3
---

现象/变更: probe 图集从「4 分账(base/amb/emit/nee)运行时组合」改为「导出即固化的单块最终 E」(lighting.json version=3)。导出时用 shading 的 nee/amb 把 4 分账 compose 成 final=base+(nee开?nee:emit)+amb×权重(miss_mode=0 时着色是分账线性组合、SH 域精确)。游戏运行时 probeE 只读固化 E 球谐、按法线重建,不再组合;nee/miss_mode/amb 游戏 cache 不再消费(仅 RT gatherRT 用,F2 已归到 RT section)。atlas 列数 L1 16→4/L2 36→9/BIN 256→64,各缩 4×(teahouse 3.95→0.99MB)。**关键:实验室 viewer 读 OUT/ 分账缓存走自己的实时组合,不受影响——两条数据路径(OUT 分账/预览 ↔ runtime 固化/游戏)**。
证据: 导出 `pipeline.py#_atlas4`(compose)+ payload version=3;运行时 `CharacterShadingFilter.ts` probeE 简化 + `CharacterLightingSystem.ts` atlas 列数 4/9/64 + 版本门 `<3` 禁用;28 场景一次性迁移(读 OUT 分账重 compose+bump version,不重烘不动体素卷,避开背景哈希门)。miss_mode=1 的 /cov 逐方向非线性、无法 SH 域精确固化 → 按 miss_mode=0 近似并告警。tsc/329 单元/validate-data/素材审计全绿。
建议: entity-lighting 机制卡更新 probe 格式为 v3 固化单块;记两条数据路径分离、miss_mode=1 近似坑。新烘场景经 export_runtime 自动 v3;旧 v2 场景需重导出(否则运行时禁用)。

追加(2026-07-24 同日,decision B 已完成并真机验过): **按需加载落地** —— 进场景只 fetch 当前 mode 那一份 atlas(默认 L2=0.115MB,不再三份全载 ~1MB),另两种在 resources 上放 1×1 占位;F2 切 cache 档(L1/L2/BIN)才 `CharacterLightingSystem.ensureProbeAtlas(mode)` 按需 fetch 目标份、`swapProbeAtlas` 换纹理、复用体素卷「先重挂滤镜再 dispose 旧纹理」的 BindGroup 时序。入口 `Game.applyCharMode(nextMode)` 统一管 RT 体素卷 + cache probe 图集(原 `applyRtVolumeMode` 合并进来),`setCharLighting` 在**任意** mode 变化时触发(不再只 RT 边界)。**固化把 3 账 stride-36 塌成单块 9 列**,故 CPU 侧 `l2u16`→`probeAtlasU16`(+`probeAtlasCol`),`sampleFluxLum`(影子跟灯)与 probe 点云 viz 改读单块 coeff0-3、按 nCol 步长;BIN(64 方向桶)无 SH → 影子跟灯该档不供流向。真机验(bridge_underpass):进场景只 fetch atlas_l2.bin、loadedProbeMode=2、player+NPC CHAR_FS 滤镜在;L2→L1→BIN→L2 每步只按需 fetch 目标份、loadedProbeMode 跟随、滤镜没烧、无 GL/BindGroup 报错。⚠注:`setCharLighting` 是 `DebugTools.deps` 回调**不是 eventBus 事件**(无头驱动想走真实 F2 路径要调 deps 回调)。
