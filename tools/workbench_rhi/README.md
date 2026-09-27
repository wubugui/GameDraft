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
- **并发安全（跨进程）**：同一产物同时只打一次——线程锁 + 系统临时目录里按产物路径一把的文件锁（`lock_path`；操作系统的字节锁 / flock，
  进程死了自动释放）；拿到锁后**再核一次戳**，等锁期间别人打好了就用它的（`force` 也合并）。生成式入口经 `ensure_entry` 在同一把锁里原子写。
  最新时不拿锁、不写任何东西。（2026-09-28：以前只有线程锁，pytest `-n auto` 的几个 worker 同时撞上过期产物各打一遍、互相覆盖，
  `test_bundle_is_cached_by_source_stamp` 偶发红；回归 `tests/test_build.py::test_concurrent_processes_build_once`，修前 4 个进程打 4 遍。）
- **不回落**：宿主拿不到 WebGPU 就明确说画不了（`WorkbenchRhiError` 带人话原因），不换 WebGL / 2D。
- **跨平台**：只调 `node`（PATH 或 `.tools/node`）+ 仓库根 `node_modules`，路径一律 `pathlib` / `path`；不联网（离线机器照样能打）。

## 文件

| 文件 | 干什么 |
|---|---|
| `build.py` | Python：`ensure_entry(entry, text, out)` / `ensure(entry, out)` 按需打包（跨进程只打一次）；`stale_reason` / `inputs_of` 看新旧与源清单；`entry_source` 生成 `export * as <名> from …` 入口；`import_tree` 打之前的近似依赖树 |
| `build.mjs` | node：vite 库模式打包 → 临时目录 → 原子换上；写打包戳 |
| `workbenchRhi.ts` | 页面侧（打进各工作台的包，命名空间 `workbenchRhi`）：`createCanvasHost(canvas, opts)` 在画布上建游戏同一个 WebGPU 渲染器（与 `Renderer.init` 同参：不抗锯齿、分辨率 = 设备像素比）；`loadTexture(url)` = 游戏 `AssetManager.loadTexture` 同一条（engine2d `Assets.load`）；`host.readPixels()` / `readPixel()` / `countDrawnPixels()` **异步**：RHI 纹理回读最近一次 `render` 画出的画面（`renderer.readCanvasPixels`：读画布中间纹理，不经浏览器上屏 / 合成；拷贝在调用当下提交，之后再画不影响）；`probeWebGpu()`；也导出整个 `engine2d` 命名空间 |
| `rhiTrace.ts` | 测试：在空后端（`NullRhiDevice`）上把决定像素的全部 GPU 输入记成规范化文字（pass / 视口 / 管线与 WGSL 摘要 / uniform 字节 / 纹理内容 / 顶点索引 / draw）——"工作台画法 == 游戏画法"的无 GPU 对照（vitest） |
| `chrome_page.mjs` | 测试：真 Chrome（真显卡 WebGPU，缺省无头）跑工作台页面：`--smoke`（页面的 `window.__rhiSmoke()` 报 ok、控制台无 error、可截图）/ `--selftest <js>`（与桌面壳同一约定，`--no-skip` 不许有 SKIP） |
| `browser.py` | 测试：pytest 侧起服务子进程 + 调 `chrome_page.mjs`；没有 node / playwright-core / Chrome 时给 skip 原因；`qt_host_unavailable()` / `skip_lines()` 给 Qt（WebGPU）宿主的自检用 |

## 别的工作台怎么接（照燃烧工作台）

1. **入口**：在工作台的 `bundle.py` 里列模块（游戏的渲染模块 + `tools/workbench_rhi/workbenchRhi.ts` + 工作台自己的 TS 胶水），
   `entry_source()` 生成入口文本，`ensure_entry(ENTRY, 文本, OUT, force=…)` 在打包锁里写入口并打（别在锁外自己写入口）。命名空间 = 文件名。
   Qt 宿主：`run_desktop(..., webgpu=True)`（正常窗口与自检两处都给；QtWebEngine 没编 Dawn，WebGPU 页面只能走 WebView2 / WKWebView）。
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
   - **页内自检 + 冒烟**：selftest 里读像素的条目改成 GPU 版（`await host.readPixel(...)`，画完同一个任务里发读）；宿主拿不到 WebGPU 时这几条记
     `SKIP`（带原因）——但 Qt 宿主（WebView2）与真 GPU 的 Chrome（`browser.run_page(..., no_skip=True)`）两边都拿得到，pytest 两边都断言零 SKIP。
     冒烟钩子 `window.__rhiSmoke` 可以是 async（`chrome_page.mjs` 会等它）。

