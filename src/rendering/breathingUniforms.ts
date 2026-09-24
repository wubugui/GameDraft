import type { BreathingOverlayRig } from '../data/breathingOverlays';
import type { BreathingFrame, BreathingLimits } from '../systems/breathing/BreathingPerformance';

/**
 * 呼吸图:表演帧 → 着色器 uniform 的换算(纯函数、不碰 Pixi;游戏的呼吸图 Mesh 与呼吸工作台的预览共用,保证两边一样)。
 * 着色器本体在 `breathingShade.glsl`(两边拼的也是同一份,按 BEGIN/END 标记切片)。
 */

export const BREATHING_SHADE_TAG = 'BREATHING_SHADE';

/** 从 breathingShade.glsl 原文切出 BEGIN/END 之间那段 */
export function sliceBreathingShade(src: string): string {
  const b = `//__${BREATHING_SHADE_TAG}_BEGIN__`;
  const e = `//__${BREATHING_SHADE_TAG}_END__`;
  const i = src.indexOf(b);
  const j = src.indexOf(e);
  if (i < 0 || j < 0) throw new Error(`breathingShade.glsl 缺切片标记 ${BREATHING_SHADE_TAG}`);
  return src.substring(i + b.length, j);
}

export interface BreathingUniformInput {
  frame: BreathingFrame;
  vent: number;
  cran: number;
  inflate: number;
  sink: number;
}

/**
 * 每帧变的那几个 uniform。胸口位移按 limits 夹紧;飞起 / 贴下的明暗按各自满幅归一。
 */
export function breathingUniforms(inp: BreathingUniformInput, rig: BreathingOverlayRig, limits: BreathingLimits = rig.limits): Record<string, number> {
  const { frame } = inp;
  const infl = frame.paperMm;
  const ref = infl >= 0 ? Math.max(inp.inflate, 0.1) : Math.max(inp.sink * 2.5, 0.1);
  return {
    uInfl: infl * rig.pxPerMm,
    uFlapAng: (frame.flapDeg * Math.PI) / 180,
    uShade: rig.shade * Math.max(-1, Math.min(1.4, infl / ref)),
    uVentPx: Math.min(inp.vent * frame.chest, limits.ventMm) * rig.pxPerMm,
    uCranPx: Math.min(inp.cran * frame.chest, limits.cranMm) * rig.pxPerMm,
  };
}

/** 不随帧变的 uniform(由这张图的骨架常数决定) */
export function breathingStaticUniforms(rig: BreathingOverlayRig, size: [number, number], layersPremultiplied: boolean): {
  uSize: [number, number]; uL: number; uRoot: [number, number]; uRootDisp: [number, number]; uN0: [number, number]; uLamp: [number, number]; uPremul: number;
} {
  return {
    uSize: size,
    uL: rig.flapLengthPx,
    uRoot: rig.root,
    uRootDisp: rig.rootDisp,
    uN0: rig.flapNormal,
    uLamp: rig.lampDir,
    uPremul: layersPremultiplied ? 1 : 0,
  };
}
