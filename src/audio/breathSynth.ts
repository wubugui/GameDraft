/**
 * 呼吸声合成(唯一一份:游戏的 AudioManager.startProceduralBreath 与呼吸工作台的页面都用它)。
 *
 * 一段 2 s 循环的有色噪声过两路带通(呼气低 ~650 Hz、吸气高 ~1700 Hz),两路响度与中心频率随鼻息流量走,
 * 汇到一个输出增益;输出接到调用方给的 destination(游戏 = Howler.masterGain,工作台 = ctx.destination)。
 *
 * `update(flow, gain)`:flow = 鼻息流量(呼出为正、吸入为负,平常一口呼气峰值 ≈ 1),gain = 这一刻的总增益
 * (游戏里 = 这张图的音量 × 混音口径)。每次更新顺带预约 0.25 s 后淡出——调用方停止更新(世界暂停、页面被截住)
 * 声音自己落下去,不会卡在最后一个流量上一直响。
 */
export interface BreathSynth {
  readonly ctx: AudioContext;
  update(flow: number, gain: number): void;
  stop(): void;
}

export function createBreathSynth(ctx: AudioContext, destination: AudioNode): BreathSynth {
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.97 * b0 + 0.03 * w;
    b1 = 0.6 * b1 + 0.4 * w;
    d[i] = (b0 * 3 + b1) * 0.5;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const band = (f: number, q: number): BiquadFilterNode => {
    const b = ctx.createBiquadFilter();
    b.type = 'bandpass'; b.frequency.value = f; b.Q.value = q;
    return b;
  };
  const ex = band(650, 0.8), inh = band(1700, 1.1);
  const gEx = ctx.createGain(), gIn = ctx.createGain(), out = ctx.createGain();
  gEx.gain.value = 0; gIn.gain.value = 0; out.gain.value = 0;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 3200;
  src.connect(ex); src.connect(inh); ex.connect(gEx); inh.connect(gIn);
  gEx.connect(lp); gIn.connect(lp); lp.connect(out); out.connect(destination);
  src.start();
  let stopped = false;
  return {
    ctx,
    update(flow: number, gain: number): void {
      if (stopped) return;
      const t = ctx.currentTime;
      const o = Math.max(flow, 0), n = Math.max(-flow, 0);
      for (const p of [gEx.gain, gIn.gain, out.gain, ex.frequency, inh.frequency]) p.cancelScheduledValues(t);
      gEx.gain.setTargetAtTime(0.9 * Math.pow(o, 1.5), t, 0.03);
      gIn.gain.setTargetAtTime(0.7 * Math.pow(Math.min(n, 4), 1.5), t, 0.03);
      ex.frequency.setTargetAtTime(520 + 260 * Math.min(o, 2), t, 0.05);
      inh.frequency.setTargetAtTime(1400 + 500 * Math.min(n, 4), t, 0.05);
      out.gain.setTargetAtTime(Math.max(0, gain), t, 0.05);
      out.gain.setTargetAtTime(0, t + 0.25, 0.08);   // 看门狗:没有下一次更新就自己落下去
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      try { src.stop(); } catch { /* 已停 */ }
      try { out.disconnect(); src.disconnect(); } catch { /* 已断 */ }
    },
  };
}
