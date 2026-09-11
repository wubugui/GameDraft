import { useEffect, useRef, useState } from 'react';
import { collectTaps, directPath, sourcePoint, buildImpulseResponse, type AcousticSpaceDef, type BuiltIR } from '../../../src/audio/acousticSpace';
import { workspace as w, type Slot } from './state';

let cacheKey = '', cache: ReturnType<typeof calculate> | undefined;
function calculate(def: AcousticSpaceDef, index: number) {
  const source = def.sources?.[index], opts = source ? { source: sourcePoint(def, source) } : {};
  const ear: number[] = [def.listener.x, (def.listener.y || 0) + (def.earHeight ?? 141), def.listener.z];
  const s = opts.source, start = s ? [s.x, s.y, s.z] : ear;
  const taps = collectTaps(def, opts), direct = directPath(def, opts);
  // Runtime exposes only the first hit of order-two paths; do not invent a
  // second hit and draw a misleading complete reflection path.
  const paths = taps.filter(t => t.order === 1 && t.hit).map(t => [start, t.hit!, ear]);
  return { taps, direct, paths, opts };
}
export let probeSource = -1;
export function acousticPreview() {
  const slot = w.slots.get(w.active);
  if (!w.visible.acoustic || slot?.kind !== 'acoustic' || slot.doc.authoring?.sceneId !== w.sceneId) return;
  const key = JSON.stringify([slot.doc, probeSource]);
  if (key !== cacheKey) { cache = calculate(slot.doc as AcousticSpaceDef, probeSource); cacheKey = key; }
  return cache;
}
export function AcousticPreview({ slot }: { slot: Slot }) {
  const canvas = useRef<HTMLCanvasElement>(null), [ir, setIr] = useState<BuiltIR>();
  const stamp = JSON.stringify([slot.doc, probeSource]), result = acousticPreview();
  useEffect(() => {
    const timer = setTimeout(() => setIr(buildImpulseResponse(slot.doc as AcousticSpaceDef, { sampleRate: 24000, ...result?.opts })), 250);
    return () => clearTimeout(timer);
  }, [stamp]);
  useEffect(() => {
    const c = canvas.current; if (!c || !ir) return;
    const g = c.getContext('2d')!, W = c.width = Math.max(200, c.clientWidth * devicePixelRatio), H = c.height = 90 * devicePixelRatio;
    g.clearRect(0, 0, W, H); g.fillStyle = '#64e3d0';
    for (let x = 0; x < W; x++) {
      let peak = 0;
      for (let i = Math.floor(x / W * ir.left.length); i < (x + 1) / W * ir.left.length && i < ir.left.length; i++) peak = Math.max(peak, Math.abs(ir.left[i]), Math.abs(ir.right[i]));
      const h = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(1e-9, peak)) + 60) / 60)) * H;
      g.fillRect(x, H - h, 1, h);
    }
  }, [ir]);
  return <section><h3>反射路径与 IR</h3>
    <label className="field"><span>发声位置</span><select value={probeSource} onChange={e => { probeSource = Number(e.target.value); w.notify(); }}><option value={-1}>听者自己喊</option>{(slot.doc.sources || []).map((s: any, i: number) => <option key={s.id} value={i}>{s.id}</option>)}</select></label>
    <p className="muted">作者态听者 · 画布显示一阶路径</p>
    {result && <><p className="muted">直达 {result.direct.length.toFixed(1)} m · {(result.direct.delay * 1000).toFixed(0)} ms</p>
      <p className="muted">{result.taps.length} 个反射 · 首回 {((result.taps[0]?.delay || 0) * 1000).toFixed(0)} ms</p>
      <div className="tap-table"><table><thead><tr><th>阶</th><th>反射面</th><th>ms</th><th>增益</th></tr></thead><tbody>{result.taps.slice(0, 24).map((t, i) => <tr key={i}><td>{t.order}</td><td>{t.reflectorIds.join(' → ')}</td><td>{(t.delay * 1000).toFixed(0)}</td><td>{t.gain.toFixed(3)}</td></tr>)}</tbody></table></div></>}
    <canvas className="ir-wave" ref={canvas}/><small className="muted">{ir ? (ir.left.length / ir.sampleRate).toFixed(1) : '…'} s · −60…0 dB</small>
  </section>;
}
