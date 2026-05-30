import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { findSequenceBlockRange, serializeSequence, parseSequencePoints } from './yamlBlock.js';

describe('findSequenceBlockRange', () => {
  it('finds sequence block for key', () => {
    const lines = [
      'patrol:',
      '  route:',
      '    - x: 100',
      '      y: 200',
      '    - x: 300',
      '      y: 400',
      'speed: 20',
    ];
    const result = findSequenceBlockRange(lines, 1);
    assert.ok(result);
    assert.equal(result.startLine, 2);
    assert.equal(result.endLine, 5);
    assert.equal(result.indent, '    ');
  });

  it('returns undefined for key with inline value', () => {
    const lines = ['route: []'];
    assert.equal(findSequenceBlockRange(lines, 0), undefined);
  });

  it('stops at next sibling key', () => {
    const lines = [
      'polygon:',
      '  - x: 10',
      '    y: 20',
      'name: test',
    ];
    const result = findSequenceBlockRange(lines, 0);
    assert.ok(result);
    assert.equal(result.endLine, 2);
  });
});

describe('serializeSequence', () => {
  it('serializes points with indent', () => {
    const points = [{ x: 100, y: 200 }, { x: 300, y: 400 }];
    const result = serializeSequence(points, '    ');
    assert.equal(result, '    - x: 100\n      y: 200\n    - x: 300\n      y: 400');
  });

  it('uses toFixed(1) for non-integers', () => {
    const points = [{ x: 100.5, y: 200.3 }];
    const result = serializeSequence(points, '  ');
    assert.ok(result.includes('100.5'));
    assert.ok(result.includes('200.3'));
  });
});

describe('parseSequencePoints', () => {
  it('parses dash-x-y format', () => {
    const lines = [
      '    - x: 100',
      '      y: 200',
      '    - x: 300',
      '      y: 400',
    ];
    const pts = parseSequencePoints(lines, 0, 3);
    assert.equal(pts.length, 2);
    assert.deepEqual(pts[0], { x: 100, y: 200 });
    assert.deepEqual(pts[1], { x: 300, y: 400 });
  });
});
