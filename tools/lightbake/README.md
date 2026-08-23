# `tools/lightbake` — 独立光照 Baker

全新、独立、自带预览的离线 baker，产出统一光影管线（`lighting3/`）的全部烘焙产物。
预览是**单文件自包含 HTML**（图全部内联），结构上不可能看到浏览器缓存的旧图。

设计文档：`artifact/Design/独立光照Baker-lightbake-实施方案-2026-08-23.md`（权威规范，本 README 只做索引）。

## 一句话

从场景输入（原画 + 深度图 + `depthConfig`）产出光照载荷（`base` / `irradiance` / 遮蔽 / 法线 / 实体体积数据），
并把它渲染成可判读的预览。

## 用法

```bash
# 烘一个场景（结束自动出 report + 自检，红就非零退出）
sh scripts/py.sh -m tools.lightbake bake --scene 雾津街头

# 全烘
sh scripts/py.sh -m tools.lightbake bake --all

# 只跑自检，不写盘
sh scripts/py.sh -m tools.lightbake check --scene 雾津街头

# 只出预览
sh scripts/py.sh -m tools.lightbake report --scene 雾津街头 --open

# 两次产物逐项对比
sh scripts/py.sh -m tools.lightbake diff --scene 雾津街头 --against path/to/other/lighting3
```

可选参数（`bake` / `check` / `report`）：

| 参数 | 含义 | 缺省 |
|---|---|---|
| `--spp N` | 场景 gather 每像素样本数 | 16 |
| `--vol-density N` | 实体体积数据密度（每角色高格数，纵向自动 ×2） | 3 |
| `--no-gi` | 关掉实体 GI 通道 | 关 |
| `--work-w N` | 工作分辨率宽 | 1024 |
| `--sky <json|path>` | 逃逸辐射：JSON 字符串 / `.json` 文件 / 图片路径（skybox） | `DEFAULT_SKY` |
| `--sky-color R,G,B` | 纯色天空（线性 RGB） | — |
| `--sky-intensity K` | 天空强度 | — |

产物落 `public/resources/runtime/scenes/<sid>/lighting3/`：

```
base.png            原生分辨率（I/E，比例基底）
irradiance.png      work 分辨率（烘焙 GI）
normal.png          work（全值域世界法线）
sky_occlusion.png   work（RGB=Bdir，A=余弦加权可见度 V）
vis_linear.png      work（V(ω)≈clamp(a+b·ω) 线性重建）
ao.png              work（局部 AO）
char_volume.bin     3D 实体空间数据（L1 传输）
meta.json
preview/report.html 单文件自包含预览
```

## 模块划分

```
input.py     场景 → (深度, 原画, R/ppu/cx/cy, world, normal, char_wu, band)。★ 唯一外部依赖面
trace.py     唯一 tracer：trace_pixels / trace_points + 契约测试
gather.py    去霾 / E / base / Bdir / V / vis_linear / 直接光反解 / gather_gain / AO / 运行时拟合
volume.py    实体空间数据：密度、validity、dilation、打包
sky.py       程序性天空 CPU 镜像（与 skySh.ts 同式）+ 烘焙期逃逸天空
encode.py    三条编码曲线 + 往返自检
payload.py   原子写 + meta.json + PAYLOAD_VERSION
bake.py      顶层编排（把上面串成一次烘焙）
check.py     自检断言（方案 §10）
report.py    自包含 HTML 预览（方案 §11）
const.py     全部常量（方案 §9）
```

## 测试

```bash
sh scripts/py.sh -m pytest tools/lightbake/tests
```

全部确定性、纯内存（不写仓库），可离线跑。

## 边界

- **做**：漫反射、遮蔽/AO、程序性天光、环境光、色彩与曝光标定、实体与场景同一条光照管线。
- **不做**：阴影、高光、场景 GI 多次弹射（实体 GI 通道保留，可 `--no-gi` 关）。
- **不动**：`tools/scene_relight/` 整包、场景侧逐像素产物精度。

## 载荷版本

`PAYLOAD_VERSION = 6`。三处常量必须同时改（方案 §4.1）：`payload.py`、
`src/core/SceneLightingSystem.ts`、`tools/editor/validator.py`。本工具只产 v6 载荷，
运行时接线（P6）由接手方同步改。
