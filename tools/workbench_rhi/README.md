# 工作台 RHI 接入层（`tools/workbench_rhi`）

让 **Python serve 的原生 JS 工作台页面**直接用游戏的 engine2d / RHI（只有 WebGPU）和**游戏自己的渲染模块**
（滤镜、网格、WGSL、贴图装载……同一份 TS / WGSL）画画面，不在工具里另写着色器、不维护 GLSL 孪生。
样板：燃烧工作台（`tools/burn_workbench`，2026-09-27 迁过来）。

## 为什么放这里、为什么这么做

- **放 `tools/workbench_rhi/`**：它服务多个工作台（与 `tools/desktop_shell.py`、`tools/webengine_cache_policy.py` 同一层的
  工具公共件），既有 Python（打包 / 服务 / 测试驱动）也有 TS（页面侧宿主）。不放 `src/`：游戏运行时不需要它，
  也不该被运行时的守门测试与分层规矩牵连。
- **构建 = vite 库模式出一个自包含 ESM**（`build.mjs`），不是裸 rolldown：游戏模块里的 `*.wgsl?raw`、`import.meta.env`、
  `@src` 别名与游戏构建同一套语义（裸 rolldown 解析不了 `?raw`，这正是以前只能把 GLSL 孪生当文本另给页面的原因）。
  单文件、不拆块：页面只 `await import('/gen/xxx.bundle.js')` 一个地址，serve 不用管块路由。
- **按需构建、产物不进 git**：serve 收到包请求（或 `/api/boot`）时调 `build.ensure()`——产物旁的 `*.stamp.json` 是
  **打包器自己报的源清单**（本次实际打进去的每个文件：游戏 src、WGSL、工作台胶水、node_modules 里的依赖、package-lock.json）
  的尺寸 + 修改时刻，任何一个变了 / 没了、入口换了、打包器改了 ⇒ 重打（约 2–3 秒）；都没变 ⇒ 一个字节不写。
  产物放各工作台自己的 `viewer/_gen/`（已 gitignore）。不用 vite dev 中间件：Python serve 不起 node 常驻进程，
  打包失败也不拖垮服务。
- **不回落**：宿主拿不到 WebGPU 就明确说画不了（`WorkbenchRhiError` 带人话原因），不换 WebGL / 2D。
- **跨平台**：只调 `node`（PATH 或 `.tools/node`）+ 仓库根 `node_modules`，路径一律 `pathlib` / `path`；不联网（离线机器照样能打）。

## 文件

| 文件 | 干什么 |
|---|---|
| `build.py` | Python：`ensure(entry, out)` 按需打包；`stale_reason` / `inputs_of` 看新旧与源清单；`entry_source` 生成 `export * as <名> from …` 入口；`import_tree` 打之前的近似依赖树 |
| `build.mjs` | node：vite 库模式打包 → 临时目录 → 原子换上；写打包戳 |
| `workbenchRhi.ts` | 页面侧（打进各工作台的包，命名空间 `workbenchRhi`）：`createCanvasHost(canvas, opts)` 在画布上建游戏同一个 WebGPU 渲染器（与 `Renderer.init` 同参：不抗锯齿、分辨率 = 设备像素比）；`loadTexture(url)` = 游戏 `AssetManager.loadTexture` 同一条（engine2d `Assets.load`）；`host.readPixels()` / `readPixel()` **同任务重画再回读**（WebGPU 画布呈现后读不回来，Chrome 实测全 0）；`probeWebGpu()`；也导出整个 `engine2d` 命名空间 |
| `rhiTrace.ts` | 测试：在空后端（`NullRhiDevice`）上把决定像素的全部 GPU 输入记成规范化文字（pass / 视口 / 管线与 WGSL 摘要 / uniform 字节 / 纹理内容 / 顶点索引 / draw）——"工作台画法 == 游戏画法"的无 GPU 对照（vitest） |
| `chrome_page.mjs` | 测试：真 Chrome（真显卡 WebGPU，缺省无头）跑工作台页面：`--smoke`（页面的 `window.__rhiSmoke()` 报 ok、控制台无 error、可截图）/ `--selftest <js>`（与桌面壳同一约定，`--no-skip` 不许有 SKIP） |
| `browser.py` | 测试：pytest 侧起服务子进程 + 调 `chrome_page.mjs`；没有 node / playwright-core / Chrome 时给 skip 原因 |

## 别的工作台怎么接（照燃烧工作台）