## 宿主拿不到 WebGPU 时（Qt 离屏 / 显卡驱动不行 / 远程桌面）

- 页面：着色层显示原因（「这个窗口拿不到 WebGPU 适配器……」），画布留底色；编辑、保存、模拟、站位、2D 标注照常。
- 打包失败（没 node / vite 报错）：有旧包用旧包并提示；没有就没有着色预览，其余照常。
- QtWebEngine 没编 Dawn，永远拿不到 WebGPU（见 `tools/qt_webgpu.py` 模块头）；工作台的 Qt 宿主一律 `run_desktop(webgpu=True)` 走 WebView2
  （Edge 135，本机 dpr 1.24）。自检 / 冒烟在离屏平台下由壳改开**挪到屏幕外、尺寸固定的无边框真窗口**（带边框的窗口会被系统夹到屏幕大小：
  1280×720 的机器上页面 CSS 视口只剩 1036×566，依赖视口大小的自检条目假红）。
- 读像素别用 `drawImage(WebGPU 画布)`：Chrome 里呈现之后读到全 0，WebView2（窗口在屏幕外）里读到**旧的合成帧**甚至全 0（2026-09-28 实测）。
  接入层的回读走 RHI 纹理回读，两个宿主一致。无头 Chrome 在真显卡上 WebGPU 可用（RTX 4070 SUPER），测试用它。

## 运行

```bash
export PLAYWRIGHT_CORE=<playwright-core 包目录>          # 仓库不装
sh scripts/py.sh -m pytest tools/workbench_rhi -q        # 打包器
npx tsc --noEmit -p tools/workbench_rhi                  # 页面侧 TS + 各工作台胶水
npx vitest run tools/burn_workbench/gpu                  # 无 GPU 对照
node tools/workbench_rhi/chrome_page.mjs --url http://127.0.0.1:<端口>/ --smoke --shot out.png
```

## 粒子工作台（`tools/vfx_workbench`，2026-09-27 迁过来）的几条经验

- **画面 = 游戏的 `VfxRenderer`**（粒子 / 薄片 / 雷 / 光柱）：胶水 `tools/vfx_workbench/gpu/vfxView.ts` 只照 `Renderer` 的层与 `Game.start` 那组
  依赖现拼（无光口径：`createLitShader → null`、`canLight → false`、`getToneEnv → null`、显示变换 = `createCharLightUniforms()` 缺省），
  模拟就是页面里的 `VfxInstanceSim`；贴图表用游戏抽出来的 `loadVfxSpriteSheet`（`VfxSystem.loadSheet` 等价重构出来的那一个）。
  标注 / gizmo 另起一块叠在上面、`pointer-events: none` 的 2D 画布（`#overlay2d`），事件照旧在 GPU 画布上收。
- **一页多块画布 = 各自一台设备**：RHI 设备绑一块画布的交换链（`createRhiDevice({canvas})`），两块画布共用一台设备要动 RHI 接口，
  所以原画视图与检视器里的雷预览各 `createCanvasHost` 一次（引擎2d 的多渲染器互不影响；`Assets` 缓存的纹理各自上传）。没有另建共享设备模块。
- **`getScreen` 取渲染器自己的 `screen`**（= 游戏的 `app.screen`）：CSS 尺寸可以是小数，`clientWidth` 是取整过的——
  雷的屏幕下限按 `screen.h / 768` 换算，差半个像素高度就是一片 ±3 的像素差（高分屏对照抓到的）。
- **有历史的渲染状态先清掉再比**：天上那道雷按镜头要的高度往上续算、每续一次多一段折线，同一道雷在不同镜头史下分段不同；
  逐像素对照前 `stage.clear()` 让两边都"这个镜头下第一次画"。
