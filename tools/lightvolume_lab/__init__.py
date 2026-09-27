"""LightVolume Lab — 深度图离线辐照度体积烘焙 / quad 预览(独立 Web 工具)。

启动:``./dev.sh lightvol``(起静态服 + 开浏览器)。画面(预览 quad / 环境 FX)走引擎 RHI(只有 WebGPU,2026-09-28),
要经启动器打开才拿得到渲染包;直接双击 ``index.html``(file://)只剩载入 / 烘焙 / 切片,画面区写原因。

⚠ 它按已废除的拟合地面 ``floor_depth_A/B`` 算;新管线烘出来的场景没有这两个字段:载入照常、FX 的地面项是 NaN、烘焙当场抛错。
"""
