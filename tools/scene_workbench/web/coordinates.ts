import * as THREE from 'three';
import { groundWorldAt, qToWorld, worldToQ, worldToScene, viewDirWorld, type SceneSpaceGeometry, type Vec3 } from '../../../src/utils/sceneSpace';

// Documents remain in M-world. The one reflection below exists only at the
// Three presentation boundary; never write Three's right-handed coordinates.
export const toRender = (p: ArrayLike<number>) => new THREE.Vector3(p[0], p[1], -p[2]);
export const fromRender = (p: THREE.Vector3): Vec3 => [p.x, p.y, -p.z];
export function runtimeGeometry(cal: any): SceneSpaceGeometry {
  return { work: cal.work, cal: { ppu: cal.ppu, cx: cal.cx, cy: cal.cy },
    sceneWorld: { w: cal.worldW, h: cal.worldH }, basisRows: cal.rows,
    wuPerQUnit: cal.wuPerQ, ground: cal.ground };
}

// Keep the original editor's heightfield and authoring helpers, but use the
// actual runtime implementation for the shared projection/ground contract.
export function useRuntimeProjection(cal: any) {
  const geo = runtimeGeometry(cal);
  cal.qToWorld = (x: number, y: number, z: number) => qToWorld(geo, [x, y, z]);
  cal.worldToQ = (x: number, y: number, z: number) => worldToQ(geo, [x, y, z]);
  cal.worldToScene = (x: number, y: number, z: number) => { const p = worldToScene(geo, [x, y, z]); return [p.x, p.y]; };
  cal.sceneToWorldGround = (x: number, y: number) => groundWorldAt(geo, x, y);
  return cal;
}

export function fitGameCamera(camera: THREE.OrthographicCamera, cal: any, mesh: THREE.Object3D, aspect: number) {
  const geo = runtimeGeometry(cal), k = geo.wuPerQUnit;
  const bounds = new THREE.Box3().setFromObject(mesh);
  const centerDepth = worldToQ(geo, fromRender(bounds.getCenter(new THREE.Vector3())))[2];
  const target = toRender(qToWorld(geo, [(geo.work.w / 2 - geo.cal.cx) / geo.cal.ppu,
    (geo.cal.cy - geo.work.h / 2) / geo.cal.ppu, centerDepth]));
  const distance = Math.max(100, bounds.getSize(new THREE.Vector3()).length() * 2);
  const imageW = geo.work.w / geo.cal.ppu * k, imageH = geo.work.h / geo.cal.ppu * k;
  const height = Math.max(imageH, imageW / aspect) / 0.92;
  camera.left = -height * aspect / 2; camera.right = height * aspect / 2;
  camera.top = height / 2; camera.bottom = -height / 2; camera.zoom = 1;
  camera.near = Math.max(.01, distance / 100000); camera.far = distance * 4;
  camera.up.copy(toRender(qToWorld(geo, [0, 1, 0]))).normalize();
  camera.position.copy(target).addScaledVector(toRender(viewDirWorld(geo)), -distance);
  camera.lookAt(target); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  return target;
}

export function auditProjection(cal: any, mesh: THREE.Mesh, camera: THREE.OrthographicCamera) {
  const geo = runtimeGeometry(cal), pos = mesh.geometry.getAttribute('position'), uv = mesh.geometry.getAttribute('uv');
  let meshError = 0, cameraError = 0;
  // Camera comparison uses the runtime projection at different depths, not
  // a self-consistent Three project/unproject pair (which missed the old bug).
  const origin = toRender(qToWorld(geo, [0, 0, 0])).project(camera);
  const xScale = 2 * geo.wuPerQUnit / (camera.right - camera.left) * camera.zoom;
  const yScale = 2 * geo.wuPerQUnit / (camera.top - camera.bottom) * camera.zoom;
  for (let i = 0; i < pos.count; i += Math.max(1, Math.floor(pos.count / 128))) {
    const p: Vec3 = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    const s = worldToScene(geo, p), projected = toRender(p).project(camera);
    meshError = Math.max(meshError, Math.hypot(s.x - uv.getX(i) * cal.worldW, s.y - uv.getY(i) * cal.worldH));
    const px = s.x / geo.sceneWorld.w * geo.work.w, py = s.y / geo.sceneWorld.h * geo.work.h;
    cameraError = Math.max(cameraError, Math.hypot(projected.x - origin.x - (px - geo.cal.cx) / geo.cal.ppu * xScale,
      projected.y - origin.y - (geo.cal.cy - py) / geo.cal.ppu * yScale));
  }
  const p = groundWorldAt(geo, cal.worldW * .5, cal.worldH * .7);
  const center = toRender(p).project(camera);
  const right = toRender(qToWorld(geo, [1, 0, 0])).project(camera).x > origin.x;
  const up = toRender([p[0], p[1] + 150, p[2]]).project(camera).y > center.y;
  const direction = camera.getWorldDirection(new THREE.Vector3()).dot(toRender(viewDirWorld(geo)));
  const tolerance = Math.hypot(cal.worldW / geo.work.w, cal.worldH / geo.work.h) * .51;
  return { meshError, cameraError, right, up, direction, tolerance,
    ok: meshError <= tolerance && cameraError < 1e-5 && right && up && direction > .99999 };
}
