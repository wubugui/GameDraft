import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { resolveSpatialField } from './fieldResolver.js';

const noCtx: string[] = [];

describe('resolveSpatialField', () => {
  it('resolves x to position', () => {
    assert.equal(resolveSpatialField('  x: 100', noCtx, 0).kind, 'position');
  });
  it('resolves y to position', () => {
    assert.equal(resolveSpatialField('  y: 200', noCtx, 0).kind, 'position');
  });
  it('resolves polygon to polygon', () => {
    assert.equal(resolveSpatialField('  polygon:', noCtx, 0).kind, 'polygon');
  });
  it('resolves collisionPolygon to polygon', () => {
    assert.equal(resolveSpatialField('  collisionPolygon:', noCtx, 0).kind, 'polygon');
  });
  it('resolves route to route', () => {
    assert.equal(resolveSpatialField('  route:', noCtx, 0).kind, 'route');
  });
  it('resolves spawnPoint to spawn', () => {
    assert.equal(resolveSpatialField('  spawnPoint: from_street', noCtx, 0).kind, 'spawn');
  });
  it('resolves targetSpawnPoint to spawn', () => {
    assert.equal(resolveSpatialField('  targetSpawnPoint: entrance', noCtx, 0).kind, 'spawn');
  });
  it('resolves zone to zone', () => {
    assert.equal(resolveSpatialField('  zone: safe_area', noCtx, 0).kind, 'zone');
  });
  it('resolves entity to entity', () => {
    assert.equal(resolveSpatialField('  entity: blind_li', noCtx, 0).kind, 'entity');
  });
  it('resolves scene to scene', () => {
    assert.equal(resolveSpatialField('  scene: teahouse', noCtx, 0).kind, 'scene');
  });
  it('resolves targetScene to scene', () => {
    assert.equal(resolveSpatialField('  targetScene: mountain_pass', noCtx, 0).kind, 'scene');
  });
  it('returns unknown for unrecognized key', () => {
    assert.equal(resolveSpatialField('  foo: bar', noCtx, 0).kind, 'unknown');
  });
  it('returns unknown for empty line', () => {
    assert.equal(resolveSpatialField('', noCtx, 0).kind, 'unknown');
  });
  it('extracts the key', () => {
    assert.equal(resolveSpatialField('  scene: teahouse', noCtx, 0).key, 'scene');
  });
});