- **Chrome 里跑真数据的自检**：服务开 `--serve --selftest-sandbox`（布置库 / 样式库指到临时拷贝、游戏地址钉死端口，与桌面壳自检同一个沙箱），
  自检里故意发的坏请求服务端回 500 时给 `chrome_page.mjs --allow` 放过那一类（断言由自检自己做）。
- ⚠ `VfxRenderer.ensureView` 在 `getDepth()` 为 null 时拿发射器贴图顶替深度槽，**雷层的占位贴图表没有贴图 ⇒ 当场抛**（游戏里没深度的
  场景 / 画布特效放雷同样会抛，未修）。工作台原画视图在深度图还没装到时先不交模拟；雷预览给白图当深度（平面近似下 `uHasDepth` 恒 0，
  雷层的深度槽在游戏里没深度时绑的也正是白图）。

```bash
npx vitest run tools/vfx_workbench/gpu                                        # 无 GPU 对照（三组效果 + 雷预览）
node tools/vfx_workbench/tests/parity/run.mjs --python <py> --out <目录>        # 真 GPU 逐像素（纸钱 / 雷符的云与雨 / 光柱尘埃 / 落雷 / 高分屏）
```

## 离屏渲染纹理 + 异步回读（`offscreenReadback.ts`，2026-09-27 呼吸工作台出片加）

出片 / 自检要按**成品尺寸**画、逐帧读、读的时候别卡住下一帧；画布回读（`CanvasHost.readPixels`，异步读画布中间纹理）尺寸跟画布走、做不到成品尺寸。

- `createOffscreenTarget(host | renderer, w, h, { clearColor? })` → `OffscreenTarget`：同一个渲染器 / 同一台设备上的一张
  engine2d `RenderTexture`（分辨率 1，像素 = 逻辑像素）。打进包的命名空间 `offscreenReadback`（在工作台 `bundle.py` 的入口里列它）。
- `render(root)` 画进去（与画到画布同一条渲染路径，只是目标不同；不碰 `CanvasHost` 的"上一次画的根"，预览照常）；
  `read()` / `capture(root)` 异步回读，给 `Pixels`（**自上而下** RGBA8，纹理里存的字节 = 预乘；不透明画面就是颜色）。
- **拷贝在调用那一刻就排进 GPU 队列**（`rhi.readTexture` 的 `copyTextureToBuffer` 当场提交）：之后再往同一张纹理画不影响已发出的读，
  所以可以"画 i → 发读 i → 画 i+1 → 发读 i+1…"同时挂几帧（呼吸工作台挂 4 帧）。没画过就读 / 销毁后再用都明确报错。
- 行序：WebGPU 纹理第 0 行就是画面最上面，原样给出，**不翻**（以前 WebGL `readPixels` 自下而上、要服务端翻；接这个的服务端别再翻）。
- ⚠ 与画布的差：引擎的**画布** pass 为了与 master（WebGL 自下而上）逐位一致，是上下颠倒光栅化进中间纹理再翻上屏的（`FrameBuilder` 的 `flipY`），
  离屏渲染纹理不翻。同一场景两者在少数像素上差 1（插值末位舍入；呼吸图 1664×928 实测 ≤ 0.01% 像素、最大差 1）。
  所以"离屏读的 == 游戏"要对**引擎自己的离屏读法**（`renderer.extract.pixels` / `generateTexture`）逐字节，与画布的差单独报容差——
  样板见 `tools/breathing_workbench/tests/parity/run.mjs` 的出片例。
- 测试：`offscreenReadback.test.ts`（vitest，空后端：画进的是成品尺寸的纹理不是画布、拷贝当场发出、行序原样、BGRA→RGBA、报错）；
  真 GPU 的像素 / 行序由接它的工作台自检覆盖（呼吸工作台 selftest S10「回读自上而下」、S17 出片）。

## 3D 调试件（`debug3d.ts` + `debug3d.wgsl`，2026-09-27）

