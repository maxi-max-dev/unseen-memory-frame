const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Translate both the camera and its target in the current screen plane. The
// original capture may have a tilted up axis, so world X/Y are not sufficient.
export function screenPanOffset({ dx, dy, height, distance, fov, yaw, pitch, right, up, back }) {
  const scale = 2 * distance * Math.tan(fov * Math.PI / 360) / Math.max(1, height);
  const horizontal = -dx * scale;
  const vertical = dy * scale;
  const x = horizontal * Math.cos(yaw) - vertical * Math.sin(yaw) * Math.sin(pitch);
  const y = vertical * Math.cos(pitch);
  const z = -horizontal * Math.sin(yaw) - vertical * Math.cos(yaw) * Math.sin(pitch);
  return [0, 1, 2].map(axis => right[axis] * x + up[axis] * y + back[axis] * z);
}

/** Pointer input is bounded to the canvas; dispose releases listeners/capture. */
export function bindSpatialNavigation({ canvas, isReady, mode, rotate, pan, zoom, reset }) {
  const pointers = new Map();
  const removers = [];
  let previous = [];
  let disposed = false;
  const listen = (name, listener, options) => {
    canvas.addEventListener(name, listener, options);
    removers.push(() => canvas.removeEventListener(name, listener, options));
  };
  const snapshot = () => [...pointers.values()];
  const clear = () => {
    const ids = [...pointers.keys()];
    pointers.clear();
    previous = [];
    for (const id of ids) {
      if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id);
    }
  };
  listen('pointerdown', event => {
    if (!isReady() || (event.pointerType === 'mouse' && ![0, 1, 2].includes(event.button))) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, pan: event.button === 1 || event.button === 2 });
    previous = snapshot();
  });
  listen('pointermove', event => {
    if (!isReady() || !pointers.has(event.pointerId)) return;
    const point = pointers.get(event.pointerId);
    pointers.set(event.pointerId, { ...point, x: event.clientX, y: event.clientY });
    const current = snapshot();
    if (previous.length === 1 && current.length === 1) {
      const dx = current[0].x - previous[0].x;
      const dy = current[0].y - previous[0].y;
      if (point.pan || event.shiftKey || mode() === 'pan') pan(dx, dy);
      else rotate(dx, dy);
    } else if (previous.length === 2 && current.length === 2) {
      const span = points => Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      const beforeSpan = span(previous), afterSpan = span(current);
      // Moving the midpoint pans; changing its span zooms. A two-finger drag
      // therefore never accidentally becomes an orbit when the first lifts.
      pan((current[0].x + current[1].x - previous[0].x - previous[1].x) / 2,
        (current[0].y + current[1].y - previous[0].y - previous[1].y) / 2);
      if (beforeSpan > 2 && afterSpan > 2) zoom(clamp(beforeSpan / afterSpan, 0.5, 2));
    }
    previous = current;
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    listen(name, event => {
      pointers.delete(event.pointerId);
      previous = snapshot();
      if (name !== 'lostpointercapture' && canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    });
  }
  listen('contextmenu', event => { if (isReady()) event.preventDefault(); });
  listen('blur', clear);
  listen('wheel', event => {
    if (!isReady() || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(1, canvas.clientHeight) : 1;
    zoom(Math.exp(clamp(event.deltaY * unit, -300, 300) * 0.002));
  }, { passive: false });
  listen('keydown', event => {
    if (!isReady() || event.ctrlKey || event.metaKey || event.altKey) return;
    const arrows = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
    const delta = arrows[event.key];
    if (delta) {
      event.preventDefault();
      if (event.shiftKey) pan(...delta);
      else rotate(...delta);
    } else if (['+', '=', '-'].includes(event.key)) {
      event.preventDefault();
      zoom(event.key === '-' ? 1.25 : 0.8);
    } else if (['r', 'R', 'Home'].includes(event.key)) {
      event.preventDefault();
      reset();
    }
  });
  return {
    clear,
    destroy() {
      if (disposed) return;
      disposed = true;
      removers.splice(0).forEach(remove => remove());
      clear();
    }
  };
}
