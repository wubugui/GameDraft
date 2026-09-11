import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { workspace as w, type Mark } from './state';
import { toRender, fromRender, fitGameCamera, auditProjection } from './coordinates';
import { acousticPreview } from './AcousticPreview';

type Camera2D = { zoom: number; x: number; y: number };
export function Viewport2D() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current!, g = c.getContext('2d')!;
    const cam: Camera2D = { zoom: 1, x: 0, y: 0 };
    let sceneKey = '', space = false;
    let drag: { mark?: Mark; start: number[]; camera: Camera2D; world?: number[] } | null = null;
    const screen = (p: number[]) => [(p[0] - cam.x) / cam.zoom, (p[1] - cam.y) / cam.zoom];
    const pixel = (p: number[]) => [p[0] * cam.zoom + cam.x, p[1] * cam.zoom + cam.y];
    const local = (e: PointerEvent | WheelEvent) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const fit = () => { if (!w.scene) return; cam.zoom = Math.min(c.clientWidth / w.scene.worldWidth, c.clientHeight / w.scene.worldHeight) * 0.92;
      cam.x = (c.clientWidth - w.scene.worldWidth * cam.zoom) / 2; cam.y = (c.clientHeight - w.scene.worldHeight * cam.zoom) / 2; };
    const draw = () => {
      const dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      if (!w.scene || !w.image) return;
      const key = `${w.sceneId}:${w.background}`; if (key !== sceneKey) { sceneKey = key; fit(); }
      g.drawImage(w.image, cam.x, cam.y, w.scene.worldWidth * cam.zoom, w.scene.worldHeight * cam.zoom);
      const marks = w.marks();
      for (const path of acousticPreview()?.paths || []) {
        g.strokeStyle = '#64e3d0aa'; g.lineWidth = 1; g.beginPath();
        path.forEach((p, i) => { const q = pixel(w.cal.worldToScene(...p)); if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }); g.stroke();
      }
      // Preview curves are produced by the original Python baker.
      if (w.visible.trajectory) for (const s of w.slots.values()) {
        if (s.kind !== 'trajectory' || s.doc.authoring?.sceneId !== w.sceneId || (s.doc.authoring.background && s.doc.authoring.background !== w.background)) continue;
        const points = s.bake?.preview?.screen || [];
        g.strokeStyle = '#bba2ff'; g.lineWidth = 2; g.beginPath();
        points.forEach((p: number[], i: number) => { const q = pixel([p[1], p[2]]); if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }); g.stroke();
        if (w.slots.get(w.active) === s) {
          const pose = window.Legacy.sampleScreen(points, w.playhead);
          if (pose) { const q = pixel([pose.x, pose.y]); g.save(); g.translate(q[0], q[1]); g.rotate(pose.rot * Math.PI / 180); g.globalAlpha = pose.alpha; g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(-9 * pose.sx, -18 * pose.sy, 18 * pose.sx, 36 * pose.sy); g.restore(); }
        }
      }
      for (const m of marks.filter(m => m.type === 'reflector' && m.path.at(-1) === 'a')) {
        const other = marks.find(b => b.slot === m.slot && b.type === 'reflector' && b.path[1] === m.path[1] && b.path.at(-1) === 'b');
        if (!other) continue;
        const a = pixel(m.screen), b = pixel(other.screen);
        g.strokeStyle = m.color; g.lineWidth = 3; g.beginPath(); g.moveTo(...a as [number, number]); g.lineTo(...b as [number, number]); g.stroke();
        const r = w.slots.get(m.slot)!.doc.reflectors[Number(m.path[1])];
        const quad = window.Legacy.AcousticGeo.quad(r).map((p: number[]) => pixel(w.cal.worldToScene(...p)));
        g.fillStyle = '#64e3d023'; g.beginPath(); quad.forEach((p: number[], i: number) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath(); g.fill();
      }
      for (const m of marks) {
        const [x, y] = pixel(m.screen), selected = w.selectedKeys.has(m.key) || m.key === w.selected;
        if (m.type === 'light' && m.world) {
          const floor = pixel(w.cal.worldToScene(m.world[0], w.cal.groundHeight(m.world[0], m.world[2]), m.world[2]));
          g.strokeStyle = '#ffcc7290'; g.setLineDash([3, 4]); g.beginPath(); g.moveTo(x, y); g.lineTo(floor[0], floor[1]); g.stroke(); g.setLineDash([]);
        }
        g.fillStyle = selected ? '#fff' : m.color; g.strokeStyle = selected ? m.color : '#111922'; g.lineWidth = selected ? 3 : 2;
        g.beginPath(); g.arc(x, y, selected ? 7 : m.type === 'point' ? 4 : 5, 0, Math.PI * 2); g.fill(); g.stroke();
        if (selected || m.type !== 'point') { g.font = '12px "Microsoft YaHei", sans-serif'; const text = m.label;
          g.fillStyle = '#111820da'; g.fillRect(x + 10, y - 12, g.measureText(text).width + 12, 22);
          g.fillStyle = selected ? '#fff' : '#d7e1eb'; g.fillText(text, x + 16, y + 3); }
      }
      g.font = '11px monospace'; g.fillStyle = '#a5b4c7'; g.fillText(`${Math.round(cam.zoom * 100)}%  ·  ${Math.round(w.scene.worldWidth)} × ${Math.round(w.scene.worldHeight)} wu`, 20, H - 18);
    };
    const finish = (cancel = false) => { if (drag?.mark) { const s = w.slots.get(drag.mark.slot)!; if (cancel) s.history.cancelDrag(); else s.history.endDrag(); w.changed(drag.mark.slot); } drag = null; };
    const down = (e: PointerEvent) => {
      if (w.locked || !w.scene) return;
      c.focus(); const p = local(e); c.setPointerCapture(e.pointerId);
      if (e.button !== 0 || space) { drag = { start: p, camera: { ...cam } }; return; }
      if (w.tool === 'pen') { w.addPoint(screen(p)); return; }
      const mark = w.marks().reverse().find(m => { const q = pixel(m.screen); return Math.hypot(p[0] - q[0], p[1] - q[1]) < 13; });
      w.select(mark, e.shiftKey);
      if (e.shiftKey) return;
      if (mark) { w.slots.get(mark.slot)!.history.beginDrag('移动 ' + mark.label); drag = { mark, start: p, camera: { ...cam }, world: mark.world?.slice() }; }
    };
    const move = (e: PointerEvent) => {
      if (!drag) return; const p = local(e);
      if (!drag.mark) { cam.x = drag.camera.x + p[0] - drag.start[0]; cam.y = drag.camera.y + p[1] - drag.start[1]; draw(); return; }
      const m = drag.mark;
      if ((e.altKey || m.type === 'apex') && drag.world && (['light', 'sound', 'point', 'tip'].includes(m.type) || (m.type === 'apex' && w.slots.get(m.slot)!.doc.space === 'world'))) {
        const xyz = [...drag.world]; xyz[1] -= (p[1] - drag.start[1]) / cam.zoom / Math.max(.001, Math.abs(w.cal.cosTheta));
        w.move(m, w.cal.worldToScene(...xyz), xyz);
      } else if (m.type === 'tip' && w.slots.get(m.slot)!.doc.space === 'world') {
        const now = screen(p), xyz = w.cal.sceneToWorldAtHeight(now[0], now[1], drag.world![1]);
        w.move(m, now, xyz);
      } else if (m.world && (['light', 'sound'].includes(m.type) || (m.type === 'point' && w.slots.get(m.slot)!.doc.space === 'world'))) {
        // Move on the ground, retaining the object's original height above it.
        const old = drag.world!, h = old[1] - w.cal.groundHeight(old[0], old[2]);
        const foot = w.cal.worldToScene(old[0], old[1] - h, old[2]);
        const start = screen(drag.start), now = screen(p);
        const xyz = w.cal.sceneToWorldGround(foot[0] + now[0] - start[0], foot[1] + now[1] - start[1]);
        xyz[1] += h;
        w.move(m, screen(p), xyz);
      } else w.move(m, screen(p));
    };
    const wheel = (e: WheelEvent) => { e.preventDefault(); const p = local(e), before = screen(p); cam.zoom = Math.max(0.02, Math.min(12, cam.zoom * Math.exp(-e.deltaY * 0.001))); cam.x = p[0] - before[0] * cam.zoom; cam.y = p[1] - before[1] * cam.zoom; draw(); };
    const key = (e: KeyboardEvent) => { if ((e.target as HTMLElement).matches('input,textarea,select')) return; if (e.code === 'Space') { e.preventDefault(); space = e.type === 'keydown'; } if (e.type === 'keydown' && e.key === 'Escape') finish(true); if (e.type === 'keydown' && e.key.toLowerCase() === 'f') { fit(); draw(); } };
    const up = () => finish(), cancel = () => finish(true);
    c.addEventListener('pointerdown', down); c.addEventListener('pointermove', move); c.addEventListener('pointerup', up); c.addEventListener('pointercancel', cancel); c.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', key); window.addEventListener('keyup', key); window.addEventListener('blur', cancel);
    const resize = new ResizeObserver(draw); resize.observe(c); const unsub = w.subscribe(draw);
    w.viewportCenter = () => screen([c.clientWidth / 2, c.clientHeight / 2]); draw();
    return () => { finish(true); resize.disconnect(); unsub(); w.viewportCenter = null; c.removeEventListener('pointerdown', down); c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); c.removeEventListener('pointercancel', cancel); c.removeEventListener('wheel', wheel); window.removeEventListener('keydown', key); window.removeEventListener('keyup', key); window.removeEventListener('blur', cancel); };
  }, []);
  return <canvas aria-label="场景二维画布" ref={canvas} tabIndex={0} />;
}

