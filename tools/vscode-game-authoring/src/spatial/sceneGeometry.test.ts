import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  validatePolygon, validateRoute,
  readPolygon, writePolygon, readRoute, writeRoute,
  listSpawnPoints, listZones, listEntities,
} from './sceneGeometry.js';
import type { SceneJson } from './sceneGeometry.js';

const baseScene: SceneJson = {
  id: 'teahouse',
  worldWidth: 700,
  zones: [
    { id: 'safe', polygon: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] },
  ],
  npcs: [
    { id: 'storyteller', x: 100, y: 200, patrol: { route: [{ x: 200, y: 300 }, { x: 300, y: 200 }], speed: 20 } },
    { id: 'blind_li', x: 50, y: 60 },
  ],
  hotspots: [{ id: 'notice', x: 300, y: 100 }],
  spawnPoint: { x: 285, y: 195 },
  spawnPoints: { from_street: { x: 151, y: 171 } },
};

describe('validatePolygon', () => {
  it('accepts valid polygon', () => {
    const r = validatePolygon([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]);
    assert.ok(r.valid);
    assert.equal(r.errors.length, 0);
  });
  it('rejects < 3 points', () => {
    const r = validatePolygon([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
    assert.ok(!r.valid);
    assert.ok(r.errors[0]!.includes('3'));
  });
});

describe('validateRoute', () => {
  it('accepts single point route', () => {
    const r = validateRoute([{ x: 0, y: 0 }]);
    assert.ok(r.valid);
  });
  it('rejects empty route', () => {
    const r = validateRoute([]);
    assert.ok(!r.valid);
  });
});

describe('readPolygon / writePolygon', () => {
  it('reads polygon by zone id', () => {
    const pts = readPolygon(baseScene, 'safe');
    assert.equal(pts?.length, 4);
    assert.deepEqual(pts![0], { x: 0, y: 0 });
  });
  it('returns undefined for missing zone', () => {
    assert.equal(readPolygon(baseScene, 'missing'), undefined);
  });
  it('writes polygon back', () => {
    const newPts = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }];
    const updated = writePolygon(baseScene, 'safe', newPts);
    assert.deepEqual(readPolygon(updated, 'safe'), newPts);
    assert.equal(updated.zones?.length, 1);
  });
  it('does not mutate original', () => {
    const newPts = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }];
    writePolygon(baseScene, 'safe', newPts);
    assert.equal(baseScene.zones![0]!.polygon!.length, 4);
  });
});

describe('readRoute / writeRoute', () => {
  it('reads route by entity id', () => {
    const pts = readRoute(baseScene, 'storyteller');
    assert.equal(pts?.length, 2);
  });
  it('returns undefined for entity without patrol', () => {
    assert.equal(readRoute(baseScene, 'blind_li'), undefined);
  });
  it('writes route back without base point', () => {
    const newRoute = [{ x: 150, y: 250 }, { x: 350, y: 150 }];
    const updated = writeRoute(baseScene, 'storyteller', newRoute);
    assert.deepEqual(readRoute(updated, 'storyteller'), newRoute);
  });
});

describe('listSpawnPoints', () => {
  it('includes default spawnPoint and named ones', () => {
    const ids = listSpawnPoints(baseScene);
    assert.ok(ids.includes('spawnPoint'));
    assert.ok(ids.includes('from_street'));
  });
});

describe('listZones', () => {
  it('returns zone ids', () => {
    assert.deepEqual(listZones(baseScene), ['safe']);
  });
});

describe('listEntities', () => {
  it('returns npc and hotspot ids with kinds', () => {
    const ents = listEntities(baseScene);
    assert.ok(ents.some((e) => e.id === 'storyteller' && e.kind === 'npc'));
    assert.ok(ents.some((e) => e.id === 'notice' && e.kind === 'hotspot'));
  });
});
