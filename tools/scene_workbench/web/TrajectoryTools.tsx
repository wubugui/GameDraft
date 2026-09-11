import { useEffect, useState } from 'react';
import { workspace as w, type Slot } from './state';

export function TrajectoryTransform({ slot }: { slot: Slot }) {
  const [scope, setScope] = useState('segment'), [segment, setSegment] = useState(0), [kind, setKind] = useState('translate'), [a, setA] = useState(0), [b, setB] = useState(0);
  const world = slot.doc.space === 'world';
  return <section><h3>轨迹变换</h3>
    <label className="field"><span>范围</span><select value={scope} onChange={e => setScope(e.target.value)}><option value="points">本段选中点</option><option value="segment">整段</option><option value="all">整条轨迹</option></select></label>
    {scope !== 'all' && <label className="field"><span>轨迹段</span><select value={segment} onChange={e => setSegment(Number(e.target.value))}>{slot.doc.source.segments.map((s: any, i: number) => <option key={s.id} value={i}>{s.id}</option>)}</select></label>}
    <label className="field"><span>操作</span><select value={kind} onChange={e => { setKind(e.target.value); setA(e.target.value === 'scale' ? 1 : 0); setB(e.target.value === 'scale' ? 1 : 0); }}><option value="translate">平移</option><option value="rotate">旋转</option><option value="scale">缩放</option><option value="mirror">镜像</option></select></label>
    {kind === 'mirror' ? <label className="field"><span>镜像轴</span><select value={a} onChange={e => setA(Number(e.target.value))}><option value={0}>X</option><option value={1}>{world ? 'Z' : 'Y'}</option></select></label> : <>
      <label className="field"><span>{kind === 'rotate' ? '角度 °' : 'X'}</span><input type="number" value={a} step={kind === 'scale' ? .1 : 1} onChange={e => setA(Number(e.target.value))}/></label>
      {kind !== 'rotate' && <label className="field"><span>{world ? 'Z' : 'Y'}</span><input type="number" value={b} step={kind === 'scale' ? .1 : 1} onChange={e => setB(Number(e.target.value))}/></label>}
    </>}
    <button disabled={w.locked || !Number.isFinite(a) || !Number.isFinite(b)} onClick={() => w.transformTrajectory(scope, segment, kind, a, b)}>应用变换</button>
    <p className="muted">Shift 多选控制点。旋转以段起点／整条锚点为中心。</p>
  </section>;
}

export function Timeline({ slot }: { slot: Slot }) {
  const duration = slot.bake?.totalMs || 0;
  useEffect(() => {
    let frame = 0, last = performance.now();
    const tick = (now: number) => {
      if (w.playing && duration > 0) {
        w.playhead += Math.min(100, now - last);
        if (w.playhead > duration) { if (w.loop) w.playhead %= duration; else { w.playhead = duration; w.playing = false; } }
        w.notify();
      }
      last = now; frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [slot.id, duration]);
  useEffect(() => { w.playing = false; w.playhead = 0; w.notify(); return () => { w.playing = false; }; }, [slot.id]);
  return <div className="timeline">
    <button disabled={!duration} onClick={() => { if (w.playhead >= duration) w.playhead = 0; w.playing = !w.playing; w.notify(); }}>{w.playing ? '暂停' : '播放'}</button>
    <button onClick={() => { w.playing = false; w.playhead = Math.max(0, w.playhead - 1000 / 60); w.notify(); }}>−帧</button>
    <input aria-label="轨迹时间" type="range" min={0} max={duration} step={1} value={Math.min(w.playhead, duration)} onChange={e => { w.playing = false; w.playhead = Number(e.target.value); w.notify(); }}/>
    <button onClick={() => { w.playing = false; w.playhead = Math.min(duration, w.playhead + 1000 / 60); w.notify(); }}>＋帧</button>
    <span>{Math.round(w.playhead)} / {Math.round(duration)} ms</span><label><input type="checkbox" checked={w.loop} onChange={e => { w.loop = e.target.checked; w.notify(); }}/>循环</label>
  </div>;
}
