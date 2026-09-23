import { bindSpatialNavigation, screenPanOffset } from './spatial-viewer-navigation.mjs';
import { downloadSpatialAsset } from './spatial-download.mjs?v=0.4.1';
// The engine is intentionally loaded only when a family member opens a scene.
let viewerId = 0;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function stylesheet() {
  const href = new URL('./spatial-viewer.css', import.meta.url).href;
  if (!document.querySelector('link[data-spatial-viewer]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.spatialViewer = '';
    document.head.append(link);
  }
}

/** Synchronous lifecycle handle; loading continues asynchronously and is cancellable. */
export function openSpatialViewer({ container, asset, refreshAsset, onClose, signal } = {}) {
  if (!(container instanceof HTMLElement)) throw new TypeError('查看器需要一个页面容器');
  stylesheet();
  const root = document.createElement('section');
  root.className = 'spatial-viewer';
  root.setAttribute('aria-label', '空间记忆查看器');
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '空间场景');
  canvas.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown + - R Home');
  const status = document.createElement('div');
  status.className = 'spatial-viewer-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const toolbar = document.createElement('div');
  toolbar.className = 'spatial-viewer-controls';
  toolbar.setAttribute('role', 'group');
  toolbar.setAttribute('aria-label', '空间观看操作');
  const hint = document.createElement('p');
  hint.className = 'spatial-viewer-hint';
  hint.textContent = '拖动看看四周 · 双指分合可缩放';
  hint.id = 'spatial-hint-' + ++viewerId;
  canvas.setAttribute('aria-describedby', hint.id);
  const help = document.createElement('div');
  help.className = 'spatial-viewer-help';
  help.id = 'spatial-help-' + viewerId;
  help.hidden = true;
  help.tabIndex = 0;
  help.setAttribute('role', 'region');
  help.setAttribute('aria-label', '空间操作说明');
  for (const text of ['鼠标：拖动旋转；选择“平移”或按住 Shift / 右键拖动，挪动画面。滚轮可缩放。',
    '触屏：单指按当前模式旋转或平移；双指拖动平移，分合缩放。',
    '键盘：Tab 选中场景后，方向键旋转，Shift + 方向键平移，加减键缩放，R / Home 回到初始视角。Esc 先收起说明，再关闭空间。',
    '移到没拍到的位置可能出现空缺，点“回到起点”即可恢复。']) {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    help.append(paragraph);
  }
  const announcer = document.createElement('p');
  announcer.className = 'spatial-viewer-sr-only';
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  const makeButton = (text, label, action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', action);
    toolbar.append(button);
    return button;
  };
  const rotateButton = makeButton('旋转', '旋转模式', () => setMode('rotate'));
  const panButton = makeButton('平移', '平移模式', () => setMode('pan'));
  rotateButton.setAttribute('aria-pressed', 'true');
  panButton.setAttribute('aria-pressed', 'false');
  const zoomIn = makeButton('＋ 放大', '放大空间', () => zoom(0.8));
  const zoomOut = makeButton('− 缩小', '缩小空间', () => zoom(1.25));
  const resetButton = makeButton('回到起点', '回到起点，复位视角', () => reset());
  const qualityButton = makeButton('画质：省电', '画质：省电，切换为清晰', () => {
    highQuality = !highQuality;
    qualityButton.textContent = highQuality ? '画质：清晰' : '画质：省电';
    qualityButton.setAttribute('aria-label', highQuality ? '画质：清晰，切换为省电' : '画质：省电，切换为清晰');
    qualityButton.setAttribute('aria-pressed', String(highQuality));
    announcer.textContent = highQuality ? '已切换为清晰画质' : '已切换为省电画质';
    resize();
  });
  qualityButton.setAttribute('aria-pressed', 'false');
  const helpButton = makeButton('操作说明', '操作说明', () => toggleHelp());
  helpButton.setAttribute('aria-controls', help.id);
  helpButton.setAttribute('aria-expanded', 'false');
  root.append(canvas, status, hint, help, toolbar, announcer);
  container.append(root);

  const controller = new AbortController();
  const removers = [];
  let destroyed = false;
  let app, device, modelAsset, camera, observer, timer;
  let highQuality = false;
  let interactionMode = 'rotate';
  let navigation;
  let frameRight, frameUp, frameBack;
  let target, home, yaw = 0, pitch = 0.2, distance = 1, radius = 1;
  let ready = false;
  const notify = (state, message) => {
    if (destroyed) return;
    root.dataset.state = state;
    status.textContent = message;
    status.hidden = state === 'ready';
    root.dispatchEvent(new CustomEvent('spatial-viewer-state', { bubbles: true, detail: { state, message } }));
  };
  const on = (object, name, callback, options) => {
    object.addEventListener(name, callback, options);
    removers.push(() => object.removeEventListener(name, callback, options));
  };
  const controlsEnabled = (enabled) => {
    [rotateButton, panButton, resetButton, zoomIn, zoomOut, qualityButton, helpButton].forEach(button => { button.disabled = !enabled; });
    hint.hidden = !enabled;
    if (!enabled) toggleHelp(false);
  };
  controlsEnabled(false);
  notify('loading', '正在准备空间记忆…');

  function releaseEngine() {
    const gl = device?.gl;
    clearTimeout(timer);
    observer?.disconnect();
    observer = null;
    // Removing the entity first releases its splat references, worker and GPU buffers.
    if (app) {
      app.root.destroy();
      if (modelAsset) { modelAsset.unload(); app.assets.remove(modelAsset); }
      app.destroy();
      app = null;
    }
    // Explicitly release the browser context, including when creation failed halfway.
    if (device) {
      if (!device._destroyed) device.destroy();
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      device = null;
    }
    modelAsset = null;
    camera = null;
    navigation?.clear();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    ready = false;
    controller.abort();
    removers.splice(0).forEach(remove => remove());
    releaseEngine();
    root.remove();
  }

  function updateCamera() {
    if (!camera || !target) return;
    pitch = clamp(pitch, -Math.PI * 0.47, Math.PI * 0.47);
    distance = clamp(distance, radius * 0.035, radius * 12);
    const x = Math.sin(yaw) * Math.cos(pitch) * distance;
    const y = Math.sin(pitch) * distance;
    const z = Math.cos(yaw) * Math.cos(pitch) * distance;
    camera.setPosition(target.x + frameRight.x*x + frameUp.x*y + frameBack.x*z,
      target.y + frameRight.y*x + frameUp.y*y + frameBack.y*z,
      target.z + frameRight.z*x + frameUp.z*y + frameBack.z*z);
    camera.lookAt(target, frameUp);
    app.renderNextFrame = true;
  }

  function setMode(mode) {
    interactionMode = mode;
    rotateButton.setAttribute('aria-pressed', String(mode === 'rotate'));
    panButton.setAttribute('aria-pressed', String(mode === 'pan'));
    root.dataset.interaction = mode;
    hint.textContent = mode === 'pan' ? '拖动挪动画面 · 回到起点可复位' : '拖动看看四周 · 双指分合可缩放';
    announcer.textContent = mode === 'pan' ? '已切换为平移模式' : '已切换为旋转模式';
  }

  function toggleHelp(visible = help.hidden) {
    help.hidden = !visible;
    helpButton.setAttribute('aria-expanded', String(visible));
  }

  function pan(dx, dy) {
    if (!ready) return;
    const offset = screenPanOffset({ dx, dy, height: canvas.clientHeight, distance,
      fov: camera.camera.fov, yaw, pitch,
      right: [frameRight.x, frameRight.y, frameRight.z],
      up: [frameUp.x, frameUp.y, frameUp.z],
      back: [frameBack.x, frameBack.y, frameBack.z] });
    target.x += offset[0]; target.y += offset[1]; target.z += offset[2];
    const fromHome = target.clone().sub(home.target);
    const limit = radius * 4;
    if (fromHome.length() > limit) target.copy(home.target).add(fromHome.normalize().mulScalar(limit));
    updateCamera();
  }

  function reset() {
    if (!ready) return;
    yaw = home.yaw;
    pitch = home.pitch;
    distance = home.distance;
    target.copy(home.target);
    updateCamera();
    announcer.textContent = '已回到初始视角';
  }

  function zoom(factor) {
    if (!ready) return;
    distance *= factor;
    updateCamera();
  }

  function resize() {
    if (!app) return;
    const rect = root.getBoundingClientRect();
    const ratio = highQuality ? Math.min(devicePixelRatio || 1, 1.5) : Math.min(1, 900 / Math.max(rect.width, rect.height, 1));
    device.maxPixelRatio = ratio;
    app.resizeCanvas(Math.max(1, rect.width), Math.max(1, rect.height));
    app.renderNextFrame = true;
  }

  function fail(message) {
    if (destroyed || controller.signal.aborted) return;
    ready = false;
    controller.abort();
    controlsEnabled(false);
    releaseEngine();
    notify('error', message);
  }

  on(canvas, 'webglcontextlost', event => {
    event.preventDefault();
    if (!destroyed && ready) fail('设备暂时无法继续显示空间，请关闭后重试，或打开来源页面。');
  });
  navigation = bindSpatialNavigation({ canvas,
    isReady: () => ready && !destroyed,
    mode: () => interactionMode,
    rotate: (dx, dy) => { yaw -= dx * 0.006; pitch += dy * 0.006; updateCamera(); },
    pan, zoom, reset
  });
  removers.push(() => navigation.destroy());
  // Escape also works while a toolbar button or the help region has focus.
  on(root, 'keydown', event => {
    if (event.key !== 'Escape') return;
    if (!help.hidden) {
      event.preventDefault(); event.stopPropagation();
      toggleHelp(false);
      helpButton.focus({ preventScroll: true });
    } else if (typeof onClose === 'function') {
      event.preventDefault(); event.stopPropagation();
      onClose();
    }
  });
  on(document, 'visibilitychange', () => {
    if (app) app.renderNextFrame = !document.hidden;
  });
  if (signal) {
    if (signal.aborted) destroy();
    else on(signal, 'abort', destroy, { once: true });
  }

  async function download(initialAsset) {
    return downloadSpatialAsset(initialAsset, {
      baseURL: location.href, signal: controller.signal, refreshAsset,
      onProgress: ({ received, total, refreshing }) => notify('loading', refreshing
        ? '正在更新空间访问地址…'
        : `正在载入空间记忆 ${Math.min(99, Math.round(received / total * 100))}%`)
    });
  }

  async function start() {
    try {
      const pc = await import('./vendor/playcanvas-2.22.3.mjs');
      if (destroyed || controller.signal.aborted) return;
      try {
        device = new pc.WebglGraphicsDevice(canvas, { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
      } catch { throw new Error('当前浏览器不支持此空间，请更新浏览器或打开来源页面。'); }
      app = new pc.AppBase(canvas);
      const options = new pc.AppOptions();
      options.graphicsDevice = device;
      options.componentSystems = [pc.CameraComponentSystem, pc.GSplatComponentSystem];
      options.resourceHandlers = [pc.TextureHandler, pc.GSplatHandler];
      app.init(options);
      app.setCanvasFillMode('NONE', 1, 1);
      app.setCanvasResolution('AUTO');
      app.autoRender = false;
      camera = new pc.Entity('Spatial camera');
      camera.addComponent('camera', { clearColor: new pc.Color(0.07, 0.08, 0.09), fov: 60, nearClip: 0.01, farClip: 10000 });
      app.root.addChild(camera);
      app.scene.on('gsplat:sorted', () => { if (app && !document.hidden) app.renderNextFrame = true; });
      observer = new ResizeObserver(resize);
      observer.observe(root);
      resize();
      app.start();
      timer = setTimeout(() => fail('空间载入超时，请关闭后重试，或打开来源页面。'), 90000);
      const { buffer, view } = await download(asset);
      if (destroyed || controller.signal.aborted) return;
      notify('loading', '正在还原空间，第一次打开可能需要片刻…');
      modelAsset = new pc.Asset('空间记忆', 'gsplat', { url: 'memory.sog', filename: 'memory.sog', contents: buffer });
      app.assets.add(modelAsset);
      const resource = await new Promise((resolve, reject) => {
        modelAsset.once('load', () => resolve(modelAsset?.resource));
        modelAsset.once('error', () => reject(new Error('设备无法还原此空间，请关闭后重试，或打开来源页面。')));
        controller.signal.addEventListener('abort', () => reject(new DOMException('Closed', 'AbortError')), { once: true });
        app.assets.load(modelAsset);
      });
      if (destroyed || controller.signal.aborted || !resource) return;
      modelAsset.file.contents = null;
      const model = new pc.Entity('空间记忆');
      // The provider uses the common COLMAP splat orientation (Y points down).
      model.setEulerAngles(0, 0, view ? 0 : 180);
      model.addComponent('gsplat', { asset: modelAsset, unified: true });
      app.root.addChild(model);
      // Trim sparse reconstruction outliers so a distant splat cannot hide the scene.
      const axes = [[], [], []];
      const centers = resource.centers;
      const stride = Math.max(1, Math.floor((centers?.length || 0) / (3 * 12000)));
      if (!centers?.length) throw new Error('空间缺少可用的场景坐标，请打开来源页面。');
      for (let i = 0; i < centers.length; i += 3 * stride) {
        if ([centers[i], centers[i + 1], centers[i + 2]].every(Number.isFinite)) {
          axes[0].push(-centers[i]); axes[1].push(-centers[i + 1]); axes[2].push(centers[i + 2]);
        }
      }
      const bounds = axes.map(values => {
        values.sort((a, b) => a - b);
        return [values[Math.floor(values.length * 0.05)], values[Math.floor(values.length * 0.95)]];
      });
      if (!bounds.flat().every(Number.isFinite)) throw new Error('空间坐标无法读取。');
      target = new pc.Vec3(...bounds.map(([min, max]) => (min + max) / 2));
      radius = Math.max(0.1, Math.hypot(...bounds.map(([min, max]) => (max - min) / 2)));
      home = { target: target.clone(), yaw: 0.3, pitch: 0.2, distance: radius * 1.6 };
      frameRight = new pc.Vec3(1, 0, 0);
      frameUp = new pc.Vec3(0, 1, 0);
      frameBack = new pc.Vec3(0, 0, 1);
      const validVector = v => Array.isArray(v) && v.length === 3 && v.every(n => Number.isFinite(n) && Math.abs(n) < 100000);
      if (view && ![view.position, view.forward, view.up].every(validVector)) throw new Error('空间初始视角无效。');
      if (view) {
        const forward = new pc.Vec3(...view.forward).normalize();
        frameBack = forward.clone().mulScalar(-1);
        frameRight = new pc.Vec3().cross(new pc.Vec3(...view.up), frameBack).normalize();
        frameUp = new pc.Vec3().cross(frameBack, frameRight).normalize();
        if (frameRight.length() < 0.9 || forward.length() < 0.9) throw new Error('空间初始视角无效。');
        radius = Math.max(1, radius * 0.08);
        target = new pc.Vec3(...view.position).add(forward.mulScalar(radius));
        home = { target: target.clone(), yaw: 0, pitch: 0, distance: radius };
        camera.camera.fov = clamp(Number(view.fov) || 65, 35, 100);
      }
      ready = true;
      reset();
      controlsEnabled(true);
      clearTimeout(timer);
      notify('ready', '空间记忆已载入');
    } catch (error) {
      if (!destroyed && error?.name !== 'AbortError') fail(error.message || '空间暂时无法显示，请打开来源页面。');
    }
  }
  if (!destroyed) void start();
  return { destroy, reset };
}
