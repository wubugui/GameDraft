"""蒙特卡洛烘焙的常量表 —— 值的依据写在这，不散在调用点。

2026-09-01 从 `lighting-rebuild` 分支的 `tools/lightbake/const.py` 移植。
只搬**算法**用得着的那些：判据、步长、采样数、种子。载荷布局、编码曲线、
运行时契约一概不动（本次收窄：只换 probe 与 skyao 的**算法**，形式不改）。

⚠ 单一实现:判据常量 `MARCH_BIAS` / `MARCH_BIAS_GROWTH` / `MARCH_THICKNESS` /
`GATHER_STEP_PX` **只许 `trace.py`（与本定义处、tests）引用**。别处引用了它们
就说明在自写 march 判据 —— 那正是被替换掉的旧代码的病根（`scene_geometry`
与 `scene_fields` 各写了一套 march，判据漂了都没人发现）。
"""
from __future__ import annotations

#: tracer 行进步长(像素)。亚像素 —— 旧实现是 `2.2/16 wu ≈ 15.5 px`，
#: 比栏杆/檐口/电线杆还粗，细结构射线直接迈过去、完全不产生遮蔽。
GATHER_STEP_PX = 0.5

#: 命中判据(可见壳):bias < pen < THICKNESS，bias = BIAS + GROWTH·t。
#: 旧实现 thickness=2.0 wu ≈ 场景深度跨度的一半 ⇒ 判挡退化成"前面有东西就算挡"。
MARCH_BIAS = 0.025
MARCH_BIAS_GROWTH = 0.015
MARCH_THICKNESS = 0.75

#: 位置哈希种子的根:同一空间点永远抽到同一批方向，与批次/线程/调用顺序无关。
#: 这是 `test_烘出来的场与光照参数无关`（重烘两次逐字节相同）在 MC 下仍成立的地基。
GATHER_SEED = 20260823

#: 天穹遮蔽矩的每点样本数。逐像素与 3D 网格**必须同值** —— 两边是同一个被估量，
#: spp 不同就不是"同一个估计器"，格点落在表面点上时不再逐位相同。
MOMENT_SPP = 64

#: probe 每颗的方向样本数。旧实现是 196 条 Fibonacci 定向 —— 无分层、无位置抖动，
#: 相邻 probe 抽到几乎同一批方向，误差在空间上**相关**，表现为块状而不是噪声。
PROBE_SPP = 256

#: à-trous 引导去噪的趟数(0=关)。只作用于 2D 场(skyvis)，probe 走 dilation。
DENOISE_ITERS = 3
