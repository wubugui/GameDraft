# 场景工作台 · 功能迁移中

2026-09-09 复核：此前版本的功能覆盖不足，3D 初始机位与坐标手性也有错误。坐标已修正，但本工具仍不能替代全部旧工作台。逐项清单见 [FUNCTION_AUDIT.md](FUNCTION_AUDIT.md)，本轮证据见 [VERIFICATION.md](VERIFICATION.md)。

本目录是新增的独立工具。没有替换旧入口，也不需要修改根目录的 package.json、Vite、Tauri 或编辑器注册表。

界面使用 React + TypeScript；2D 使用 Canvas，3D 使用 Three.js，最终光影使用原 Pixi 游戏运行时；桌面外壳使用现有 PySide6 / Qt WebEngine，Python 适配层调用原工具的数据逻辑。

## 启动

Windows 双击本目录的 `start.cmd`，或在工程根目录运行：

```powershell
node scripts/pytool.cjs scene_workbench
```

定位到场景：

```powershell
node scripts/pytool.cjs scene_workbench --scene test_room_b
```

默认分配空闲本机端口，不占用已有工作台端口。第一次启动会在**本目录**安装前端依赖并构建；之后源码变更才重建。Python、PySide6、几何依赖使用工程现有环境。

## 已接入

- 3D 默认校准正交游戏机位；自由旋转、俯视和回到游戏机位；世界坐标仅在 Three 显示边界转换，拾取反变换后交回原操作。
- 轨迹初速、落点、最高点手柄；Shift 多选点；点／段／整条数值变换；播放、逐帧、循环、时间拖动和采样位置标记。均调用原 Edit 和采样器，尚无真实动画实体预览。
- 多声源、水平／垂直反射面、朝向和长度；作者态反射抽头、一阶路径、IR 波形直接使用游戏 acousticSpace 实现。尚未接入游戏内试听和声学同步。

- 共用的场景／背景选择、图层、对象列表、属性栏和文档切换。
- 2D 原图编辑和 3D 深度几何编辑，两种视图读同一份文档；无深度的场景支持画面坐标编辑。
- NPC／有位置的热区／出生点位置编辑；灯光新增、移动、基础参数；轨迹创建、手绘控制点、物理段、段顺序与烘焙预览；声学空间创建、听者、反射面和基础参数。
- 编辑即时入文档；拖拽合成一次撤销。切场景、切资产保留各自未保存的编辑。
- 原游戏运行时嵌入预览：F2 调光、F3 灯位编辑；「发送灯光」「读取运行时灯光」走现有同步通道。切换 2D／3D／运行时保留同一个游戏实例。
- Ctrl+S 保存所有打开的脏文档；失败保留草稿；外部文件变更拒绝覆盖。右侧「放弃修改」撤销本地草稿；文档信息中的「重新读取磁盘」读取外部最新版本。

点击「连接游戏预览」自动启动本工具专用的游戏进程，使用原工程的游戏入口、素材和 Vite 插件。自动选空闲端口；每次打开工作台使用新的临时状态目录 `.runtime/<会话>/`，不会读取上次残留的预览状态，也不依赖其他工具的服务。关闭工作台仅停止自己启动的进程。临时日志和编译产物都在本目录内。

需要连接指定的已有服务时可传 `--game-url http://127.0.0.1:5199`；此模式使用该服务原有的临时同步槽，工作台不启动或停止它。

预览中做的灯光修改需读取进工作台，再保存。不同场景禁止收发灯光；有尚未发送的本地灯光修改时拒绝回读覆盖。发送时按照**游戏实际所在时段**调用原有合并函数。关闭窗口先提交属性框输入并读取运行时；读取失败或冲突时保留草稿，让用户选择继续编辑或放弃关闭。

灯光支持上述内存往返；实体位置、轨迹等其他场景内容在保存后点击「进入当前场景」，由游戏原有读取流程重新加载。

## 数据处理的复用关系

