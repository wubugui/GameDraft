"""重打光预设库。

- 时段预设的 key **对齐 game_config.dayNight.phases 的 id**(辰/午/暮/夜),
  导出的变体图直接对应 `SceneTimeVariant` 的 timeVariants 键。
- 天气预设(阴/雨/雾)是**修饰层**,与时段预设叠加(后者覆盖前者同名键);
  组合预设(如 夜雨)已预展开,策划直接选。
- 这里只是全局起点;逐场景微调过的参数存 out/<场景>/params_<预设>.json,
  优先于本表(见 serve/__main__)。
"""
from __future__ import annotations

from .relight import merge_params

#: 时段基准(键=游戏时段 id)
PHASES: dict[str, dict] = {
    '辰': {   # 清晨:低角度暖阳,长软影,一点薄霭
        'amb_int': 0.78, 'amb_kelvin': 7200.0,
        'sun_int': 0.55, 'sun_elev': 14.0, 'sun_azim': 115.0, 'sun_kelvin': 3600.0,
        'shadow_strength': 0.7, 'shadow_soft': 4.0,
        'fog_density': 0.9, 'fog_start': 0.35, 'fog_kelvin': 7000.0, 'fog_lum': 0.42,
        'ev': -0.1, 'grade_kelvin': 6200.0,
    },
    '午': {   # 正午:接近原图,轻微顶光让立体感醒一点
        'amb_int': 1.0,
        'sun_int': 0.28, 'sun_elev': 68.0, 'sun_azim': 195.0, 'sun_kelvin': 5600.0,
        'shadow_strength': 0.5, 'shadow_soft': 2.0,
    },
    '暮': {   # 向晚:西斜橙阳,影子拉长,暗部转紫
        'amb_int': 0.62, 'amb_kelvin': 8600.0,
        'sun_int': 0.85, 'sun_elev': 10.0, 'sun_azim': 255.0, 'sun_kelvin': 2700.0,
        'shadow_strength': 0.8, 'shadow_len': 3.5, 'shadow_soft': 3.0,
        'ev': -0.35, 'sat': 1.05, 'grade_kelvin': 5300.0, 'lift': 0.12, 'lift_kelvin': 12000.0,
    },
    '夜': {   # 入夜(纯夜,无灯,「只去天光」口径——对齐制作人 2026-08 验收的 C 版):
              # 无定向光,只留强半球梯度的天光残量(经天穹遮蔽场,巷道/檐下真遮蔽);
              # 定标硬指标:中位亮度≈12/255,朝上/朝下亮度比≈2.2:1,中性微冷。
              # 灯火之后在这个底子上叠(夜灯火/点光源系统)。
        'sun_int': 0.0,
        'amb_int': 0.35, 'amb_hemi': 0.717, 'amb_kelvin': 6500.0,
        'fog_density': 0.2, 'fog_start': 0.35, 'fog_kelvin': 6500.0, 'fog_lum': 0.06,
        'ev': -1.86, 'contrast': 0.9, 'sat': 1.0, 'grade_kelvin': 7200.0,
    },
    '夜月': { # 夜的备选:同上但开冷月光方向光(带投影;方位角逐场景对齐原图日影)
        'amb_int': 0.55, 'amb_hemi': 0.75, 'amb_kelvin': 6500.0,
        'sun_int': 0.55, 'sun_elev': 48.0, 'sun_azim': 60.0, 'sun_kelvin': 7000.0,
        'shadow_strength': 0.9, 'shadow_len': 3.5, 'shadow_soft': 2.0, 'shadow_steps': 48.0,
        'fog_density': 0.35, 'fog_start': 0.3, 'fog_kelvin': 6500.0, 'fog_lum': 0.10,
        'ev': -1.71, 'contrast': 0.88, 'sat': 1.0, 'grade_kelvin': 6800.0,
    },
    '夜浅': { # 阴沉夜(v2 风):亮度基本不降,靠彻底去色偏+去饱和读作阴夜,细节全保
        'sun_int': 0.0,
        'amb_int': 1.0, 'amb_hemi': 0.55, 'amb_kelvin': 6500.0,
        'fog_density': 0.35, 'fog_start': 0.3, 'fog_kelvin': 6500.0, 'fog_lum': 0.10,
        'ev': 0.23, 'contrast': 1.14, 'sat': 1.3, 'grade_kelvin': 7550.0,
    },
}

#: 天气修饰层(叠加在时段之上;值本身就是"叠加后"的绝对值,不做乘法合成)
WEATHERS: dict[str, dict] = {
    '阴': {   # 阴天:无定向光,压平,微降饱和
        'sun_int': 0.0, 'amb_int': 0.72, 'amb_kelvin': 7400.0,
        'sat': 0.85, 'ev': -0.2, 'contrast': 0.95,
    },
    '雨': {   # 雨:阴天基础上地面全湿、深雾、更暗(雨丝/涟漪是运行时特效,不烘进图)
        'sun_int': 0.0, 'amb_int': 0.6, 'amb_kelvin': 7800.0,
        'wet': 1.0, 'sheen': 0.5,
        'fog_density': 1.3, 'fog_start': 0.25, 'fog_kelvin': 7600.0, 'fog_lum': 0.3,
        'sat': 0.72, 'ev': -0.35, 'contrast': 0.92,
    },
    '雾': {   # 大雾:重深度雾,近处也吃一点
        'sun_int': 0.0, 'amb_int': 0.78,
        'fog_density': 2.6, 'fog_start': 0.06, 'fog_kelvin': 7200.0, 'fog_lum': 0.5,
        'sat': 0.8, 'contrast': 0.9,
    },
}


def _compose(*patches: dict) -> dict:
    out: dict = {}
    for p in patches:
        out.update(p)
    return out


#: 全部可选预设(时段 × 常用组合,先验证再进 merge_params 防打错键)
PRESETS: dict[str, dict] = {
    **PHASES,
    **WEATHERS,
    '夜灯火': _compose(PHASES['夜'],   # 纯夜基 + 点光源灯火(等纯夜验收后再调)
                       {'emis_gain': 2.6, 'emis_kelvin': 1900.0,
                        'lamp_int': 1.3, 'lamp_range': 1.2,
                        'glow_radius': 5.0, 'glow_gain': 0.8}),
    '夜雨': _compose(PHASES['夜'], WEATHERS['雨'],
                     {'ev': -2.28, 'contrast': 0.82, 'sat': 1.2, 'grade_kelvin': 7500.0}),
    '夜雾': _compose(PHASES['夜'], WEATHERS['雾'],
                     {'ev': -2.1, 'contrast': 0.8, 'sat': 1.2, 'grade_kelvin': 7500.0,
                      'fog_lum': 0.14}),
    '暮雨': _compose(PHASES['暮'], WEATHERS['雨'], {'ev': -0.5}),
}

for _name, _p in PRESETS.items():                  # 启动即验证,坏键当场炸
    merge_params(_p)