工具里**游戏没有对应效果**的 3D 调试视图（粒子 / 地形 / 声学 / 轨迹四台的 `viewer/view3d.js`：场景深度网格贴背景、
网格线、线框、标记、碰撞格、反射面、幽灵卡片）共用的一套画法。**着色器只有 `debug3d.wgsl` 一份、归接入层所有**，
页面不写任何 GLSL / WGSL、不碰图形 API；走游戏同一套 RHI（只有 WebGPU，不回落）。

| 文件 | 干什么 |
|---|---|
| `debug3d.ts` | 页面侧（命名空间 `debug3d`）：`createView` / `Debug3DView`、纯函数（矩阵约定换算、投影、折线、射线打网格）、页内自检 `selfCheck` |
| `debug3d.wgsl` | 唯一的着色器：纯色 / 贴图×颜色 / 顶点色 / 点（屏幕方片）/ 宽线（屏幕四边形）五组入口，共用一组绑定 |
| `debug3dGlobals.ts` | 3D 调试件不许改宿主页面的全局：luma 依赖的 probe.gl 求值时无条件写 `globalThis.probe`（声学台的「试听」就叫 `probe`），这里先记后还 |
| `debug3d_bundle.py` | Python：把 `debug3d.ts` 打成 `<工作台>/viewer/_gen/debug3d.bundle.js`（`build.ensure`，按需、不进 git）；`ROUTE = '/gen/debug3d.bundle.js'` |
| `debug3d.test.ts` / `debug3dGlobals.test.ts` | vitest（空后端）：矩阵 / 投影 / 射线纯函数、命令流（pass / 管线状态 / 统一数据 / draw 参数 / 确定且灵敏）、只有一份 WGSL、设备恢复重建、不盖页面全局 |
| `tests/test_debug3d.py` | pytest：包打得出来且带着色器、四个 view3d 里没有 WebGL / GLSL、四个 serve 都有路由 |

### API（页面是原生 JS）

```js
const rt = await import('/gen/debug3d.bundle.js');                       // serve：if (u.path == debug3d_bundle.ROUTE) debug3d_bundle.ensure(GEN_DIR)
const g = await rt.debug3d.createView(canvas, { background: [r, g, b] }); // 自己的 WebGPU 设备（画布不透明）；拿不到抛 Debug3DError（带人话原因）
// 常驻资源（CPU 源留着：设备丢失恢复后下一帧自动重建重传）
const mesh  = g.createMesh({ vertices, indices });           // 贴图网格：xyz+uv 交错 5 float（服务端 /api/scene_mesh 原样）
const cells = g.createMesh({ positions });  cells.setColors(rgbaPerVertex);   // 顶点色网格（颜色随时换，下一帧上传）
const tex   = g.createTexture(img);                          // 不预乘、不翻转（与 WebGL texImage2D 缺省相同；uv (0,0) = 图左上）
// 每次重画：viewProj = 页面自己的相机矩阵（列主序，缺省 GL 裁剪约定 z∈[-1,1]；拾取 / 叠加层用的同一个）
g.render(mvp, (d) => {
  d.mesh(mesh, { texture: tex, tint: [k, k, k, 1] });        // 缺省深度测试 + 写、不混合
  d.mesh(cells, { depth: 'test', blend: true, alphaCutoff: 0.001 });
  d.lines(xyz, { color: [1, 1, 1, 0.09] });                  // 每两点一段；strip: true = 折线；width > 1 = 屏幕空间四边形
  d.points(xyz, { color, size: 9, depth: 'off' });           // 边长 size CSS 像素的屏幕方片（GL 点精灵的语义）
  d.triangles(xyz, { color, depth: 'test' });                // 纯色三角形
  d.quad(corners4, { texture, color: [1, 1, 1, alpha], depth: 'off' });   // 公告板（没贴图 = color 填充）
}, { pixelRatio: devicePixelRatio });
g.readPixel(cssX, cssY); g.readPixels(); g.countDrawnPixels();           // 同任务重画再回读（测试 / 自检）
rt.debug3d.selfCheck(g, { project, ray, cssSize, mesh, markers });       // 真 GPU 像素断言（见下）
```

- `depth`：`'test-write'`（缺省；≤ 测试 + 写深度 = WebGL 缺省）/ `'test'`（测不写 = `depthMask(false)`）/ `'off'`（不测不写 = 关 `DEPTH_TEST`）。
  除贴图网格外一律源 alpha 混合；清屏深度 1；4× MSAA（= WebGL `antialias:true`，`antialias:false` 关）。
