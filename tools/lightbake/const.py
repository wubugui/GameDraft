"""`tools/lightbake` 的全部常量。

集中在此而不是散在各模块：载荷代次、tracer 判据、编码跨度、角色网格密度
这几组常量历史上都在同一天内漂过多次，散落两处就会各写各的。单点维护、
被 `tests/test_constants.py` 钉死。

数值与依据逐条对应 `artifact/Design/独立光照Baker-lightbake-实施方案-2026-08-23.md` §9。
"""
from __future__ import annotations

# 烘焙工作分辨率（宽）。遮蔽 / E / 法线都是低频量，1024 够用；`base` 仍出原生分辨率。
WORK_W = 1024

# 蒙特卡洛 gather 的每像素样本数。误差是无偏噪声按 √spp 退。
# 实测偏差 0.1120（16spp）< 旧固定求积偏差 0.1346。
GATHER_SPP = 16

# gather 行进步长（像素）。0.5px 亚像素，避免跨过薄遮挡壳。
# ⚠ 与旧 `MARCH_LENGTH` 不是一回事：射线再长步长都一样细。
GATHER_STEP_PX = 0.5

# gather 随机种子。**必须固定** —— 产物要字节可复现。
GATHER_SEED = 20260823

# tracer 三判据里的 bias / 厚度。两个入口逐字共享。
MARCH_BIAS = 0.025
MARCH_BIAS_GROWTH = 0.015
MARCH_THICKNESS = 0.75

# 逆 Reinhard 的分母下限。整条链唯一的建模假设。
HDR_MAX = 200.0

# 对数编码跨度（以 2 为底的档数）的钳位与下界取样分位。
HDR_LOG_SPAN_MIN = 8.0
HDR_LOG_SPAN_MAX = 24.0
HDR_LOG_FLOOR_PCT = 0.1

# 去霾时每个通道至少留下的比例（按自身留下限，保色度）。
HAZE_KEEP = 0.1

# 整体增益：取 hdr/E 的该分位让 base 的 p95 落在 1；上限是天光/日照比的天花板。
GATHER_GAIN_PERCENTILE = 95.0
GATHER_GAIN_MAX = 12.0

# 直射光方向扫描分辨率（仰角 × 方位）。
SUN_SCAN_EL = 7
SUN_SCAN_AZ = 16
# 直射光色度允许偏离中性的范围。方向不准时逐通道解会跑到边界。
SUN_CHROMA_CLAMP = (0.78, 1.28)

# 局部 AO：短程、全球面。**这里的截断是设计**（它量的就是近场）。
AO_STEPS = 10
AO_LENGTH = 0.25

# 实体空间数据的采样数。空间点没有法线只能均匀采样，收敛比余弦重要性慢。
CHAR_VOL_SPP = 64

# 实体空间网格密度，按角色高度定（§5.9 的密度扫描）。
CHAR_VOL_CELLS_PER_CHAR_XZ = 3.0
CHAR_VOL_CELLS_PER_CHAR_Y = 6.0

# 单场景格点总数上限，超了整体等比降密度。
CHAR_VOL_MAX_CELLS = 200_000

# 逃逸辐射（烘焙期天空）的缺省取法。**不进运行时载荷**。
# `intensity` 相对原画经逆 Reinhard 展开后的 HDR 辐射。
DEFAULT_SKY = {'mode': 'color', 'color': [1.0, 1.0, 1.0], 'intensity': 0.05}
