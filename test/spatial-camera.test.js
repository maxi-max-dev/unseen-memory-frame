'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCamera } = require('../server/spatial-network');
function camera(direction, degrees, frame = 'frame_000000', id = 1) {
  const angle = degrees * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  return { img_name: frame + '_cam1_' + direction, position: [id, 2, 3], rotation: [[1, 0, 0], [0, cos, -sin], [0, sin, cos]], width: 960, height: 960, fx: 480, fy: 480 };
}
const parse = cameras => parseCamera(JSON.stringify(cameras));

test('camera selection uses validated pitch rather than model name: upright center and tilted capture up', () => {
  const upright = [camera('up', 48, undefined, 2), camera('center', 3, undefined, 1)];
  assert.deepEqual(parse(upright), parse([upright[1]]));
  const tilted = [camera('center', -65, undefined, 1), camera('up', -20, undefined, 2)];
  assert.deepEqual(parse(tilted), parse([tilted[1]]));
  assert.deepEqual(parse([...tilted].reverse()), parse([tilted[1]]));
});

test('selection stays in the first usable capture and resolves equal pitch to center deterministically', () => {
  const first = camera('center', 12, 'frame_000000', 1), later = camera('center', 0, 'frame_000001', 2);
  assert.deepEqual(parse([first, later, camera('up', 50, 'frame_000000', 3)]), parse([first]));
  const center = camera('center', 0, undefined, 1), up = camera('up', 0, undefined, 2);
  assert.deepEqual(parse([up, center]), parse([center]));
  assert.deepEqual(parse([center, up]), parse([center]));
});

test('missing named candidates fall back to the first validated pose and invalid primary candidates cannot win', () => {
  const fallback = camera('side', 15), broken = camera('center', 0);
  broken.rotation[0][0] = 2;
  assert.deepEqual(parse([broken, fallback]), parse([fallback]));
  const up = camera('up', 25);
  assert.deepEqual(parse([broken, fallback, up]), parse([up]));
  assert.deepEqual(parse([{ ...fallback, img_name: undefined }]), parse([fallback]));
  assert.equal(parse([]), undefined); assert.equal(parseCamera('{}'), undefined); assert.equal(parseCamera('invalid'), undefined);
});

test('bad quaternion-shaped/missing/singular/reflected rotation data and unsafe pose values are skipped', () => {
  const good = camera('center', 0), fallback = camera('side', 20);
  const invalid = [
    { ...good, rotation: undefined, quaternion: [0, 0, 0, 0] },
    { ...good, rotation: [0, 0, 0, 1] },
    { ...good, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    { ...good, rotation: [[1, 0, 0], [1, 0, 0], [0, 0, 1]] },
    { ...good, rotation: [[-1, 0, 0], [0, 1, 0], [0, 0, 1]] },
    { ...good, rotation: [['1', 0, 0], [0, 1, 0], [0, 0, 1]] },
    { ...good, position: [1e6, 0, 0] }, { ...good, fy: 0 }, { ...good, width: 0 }, { ...good, fy: 20000 }
  ];
  for (const candidate of invalid) {
    assert.equal(parse([candidate]), undefined);
    assert.deepEqual(parse([candidate, fallback]), parse([fallback]));
  }
  assert.equal(parse(Array(5001).fill(good)), undefined);
});
