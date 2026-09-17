偏差：旧角色/VFX 机制卡描述粒子共用角色 frameShade、只用 beta/GI 调亮，与本次场景倍率接线不符。
证据：CharacterLightingSystem.getLightFactors / createCustomLitShader，VfxRenderer.syncLightGain，DebugTools 的场景/时段六项倍率。
处理：已同步三张机制卡；倍率按场景/时段保存，粒子效果仅保留独立 lightGain，旧载荷缺项等价解析。