| 工作台能力 | 实际调用的旧逻辑 |
| --- | --- |
| 场景文档读取、保存前校验、事务写盘 | `tools.editor.project_model.ProjectModel.load_project / mark_dirty / detect_external_changes / save_all` |
| 场景清单、背景、标定、地面、深度壳与三角网 | `tools.trajectory_workbench.geometry`、`serve.get_geometry / scaled_background` |
| 轨迹作者操作、高度场与撤销 | 原文件 `trajectory_workbench/viewer/common.js / edit.js / history.js`，运行时读取原文件，不复制实现 |
| 轨迹预览、烘焙、相对帧与文件保存 | `trajectory_workbench.serve.bake_document / save_document`；由其调用原 `assets` 写盘 |
| 声学默认定义、归一化、备份与写盘 | `acoustic_workbench.spaces.new_space_def / save_space` |
| 2D／3D 共同投影 | 直接 import `src/utils/sceneSpace.ts`；Three 显示边界单次翻 Z |
| 声学反射、直达、IR | 直接 import `src/audio/acousticSpace.ts`，使用作者态听者与选择的声源 |
| 反射面可视化的墙／水平面几何 | 原 `acoustic_workbench/viewer/mathx.js` 中的 `Geo.quad` |
| 灯光默认值、类型转换、校验、运行时传输、时段合并与拆分 | `editor.editors.scene_lights` 中原函数 |
| WebEngine 零缓存策略 | `tools.webengine_cache_policy.disable_all_caches / apply_no_cache` |
| 专用游戏预览 | 原 `vite.config.ts` 插件与 `src/main.ts`，只适配只读场景索引的根目录；插件产生的临时状态写在新目录 |

`backend.py` 只做请求分发与过期文档检查。没有新 JSON 序列化器、另一个轨迹烘焙器或另一套声学算法。原有 writer 自己的规范化／备份行为保持原样；没有扩展旧数据格式。

「保存全部」依次调用三个域已有的保存出口，各自保持原有事务边界；不是跨场景、轨迹、声学库的全局事务。已成功保存的文档会显示干净，后续失败的文档保留未保存状态。

## 桌面行为

独立 Qt WebEngine profile，不与其他工具或用户浏览器共享；调用统一零缓存策略；禁 LocalStorage、持久 Cookie、自动弹窗与下载；无需音频点击解锁；关闭后台定时器和渲染降速；拦截网页右键菜单、F5、Ctrl+R、Ctrl+P 和浏览器前进后退。保留画布自身的缩放与编辑快捷键。不申请摄像头、麦克风等浏览器权限。

专用运行时关闭 Vite HMR、开发 WebSocket 和浏览器控制台转发。Ctrl+S 在嵌入的游戏中也保存工作台文档。

运行时素材的 CPU／GPU 工作缓冲属于渲染所需内存。工作台不使用 Service Worker、IndexedDB 或浏览器存储保存草稿。退出时必须保存或放弃草稿。

## 当前边界

这是独立运行的迁移中界面；主场景结构编辑、真实实体预览以及多个专用工作流仍缺失，不只是少了高级参数。离线光照烘焙、场景重绘／relight、动画装配、生产工作台等继续由原工具完成。本版本不修改它们，也不包含声学试听面板的完整迁移。

2D 展示原场景图和编辑标记；3D 展示同源深度几何。光影最终效果由嵌入的真实游戏运行时显示，Three.js 视图使用无光材质，不冒充游戏光照。旧文档中没有对应控件的字段保持在完整草稿中，保存交给旧逻辑处理。

## 开发与验证

```powershell
# 本目录前端
npm ci
npm run build
npm test

# 工程根目录：测试真实旧保存链，写入仅在 pytest 临时工程
.tools/venv/Scripts/python.exe -B -m pytest tools/scene_workbench/tests -q -n 0 -p no:cacheprovider

# 原生桌面鼠标／键盘、撤销、几何、音频自测；不保存生产数据
node scripts/pytool.cjs scene_workbench --scene test_room_b --selftest tools/scene_workbench/tests/selftest.js --screenshot tools/scene_workbench/evidence/workbench-2d.png

# 专用游戏进程、真实灯光通道、F3、关闭保护；不保存生产数据
node scripts/pytool.cjs scene_workbench --scene test_room_b --selftest tools/scene_workbench/tests/runtime-selftest.js --screenshot tools/scene_workbench/evidence/workbench-runtime.png
```

调试前端可以使用 `--serve --port 5348` 启动 API，然后在本目录 `npm run dev`。常规使用直接运行桌面入口，以应用完整的桌面策略。

本轮原生检查（仅内存草稿）：

```powershell
node scripts/pytool.cjs scene_workbench --scene test_room_b --selftest tools/scene_workbench/tests/3d-selftest.js --screenshot tools/scene_workbench/evidence/coordinates-3d.png
node scripts/pytool.cjs scene_workbench --scene test_room_b --selftest tools/scene_workbench/tests/authoring-selftest.js --screenshot tools/scene_workbench/evidence/authoring-3d.png
```
