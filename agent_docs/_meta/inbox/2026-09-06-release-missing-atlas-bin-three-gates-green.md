---
target: build-pipeline
date: 2026-09-06
session: 打包产物 vs 编辑器运行差异排查 + 修复
---

现象: build-pipeline 卡与 manifest_rules.json 都说光照载荷"atlas_l1/l2 按 mode 二选一、atlas_bin 只有 F2 才读",实际 09-02 起 29 份载荷 100% 是 mode 3 → atlas_bin.bin 进场景必读;发行包一份都没有,28 个场景角色照明整份失效(黑剪影 / 深度场一起丢两种表现),清单护栏、verify、素材审计三道门全绿;运行时 fetch 不判 r.ok 把 404 正文当图集吃了。
证据: `find F:/build/2026-09-04_1201/game -name atlas_bin.bin | wc -l` = 0 vs 开发树 29;`.build/manifest-release.json` 零命中 atlas_bin;git log: manifest_rules 最后改 2066a73(09-01),mode3 转正 1f35550(09-02);verify-report.json 无 expected404 字段 = --serve 从没跑过;npm run build / tauri:build 不含 verify。
建议: 已修——文件名表收成 src/core/lightingPayloadFiles.ts 一处(Python/mjs 镜像 + 两条契约测试),展开器按载荷 mode 抽图集,verify 加开发树→产物平价,新增 scene_sweep 无头全场景抓取扫描接进 release.mjs 与 npm run build,fetch 缺文件必抛,reportDevError 两档都写 console;卡与 README 已随动。character-lighting 卡里"进场景只拉当前 mode 那一种(游戏默认 L2=9列)"那句仍是旧口径(缺省已是 mode 3 八面体),下次治理顺手改。