export function Viewport3D() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = host.current!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); } catch { w.error = '无法创建 WebGL2 上下文，请检查显卡或切回 2D'; w.notify(); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
    root.appendChild(renderer.domElement);
    const c = renderer.domElement, scene = new THREE.Scene(); scene.background = new THREE.Color('#111820');
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 100000);
    const controls = new OrbitControls(camera, c); controls.mouseButtons = { LEFT: null as any, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    controls.screenSpacePanning = true;
    const worldRoot = new THREE.Group(); worldRoot.scale.z = -1; scene.add(worldRoot);
    const marksGroup = new THREE.Group(); worldRoot.add(marksGroup);
    let surface: THREE.Mesh | null = null, backdrop: THREE.Mesh | null = null, key = '', disposed = false;
    let drag: { mark: Mark; plane: THREE.Plane; start: number[]; offset: THREE.Vector3; world: number[] } | null = null;
    let gameCamera = true;
    const raycaster = new THREE.Raycaster();
    const disposeGroup = (group: THREE.Object3D) => { group.traverse((obj: any) => { obj.geometry?.dispose(); if (obj.material) { const materials = Array.isArray(obj.material) ? obj.material : [obj.material]; materials.forEach((mat: any) => { mat.map?.dispose(); mat.dispose(); }); } }); group.clear(); };
    const draw = () => { if (!disposed) renderer.render(scene, camera); };
    const fit = () => {
      if (!surface || !w.cal) return;
      scene.updateMatrixWorld(true);
      controls.target.copy(fitGameCamera(camera, w.cal, surface, Math.max(1, root.clientWidth) / Math.max(1, root.clientHeight)));
      controls.update(); gameCamera = true; if (backdrop) backdrop.visible = true;
      const report = auditProjection(w.cal, surface, camera);
      root.dataset.alignment = JSON.stringify(report);
      if (!report.ok) { w.error = `3D 坐标校验失败：${JSON.stringify(report)}`; }
      draw();
    };
    const rebuild = () => {
      const nextKey = `${w.sceneId}:${w.background}`;
      if (nextKey !== key) {
        key = nextKey;
        if (surface) { worldRoot.remove(surface); disposeGroup(surface); surface = null; }
        if (backdrop) { worldRoot.remove(backdrop); disposeGroup(backdrop); backdrop = null; }
        if (w.mesh && w.image) {
          const dv = new DataView(w.mesh), nv = dv.getUint32(0, true), ni = dv.getUint32(4, true);
          const interleaved = new THREE.InterleavedBuffer(new Float32Array(w.mesh, 8, nv * 5), 5);
          const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(interleaved, 3, 0)); geometry.setAttribute('uv', new THREE.InterleavedBufferAttribute(interleaved, 2, 3)); geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(w.mesh, 8 + nv * 20, ni), 1));
          const texture = new THREE.Texture(w.image); texture.flipY = false; texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true;
          // Unlit material: this view shows geometry, and does not invent a second lighting pipeline.
          surface = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide })); worldRoot.add(surface);
          // The old shell omits triangles across depth discontinuities. Restore
          // the source image behind those holes only at the calibrated camera.
          // Free geometry inspection must not show a fictitious background wall.
          let farQ = -Infinity;
          for (let i = 0; i < nv; i++) farQ = Math.max(farQ, w.cal.worldToQ(interleaved.array[i * 5], interleaved.array[i * 5 + 1], interleaved.array[i * 5 + 2])[2]);
          const corners = [[0, 0], [w.cal.work.w, 0], [w.cal.work.w, w.cal.work.h], [0, w.cal.work.h]].map(([x, y]) => w.cal.qToWorld((x - w.cal.cx) / w.cal.ppu, (w.cal.cy - y) / w.cal.ppu, farQ + 1));
          const bgGeo = new THREE.BufferGeometry(); bgGeo.setAttribute('position', new THREE.Float32BufferAttribute(corners.flat(), 3)); bgGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2)); bgGeo.setIndex([0, 1, 2, 0, 2, 3]);
          backdrop = new THREE.Mesh(bgGeo, new THREE.MeshBasicMaterial({ map: texture.clone(), side: THREE.DoubleSide })); worldRoot.add(backdrop); fit();
        }
      }
      disposeGroup(marksGroup);
      const marks = w.marks().filter(m => m.world);
      const scale = Math.max(3, (w.scene?.worldWidth || 1000) / 180);
      for (const m of marks) {
        const selected = w.selectedKeys.has(m.key) || m.key === w.selected;
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(scale * (selected ? 1.4 : 1), 12, 8), new THREE.MeshBasicMaterial({ color: selected ? '#ffffff' : m.color, depthTest: false }));
        mesh.position.fromArray(m.world!); mesh.userData.mark = m; mesh.renderOrder = 3; marksGroup.add(mesh);
        if (selected) { const axes = new THREE.AxesHelper(scale * 12); axes.position.copy(mesh.position); axes.renderOrder = 4; marksGroup.add(axes); }
        if (m.type === 'reflector' && m.path.at(-1) === 'a') {
          const other = marks.find(b => b.slot === m.slot && b.type === 'reflector' && b.path[1] === m.path[1] && b.path.at(-1) === 'b'); if (!other) continue;
          const r = w.slots.get(m.slot)!.doc.reflectors[Number(m.path[1])], a = m.world!, b = other.world!;
          const points: number[][] = window.Legacy.AcousticGeo.quad(r);
          const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3)); geo.setIndex([0, 1, 2, 0, 2, 3]);
          marksGroup.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: m.color, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false })));
          marksGroup.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(...p))), new THREE.LineBasicMaterial({ color: m.color })));
        }
      }
      for (const path of acousticPreview()?.paths || []) marksGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(path.map(p => new THREE.Vector3(...p))), new THREE.LineBasicMaterial({ color: '#64e3d0', transparent: true, opacity: .6, depthTest: false })));
      if (w.visible.trajectory) for (const s of w.slots.values()) {
        if (s.kind !== 'trajectory' || s.doc.authoring?.sceneId !== w.sceneId || (s.doc.authoring.background && s.doc.authoring.background !== w.background)) continue;
        const pts = s.bake?.preview?.world || [];
        if (pts.length) marksGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map((p: number[]) => new THREE.Vector3(p[1], p[2], p[3]))), new THREE.LineBasicMaterial({ color: '#bba2ff', depthTest: false })));
        if (w.slots.get(w.active) === s) {
          const pose = window.Legacy.sampleWorld(pts, w.playhead);
          if (pose) { const ghost = new THREE.Mesh(new THREE.OctahedronGeometry(scale * 2), new THREE.MeshBasicMaterial({ color: '#ffffff', wireframe: true, depthTest: false })); ghost.position.fromArray(pose); marksGroup.add(ghost); }
        }
      }
      draw();
    };
    const setRay = (e: PointerEvent) => { const r = c.getBoundingClientRect(); raycaster.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera); };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || w.locked || !w.cal) return;
      setRay(e);
      if (w.tool === 'pen' && surface) { const hit = raycaster.intersectObject(surface)[0]; if (hit) w.addPoint(w.cal.worldToScene(...fromRender(hit.point))); return; }
      const hit = raycaster.intersectObjects(marksGroup.children).find(hit => hit.object.userData.mark);
      const mark = hit?.object.userData.mark as Mark | undefined; w.select(mark, e.shiftKey);
      if (e.shiftKey) return;
      if (!mark) return;
      controls.enabled = false; c.setPointerCapture(e.pointerId);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -mark.world![1]);
      const intersection = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      drag = { mark, start: [e.clientX, e.clientY], plane, world: mark.world!.slice(),
        offset: intersection ? toRender(mark.world!).sub(intersection) : new THREE.Vector3() };
      w.slots.get(mark.slot)!.history.beginDrag('移动 ' + mark.label);
    };
    const move = (e: PointerEvent) => {
      if (!drag) return; setRay(e); const point = new THREE.Vector3();
      if (e.altKey || drag.mark.type === 'apex') {
        const base = toRender(drag.world), a = base.clone().project(camera), b = base.clone().add(new THREE.Vector3(0, 1, 0)).project(camera);
        const dx = (b.x - a.x) * c.clientWidth / 2, dy = -(b.y - a.y) * c.clientHeight / 2, lengthSq = dx * dx + dy * dy;
        if (lengthSq < 1e-10) return;
        const height = ((e.clientX - drag.start[0]) * dx + (e.clientY - drag.start[1]) * dy) / lengthSq;
        point.copy(base).add(new THREE.Vector3(0, height, 0));
      }
      else { if (!raycaster.ray.intersectPlane(drag.plane, point)) return; point.add(drag.offset); }
      const xyz = fromRender(point); w.move(drag.mark, w.cal.worldToScene(...xyz), xyz);
    };
    const finish = (cancel = false) => { if (drag) { const slot = drag.mark.slot, s = w.slots.get(slot)!; drag = null; if (cancel) s.history.cancelDrag(); else s.history.endDrag(); w.changed(slot); } controls.enabled = true; };
    const up = () => finish(), cancel = () => finish(true);
    const keydown = (e: KeyboardEvent) => { if ((e.target as HTMLElement).matches('input,textarea,select')) return; if (e.key === 'Escape') cancel(); if (e.key.toLowerCase() === 'f') fit(); };
    c.addEventListener('pointerdown', down); c.addEventListener('pointermove', move); c.addEventListener('pointerup', up); c.addEventListener('pointercancel', cancel); window.addEventListener('keydown', keydown); window.addEventListener('blur', cancel);
    controls.addEventListener('change', draw);
    controls.addEventListener('start', () => { gameCamera = false; if (backdrop) backdrop.visible = false; draw(); });
    const resize = new ResizeObserver(() => { const W = root.clientWidth, H = Math.max(1, root.clientHeight); renderer.setSize(W, H); if (gameCamera) fit(); else { camera.left = -camera.top * W / H; camera.right = -camera.left; camera.updateProjectionMatrix(); draw(); } }); resize.observe(root);
    w.viewportCenter = () => { if (!w.cal) return [0, 0]; return w.cal.worldToScene(...fromRender(controls.target)); };
    const onCamera = (event: Event) => {
      finish(true);
      if ((event as CustomEvent).detail === 'top') {
        fit(); gameCamera = false; if (backdrop) backdrop.visible = false; const distance = camera.position.distanceTo(controls.target);
        camera.position.copy(controls.target).add(new THREE.Vector3(0, distance, 0)); camera.up.set(0, 0, -1); camera.lookAt(controls.target); controls.update(); draw();
      } else fit();
    };
    window.addEventListener('workbench-camera', onCamera);
    // Read-only QA access to the rendered camera, also used to test native drag.
    const debug = { project: (p: number[]) => { const v = toRender(p).project(camera), r = c.getBoundingClientRect(); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; },
      audit: () => surface && auditProjection(w.cal, surface, camera) };
    window.workbench.viewport3D = debug;
    const unsub = w.subscribe(rebuild); rebuild();
    return () => { finish(true); disposed = true; unsub(); resize.disconnect(); controls.dispose(); disposeGroup(scene); renderer.dispose(); renderer.forceContextLoss(); c.remove(); w.viewportCenter = null; if (window.workbench.viewport3D === debug) delete window.workbench.viewport3D; window.removeEventListener('workbench-camera', onCamera); window.removeEventListener('keydown', keydown); window.removeEventListener('blur', cancel); };
  }, []);
  return <div className="three-host" ref={host} aria-label="场景三维画布" />;
}
