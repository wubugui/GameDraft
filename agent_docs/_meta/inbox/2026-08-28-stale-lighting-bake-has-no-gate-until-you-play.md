现象：`雾津街头` 与 `test_room_b` 的 `background.png` 在 2026-08-28 01:17/01:28 被重画过，而 `lighting/lighting.json` 还是 2026-08-19 烘的。运行时表现是 `[CharLighting] ERROR: 雾津街头 : 照明烘焙过期(bake c2e151bb1c0a vs bg 1c49a742e82f)，已禁用` —— 那个场景的角色光照被**整个关掉**，画面明显不对，但没有一条报错指向根因（"重画了图没重烘"）。

与库内认知的冲突：这一类"文件都在、路径都对、唯独内容换了"的问题，**既有的门一个都抓不到**。素材审计只查存在性（`asset_reference_audit` 报 0 issue）；打包的抽取清单照抽不误；产物真跑一遍也零 404（它不产生 404）。唯一会说话的是 `validate-data` 的 `[lighting-bake]`，但那条淹在 34 条存量 error 里，而且没有任何流程要求打包/发行前必须看它。

处置：本次给 `scripts/verify_build.mjs` 加了 `checkBakeFreshness`，比对包里 `lighting/lighting.json` 的 `background_sha1` 与 `background.png` 的实际 SHA-1 前 12 位（判据与 `CharacterLightingSystem` 的哈希门逐字一致），发行前静态就能拦住。已写进 `runtime/mechanisms/build-pipeline.md`。

留给治理 run 的问题：`character-lighting` 卡里没有"重画背景必须重烘"这条硬约束，而重画背景是内容侧的日常操作（策划/美术都会做），烘焙却在另一条工具链上。值得考虑在 `character-lighting.md` 补一条，或者让编辑器的 save_all 在背景哈希变化时给一次提示 —— 现状是**改完到发现之间隔了整整九天**。
