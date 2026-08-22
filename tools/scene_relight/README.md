# 场景重打光工作台(scene_relight)

把**已经画好的白天场景背景图** relight 成任意时段/天气的变体图:入夜、向晚、清晨、
阴、雨、雾及其组合。核心是**确定性**管线(纯 numpy,零随机、零生成模型)——
同输入同参数必出同字节,画面结构 100% 不变,这是"可调、稳定、可 ship"的根。

技术路线依据 2026-08 的调研结论(扩散 relighting 对手绘图风格漂/不可复现/许可证
不可 ship;业界 2D 游戏 day-night 全部走确定性资产管线),取"程序化 depth 感知
重打光"为主体;扩散模型只建议将来作离线关键帧参考,不进本管线。

## 用法

```bash
sh scripts/py.sh -m tools.scene_relight            # 桌面应用(缺省;PySide6 壳)
./dev.sh scene-relight                             # 同上(POSIX 机)
sh scripts/py.sh -m tools.scene_relight --serve    # 仅 HTTP 服务 http://localhost:5317
sh scripts/py.sh -m tools.scene_relight --list     # 场景清单与状态
sh scripts/py.sh -m tools.scene_relight --scene 码头白天 --preset 夜 --export
sh scripts/py.sh -m tools.scene_relight --all --preset 夜 --export   # 批量
```

**接进游戏的两步**（离线导出变体图是旧路线，现在走运行时重打光）：

```bash
# ① 烘几何场：法线 / 天穹可见性 / 3D 网格 / GI 命中图 → runtime/scenes/<id>/lighting2/
sh scripts/py.sh -m tools.scene_relight.bake --scene 雾津街头
sh scripts/py.sh -m tools.scene_relight.bake --all              # 全部（约 3 分钟/场景）

# ② 恒等迁移：把场景接进统一光影且**画面零变化**（S_new ≡ S_day）
sh scripts/py.sh -m tools.scene_relight.migrate --all
sh scripts/py.sh -m tools.scene_relight.migrate --all --verify  # 只验不写
```

★ **烘的全是几何项**，与灯、时刻、天光无关——摆灯、调参、推进时刻**都不用重烘**。

★ 恒等迁移写的是**占位**配置（`lighting.placeholder: true`）：背景已接新管线、
画面逐像素不变，但**角色仍走旧 probe 路径**（恒等只对背景成立）。
作者真给某个场景摆了灯之后，删掉 `placeholder` 键，那个场景的角色才切过来。

两步也可以在桌面壳里点（`POST /api/bake?scene=` / `POST /api/migrate?scene=`）。

桌面壳零浏览器缓存(app.py,三层):off-the-record profile(纯内存,磁盘无缓存目录)
+ 显式 NoCache/NoPersistentCookies + 服务端全响应 `no-store`。F5/Ctrl+R 刷新。

工作流(工作台):选场景 → 选预设「载入预设」(或拖时刻滑杆「按时刻推光照」)
→ 微调滑杆(预览 = **同一份核心**低分辨率跑,所见即导出)→ 夜景先「✎ 刷发光
mask」把灯笼/亮窗涂出来存掉 → 「保存参数」→ 「⇪ 导出本预设」。

## 输入(全部来自工程,不另立源)

| 输入 | 来源 | 缺了会怎样 |
|---|---|---|
| 背景图 | `runtime/scenes/<id>/<backgrounds[0].image>` | 场景不可用 |
| 深度 | `raw_depth_rg.png` + 场景 JSON `depthConfig`(char-lighting lab 导出) | 退化为纯调色+发光,无阴影/雾/湿地 |
| 发光 mask | `out/<id>/emissive_mask.png`(本工具里刷,**进 git**) | 夜景没有灯火 |

深度解码与世界重建与运行时同式:`d=(R*256+G)/65535*scale+offset`,
`world = R·[(sx-cx)/ppu, (cy-py)/ppu, d]`。

## 算法(一屏说完)

方法按承重顺序是三件事(2026-08-20 制作人验收口径):
①**天穹可见性**——逐像素向上半球 12 方向 march 深度场(`sky_field`),巷道深处/屋檐下
物理上收不到天光就是黑的;②**定向光(日/月)投影**——沿光方向 march 深度场
(`screen_shadow`);③**先除掉白天光、再乘上新光**(只是最后一步算术):
`out = bg_lin × clamp(S_new/S_day, 0, ratio_max)`,**S_day 与 S_new 都由 ①② 构成**。

⚠ **别把 ③ 当成方法的名字。已被否**:S_day/S_new 只用法线朝上项、不做任何 march 的
写法——逐像素纯调色,画不出遮蔽结构,看着就是贴滤镜。同样被否:照别的夜景图的统计量
定标调色(本质仍是调色)。调色只许作收尾,**明暗结构必须由光照扛**。

`S_new` = 环境半球光(色温/强度/半球权重,**经天穹可见性**)+ 定向光(高度角/方位角/色温)
× N·L × **深度场投影**(沿光线 march,确定步长);
再叠:**发光 mask → 伪世界点光源**(每个 mask 连通域反投影成 3D 灯:N·L/r² 真照明
+ 高斯作用半径 + 沿深度场的逐灯可见性 march,墙背后收不到光;灯色 = 色温 × 原图
像素色,红灯笼发红光)+ 灯体自亮 + 大气光晕 → 湿地(法线朝上区压暗+水光)→
**深度雾**(按视深指数,支持世界高度衰减)→ 调色(EV/对比/饱和/白平衡/暗部提升)
→ sRGB。`keep_src` 是与原图的保底混合。
夜的观感结构:冷天光只打朝上面(屋顶亮、墙面黑)+ 冷月光带真投影 + 暖灯池贴几何,
暖冷对比是"重打光"而非"糊滤镜"的分界。

## 产物与接线

- 变体图:`runtime/scenes/<id>/background_relight_<预设>.png`(原子写;覆盖旧变体
  前自动备份到 `out/<id>/backup/`,该目录 gitignore)。runtime 资源区走 DVC,
  记得按钦定链路 push。
- 参数:`out/<id>/params_<预设>.json`(完整参数,进 git;导出/批量优先用它)。
- 接线:预设名 = `game_config.dayNight.phases` 的 id(辰/午/暮/夜),导出后把
  工作台打印的 `timeVariants` 片段配进场景 JSON。⚠ **运行时目前只声明了
  `SceneTimeVariant.timeVariants` 类型,还没有消费它的换图逻辑**(types.ts:2618),
  接线前需先做运行时消费(feature-iteration,小改动:听 `time:phaseChanged` 换
  背景纹理)。

## 边界(知情决策,不是疏漏)

- **角色照明仍是白天烘的**:lighting/ 的 probe 是按白天背景烘的,夜景变体下角色
  会偏亮。后续在 char-lighting lab 里按变体图重烘/多套导出(未做)。
- 白天原图里**画死的投影**不会被抹掉(阴天风原画基本无硬影,实际影响小);
  雨丝、涟漪、飘雾动效属运行时特效,不烘进静态图。
- 深度来自单目模型,薄结构阴影会偏粗;`shadow_soft`/`shadow_bias` 是修正旋钮。

## 测试

```bash
sh scripts/py.sh -m pytest tools/scene_relight/tests -q -p no:cacheprovider
```

(`-p no:cacheprovider`:仓库写保护下 pytest 收尾挂 120s 的已知坑,见
agent_docs inbox 2026-08-19。)
