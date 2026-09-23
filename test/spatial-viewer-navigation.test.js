'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const moduleReady = import('../server/public/spatial-viewer-navigation.mjs');
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);

class Canvas extends EventTarget {
  constructor() { super(); this.captured = new Set(); this.listeners = new Map(); this.clientHeight = 600; }
  addEventListener(name, fn, options) { super.addEventListener(name, fn, options); if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn, options) { super.removeEventListener(name, fn, options); this.listeners.get(name)?.delete(fn); }
  focus() { this.focused = true; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); this.emit('lostpointercapture', { pointerId: id }); }
  emit(type, data = {}) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0, ...data });
    this.dispatchEvent(event);
    return event;
  }
}

async function fixture() {
  const { bindSpatialNavigation } = await moduleReady;
  const canvas = new Canvas(), actions = [];
  let ready = true, mode = 'rotate';
  const input = bindSpatialNavigation({ canvas, isReady: () => ready, mode: () => mode,
    rotate: (...args) => actions.push(['rotate', ...args]), pan: (...args) => actions.push(['pan', ...args]),
    zoom: factor => actions.push(['zoom', factor]), reset: () => actions.push(['reset']) });
  return { canvas, actions, input, setReady: value => { ready = value; }, setMode: value => { mode = value; } };
}

test('screen-space pan preserves depth and scales with viewport, FOV and distance', async () => {
  const { screenPanOffset } = await moduleReady;
  const camera = { dx: 100, dy: 50, height: 1000, distance: 10, fov: 90, yaw: 0, pitch: 0,
    right: [1, 0, 0], up: [0, 1, 0], back: [0, 0, 1] };
  const delta = screenPanOffset(camera);
  delta.forEach((value, i) => near(value, [-2, 1, 0][i]));
  screenPanOffset({ ...camera, height: 2000 }).forEach((value, i) => near(value, delta[i] / 2));
  screenPanOffset({ ...camera, distance: 20 }).forEach((value, i) => near(value, delta[i] * 2));
  // A quarter-turn swaps world X/Z, without changing how far the scene moves.
  screenPanOffset({ ...camera, yaw: Math.PI / 2 }).forEach((value, i) => near(value, [0, 1, 2][i]));
  // A vertically tilted capture must still pan along its screen, not world Y.
  screenPanOffset({ ...camera, up: [0, 0, 1], back: [0, -1, 0] }).forEach((value, i) => near(value, [-2, 0, 1][i]));
  const tilted = screenPanOffset({ ...camera, pitch: Math.PI / 4 });
  near(tilted[1] + tilted[2], 0); // zero component along the viewing direction
});

test('left drag rotates, selected pan mode and Shift/right drag translate', async () => {
  const f = await fixture();
  f.canvas.emit('pointerdown', { clientX: 10, clientY: 20 });
  f.canvas.emit('pointermove', { clientX: 14, clientY: 27 });
  assert.deepEqual(f.actions.pop(), ['rotate', 4, 7]);
  f.canvas.emit('pointermove', { clientX: 20, clientY: 24, shiftKey: true });
  assert.deepEqual(f.actions.pop(), ['pan', 6, -3]);
  f.setMode('pan');
  f.canvas.emit('pointermove', { clientX: 22, clientY: 25 });
  assert.deepEqual(f.actions.pop(), ['pan', 2, 1]);
  f.canvas.emit('pointerup'); f.setMode('rotate');
  f.canvas.emit('pointerdown', { button: 2 });
  f.canvas.emit('pointermove', { clientX: 9 });
  assert.deepEqual(f.actions.pop(), ['pan', 9, 0]);
  assert.equal(f.canvas.emit('contextmenu').defaultPrevented, true);
  f.input.destroy();
});

test('two touches combine midpoint pan with pinch; lifting/cancelling cannot jump the camera', async () => {
  const f = await fixture();
  f.canvas.emit('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 0 });
  f.canvas.emit('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 100 });
  f.canvas.emit('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 0 });
  assert.deepEqual(f.actions[0], ['pan', 10, 0]);
  near(f.actions[1][1], 100 / 120);
  f.canvas.emit('pointerup', { pointerId: 1 });
  f.actions.length = 0;
  f.canvas.emit('pointermove', { pointerId: 2, clientX: 121, clientY: 2 });
  assert.deepEqual(f.actions, [['rotate', 1, 2]]);
  f.canvas.emit('pointercancel', { pointerId: 2 });
  f.canvas.emit('pointermove', { pointerId: 2, clientX: 900 });
  assert.equal(f.actions.length, 1);
  assert.equal(f.canvas.captured.size, 0);
  f.input.destroy();
});

test('overlapping fingers do not produce infinite zoom, and three touches are ignored', async () => {
  const f = await fixture();
  f.canvas.emit('pointerdown', { pointerId: 1, pointerType: 'touch' });
  f.canvas.emit('pointerdown', { pointerId: 2, pointerType: 'touch' });
  f.canvas.emit('pointermove', { pointerId: 2, clientX: 1 });
  assert.equal(f.actions.some(action => action[0] === 'zoom'), false);
  f.canvas.emit('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 200 });
  f.actions.length = 0;
  f.canvas.emit('pointermove', { pointerId: 3, clientX: 300 });
  assert.deepEqual(f.actions, []);
  f.input.destroy();
});

test('keyboard and wheel remain local and preserve browser shortcuts', async () => {
  const f = await fixture();
  f.canvas.emit('keydown', { key: 'ArrowLeft', shiftKey: true });
  assert.deepEqual(f.actions.pop(), ['pan', -20, 0]);
  f.canvas.emit('keydown', { key: 'ArrowDown' });
  assert.deepEqual(f.actions.pop(), ['rotate', 0, 20]);
  f.canvas.emit('keydown', { key: 'Home' });
  assert.deepEqual(f.actions.pop(), ['reset']);
  assert.equal(f.canvas.emit('keydown', { key: '+', ctrlKey: true }).defaultPrevented, false);
  assert.equal(f.canvas.emit('keydown', { key: 'ArrowLeft', altKey: true }).defaultPrevented, false);
  assert.equal(f.canvas.emit('wheel', { deltaY: 1, ctrlKey: true }).defaultPrevented, false);
  assert.equal(f.actions.length, 0);
  f.canvas.emit('wheel', { deltaY: 2, deltaMode: 1 });
  const lineFactor = f.actions.pop()[1];
  f.canvas.emit('wheel', { deltaY: 32, deltaMode: 0 });
  near(f.actions.pop()[1], lineFactor);
  f.input.destroy();
});

test('loading/failed viewers ignore input; blur and destroy release capture and every listener', async () => {
  const f = await fixture();
  f.setReady(false);
  assert.equal(f.canvas.emit('wheel', { deltaY: 100 }).defaultPrevented, false);
  f.canvas.emit('pointerdown'); f.canvas.emit('pointermove', { clientX: 10 });
  assert.deepEqual(f.actions, []);
  f.setReady(true);
  f.canvas.emit('pointerdown'); f.canvas.emit('blur');
  assert.equal(f.canvas.captured.size, 0);
  f.canvas.emit('pointermove', { clientX: 10 });
  assert.deepEqual(f.actions, []);
  f.canvas.emit('pointerdown'); f.input.destroy(); f.input.destroy();
  assert.equal(f.canvas.captured.size, 0);
  assert.equal([...f.canvas.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0), 0);
  f.canvas.emit('keydown', { key: 'R' });
  assert.deepEqual(f.actions, []);
});
