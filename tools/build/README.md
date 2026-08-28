# 打包管线

把开发树里的东西**抽取**成一个能独立跑的游戏产物。

规则、坑与判据都在机制卡里：[`agent_docs/runtime/mechanisms/build-pipeline.md`](../../agent_docs/runtime/mechanisms/build-pipeline.md)。
本文件只给命令。

## 一条铁律

**打包只读开发数据。** 对 `public/`、`src/`、`resources/` 一个字节都不写。
包体裁剪一律通过「不抽取」实现——没进清单的文件原样留在原地，不受任何影响。
音频转码与 `.wav→.ogg` 的引用改写只发生在 `release/` 下的 staging 副本上。

## 出一个可以直接发布的包

```bash
# 编辑器手动 build：每次传同一个目录 → 覆盖上一次
node scripts/release.mjs --out-dir D:/builds/current

# 自动化定期 build：每次传新目录 → 全部留档
node scripts/release.mjs --out-dir D:/builds/2026-08-28T09-00

# 档位（缺省 release）
node scripts/release.mjs --out-dir D:/builds/devcheck --target dev
```

**输出目录是参数，不进任何配置文件。** 它不是"这个项目怎么构建"的一部分，
而是"这一次把结果放哪"——编辑器和自动化因此能共用同一个入口，区别只有这一个值。
（编辑器把上次用的那个记在自己的 QSettings 里，属本机偏好，不是配置也不是游戏数据。）

产出的是**绿色版**，双击即玩，不打安装包：

```
<out-dir>/gamedraft.exe          3 MB
<out-dir>/game/                  游戏内容
<out-dir>/.gamedraft-build.json  构建标记：档位、时间、体积、有没有过验收
```

要 NSIS 安装包单独跑 `npm run tauri:build`。只要绿色版的话不值得等 makensis
压 566 MB 那四五分钟，所以 `release.mjs` 走 `tauri build --no-bundle`。

### 输出目录的两道闸

会被**整体清空重写**的目录，所以先过两关：

1. **路径体检**（与磁盘无关）：盘符根、仓库根、仓库根的上级、
   `public/` `src/` `tools/` 这些源码树，一律拒绝。
2. **覆盖策略**：目录里有上次的 `.gamedraft-build.json` → 直接覆盖；
   空目录或不存在 → 直接用；**是个陌生的非空目录 → 报错退出**，
   确认无误再加 `--force`。防的是手滑把别的目录清了。

### 验收不过就不出包

`release.mjs` 中间会跑一遍验收门，不过就停下、不产出。
确认那些问题可以接受（比如已知的存量数据问题）时加 `--skip-verify`——
这时构建标记里会记 `verified: false`，包不会假装自己验过。

## 命令

```bash
# 先看清单（不产出任何东西，只报告抽多少、剩下什么没抽）
npm run manifest:release
npm run manifest:dev

# 打包 → release/<档>/game/
npm run package:dev        # 调试设施齐全、不压缩
npm run package:release    # 剥调试、裁素材、音频转 ogg（要 ffmpeg）

# 验收产物
npm run verify:dev
npm run verify:release

# 真跑一遍找漏抽（静态检查证明不了"能玩"）
node scripts/verify_build.mjs --target dev --serve
#   浏览器打开 http://127.0.0.1:5199/ 走一段流程
#   随时 GET /__verify/404 看当前漏了什么
#   Ctrl-C 收尾，报告写进 release/<档>/verify-report.json

# 出 exe（需要 Rust 工具链）
npm run tauri:build
```

## 外部工具

| 工具 | 什么时候要 | 装法 |
|---|---|---|
| ffmpeg | 发行档的音频转码 | `winget install Gyan.FFmpeg` |
| Rust 工具链 | 出 exe（`tauri:build` / `tauri:dev`） | `winget install Rustlang.Rustup` |

两者都不装也能跑 `package:dev` 与全部验收——只是发行档会在转码那步**直接停下**
（带着 wav 发出去等于悄悄改了交付内容），exe 打不出来。

## 目录

```
tools/build/
  asset_manifest.py     抽取清单生成器（只读；反向能力复用素材审计的引用语义）
  manifest_rules.json   显式抽取规则（每条都注明了 src 里的出处）
  tests/                回归测试，含"生成清单不动工程里任何文件"这条
scripts/
  package.mjs           装配器：清单 → staging → 转码 → 报告
  verify_build.mjs      验收门：完整性 / 发行卫生 / 可服务 / 404 记录
src-tauri/              桌面壳：自定义协议读 exe 旁 game/、存档写 exe 旁 gamedata/
```

## 「从哪里开始」怎么配

`build_config.json` 的 `targets.<档>.bootQuery`：产物**首次加载**时套用的启动参数。

```
dev      mode=dev&devScene=dev_room   进 dev 直达路由，从这个场景起
release  screen_title=1               停在标题界面（玩家才够得到「继续」）
```

只作缺省：地址栏真带了引导参数时以那个为准，所以玩家点「新游戏 / 继续 / 返回主菜单」
的整页重启不受影响。换 dev 起始场景就改 `devScene` 的值（场景 id）；
也可以换成 `narrativeWarp=<锚点>`，它在 dev 路由里优先于 `devScene`。

⚠ `devScene` **单独给不够**——真正让游戏走 dev 分支的是 `mode=dev`，两个都要带。

## 验收门查什么

1. **完整性** —— 清单承诺的文件都落地了吗？入口 HTML 与 JS 在不在？
   （比对认转码：清单记 `.wav`，产物是 `.ogg`。）
2. **档位标记** —— 产物里的 `__GAMEDRAFT_BUILD__` 与 `--target` 对不对得上。
   *dev 档只给 `--mode development` 而漏了 `NODE_ENV=development` 时，
   打出来的包实际是发行档，连 `?mode=dev` 都不认且毫无报错* —— 这条门专治这个。
3. **发行卫生** —— authoring 残留（`.py` / `.npy` / `preview` / 备份）、dev 设施剥没剥净、
   有没有未转码的 wav。
4. **内容一致性** —— 光照烘焙的 `background_sha1` 和包里的 `background.png` 是不是同一版。
   *文件在不等于内容对*：重画背景没重烘光照时，素材审计全绿、零 404，
   但运行时会把那个场景的角色光照整个禁用。
5. **可服务** —— 真起静态服务把入口和它引用的东西抓一遍。
6. **404 记录**（`--serve`）—— 真跑一遍游戏才知道清单漏没漏。
   `sockets.json` 那批 404 是**按设计**的（109 个动画包里只有 2 个有这个可选文件），
   已在 `EXPECTED_404` 里豁免，别去"修"它。

## 加了新素材类别之后

如果新素材的路径是**代码拼出来的**（写死常量、或按 id/slug 拼），素材审计和传递闭包
都抓不到它，必须在 `manifest_rules.json` 的 `always_extract` 里登记，并在
`_always_extract_出处` 写清 src 位置。

判断方法：这条路径的字符串，在 `public/assets/**` 里 grep 得到吗？
grep 不到 = 必须登记。
