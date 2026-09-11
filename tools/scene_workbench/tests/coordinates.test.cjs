const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const THREE = require('three');
const load = require('./load-ts.cjs');
const C = load(path.join(__dirname, '../web/coordinates.ts'));
const R = load(path.join(__dirname, '../../../src/utils/sceneSpace.ts'));

for (const [tilt, k, workW, nativeW] of [[36, 154, 512, 2048], [40, 880, 768, 2064], [50, 302, 600, 1800]]) test(`runtime projection and native picking: tilt ${tilt}, scale ${k}, native/work ${nativeW / workW}`, () => {
  const t = tilt * Math.PI / 180, cal = { work: { w: workW, h: 384 }, ppu: 140, cx: workW * .46, cy: 177, wuPerQ: k, worldW: nativeW, worldH: 1152,
    rows: [1, 0, 0, 0, Math.cos(t), -Math.sin(t), 0, Math.sin(t), Math.cos(t)], ground: { w: workW, h: 384, data: new Float32Array(workW * 384).fill(2) } };
  const geo = C.runtimeGeometry(cal), vertices = [], uvs = [];
  for (const [x, y, d] of [[.1, .2, 1], [.8, .2, 5], [.3, .8, 10], [.9, .9, 1]]) {
    vertices.push(...R.qToWorld(geo, [(x * workW - cal.cx) / cal.ppu, (cal.cy - y * 384) / cal.ppu, d])); uvs.push(x, y);
  }
  const mesh = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)).setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)), new THREE.MeshBasicMaterial());
  const group = new THREE.Group(); group.scale.z = -1; group.add(mesh); group.updateMatrixWorld(true);
  const camera = new THREE.OrthographicCamera();
  C.fitGameCamera(camera, cal, mesh, 1.6);
  const report = C.auditProjection(cal, mesh, camera);
  assert.equal(report.ok, true, JSON.stringify(report));
  const p = R.groundWorldAt(geo, nativeW * .3, 800), render = C.toRender(p), ndc = render.clone().project(camera);
  const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
  const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -p[1]), new THREE.Vector3());
  assert.ok(hit); assert.ok(Math.hypot(...C.fromRender(hit).map((v, i) => v - p[i])) < 1e-6);
  // Explicitly reject the previously shipped +Z, perspective/right-handed setup.
  camera.position.set(0, 500, 5000); camera.up.set(0, 1, 0); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  assert.equal(C.auditProjection(cal, mesh, camera).ok, false);
  mesh.geometry.dispose(); mesh.material.dispose();
});