- **相机归页面**：四台的拾取、gizmo、2D 叠加层都用页面自己的矩阵（`common.js` / `mathx.js` 的左手 lookAt + GL 约定 perspective / ortho），
  这里原样吃同一个矩阵，只在 CPU 上把 z 换成 WebGPU 的 [0, 1]（`glToWebGpuClip`，x / y / w 逐位不变）——画出来的与点出来的是同一个投影。
  正交（near 取负、机位背后也画）与透视只是矩阵不同。
- **帧内一次写完**：每帧先把全部动态顶点（三条流：xyz / 线段对 / 公告板）与每次 draw 的统一数据（256 字节一格：矩阵 + 颜色 + 点径线宽 + 目标尺寸）
  写进缓冲，再录一个 pass（RHI 不许录制期写本批已引用的缓冲）；缓冲不够就翻倍重建。
- **测试钩子** `g.debugDraw = (d) => …`：在页面画法之后再录一段（自检插探针点用），平时 null。
- 页面在拿不到 WebGPU 时（离屏 Qt / 驱动不行）：视图逻辑（相机、拾取、gizmo、叠加层、编辑）照常，叠加层正中写原因（四台 view3d 的 `drawGpuNote3`）。

### 页内自检（`selfCheck`，四台 selftest.js 的 S1g 共用）

页面先 `draw()` 一帧，再给：页面自己的 `project` / `ray`、画布 CSS 尺寸、场景网格的 CPU 源、页面按画的先后列出的标记。断言：
1. 画面非空（与清屏色不同的像素 ≥ 5%）、这帧没有设备诊断错误、draw 数 > 0；
2. **标记颜色**：从后往前取一个实心、在画内、不被后画的标记盖住的标记，在页面投影出的位置读回来就是它的颜色（±3）——投影 == 画法；
3. **深度遮挡**：画面中部螺旋取点，用页面的拾取射线 `raycastMesh` 打到网格真实表面，表面后 δ 处插品红探针（测深度）→ **每一处**像素都与不插时逐字节相同；
   表面前 δ 处 → 至少一处看得见（页面别的写深度的细线恰好横在那个像素上时前探针被挡不算错）；且探针投影与射线像素差 < 0.75 px。

离屏 Qt 拿不到 WebGPU 时 S1g 记 `SKIP`（带原因）；各台 pytest 另在真 GPU 的 Chrome 里跑同一份 selftest.js（`--no-skip`），外加一条冒烟（画面非空、控制台无 error、截图）。
粒子 / 地形两台的 Chrome 自检要与桌面壳同样的隔离：`--serve --selftest-env <目录>`（布置库 / 雷电样式库 / 作者层 / 预览 / 草稿指到该目录、游戏地址指死端口）。

### 与迁移前 WebGL2 版的差异（参考图并排见迁移报告）

- 线宽：WebGL 在 Chrome 上 `lineWidth` 恒为 1，旧代码里写的 `width 2`（轨迹台选中段 / 抛体初速线、地形台选中区域）、`1.5`（地形笔刷圈）从没生效；
  现在按写的宽度画（屏幕空间四边形）。宽度 1 的线仍是原生 1 设备像素线。
- 线段光栅化（MSAA 下的覆盖）与 WebGL（ANGLE / D3D11）略有不同：细线与半透明网格线边缘有 ±1 像素的差；网格贴图、标记位置 / 颜色一致。
- 轨迹台旧画布是带 alpha 的（`getContext('webgl2', {antialias:true})` 缺省 alpha:true），半透明线在画布上留下 alpha < 1 的像素让页面底色透出一点；现在画布不透明。

```bash
npx vitest run tools/workbench_rhi                                   # 3D 调试件无 GPU 单测
sh scripts/py.sh -m pytest tools/workbench_rhi -q                    # 包 / 页面不含 WebGL / serve 路由
sh scripts/py.sh -m pytest tools/<粒子|地形|声学|轨迹>_workbench/tests/test_selftest.py -v   # Qt 自检 + Chrome 自检 + 冒烟
```