1. **入口**：在工作台的 `bundle.py` 里列模块（游戏的渲染模块 + `tools/workbench_rhi/workbenchRhi.ts` + 工作台自己的 TS 胶水），
   `entry_source()` 生成 `viewer/_gen/entry.ts`，`write_if_changed()` 写，`ensure(ENTRY, OUT)` 打。命名空间 = 文件名。
2. **胶水写 TS、放工作台自己目录**（如 `tools/burn_workbench/gpu/burnView.ts`）：只用游戏的对象拼画面（实体、滤镜、网格、
   `BurnRenderer` 之类），**不写任何 WGSL / GLSL、不抄着色式子**；拼法照游戏组装层（谁持有资源、拆卸顺序、相机 uniform 怎么推）。
   加进 `tools/workbench_rhi/tsconfig.json` 的 include，`npx tsc --noEmit -p tools/workbench_rhi` 过类型。
3. **服务**：`/gen/<名>.bundle.js` 路由调 `ensure`；打不出来有旧包就给旧包、把原因经 `/api/boot` 告诉页面；删掉只为 GLSL 服务的路由。
   顺手给 `/favicon.ico` 回 204（不然控制台一条 404，冒烟判失败）。
4. **页面**：`const rt = await import('/gen/<名>.bundle.js')`；`host = await rt.workbenchRhi.createCanvasHost(canvas, {background})`（异步；
   失败抛错带原因，页面显示、编辑照常）；每帧 `host.resize(cssW, cssH, dpr)` → 胶水同步场景 → `host.render(root)`；
   贴图一律 `rt.workbenchRhi.loadTexture(url)`（卸载前先让场景树不再引用它：绑定已销毁的纹理 = 那一帧抛错）。
   给 `window.__rhiSmoke = () => ({ ok, detail })`（冒烟用：`host.countDrawnPixels()` 非空、没报错）。
5. **测试**（三层）：
   - **无 GPU（vitest）**：`rhiTrace.traceRhi(new NullRhiDevice())` 两台设备，一边走工作台胶水、一边照游戏组装层现拼，
     `expect(workbenchTrace).toEqual(gameTrace)`；再加一条"记录器够灵敏"（相机 / 参数差一点串就不同）。样板 `tools/burn_workbench/gpu/burnView.test.ts`。
   - **真 GPU 逐像素**：工作台真页面 vs vite 按游戏模块图编译的参考页（照游戏组装层写，不经接入层、不经胶水），同一组输入各画一张、
     同任务回读、逐字节比。样板 `tools/burn_workbench/tests/parity/`（`run.mjs` + `ref.ts` + `vite.config.ts`，pytest 壳 `test_parity.py`）。
   - **页内自检 + 冒烟**：selftest 里读像素的条目改成 GPU 版（`host.readPixel` 同任务重画再读，同步可用）；宿主拿不到 WebGPU 时这几条记
     `SKIP`（带原因），pytest 再用 `browser.run_page(..., selftest=..., no_skip=True)` 在真 GPU 的 Chrome 里跑同一份脚本、不许有 SKIP。

## 宿主拿不到 WebGPU 时（Qt 离屏 / 显卡驱动不行 / 远程桌面）

- 页面：着色层显示原因（「这个窗口拿不到 WebGPU 适配器……」），画布留底色；编辑、保存、模拟、站位、2D 标注照常。
- 打包失败（没 node / vite 报错）：有旧包用旧包并提示；没有就没有着色预览，其余照常。
- 2026-09-27 实测：offscreen 的 QtWebEngine 6.11（PySide6）`navigator.gpu` 存在但**拿不到适配器**（ANGLE/SwiftShader 参数下也一样）；
  真窗口的 Qt 宿主需要的 Chromium 参数由 `tools/qt_webgpu.py` 统一接（另一条线），接好之后自检里的 SKIP 会自动变回真跑。
  无头 Chrome 在真显卡上 WebGPU 可用（RTX 4070 SUPER），测试用它。

## 运行

```bash
export PLAYWRIGHT_CORE=<playwright-core 包目录>          # 仓库不装
sh scripts/py.sh -m pytest tools/workbench_rhi -q        # 打包器
npx tsc --noEmit -p tools/workbench_rhi                  # 页面侧 TS + 各工作台胶水
npx vitest run tools/burn_workbench/gpu                  # 无 GPU 对照
node tools/workbench_rhi/chrome_page.mjs --url http://127.0.0.1:<端口>/ --smoke --shot out.png
```
