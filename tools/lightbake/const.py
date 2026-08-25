"""常量表 —— 方案 §9 逐行对应。每个值的依据在方案里,不在这重复。

⚠ 契约测试 1(单一实现):判据常量 `MARCH_BIAS` / `MARCH_BIAS_GROWTH` /
`MARCH_THICKNESS` / `GATHER_STEP_PX` 只许被 `trace.py`(与本定义处、tests)引用。
别处引用了它们就说明在自写判据 —— 静态扫描红。
"""
from __future__ import annotations

#: 烘焙工作分辨率(宽)。遮蔽/E/法线是低频量,够用。
WORK_W = 1024

#: 场景 E gather 的每像素样本数(余弦重要性)。误差是无偏噪声,按 √spp 退。
GATHER_SPP = 16

#: tracer 行进步长(像素)。亚像素,避免跨过薄壳。★ 只许 trace.py 引用。
GATHER_STEP_PX = 0.5

#: 位置哈希种子的根(方案 §5.4):同一空间点永远抽到同一批方向,
#: 与批次/线程无关;产物字节可复现。
GATHER_SEED = 20260823

#: 命中判据(可见壳):bias < pen < THICKNESS,bias = BIAS + GROWTH·t。
#: ★ 只许 trace.py 引用(契约测试 1)。
MARCH_BIAS = 0.025
MARCH_BIAS_GROWTH = 0.015
MARCH_THICKNESS = 0.75

#: 逆 Reinhard 的分母下限(整条链唯一的建模假设,§5.2)。
HDR_MAX = 200.0

#: 对数编码跨度的钳位与下界取样分位(§5.10)。
HDR_LOG_SPAN_MIN = 8.0
HDR_LOG_SPAN_MAX = 24.0
HDR_LOG_FLOOR_PCT = 0.1

#: 去霾按自身留下限,保色度(§5.1)。
HAZE_KEEP = 0.1

#: 整体增益:让 base 的 p95 落在 1 的尺度约定(§5.7)。
GATHER_GAIN_PERCENTILE = 95.0
GATHER_GAIN_MAX = 12.0

#: 直射光方向扫描(§5.6)。
SUN_SCAN_EL = 7
SUN_SCAN_AZ = 16
SUN_CHROMA_CLAMP = (0.78, 1.28)

#: 局部 AO 的积分半径(q 单位)。AO 问的就是「半径 r 内有多封闭」,
#: r 是**问题定义的一部分**,不是 tracer 截断 —— 以 `max_distance` 显式传给
#: `trace()`(§5.8)。旧的 `AO_STEPS` 已删,步长归 tracer 统一管。
AO_RANGE = 0.25

#: 局部 AO 的每点样本数。方案 §9 未定此值(仅定了矩的 64);取与矩同值 64:
#: 全球面均匀采样 + 余弦加权归约,噪声量级与旧 96 方向求积可比,且出锅后有 σ=0.8。
AO_SPP = 64

#: 遮蔽矩的统一 spp:场景逐像素与体格点**必须同值**(§5.9 极限一致性铁律 3)。
MOMENT_SPP = 64
CHAR_VOL_SPP = MOMENT_SPP

#: ---- NEE + MIS(firefly 的无偏解,§5.4 预留的采样扩展;实现在 nee.py)----
#: 发光体判定阈:to_hdr 展开后的辐亮度(典型反射面 ≲1,灯芯 ~200)。
NEE_EMITTER_MIN = 4.0
#: 发光体表上限(按亮度确定性截取;1024 宽工作分辨率下实测远够)。
NEE_MAX_EMITTERS = 65536
#: (历史:曾有 NEE_MIN_DIST_PX 近场移交与 NEE_DZ_FLOOR 掠射保护 —— 终版
#: 壳箱体采样的 ω 密度天生有界,两者皆不需要,§15 验尸记录。)

#: clamp 系(有偏,Cycles「Clamp Indirect」同款):单样本间接贡献的亮度上限,
#: None = 关闭(缺省)。CLI `--clamp-indirect X` 打开;与 NEE 正交、可叠加。
CLAMP_INDIRECT_DEFAULT = None

#: 实体空间网格密度:按角色高度定,不按场景尺寸定(§5.9)。
CELLS_PER_CHAR_XZ = 3.0
CELLS_PER_CHAR_Y = 6.0
CHAR_VOL_MAX_CELLS = 200_000

#: 载荷代次。改产物布局必须 +1,并同步
#: `src/core/SceneLightingSystem.ts:LIGHTING3_VERSION` 与
#: `tools/editor/validator.py:_LIGHTING3_VERSION`(三处漂移由测试钉死,§4.1)。
PAYLOAD_VERSION = 6

#: 角色在场景坐标里的固定高度(与 tools/scene_relight/bake.py 同一约定)。
CHAR_SCENE_H = 150.0

#: 逃逸辐射的缺省取法(烘焙期输入,不进运行时载荷,§5.3)。
DEFAULT_SKY = {'mode': 'color', 'color': [1.0, 1.0, 1.0], 'intensity': 0.05}

# 运行时阴影 bias 缺省(lightPacking.DEFAULT_SHADOW_BIAS_WU/_THICKNESS_WU 镜像,wu)
DEFAULT_SHADOW_BIAS_WU = 30.8
DEFAULT_SHADOW_THICKNESS_WU = 264.0

# 灯缺省(lightPacking 镜像,wu):作用半径 3 个人高;发光体半径 1/15 个人高
DEFAULT_LIGHT_RANGE_WU = 450.0
DEFAULT_LAMP_RADIUS_WU = 10.0
