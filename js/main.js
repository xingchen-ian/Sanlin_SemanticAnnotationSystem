/**
 * 3D 模型加载、选择、简单标注 - 最小 Demo
 * 本地运行需通过 HTTP 服务器 (如 npx serve)
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/loaders/DRACOLoader.js';
import { OBJLoader } from 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/loaders/OBJLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const DRACO_PATH = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/';
import Pusher from 'https://esm.sh/pusher-js';

// ----- 状态 -----
// 统一选择: Map<meshId, null|number[]>  null=整物体, number[]=指定面
const state = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  raycaster: new THREE.Raycaster(),
  mouse: new THREE.Vector2(),
  meshes: [],           // { mesh, meshId, originalMaterial }
  selectedTargets: new Map(),  // meshId -> null (whole) | number[] (face indices)
  annotations: [],      // { id, targets: [{ meshId, faceIndices? }], label, category, color, createdAt }
  meshIdCounter: 0,
  selectionMode: 'object',  // 'object' | 'face'
  boxSelectStart: null,
  isBoxSelecting: false,
  justDidBoxSelect: false,
  rightMouseDown: false,
  keys: { w: false, a: false, s: false, d: false, q: false, e: false },
  flySpeed: 25,
  _flyForward: new THREE.Vector3(),
  _flyRight: new THREE.Vector3(),
  _flyUp: new THREE.Vector3(0, 1, 0),
  faceOverlayMeshes: new Map(),  // meshId -> THREE.Mesh (face highlight overlay)
  overlayOpacity: 0.45,
  currentModelId: null,  // 当前模型的 Supabase ID，用于保存/加载
  editingIndex: null,    // 正在编辑的标注索引
  hiddenAnnotationIds: new Set(),  // 被隐藏的标注层 id，不参与着色与引线
  session: null,         // Supabase Auth session
  tilesRenderer: null,  // 3d-tiles-renderer 实例（每帧 update）
  tilesetRoot: null,    // 3D Tiles 根 Group，用于同步 mesh 列表
  tilesetPositionOffset: null,  // 使 tile 内容中心落在原点所需的 group.position（考虑 rotation），每帧强制应用
  tilesetCorrectionX: 0,        // 绕 X 轴校正弧度，应用到 wrapper.rotation.x
  tilesetCorrectionY: 0,        // 绕 Y 轴校正弧度，应用到 wrapper.rotation.y
  tilesetTiltCorrection: 0,     // 绕 Z 轴校正弧度，应用到 wrapper.rotation.z（不修改库的 group 避免子节点被清空）
  tilesetWrapper: null,         // 包裹 tilesRenderer.group 的外层 Group，用于施加三轴旋转校正
  tilesetErrorTarget: 2,        // LOD 屏幕空间误差目标（像素），值越小越远距离加载精细瓦片，可在 UI 调节
  ambientLight: null,           // 环境光，供 UI 调节 intensity
  dirLight: null,               // 主方向光
  fillLight: null,              // 补光
};

const supabase = (() => {
  const cfg = window.SANLIN_CONFIG || {};
  if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
    return createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  }
  return null;
})();

let pusherClient = null;
let pusherChannel = null;

function initPusher() {
  const cfg = window.SANLIN_CONFIG || {};
  if (cfg.pusherKey && cfg.pusherCluster && !pusherClient) {
    pusherClient = new Pusher(cfg.pusherKey, { cluster: cfg.pusherCluster });
  }
  return pusherClient;
}

// ----- 创建默认示例建筑 -----
function createDefaultBuilding(scene) {
  const group = new THREE.Group();
  group.name = 'default_building';

  const geometries = [
    { geo: new THREE.BoxGeometry(4, 2, 4), pos: [0, 1, 0] },
    { geo: new THREE.BoxGeometry(2, 1.5, 2), pos: [-3, 0.75, -3] },
    { geo: new THREE.BoxGeometry(2, 1, 2), pos: [3, 0.5, -2] },
    { geo: new THREE.BoxGeometry(3, 1.2, 2), pos: [-2, 0.6, 2] },
    { geo: new THREE.BoxGeometry(1.5, 2, 1.5), pos: [2, 1, 2] },
  ];

  const baseColor = new THREE.Color(0x888888);
  geometries.forEach((g, i) => {
    const mat = new THREE.MeshStandardMaterial({
      color: baseColor,
      metalness: 0.2,
      roughness: 0.8,
    });
    const mesh = new THREE.Mesh(g.geo, mat);
    mesh.position.set(...g.pos);
    const meshId = `mesh_${state.meshIdCounter++}`;
    mesh.userData.meshId = meshId;
    group.add(mesh);
    state.meshes.push({ mesh, meshId, originalMaterial: mat.clone() });
  });

  scene.add(group);
  return group;
}

// ----- 从 glTF 场景提取 meshes -----
// 使用 mesh_0, mesh_1... 替代 uuid，保证同一文件重载时 meshId 稳定，标注着色可正确匹配
function extractMeshesFromObject(obj, parentMatrix = new THREE.Matrix4()) {
  const mat = new THREE.Matrix4().copy(parentMatrix).multiply(obj.matrixWorld);
  if (obj.isMesh && obj.geometry) {
    const meshId = `mesh_${state.meshIdCounter++}`;
    if (!state.meshes.some(m => m.meshId === meshId)) {
      obj.userData.meshId = meshId;
      const origMat = obj.material?.clone?.() ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
      state.meshes.push({ mesh: obj, meshId, originalMaterial: origMat });
    }
  }
  obj.children.forEach(child => extractMeshesFromObject(child, mat));
}

// ----- 清空当前模型 -----
function clearModel(scene) {
  state.faceOverlayMeshes.clear();
  state.tilesetRoot = null;
  state.tilesetPositionOffset = null;
  state.tilesetCorrectionX = 0;
  state.tilesetCorrectionY = 0;
  state.tilesetTiltCorrection = 0;
  state.tilesetWrapper = null;
  state._tilesRuntimeErrorLogged = false;
  const toRemove = scene.children.filter(c =>
    c.name === 'default_building' || c.userData?.isLoadedModel
  );
  toRemove.forEach(c => scene.remove(c));
  if (state.tilesetWrapper) {
    scene.remove(state.tilesetWrapper);
    state.tilesetWrapper = null;
  }
  if (state.tilesRenderer) {
    state.tilesRenderer.dispose();
    state.tilesRenderer = null;
  }
  state.meshes = [];
  state.selectedTargets.clear();
  state.annotations = [];
  state.meshIdCounter = 0;
  state.hiddenAnnotationIds.clear();
}

// ----- 判断是否为 OBJ 格式 -----
function isObjUrlOrFile(urlOrFile) {
  if (typeof urlOrFile === 'string') {
    return urlOrFile.toLowerCase().includes('.obj');
  }
  const name = urlOrFile?.name ?? '';
  return name.toLowerCase().endsWith('.obj');
}

// ----- 加载 OBJ -----
function loadObjAsync(urlOrFile) {
  const loader = new OBJLoader();
  if (typeof urlOrFile === 'string') {
    const baseUrl = urlOrFile.replace(/[^/]+$/, '');
    if (baseUrl) loader.setResourcePath(baseUrl);
    return new Promise((resolve, reject) => {
      loader.load(urlOrFile, resolve, undefined, reject);
    });
  }
  const url = URL.createObjectURL(urlOrFile);
  return new Promise((resolve, reject) => {
    loader.load(url, (group) => {
      URL.revokeObjectURL(url);
      resolve(group);
    }, undefined, (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    });
  });
}

// ----- 加载 glTF/GLB 或 OBJ -----
async function loadModel(urlOrFile) {
  const useObj = isObjUrlOrFile(urlOrFile);

  if (useObj) {
    const group = await loadObjAsync(urlOrFile);
    group.traverse(obj => { obj.userData.isLoadedModel = true; });
    state.scene.add(group);
    extractMeshesFromObject(group);
    frameModelInView(state.scene, group);
    return group;
  }

  const loader = new GLTFLoader();
  let gltf;
  if (typeof urlOrFile === 'string') {
    gltf = await loader.loadAsync(urlOrFile);
  } else {
    const url = URL.createObjectURL(urlOrFile);
    gltf = await loader.loadAsync(url);
    URL.revokeObjectURL(url);
  }

  gltf.scene.traverse(obj => { obj.userData.isLoadedModel = true; });
  state.scene.add(gltf.scene);
  extractMeshesFromObject(gltf.scene);
  frameModelInView(state.scene, gltf.scene);
  return gltf.scene;
}

// ----- 3D Tiles：从 tileset 根节点同步已加载的 mesh 到 state.meshes（供选择/标注） -----
function syncTilesetMeshes() {
  if (!state.tilesetRoot) return;
  state.tilesetRoot.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    if (state.meshes.some((m) => m.mesh === obj)) return;
    const meshId = `mesh_${state.meshIdCounter++}`;
    obj.userData.meshId = meshId;
    const origMat = obj.material?.clone?.() ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    state.meshes.push({ mesh: obj, meshId, originalMaterial: origMat });
  });
}

// ----- 解析 tileset URL：同源时若 404 则尝试 /public/ 与根路径互换（兼容不同部署方式） -----
function resolveTilesetUrl(inputUrl) {
  let url = inputUrl?.trim();
  if (!url) return null;
  if (url.startsWith('/') || url.startsWith('./')) {
    url = new URL(url, window.location.origin).href;
  }
  return url;
}

function getTilesetUrlAlternate(absoluteUrl) {
  try {
    const u = new URL(absoluteUrl);
    const path = u.pathname;
    if (path.startsWith('/public/')) {
      return u.origin + path.slice(7); // 去掉 /public
    }
    if (!path.startsWith('/public') && path.includes('/terra_b3dms/')) {
      return u.origin + '/public' + path; // 加上 /public
    }
  } catch (_) {}
  return null;
}

async function ensureTilesetUrlReachable(url) {
  const tryUrl = async (u) => {
    const res = await fetch(u, { method: 'HEAD' });
    return res.ok || res.status === 304 ? u : null;
  };
  let ok = await tryUrl(url);
  if (ok) return url;
  const alt = getTilesetUrlAlternate(url);
  if (alt) {
    ok = await tryUrl(alt);
    if (ok) {
      console.warn('[3D Tiles] 原 URL 不可用，已改用:', alt);
      return alt;
    }
  }
  return null;
}

// ----- 加载 3D Tiles（tileset.json 的完整 URL，使用 NASA 3d-tiles-renderer） -----
async function loadTileset(tilesetUrl) {
  let url = resolveTilesetUrl(tilesetUrl);
  if (!url) throw new Error('请输入 tileset.json 的 URL');
  // 先检查 URL 是否可访问；若 404 则尝试 /public/ 与根路径互换（兼容 Vercel 等部署）
  const reachable = await ensureTilesetUrlReachable(url);
  if (reachable) {
    url = reachable;
  } else {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (!res.ok && res.status !== 304) {
        throw new Error('tileset.json 返回 ' + res.status + '，请检查 URL（可尝试 /terra_b3dms/tileset.json 或 /public/terra_b3dms/tileset.json）');
      }
    } catch (e) {
      if (e.message?.startsWith('tileset.json 返回')) throw e;
      console.warn('[3D Tiles] HEAD 预检失败，继续尝试加载:', e?.message || e);
    }
  }

  const tilesetUrlWithCacheBust = url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();

  // 拦截 fetch 一次，记录 3D Tiles 相关请求失败（便于排查子 tile 404）
  if (!window._tilesFetchWrapped) {
    window._tilesFetchWrapped = true;
    const nativeFetch = window.fetch;
    const isTileRelated = (s) => /tileset|\.b3dm|terra_b3dms/i.test(s) || /BlockR[A-Z0-9_]+\.(json|b3dm)/i.test(s);
    window.fetch = function (input, init) {
      const urlStr = typeof input === 'string' ? input : (input && input.url) || '';
      return nativeFetch.apply(this, arguments).then((res) => {
        if (isTileRelated(urlStr) && !res.ok && res.status !== 304) {
          console.warn('[3D Tiles] 请求失败', res.status, urlStr);
        }
        return res;
      }, (err) => {
        if (isTileRelated(urlStr)) console.warn('[3D Tiles] 请求异常', urlStr, err?.message || err);
        throw err;
      });
    };
  }

  // 先拉取并解析 tileset.json，提前把根节点中心算好，这样在 TilesRenderer 第一次 update 前就能设好 group.position，
  // 否则相机在几百单位而瓦片在数百万单位，视锥剔除会认为“不可见”从而不请求任何 .b3dm
  let rootCenter = null;
  try {
    const res = await fetch(tilesetUrlWithCacheBust);
    if (!res.ok) throw new Error('tileset.json ' + res.status);
    const json = await res.json();
    const box = json?.root?.boundingVolume?.box;
    if (box && box.length >= 3) {
      // 中心 (box[0],box[1],box[2]) 经 rotation.x=-PI/2 后变为 (box[0],box[2],-box[1])，需用此来平移
      rootCenter = new THREE.Vector3(-box[0], -box[2], box[1]);
      console.log('[3D Tiles] 预解析 root 包围盒中心 → group.position:', rootCenter.x, rootCenter.y, rootCenter.z);
    }
  } catch (e) {
    console.warn('[3D Tiles] 预解析 tileset 失败，将依赖 load-root-tileset 再定位:', e?.message || e);
  }

  const tilesRenderer = new TilesRenderer(tilesetUrlWithCacheBust);
  tilesRenderer.setCamera(state.camera);
  tilesRenderer.setResolutionFromRenderer(state.camera, state.renderer);

  // LOD 与加载速度：errorTarget 由 state.tilesetErrorTarget（可 UI 调节）决定；队列并发与每帧处理数提高以加快加载
  tilesRenderer.errorTarget = state.tilesetErrorTarget;
  tilesRenderer.maxProcessedTiles = 450;    // 默认 250，每帧多处理一些瓦片，减少加载等待
  if (tilesRenderer.downloadQueue) tilesRenderer.downloadQueue.maxJobs = 40;   // 默认 25，提高下载并发
  if (tilesRenderer.parseQueue) tilesRenderer.parseQueue.maxJobs = 12;          // 默认 5，提高解析并发
  if (tilesRenderer.processNodeQueue) tilesRenderer.processNodeQueue.maxJobs = 40; // 默认 25

  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(DRACO_PATH);
  const gltfLoader = new GLTFLoader(tilesRenderer.manager);
  gltfLoader.setDRACOLoader(dracoLoader);
  tilesRenderer.manager.addHandler(/\.(gltf|glb)$/gi, gltfLoader);
  tilesRenderer.manager.onError = (url) => console.warn('[3D Tiles] manager 加载失败:', url);

  tilesRenderer.group.traverse((o) => { o.userData.isLoadedModel = true; });
  tilesRenderer.group.rotation.x = -Math.PI / 2;
  if (rootCenter) {
    state.tilesetPositionOffset = rootCenter.clone();
    tilesRenderer.group.position.copy(rootCenter);
  }
  const wrapper = new THREE.Group();
  wrapper.userData.isLoadedModel = true;
  wrapper.add(tilesRenderer.group);
  state.scene.add(wrapper);
  state.tilesetWrapper = wrapper;
  state.tilesetRoot = tilesRenderer.group;
  state.tilesRenderer = tilesRenderer;

  const sphere = new THREE.Sphere();
  return new Promise((resolve, reject) => {
    let timeoutId;
    const onRootLoaded = () => {
      clearTimeout(timeoutId);
      tilesRenderer.removeEventListener('load-root-tileset', onRootLoaded);
      tilesRenderer.removeEventListener('error', onError);
      // 关键：group 有 rotation.x = -PI/2，世界空间内容中心 = position + R*sphere.center。
      // 要使内容中心在原点(0,0,0)，需 position = -R*sphere.center；R*(x,y,z)=(x,z,-y) => position = (-c.x, -c.z, c.y)
      if (tilesRenderer.getBoundingSphere(sphere)) {
        const c = sphere.center;
        state.tilesetPositionOffset = new THREE.Vector3(-c.x, -c.z, c.y);
        tilesRenderer.group.position.copy(state.tilesetPositionOffset);
        console.log('[3D Tiles] load-root-tileset 已触发，内容中心将落在原点，group.position:', state.tilesetPositionOffset.x, state.tilesetPositionOffset.y, state.tilesetPositionOffset.z, '半径:', sphere.radius);
      } else if (rootCenter) {
        state.tilesetPositionOffset = rootCenter.clone();
        tilesRenderer.group.position.copy(state.tilesetPositionOffset);
        console.log('[3D Tiles] load-root-tileset 已触发，使用预解析 rootCenter');
      }
      // 3D Tiles 包围球半径可能数百/数千，避免被 near/far 裁掉
      if (state.camera.far < 100000) {
        state.camera.far = 100000;
        state.camera.updateProjectionMatrix();
        console.log('[3D Tiles] 已设置相机 far = 100000');
      }
      syncTilesetMeshes();
      const meshCount = state.meshes.filter((m) => m.mesh.parent != null).length;
      console.log('[3D Tiles] 当前可见 mesh 数:', meshCount);
      frameModelInView(state.scene, tilesRenderer.group);
      const box = new THREE.Box3().setFromObject(tilesRenderer.group);
      const size = box.getSize(new THREE.Vector3());
      console.log('[3D Tiles] 当前 group 包围盒 size:', size.x?.toFixed(1), size.y?.toFixed(1), size.z?.toFixed(1), '相机距离:', state.camera.position.distanceTo(state.controls.target).toFixed(1));
      resolve(tilesRenderer.group);
    };
    const onError = (e) => {
      clearTimeout(timeoutId);
      tilesRenderer.removeEventListener('load-root-tileset', onRootLoaded);
      tilesRenderer.removeEventListener('error', onError);
      console.error('[3D Tiles] error 事件:', e?.message || e);
      reject(new Error(e?.message || '3D Tiles 加载失败'));
    };
    tilesRenderer.addEventListener('load-root-tileset', onRootLoaded);
    tilesRenderer.addEventListener('error', onError);
    console.log('[3D Tiles] 开始加载，URL:', tilesetUrlWithCacheBust.split('?')[0]);
    timeoutId = setTimeout(() => {
      tilesRenderer.removeEventListener('load-root-tileset', onRootLoaded);
      tilesRenderer.removeEventListener('error', onError);
      console.warn('[3D Tiles] 8 秒超时，load-root-tileset 未触发，使用当前 group 状态尝试框选视图');
      if (state.camera.far < 100000) {
        state.camera.far = 100000;
        state.camera.updateProjectionMatrix();
      }
      syncTilesetMeshes();
      frameModelInView(state.scene, tilesRenderer.group);
      resolve(tilesRenderer.group);
    }, 8000);
  });
}

// ----- 3D Tiles 诊断：在控制台执行 debugTileset() 查看当前加载状态 -----
function debugTileset() {
  const report = [];
  report.push('=== 3D Tiles 诊断 ===');
  if (!state.tilesRenderer) {
    report.push('未加载 3D Tiles（state.tilesRenderer 为空）');
    console.log(report.join('\n'));
    return report;
  }
  const tr = state.tilesRenderer;
  const group = tr.group;
  report.push('TilesRenderer: 已创建');
  report.push('group.position: ' + group.position.x.toFixed(2) + ', ' + group.position.y.toFixed(2) + ', ' + group.position.z.toFixed(2));
  const rotDeg = (r) => (r * 180 / Math.PI).toFixed(2) + '°';
  report.push('group.rotation (度): x=' + rotDeg(group.rotation.x) + ', y=' + rotDeg(group.rotation.y) + ', z=' + rotDeg(group.rotation.z));
  report.push('旋转校正 (wrapper): X=' + rotDeg(state.tilesetCorrectionX) + ', Y=' + rotDeg(state.tilesetCorrectionY) + ', Z=' + rotDeg(state.tilesetTiltCorrection) + (state.tilesetWrapper ? '（应用在外层 wrapper）' : ''));
  report.push('group.children 数量: ' + group.children.length);
  const sphere = new THREE.Sphere();
  if (tr.getBoundingSphere(sphere)) {
    report.push('boundingSphere 中心: ' + sphere.center.x.toFixed(2) + ', ' + sphere.center.y.toFixed(2) + ', ' + sphere.center.z.toFixed(2) + ' 半径: ' + sphere.radius.toFixed(2));
  } else {
    report.push('boundingSphere: 无法获取');
  }
  report.push('相机 position: ' + state.camera.position.x.toFixed(2) + ', ' + state.camera.position.y.toFixed(2) + ', ' + state.camera.position.z.toFixed(2));
  report.push('相机 target: ' + state.controls.target.x.toFixed(2) + ', ' + state.controls.target.y.toFixed(2) + ', ' + state.controls.target.z.toFixed(2));
  const dist = state.camera.position.distanceTo(state.controls.target);
  report.push('相机到 target 距离: ' + dist.toFixed(2));
  report.push('相机 near/far: ' + state.camera.near + ' / ' + state.camera.far);
  let meshCount = 0;
  group.traverse((o) => { if (o.isMesh && o.geometry) meshCount++; });
  report.push('group 内 mesh 数量: ' + meshCount);
  report.push('state.meshes 中在场景内的数量: ' + state.meshes.filter((m) => m.mesh.parent != null).length);
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const isEmpty = size.x === 0 && size.y === 0 && size.z === 0;
  report.push('group 包围盒 size: ' + size.x.toFixed(2) + ', ' + size.y.toFixed(2) + ', ' + size.z.toFixed(2) + (isEmpty ? ' (可能尚未加载几何体)' : ''));
  if (isEmpty || meshCount === 0) {
    report.push('→ 若一直为 0：请查看上方是否有 [3D Tiles] 请求失败/请求异常，或 Network 面板中 tileset.json / .b3dm 是否 404');
  }
  console.log(report.join('\n'));
  return report;
}

// ----- 获取当前在场景中的 mesh 列表（3D Tiles 会动态加载/卸载，只对在场景中的做射线检测） -----
function getActiveMeshes() {
  return state.meshes.filter((m) => m.mesh.parent != null);
}

// ----- 获取鼠标在 canvas 内的坐标 -----
function getCanvasCoords(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

// ----- 获取 NDC 坐标 (-1..1) -----
function toNDC(x, y, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (x / rect.width) * 2 - 1,
    y: -((y / rect.height) * 2 - 1),
  };
}

// ----- 从几何体提取指定面的新 BufferGeometry -----
function extractFacesGeometry(geometry, faceIndices) {
  const posAttr = geometry.attributes.position;
  const idx = geometry.index;
  const positions = [];
  const indices = [];
  const faceSet = new Set(faceIndices);

  for (let fi = 0; fi < (idx ? idx.count : posAttr.count) / 3; fi++) {
    if (!faceSet.has(fi)) continue;
    const i0 = idx ? idx.getX(fi * 3) : fi * 3;
    const i1 = idx ? idx.getX(fi * 3 + 1) : fi * 3 + 1;
    const i2 = idx ? idx.getX(fi * 3 + 2) : fi * 3 + 2;
    const base = positions.length / 3;
    positions.push(
      posAttr.getX(i0), posAttr.getY(i0), posAttr.getZ(i0),
      posAttr.getX(i1), posAttr.getY(i1), posAttr.getZ(i1),
      posAttr.getX(i2), posAttr.getY(i2), posAttr.getZ(i2)
    );
    indices.push(base, base + 1, base + 2);
  }
  if (positions.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ----- 射线检测单选 -----
function performClickSelect(event) {
  const canvas = document.getElementById('canvas');
  const rect = canvas.getBoundingClientRect();
  state.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  state.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  state.raycaster.setFromCamera(state.mouse, state.camera);
  const activeMeshes = getActiveMeshes().map((m) => m.mesh);
  const intersects = state.raycaster.intersectObjects(activeMeshes, true);

  if (intersects.length === 0) {
    if (!event.shiftKey) state.selectedTargets.clear();
    updateSelectionUI();
    updateHighlight();
    return;
  }

  const hit = intersects[0];
  const meshId = hit.object.userData.meshId;
  const faceIndex = hit.faceIndex;
  if (!meshId) return;

  if (state.selectionMode === 'object') {
    if (event.shiftKey) {
      if (state.selectedTargets.has(meshId)) state.selectedTargets.delete(meshId);
      else state.selectedTargets.set(meshId, null);
    } else {
      state.selectedTargets.clear();
      state.selectedTargets.set(meshId, null);
    }
  } else {
    // 面模式
    if (event.shiftKey) {
      const cur = state.selectedTargets.get(meshId);
      if (!cur) {
        state.selectedTargets.set(meshId, [faceIndex]);
      } else if (Array.isArray(cur)) {
        const next = cur.includes(faceIndex) ? cur.filter(i => i !== faceIndex) : [...cur, faceIndex];
        if (next.length === 0) state.selectedTargets.delete(meshId);
        else state.selectedTargets.set(meshId, next);
      } else {
        state.selectedTargets.delete(meshId);
        state.selectedTargets.set(meshId, [faceIndex]);
      }
    } else {
      state.selectedTargets.clear();
      state.selectedTargets.set(meshId, [faceIndex]);
    }
  }
  updateSelectionUI();
  updateHighlight();
}

// ----- 获取面的中心（世界坐标） -----
function getFaceWorldCenter(mesh, faceIndex) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const idx = geo.index;
  let i0, i1, i2;
  if (idx) {
    i0 = idx.getX(faceIndex * 3);
    i1 = idx.getX(faceIndex * 3 + 1);
    i2 = idx.getX(faceIndex * 3 + 2);
  } else {
    i0 = faceIndex * 3;
    i1 = faceIndex * 3 + 1;
    i2 = faceIndex * 3 + 2;
  }
  const v0 = new THREE.Vector3(pos.getX(i0), pos.getY(i0), pos.getZ(i0));
  const v1 = new THREE.Vector3(pos.getX(i1), pos.getY(i1), pos.getZ(i1));
  const v2 = new THREE.Vector3(pos.getX(i2), pos.getY(i2), pos.getZ(i2));
  v0.applyMatrix4(mesh.matrixWorld);
  v1.applyMatrix4(mesh.matrixWorld);
  v2.applyMatrix4(mesh.matrixWorld);
  return v0.add(v1).add(v2).divideScalar(3);
}

// ----- 框选：根据矩形选择 mesh 或面 -----
function performBoxSelect(startNDC, endNDC) {
  const left = Math.min(startNDC.x, endNDC.x);
  const right = Math.max(startNDC.x, endNDC.x);
  const bottom = Math.min(startNDC.y, endNDC.y);
  const top = Math.max(startNDC.y, endNDC.y);

  const selected = new Map();
  const proj = new THREE.Vector3();

  const active = getActiveMeshes();
  if (state.selectionMode === 'object') {
    active.forEach(({ mesh, meshId }) => {
      mesh.getWorldPosition(proj);
      proj.project(state.camera);
      if (proj.x >= left && proj.x <= right && proj.y >= bottom && proj.y <= top) {
        selected.set(meshId, null);
      }
    });
  } else {
    active.forEach(({ mesh, meshId }) => {
      if (!mesh.geometry) return;
      const geo = mesh.geometry;
      const faceCount = geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
      const facesInBox = [];
      for (let fi = 0; fi < faceCount; fi++) {
        const center = getFaceWorldCenter(mesh, fi);
        center.project(state.camera);
        if (center.x >= left && center.x <= right && center.y >= bottom && center.y <= top) {
          facesInBox.push(fi);
        }
      }
      if (facesInBox.length > 0) selected.set(meshId, facesInBox);
    });
  }

  state.selectedTargets = selected;
  updateSelectionUI();
  updateHighlight();
}

// ----- 更新框选矩形显示 -----
function updateSelectionRect(start, end, canvas) {
  const rectEl = document.getElementById('selection-rect');
  if (!start || !end) {
    rectEl.classList.add('hidden');
    return;
  }
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  rectEl.style.left = left + 'px';
  rectEl.style.top = top + 'px';
  rectEl.style.width = width + 'px';
  rectEl.style.height = height + 'px';
  rectEl.classList.remove('hidden');
}

// ----- 指针事件 -----
function onPointerDown(event) {
  if (event.button === 2) {
    state.rightMouseDown = true;
    const canvas = document.getElementById('canvas');
    if (canvas) {
      canvas.focus();
    }
    return;
  }
  if (event.button !== 0) return;
  if (!event.altKey) return; // 仅 Alt + 拖拽 进入框选
  const canvas = document.getElementById('canvas');
  const coords = getCanvasCoords(event, canvas);
  state.boxSelectStart = coords;
  state.isBoxSelecting = true;
  state.controls.enabled = false;
}

function onPointerMove(event) {
  if (!state.isBoxSelecting || !state.boxSelectStart) return;
  const canvas = document.getElementById('canvas');
  const coords = getCanvasCoords(event, canvas);
  updateSelectionRect(state.boxSelectStart, coords, canvas);
}

function onPointerUp(event) {
  if (event.button === 2) {
    state.rightMouseDown = false;
    return;
  }
  if (event.button !== 0) return;
  const canvas = document.getElementById('canvas');

  if (state.isBoxSelecting && state.boxSelectStart) {
    const end = getCanvasCoords(event, canvas);
    const dx = end.x - state.boxSelectStart.x;
    const dy = end.y - state.boxSelectStart.y;

    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      const startNDC = toNDC(state.boxSelectStart.x, state.boxSelectStart.y, canvas);
      const endNDC = toNDC(end.x, end.y, canvas);
      performBoxSelect(startNDC, endNDC);
      state.justDidBoxSelect = true;
    }
    updateSelectionRect(null, null);
    state.controls.enabled = true;
  }

  state.boxSelectStart = null;
  state.isBoxSelecting = false;
}

function onPointerClick(event) {
  if (event.altKey) return; // Alt 按下时由 mouseup 处理，不做点击选择
  if (state.justDidBoxSelect) {
    state.justDidBoxSelect = false;
    return; // 刚完成框选，避免 click 覆盖选择结果
  }
  performClickSelect(event);
}

// ----- 获取所有覆盖此 mesh 的标注 -----
function getAnnotationsForMesh(meshId) {
  return state.annotations.filter(a =>
    a.targets.some(t => t.meshId === meshId)
  );
}

// ----- 计算标注的 3D 中心（世界坐标），以最先选择的目标为准 -----
function getAnnotationWorldCenter(annot) {
  const t = annot.targets?.[0];
  if (!t) return null;
  const entry = state.meshes.find(m => m.meshId === t.meshId);
  if (!entry) return null;
  const { mesh } = entry;
  if (!t.faceIndices || t.faceIndices.length === 0) {
    const box = new THREE.Box3().setFromObject(mesh);
    return box.getCenter(new THREE.Vector3());
  }
  return getFaceWorldCenter(mesh, t.faceIndices[0]);
}

// ----- 绘制专利图式标注：白线 + 白色文字 -----
function updateCalloutOverlay() {
  const canvas = document.getElementById('callout-canvas');
  const glCanvas = document.getElementById('canvas');
  if (!canvas || !glCanvas || !state.camera) return;
  const rect = glCanvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  canvas.width = rect.width;
  canvas.height = rect.height;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const proj = new THREE.Vector3();
  const LINE_LENGTH = 150;
  const S_CURVE_AMPLITUDE = 18;
  const FONT = '14px sans-serif';
  const ANGLE = Math.PI / 4; // 斜上 45 度
  const cos45 = Math.cos(ANGLE);
  const sin45 = Math.sin(ANGLE);

  state.annotations.forEach((annot) => {
    if (state.hiddenAnnotationIds.has(annot.id)) return;
    const worldCenter = getAnnotationWorldCenter(annot);
    if (!worldCenter) return;
    proj.copy(worldCenter).project(state.camera);
    if (proj.z > 1 || proj.z < -1) return;

    const px = (proj.x + 1) / 2 * canvas.width;
    const py = (1 - proj.y) / 2 * canvas.height;

    const label = annot.label || '未命名';
    ctx.font = FONT;

    // 左侧标注向左上、右侧向右上，引线朝两侧外指，减少交叉
    const dx = px < canvas.width / 2 ? -1 : 1;
    const tx = px + dx * LINE_LENGTH * cos45;
    const ty = py - LINE_LENGTH * sin45;

    const vx = tx - px;
    const vy = ty - py;
    const cp1x = px + 0.35 * vx;
    const cp1y = py + 0.35 * vy - S_CURVE_AMPLITUDE * cos45;
    const cp2x = px + 0.65 * vx;
    const cp2y = py + 0.65 * vy + S_CURVE_AMPLITUDE * cos45;

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, tx, ty);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = dx > 0 ? 'left' : 'right';
    ctx.fillText(label, tx + (dx > 0 ? 4 : -4), ty);
  });
}

// ----- 创建透明叠加材质（在原始材质上叠加颜色） -----
function createOverlayMaterial(color, opacity) {
  const op = opacity ?? state.overlayOpacity;
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: op,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
}

// ----- 高亮选中与标注（在原始材质上叠加颜色） -----
function updateHighlight() {
  const highlightColor = 0x00aaff;

  state.faceOverlayMeshes.forEach((overlay) => {
    if (overlay.parent) overlay.parent.remove(overlay);
  });
  state.faceOverlayMeshes.clear();

  state.meshes.forEach(({ mesh, meshId, originalMaterial }) => {
    if (!mesh.parent) return; // 3D Tiles 中可能已从场景卸载
    const sel = state.selectedTargets.get(meshId);
    const annots = getAnnotationsForMesh(meshId).filter(
      (a) => !state.hiddenAnnotationIds.has(a.id)
    );

    mesh.material = originalMaterial;

    if (sel !== undefined) {
      if (sel === null) {
        const overlay = new THREE.Mesh(
          mesh.geometry,
          createOverlayMaterial(highlightColor)
        );
        overlay.userData.isFaceOverlay = true;
        mesh.add(overlay);
        state.faceOverlayMeshes.set(`${meshId}_sel`, overlay);
      } else {
        const geo = extractFacesGeometry(mesh.geometry, sel);
        if (geo) {
          const overlay = new THREE.Mesh(geo, createOverlayMaterial(highlightColor));
          overlay.userData.isFaceOverlay = true;
          mesh.add(overlay);
          state.faceOverlayMeshes.set(`${meshId}_sel`, overlay);
        }
      }
    }

    annots.forEach((annot) => {
      const faceTarget = annot.targets.find(t => t.meshId === meshId);
      const faceIndices = faceTarget?.faceIndices;
      const key = `${meshId}_annot_${annot.id}`;
      if (!faceIndices || faceIndices.length === 0) {
        const overlay = new THREE.Mesh(
          mesh.geometry,
          createOverlayMaterial(annot.color)
        );
        overlay.userData.isFaceOverlay = true;
        mesh.add(overlay);
        state.faceOverlayMeshes.set(key, overlay);
      } else {
        const geo = extractFacesGeometry(mesh.geometry, faceIndices);
        if (geo) {
          const overlay = new THREE.Mesh(geo, createOverlayMaterial(annot.color));
          overlay.userData.isFaceOverlay = true;
          mesh.add(overlay);
          state.faceOverlayMeshes.set(key, overlay);
        }
      }
    });
  });
}

// ----- 选择目标描述 -----
function getSelectedTargetsSummary() {
  let meshCount = 0;
  let faceCount = 0;
  state.selectedTargets.forEach((v) => {
    if (v === null) meshCount++;
    else faceCount += v.length;
  });
  if (meshCount === 0 && faceCount === 0) return null;
  const parts = [];
  if (meshCount) parts.push(`${meshCount} 个物体`);
  if (faceCount) parts.push(`${faceCount} 个面`);
  return parts.join('、');
}

// ----- UI 更新 -----
function updateSelectionUI() {
  const info = document.getElementById('selection-info');
  const form = document.getElementById('annotation-form');
  const addToRow = document.getElementById('add-to-annot-row');
  const selectEl = document.getElementById('annot-target-select');
  const summary = getSelectedTargetsSummary();
  if (!summary) {
    info.textContent = '未选择';
    form.classList.add('hidden');
  } else {
    info.textContent = `已选 ${summary}`;
    form.classList.remove('hidden');
    if (state.annotations.length > 0) {
      addToRow.classList.remove('hidden');
      selectEl.innerHTML = state.annotations.map((a, i) =>
        `<option value="${i}">${a.label || '未命名'}</option>`
      ).join('');
    } else {
      addToRow.classList.add('hidden');
    }
  }
}

function targetsSummary(targets) {
  let m = 0, f = 0;
  targets.forEach(t => {
    if (!t.faceIndices || t.faceIndices.length === 0) m++;
    else f += t.faceIndices.length;
  });
  const parts = [];
  if (m) parts.push(`${m} 物体`);
  if (f) parts.push(`${f} 面`);
  return parts.join(' ') || '-';
}

function isServerId(id) {
  return id && typeof id === 'string' && !id.startsWith('annot_');
}

function updateAnnotationList() {
  const ul = document.getElementById('annotation-list');
  const editingIndex = state.editingIndex;
  ul.innerHTML = state.annotations.map((a, i) => {
    if (editingIndex === i) {
      return `
        <li class="annot-item editing" data-index="${i}">
          <div class="annot-edit-form">
            <input type="text" class="annot-edit-label" value="${(a.label || '').replace(/"/g, '&quot;')}" placeholder="标签" />
            <input type="text" class="annot-edit-category" value="${(a.category || '').replace(/"/g, '&quot;')}" placeholder="分类" />
            <input type="color" class="annot-edit-color" value="${a.color || '#FF9900'}" />
            <div class="annot-edit-actions">
              <button type="button" class="btn-save-edit">保存</button>
              <button type="button" class="btn-cancel-edit">取消</button>
            </div>
          </div>
        </li>
      `;
    }
    const visible = !state.hiddenAnnotationIds.has(a.id);
    return `
      <li class="annot-item" data-index="${i}" data-id="${(a.id || '').toString().replace(/"/g, '&quot;')}" title="点击聚焦">
        <div class="annot-item-main">
          <input type="checkbox" class="annot-layer-visible" ${visible ? 'checked' : ''} title="显示/隐藏此层着色与引线" aria-label="显隐" />
          <span style="color:${a.color}">■</span>
          <span class="annot-item-label">${a.label || '未命名'}</span>
        </div>
        <div class="annot-meta">${a.category || '-'} · ${targetsSummary(a.targets)}</div>
        <div class="annot-item-actions">
          <button type="button" class="btn-edit-annot" title="编辑">编辑</button>
          <button type="button" class="btn-delete-annot" title="删除">删除</button>
        </div>
      </li>
    `;
  }).join('');

  ul.querySelectorAll('li').forEach(li => {
    const idx = parseInt(li.dataset.index, 10);
    const annot = state.annotations[idx];
    if (!annot) return;

    if (state.editingIndex === idx) {
      const saveBtn = li.querySelector('.btn-save-edit');
      const cancelBtn = li.querySelector('.btn-cancel-edit');
      saveBtn?.addEventListener('click', () => {
        const label = li.querySelector('.annot-edit-label').value.trim() || '未命名';
        const category = li.querySelector('.annot-edit-category').value.trim() || '';
        const color = li.querySelector('.annot-edit-color').value;
        saveEditAnnotation(idx, { label, category, color });
      });
      cancelBtn?.addEventListener('click', () => {
        state.editingIndex = null;
        updateAnnotationList();
      });
      return;
    }

    const mainBlock = li.querySelector('.annot-item-main');
    const metaBlock = li.querySelector('.annot-meta');
    const handleFocus = (e) => {
      if (e.target.closest('.annot-item-actions')) return;
      state.selectedTargets.clear();
      annot.targets.forEach(t => {
        state.selectedTargets.set(t.meshId, t.faceIndices?.length ? [...t.faceIndices] : null);
      });
      updateHighlight();
      updateSelectionUI();
    };
    mainBlock?.addEventListener('click', handleFocus);
    metaBlock?.addEventListener('click', handleFocus);

    li.querySelector('.annot-layer-visible')?.addEventListener('change', (e) => {
      e.stopPropagation();
      const id = annot.id;
      if (e.target.checked) state.hiddenAnnotationIds.delete(id);
      else state.hiddenAnnotationIds.add(id);
      updateHighlight();
      updateCalloutOverlay();
    });
    li.querySelector('.annot-layer-visible')?.addEventListener('click', (e) => e.stopPropagation());

    li.querySelector('.btn-edit-annot')?.addEventListener('click', (e) => {
      e.stopPropagation();
      state.editingIndex = idx;
      updateAnnotationList();
    });

    li.querySelector('.btn-delete-annot')?.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteAnnotation(idx);
    });
  });
}

async function saveEditAnnotation(idx, { label, category, color }) {
  const a = state.annotations[idx];
  if (!a) return;
  a.label = label;
  a.category = category;
  a.color = color;
  state.editingIndex = null;

  const base = getApiUrl();
  const modelId = state.currentModelId;
  if (base && modelId && isServerId(a.id)) {
    try {
      await fetch(`${base}/api/models/${modelId}/annotations/${a.id}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({ label, category, color }),
      });
    } catch (e) {
      console.error('saveEditAnnotation:', e);
    }
  }
  updateAnnotationList();
  updateHighlight();
}

async function deleteAnnotation(idx) {
  if (!confirm('确定删除此标注？')) return;
  const a = state.annotations[idx];
  if (!a) return;

  const base = getApiUrl();
  const modelId = state.currentModelId;
  if (base && modelId && isServerId(a.id)) {
    try {
      await fetch(`${base}/api/models/${modelId}/annotations/${a.id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
    } catch (e) {
      console.error('deleteAnnotation:', e);
    }
  }
  state.annotations.splice(idx, 1);
  if (state.editingIndex === idx) state.editingIndex = null;
  else if (state.editingIndex !== null && state.editingIndex > idx) state.editingIndex--;
  updateAnnotationList();
  updateHighlight();
}

// ----- 添加标注 -----
function addAnnotation() {
  const label = document.getElementById('annot-label').value.trim() || '未命名';
  const category = document.getElementById('annot-category').value.trim() || '';
  const color = document.getElementById('annot-color').value;
  const targets = [];
  state.selectedTargets.forEach((faceIndices, meshId) => {
    targets.push({ meshId, faceIndices: faceIndices && faceIndices.length > 0 ? [...faceIndices] : undefined });
  });
  if (targets.length === 0) return;

  const annot = {
    id: `annot_${Date.now()}`,
    targets,
    label,
    category,
    color,
    createdAt: Date.now(),
  };
  state.annotations.push(annot);
  updateAnnotationList();
  updateHighlight();
  updateSelectionUI();

  document.getElementById('annot-label').value = '';
  document.getElementById('annot-category').value = '';
}

// ----- 将选择添加到已有标注 -----
function mergeTargetsIntoAnnotation(annot, newTargets) {
  const targetMap = new Map();
  annot.targets.forEach(t => {
    if (!t.faceIndices || t.faceIndices.length === 0) {
      targetMap.set(t.meshId, null);
    } else {
      targetMap.set(t.meshId, [...t.faceIndices]);
    }
  });
  newTargets.forEach(({ meshId, faceIndices }) => {
    if (!faceIndices || faceIndices.length === 0) {
      targetMap.set(meshId, null);
    } else {
      const existing = targetMap.get(meshId);
      if (existing === null) return;
      if (existing) {
        const merged = new Set([...existing, ...faceIndices]);
        targetMap.set(meshId, [...merged]);
      } else {
        targetMap.set(meshId, [...faceIndices]);
      }
    }
  });
  annot.targets = Array.from(targetMap.entries()).map(([meshId, faceIndices]) =>
    ({ meshId, faceIndices: faceIndices && faceIndices.length > 0 ? faceIndices : undefined })
  );
}

function addToAnnotation() {
  const selectEl = document.getElementById('annot-target-select');
  const idx = parseInt(selectEl.value, 10);
  const annot = state.annotations[idx];
  if (!annot) return;
  const targets = [];
  state.selectedTargets.forEach((faceIndices, meshId) => {
    targets.push({ meshId, faceIndices: faceIndices && faceIndices.length > 0 ? [...faceIndices] : undefined });
  });
  if (targets.length === 0) return;
  mergeTargetsIntoAnnotation(annot, targets);
  updateAnnotationList();
  updateHighlight();
}

// ----- API 持久化 -----
function getApiUrl() {
  return (window.SANLIN_CONFIG?.apiUrl || '').replace(/\/$/, '');
}

function getAuthHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (state.session?.access_token) {
    h['Authorization'] = `Bearer ${state.session.access_token}`;
  }
  return h;
}

function getAuthHeadersForUpload() {
  const h = {};
  if (state.session?.access_token) {
    h['Authorization'] = `Bearer ${state.session.access_token}`;
  }
  return h;
}

function setPersistStatus(msg, isError = false) {
  const el = document.getElementById('persist-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#e57373' : '#666';
}

// ----- 用户登录 (Supabase Auth) -----
function setAuthStatus(msg, isError = false) {
  const el = document.getElementById('auth-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'auth-status' + (isError ? ' error' : '');
}

function updateAuthUI() {
  const loggedOut = document.getElementById('auth-logged-out');
  const loggedIn = document.getElementById('auth-logged-in');
  const emailEl = document.getElementById('auth-user-email');
  if (!loggedOut || !loggedIn) return;
  if (state.session?.user) {
    loggedOut.classList.add('hidden');
    loggedIn.classList.remove('hidden');
    if (emailEl) emailEl.textContent = state.session.user.email || '';
  } else {
    loggedOut.classList.remove('hidden');
    loggedIn.classList.add('hidden');
  }
}

async function initAuth() {
  if (!supabase) {
    updateAuthUI(); // 仍显示登录区域，点击时提示「Supabase 未配置」
    return;
  }
  try {
    const { data: { session } } = await supabase.auth.getSession();
    state.session = session;
    supabase.auth.onAuthStateChange((_event, session) => {
      state.session = session;
      updateAuthUI();
    });
  } catch (e) {
    console.error('initAuth:', e);
  }
  updateAuthUI();
}

async function handleLogin() {
  if (!supabase) {
    setAuthStatus('Supabase 未配置', true);
    return;
  }
  const email = document.getElementById('auth-email')?.value?.trim();
  const password = document.getElementById('auth-password')?.value;
  if (!email || !password) {
    setAuthStatus('请输入邮箱和密码', true);
    return;
  }
  setAuthStatus('登录中...');
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    state.session = data.session;
    updateAuthUI();
    setAuthStatus('');
  } catch (e) {
    setAuthStatus(e.message || '登录失败', true);
  }
}

async function handleRegister() {
  if (!supabase) {
    setAuthStatus('Supabase 未配置', true);
    return;
  }
  const email = document.getElementById('auth-email')?.value?.trim();
  const password = document.getElementById('auth-password')?.value;
  if (!email || !password) {
    setAuthStatus('请输入邮箱和密码', true);
    return;
  }
  if (password.length < 6) {
    setAuthStatus('密码至少 6 位', true);
    return;
  }
  setAuthStatus('注册中...');
  try {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
    state.session = data.session;
    updateAuthUI();
    setAuthStatus(data.user?.identities?.length ? '注册成功' : '请查收邮件确认');
  } catch (e) {
    setAuthStatus(e.message || '注册失败', true);
  }
}

async function handleLogout() {
  if (!supabase) return;
  await supabase.auth.signOut();
  state.session = null;
  updateAuthUI();
  setAuthStatus('');
}

// ----- Pusher 实时同步 -----
function apiToAnnot(a) {
  return {
    id: a.id,
    targets: a.targets || [],
    label: a.label || '未命名',
    category: a.category || '',
    color: a.color || '#FF9900',
    createdAt: a.created_at ? new Date(a.created_at).getTime() : Date.now(),
  };
}

function subscribePusher(modelId) {
  unsubscribePusher();
  const client = initPusher();
  if (!client || !modelId) return;
  const channelName = `model-${modelId}`;
  pusherChannel = client.subscribe(channelName);

  pusherChannel.bind('annotations-synced', (data) => {
    state.annotations = (data || []).map(apiToAnnot);
    updateAnnotationList();
    updateHighlight();
    updateCalloutOverlay();
  });

  pusherChannel.bind('annotation-updated', (data) => {
    const idx = state.annotations.findIndex((a) => a.id === data?.id);
    if (idx >= 0 && data) {
      state.annotations[idx] = apiToAnnot(data);
    } else if (data) {
      state.annotations.push(apiToAnnot(data));
    }
    updateAnnotationList();
    updateHighlight();
    updateCalloutOverlay();
  });

  pusherChannel.bind('annotation-deleted', (data) => {
    const id = data?.id;
    if (id) {
      state.annotations = state.annotations.filter((a) => a.id !== id);
      state.hiddenAnnotationIds.delete(id);
    }
    updateAnnotationList();
    updateHighlight();
    updateCalloutOverlay();
  });

  pusherChannel.bind('annotation-created', (data) => {
    if (data) {
      state.annotations.push(apiToAnnot(data));
      updateAnnotationList();
      updateHighlight();
      updateCalloutOverlay();
    }
  });
}

function unsubscribePusher() {
  if (pusherChannel && pusherClient) {
    pusherClient.unsubscribe(pusherChannel.name);
    pusherChannel = null;
  }
}

async function uploadModelToApi(file, name) {
  const base = getApiUrl();
  if (!base) {
    setPersistStatus('请先配置 API 地址', true);
    return null;
  }
  if (!state.session?.access_token) {
    setPersistStatus('请先登录', true);
    return null;
  }
  const form = new FormData();
  form.append('file', file);
  if (name && name.trim()) form.append('name', name.trim());
  try {
    const r = await fetch(`${base}/api/models/upload`, {
      method: 'POST',
      headers: getAuthHeadersForUpload(),
      body: form,
    });
    if (r.status === 401) {
      setPersistStatus('请先登录', true);
      return null;
    }
    const bodyText = await r.text();
    if (!r.ok) {
      let msg = '上传失败';
      if (r.status === 413) msg = '文件过大，请压缩或分块后上传';
      else {
        try {
          const err = JSON.parse(bodyText);
          msg = err.error || msg;
        } catch {
          msg = bodyText?.trim() || msg;
        }
      }
      throw new Error(msg);
    }
    return JSON.parse(bodyText);
  } catch (e) {
    const isNetworkError = e?.message === 'Failed to fetch' || e?.name === 'TypeError';
    const msg = isNetworkError
      ? '网络错误或上传超时，请检查网络与文件大小（限制约 50MB）'
      : (e?.message || '上传失败');
    setPersistStatus(msg, true);
    return null;
  }
}

async function fetchModelList() {
  const base = getApiUrl();
  if (!base) return [];
  try {
    const r = await fetch(`${base}/api/models`);
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('fetchModelList:', e);
    return [];
  }
}

function renderModelList(models) {
  const ul = document.getElementById('model-list');
  if (!ul) return;
  const builtin = models.filter((m) => m.url === 'builtin://default');
  const others = models.filter((m) => m.url !== 'builtin://default');
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  ul.innerHTML = [...builtin, ...others].map((m) => {
    const name = m.name || m.Name || '未命名';
    const isBuiltin = m.url === 'builtin://default';
    return `<li class="model-list-item" data-id="${esc(m.id)}">
      <div class="model-list-main">
        <span class="model-list-name" title="${esc(name)}">${esc(name)}</span>
        <div class="model-list-actions">
          <button type="button" class="btn-load-model" data-id="${esc(m.id)}" data-url="${esc(m.url || '')}" title="加载">加载</button>
          <button type="button" class="btn-rename-model" data-id="${esc(m.id)}" title="重命名">重命名</button>
          <button type="button" class="btn-delete-model" data-id="${esc(m.id)}" data-builtin="${isBuiltin}" title="删除">删除</button>
        </div>
      </div>
    </li>`;
  }).join('');

  ul.querySelectorAll('.btn-load-model').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const url = btn.dataset.url;
      const name = btn.closest('.model-list-item')?.querySelector('.model-list-name')?.textContent || '未命名';
      if (id && url) loadModelFromList({ id, url, name });
    });
  });
  ul.querySelectorAll('.btn-rename-model').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const item = btn.closest('.model-list-item');
      const nameEl = item?.querySelector('.model-list-name');
      const currentName = nameEl?.textContent || '';
      const newName = prompt('输入新名称', currentName);
      if (newName !== null && newName.trim()) renameModel(id, newName.trim(), item);
    });
  });
  ul.querySelectorAll('.btn-delete-model').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const isBuiltin = btn.dataset.builtin === 'true';
      if (isBuiltin) {
        alert('示例建筑不可删除');
        return;
      }
      if (confirm('确定删除此模型？其标注也会被删除。')) deleteModel(id);
    });
  });
}

async function renameModel(id, name, itemEl) {
  const base = getApiUrl();
  if (!base || !state.session?.access_token) {
    setPersistStatus('请先登录', true);
    return;
  }
  try {
    const r = await fetch(`${base}/api/models/${id}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ name }),
    });
    if (r.status === 401) { setPersistStatus('请先登录', true); return; }
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || '重命名失败');
    }
    const span = itemEl?.querySelector('.model-list-name');
    if (span) span.textContent = name;
    setPersistStatus('已重命名');
  } catch (e) {
    setPersistStatus(e.message || '重命名失败', true);
  }
}

async function deleteModel(id) {
  const base = getApiUrl();
  if (!base || !state.session?.access_token) {
    setPersistStatus('请先登录', true);
    return;
  }
  try {
    const r = await fetch(`${base}/api/models/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    if (r.status === 401) { setPersistStatus('请先登录', true); return; }
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || '删除失败');
    }
    if (state.currentModelId === id) {
      clearModel(state.scene);
      unsubscribePusher();
      state.currentModelId = null;
      createDefaultBuilding(state.scene);
      state.currentModelId = await ensureDefaultModel();
      if (state.currentModelId) await loadAnnotationsFromApi();
      subscribePusher(state.currentModelId);
      updateAnnotationList();
      updateSelectionUI();
    }
    const list = await fetchModelList();
    renderModelList(list);
    setPersistStatus('已删除');
  } catch (e) {
    setPersistStatus(e.message || '删除失败', true);
  }
}

async function loadModelFromList(model) {
  if (!model?.id || !model?.url) return;
  const loaderEl = document.getElementById('loader');
  clearModel(state.scene);
  unsubscribePusher();
  state.currentModelId = model.id;
  loaderEl?.classList.remove('hidden');
  try {
    if (model.url === 'builtin://default') {
      const group = createDefaultBuilding(state.scene);
      frameModelInView(state.scene, group);
    } else {
      await loadModel(model.url);
    }
    if (state.session?.access_token) await loadAnnotationsFromApi();
    subscribePusher(state.currentModelId);
    updateAnnotationList();
    updateSelectionUI();
  } catch (e) {
    console.error('loadModelFromList:', e);
    alert('加载模型失败: ' + (e.message || e));
    const fallbackGroup = createDefaultBuilding(state.scene);
    frameModelInView(state.scene, fallbackGroup);
    state.currentModelId = await ensureDefaultModel();
    if (state.currentModelId) await loadAnnotationsFromApi();
    subscribePusher(state.currentModelId);
  } finally {
    loaderEl?.classList.add('hidden');
  }
}

async function ensureDefaultModel() {
  const base = getApiUrl();
  if (!base) return null;
  try {
    const r = await fetch(`${base}/api/models`);
    const models = await r.json();
    let m = models.find((x) => x.url === 'builtin://default');
    if (!m) {
      const cr = await fetch(`${base}/api/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '默认建筑', url: 'builtin://default' }),
      });
      m = await cr.json();
    }
    return m?.id || null;
  } catch (e) {
    console.error('ensureDefaultModel:', e);
    return null;
  }
}

async function loadAnnotationsFromApi() {
  const base = getApiUrl();
  const modelId = state.currentModelId;
  if (!base || !modelId) return;
  if (!state.session?.access_token) {
    setPersistStatus('请先登录', true);
    return;
  }
  setPersistStatus('加载中...');
  try {
    const r = await fetch(`${base}/api/models/${modelId}/annotations`, {
      headers: getAuthHeaders(),
    });
    if (r.status === 401) {
      setPersistStatus('请先登录', true);
      return;
    }
    const data = await r.json();
    state.annotations = (data || []).map((a) => ({
      id: a.id,
      targets: a.targets || [],
      label: a.label || '未命名',
      category: a.category || '',
      color: a.color || '#FF9900',
      createdAt: a.created_at ? new Date(a.created_at).getTime() : Date.now(),
    }));
    updateAnnotationList();
    updateHighlight();
    setPersistStatus(`已加载 ${state.annotations.length} 条标注`);
  } catch (e) {
    console.error('loadAnnotations:', e);
    setPersistStatus('加载失败', true);
  }
}

async function saveAnnotationsToApi() {
  const base = getApiUrl();
  const modelId = state.currentModelId;
  if (!base || !modelId) {
    setPersistStatus('请先配置 API 地址并加载示例建筑', true);
    return;
  }
  if (!state.session?.access_token) {
    setPersistStatus('请先登录', true);
    return;
  }
  setPersistStatus('保存中...');
  try {
    const author = state.session?.user?.email || '';
    const payload = state.annotations.map((a) => ({
      targets: a.targets,
      label: a.label,
      category: a.category,
      color: a.color,
      author,
    }));
    const r = await fetch(`${base}/api/models/${modelId}/annotations`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ annotations: payload }),
    });
    if (r.status === 401) {
      setPersistStatus('请先登录', true);
      return;
    }
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    state.annotations = (data || []).map((a) => ({
      id: a.id,
      targets: a.targets || [],
      label: a.label || '未命名',
      category: a.category || '',
      color: a.color || '#FF9900',
      createdAt: a.created_at ? new Date(a.created_at).getTime() : Date.now(),
    }));
    state.editingIndex = null;
    updateAnnotationList();
    updateHighlight();
    setPersistStatus(`已保存 ${state.annotations.length} 条标注`);
  } catch (e) {
    console.error('saveAnnotations:', e);
    setPersistStatus('保存失败', true);
  }
}

// ----- 导出标注数据为 JSON 文件 -----
function exportAnnotations() {
  const payload = {
    exportedAt: new Date().toISOString(),
    modelId: state.currentModelId || null,
    annotations: state.annotations.map((a) => ({
      id: a.id,
      targets: a.targets || [],
      label: a.label || '未命名',
      category: a.category || '',
      color: a.color || '#FF9900',
      createdAt: a.createdAt != null ? a.createdAt : Date.now(),
    })),
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const ts = new Date();
  const fn = `annotations_${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}_${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}.json`;
  a.download = fn;
  a.click();
  URL.revokeObjectURL(url);
  setPersistStatus(`已导出 ${state.annotations.length} 条标注`);
}

// ----- 确保 Canvas 有有效尺寸 -----
function getCanvasSize(canvas) {
  const container = canvas?.parentElement;
  const w = canvas?.clientWidth || container?.offsetWidth || window.innerWidth;
  const h = canvas?.clientHeight || container?.offsetHeight || window.innerHeight;
  return { width: Math.max(1, w || 800), height: Math.max(1, h || 600) };
}

// ----- 将模型居中并调整相机 -----
function frameModelInView(scene, model) {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  let maxDim = Math.max(size.x, size.y, size.z, 1);
  // 仅当包围盒几乎为空（如 3D Tiles 刚加载时）才拉远相机，否则普通小模型会变成一个小点
  if (maxDim < 5) maxDim = 500;
  // 小模型（如示例建筑 ~6 单位）用较近距离，避免看起来太远
  const dist = maxDim >= 100 ? maxDim * 1.2 : Math.max(maxDim * 0.6, 3);
  state.camera.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist * 0.7);
  state.controls.target.copy(center);
  if (state.controls.update) state.controls.update();
}

// ----- 初始化 -----
async function init() {
  const canvas = document.getElementById('canvas');
  const loaderEl = document.getElementById('loader');

  state.scene = new THREE.Scene();
  state.scene.background = new THREE.Color(0x1a1a1a);

  const size = getCanvasSize(canvas);
  state.camera = new THREE.PerspectiveCamera(60, size.width / size.height, 0.1, 1000);
  state.camera.position.set(10, 8, 10);

  state.renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
  state.renderer.setSize(size.width, size.height);
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  state.renderer.outputColorSpace = THREE.SRGBColorSpace;
  state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  state.renderer.toneMappingExposure = 1.0;  // 原 1.3 会偏亮，降为 1.0

  const controls = new OrbitControls(state.camera, canvas);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.mouseButtons = {
    LEFT: null,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.ROTATE,
  };
  state.controls = controls;

  // 灯光（强度可由侧栏滑条调节）
  state.ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  state.scene.add(state.ambientLight);
  state.dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
  state.dirLight.position.set(10, 15, 10);
  state.scene.add(state.dirLight);
  state.fillLight = new THREE.DirectionalLight(0xffffff, 0.25);
  state.fillLight.position.set(-8, 8, -8);
  state.scene.add(state.fillLight);

  const defaultGroup = createDefaultBuilding(state.scene);
  frameModelInView(state.scene, defaultGroup);
  loaderEl.classList.add('hidden');

  await initAuth();
  state.currentModelId = await ensureDefaultModel();
  if (state.currentModelId && state.session?.access_token) await loadAnnotationsFromApi();
  subscribePusher(state.currentModelId);
  const modelList = await fetchModelList();
  renderModelList(modelList);

  canvas.tabIndex = -1;
  canvas.addEventListener('mousedown', onPointerDown, true);
  canvas.addEventListener('click', onPointerClick);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);

  const keyToFly = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', KeyQ: 'q', KeyE: 'e' };
  window.addEventListener('keydown', (e) => {
    const k = keyToFly[e.code];
    if (k) {
      state.keys[k] = true;
      if (state.rightMouseDown) e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = keyToFly[e.code];
    if (k) state.keys[k] = false;
  });

  document.getElementById('model-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const nameInput = document.getElementById('model-name-input');
    const name = nameInput?.value?.trim() || file.name.replace(/\.(glb|gltf)$/i, '');
    loaderEl.classList.remove('hidden');
    loaderEl.textContent = '上传中...';
    try {
      const model = await uploadModelToApi(file, name);
      e.target.value = '';
      if (model?.id && model?.url) {
        clearModel(state.scene);
        unsubscribePusher();
        state.currentModelId = model.id;
        loaderEl.textContent = '加载中...';
        await loadModel(model.url);
        if (state.session?.access_token) await loadAnnotationsFromApi();
        subscribePusher(state.currentModelId);
        updateAnnotationList();
        updateSelectionUI();
        const list = await fetchModelList();
        renderModelList(list);
      }
    } catch (err) {
      console.error('加载模型失败:', err);
      alert('加载/上传失败: ' + (err.message || err));
    } finally {
      loaderEl.classList.add('hidden');
      loaderEl.textContent = '加载中...';
      e.target.value = '';
    }
  });

  document.getElementById('btn-default-model').addEventListener('click', async () => {
    clearModel(state.scene);
    const group = createDefaultBuilding(state.scene);
    frameModelInView(state.scene, group);
    state.currentModelId = await ensureDefaultModel();
    if (state.currentModelId) await loadAnnotationsFromApi();
    subscribePusher(state.currentModelId);
    updateAnnotationList();
    updateSelectionUI();
    const modelList = await fetchModelList();
    renderModelList(modelList);
  });

  document.getElementById('btn-load-tileset').addEventListener('click', async () => {
    const input = document.getElementById('tileset-url-input');
    const url = input?.value?.trim();
    if (!url) {
      setPersistStatus('请输入 tileset.json 的 URL', true);
      return;
    }
    loaderEl.classList.remove('hidden');
    loaderEl.textContent = '加载 3D Tiles...';
    setPersistStatus('');
    try {
      clearModel(state.scene);
      unsubscribePusher();
      state.currentModelId = null; // 3D Tiles 暂不绑定后端模型，标注仅本地/导出
      await loadTileset(url);
      updateAnnotationList();
      updateSelectionUI();
    } catch (err) {
      console.error('loadTileset:', err);
      setPersistStatus(err?.message || '加载 3D Tiles 失败', true);
    } finally {
      loaderEl.classList.add('hidden');
      loaderEl.textContent = '加载中...';
    }
  });

  document.getElementById('btn-debug-tileset').addEventListener('click', () => {
    const report = debugTileset();
    setPersistStatus(report.length ? '诊断已输出到控制台 (F12 → Console)' : '请先加载 3D Tiles 再诊断', !state.tilesRenderer);
  });

  document.getElementById('btn-apply-tilt').addEventListener('click', () => {
    const toRad = (v) => (parseFloat(v) || 0) * Math.PI / 180;
    const degX = parseFloat(document.getElementById('tileset-rot-x')?.value) || 0;
    const degY = parseFloat(document.getElementById('tileset-rot-y')?.value) || 0;
    const degZ = parseFloat(document.getElementById('tileset-rot-z')?.value) || 0;
    state.tilesetCorrectionX = toRad(degX);
    state.tilesetCorrectionY = toRad(degY);
    state.tilesetTiltCorrection = toRad(degZ);
    if (state.tilesRenderer) {
      setPersistStatus('旋转校正已应用: X=' + degX.toFixed(1) + '° Y=' + degY.toFixed(1) + '° Z=' + degZ.toFixed(1) + '°');
    } else {
      setPersistStatus('请先加载 3D Tiles 再应用旋转校正', true);
    }
  });

  (function initLodControl() {
    const rangeEl = document.getElementById('tileset-lod-range');
    const inputEl = document.getElementById('tileset-lod-input');
    const applyLod = (value) => {
      const v = Math.max(0.5, Math.min(20, parseFloat(value) || 2));
      state.tilesetErrorTarget = v;
      if (rangeEl) rangeEl.value = String(v);
      if (inputEl) inputEl.value = String(v);
      if (state.tilesRenderer) state.tilesRenderer.errorTarget = v;
    };
    rangeEl?.addEventListener('input', () => applyLod(rangeEl.value));
    inputEl?.addEventListener('change', () => applyLod(inputEl.value));
  })();

  (function initLightingControls() {
    const cfg = [
      { id: 'light-exposure', valueId: 'light-exposure-value', min: 0.5, max: 2, step: 0.05, set: (v) => { if (state.renderer) state.renderer.toneMappingExposure = v; } },
      { id: 'light-ambient', valueId: 'light-ambient-value', min: 0, max: 2, set: (v) => { if (state.ambientLight) state.ambientLight.intensity = v; } },
      { id: 'light-dir', valueId: 'light-dir-value', min: 0, max: 2, set: (v) => { if (state.dirLight) state.dirLight.intensity = v; } },
      { id: 'light-fill', valueId: 'light-fill-value', min: 0, max: 1, set: (v) => { if (state.fillLight) state.fillLight.intensity = v; } },
    ];
    cfg.forEach(({ id, valueId, set }) => {
      const slider = document.getElementById(id);
      const valueEl = document.getElementById(valueId);
      if (!slider || !valueEl) return;
      const update = () => {
        const v = parseFloat(slider.value) || 0;
        valueEl.textContent = v.toFixed(2);
        set(v);
      };
      slider.addEventListener('input', update);
      update();
    });
  })();

  document.getElementById('btn-save').addEventListener('click', saveAnnotationsToApi);
  document.getElementById('btn-load').addEventListener('click', loadAnnotationsFromApi);
  document.getElementById('btn-export').addEventListener('click', exportAnnotations);

  document.getElementById('btn-login')?.addEventListener('click', handleLogin);
  document.getElementById('btn-register')?.addEventListener('click', handleRegister);
  document.getElementById('btn-logout')?.addEventListener('click', handleLogout);

  document.getElementById('btn-add-annotation').addEventListener('click', addAnnotation);
  document.getElementById('btn-add-to-annot').addEventListener('click', addToAnnotation);

  document.getElementById('annot-opacity').addEventListener('input', (e) => {
    state.overlayOpacity = parseFloat(e.target.value);
    document.getElementById('opacity-value').textContent = Math.round(state.overlayOpacity * 100) + '%';
    updateHighlight();
  });

  document.getElementById('btn-mode-object').addEventListener('click', () => {
    state.selectionMode = 'object';
    state.selectedTargets.clear();
    document.getElementById('btn-mode-object').classList.add('active');
    document.getElementById('btn-mode-face').classList.remove('active');
    updateSelectionUI();
    updateHighlight();
    document.getElementById('hint').textContent = '物体模式：左键选择 · Alt+左键拖拽框选 · 右键旋转';
  });
  document.getElementById('btn-mode-face').addEventListener('click', () => {
    state.selectionMode = 'face';
    state.selectedTargets.clear();
    document.getElementById('btn-mode-face').classList.add('active');
    document.getElementById('btn-mode-object').classList.remove('active');
    updateSelectionUI();
    updateHighlight();
    document.getElementById('hint').textContent = '面模式：左键选择面 · Alt+左键拖拽框选 · 右键旋转';
  });

  window.addEventListener('resize', () => {
    const c = document.getElementById('canvas');
    const s = getCanvasSize(c);
    state.camera.aspect = s.width / s.height;
    state.camera.updateProjectionMatrix();
    state.renderer.setSize(s.width, s.height);
    updateCalloutOverlay();
  });

  // 控制台可执行 debugTileset() 检查 3D Tiles 加载状态
  window.debugTileset = debugTileset;

  updateSelectionUI();
  updateAnnotationList();

  let lastTime = performance.now();
  function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.2);
    lastTime = now;
    state.controls.update();
    if (state.rightMouseDown && state.controls && (state.keys.w || state.keys.a || state.keys.s || state.keys.d || state.keys.q || state.keys.e)) {
      const speed = state.flySpeed * dt;
      state.camera.getWorldDirection(state._flyForward);
      state._flyForward.y = 0;
      state._flyForward.normalize();
      state._flyRight.crossVectors(state._flyForward, state._flyUp);
      if (state.keys.w) { state.camera.position.addScaledVector(state._flyForward, speed); state.controls.target.addScaledVector(state._flyForward, speed); }
      if (state.keys.s) { state.camera.position.addScaledVector(state._flyForward, -speed); state.controls.target.addScaledVector(state._flyForward, -speed); }
      if (state.keys.a) { state.camera.position.addScaledVector(state._flyRight, -speed); state.controls.target.addScaledVector(state._flyRight, -speed); }
      if (state.keys.d) { state.camera.position.addScaledVector(state._flyRight, speed); state.controls.target.addScaledVector(state._flyRight, speed); }
      if (state.keys.q) { state.camera.position.y += speed; state.controls.target.y += speed; }
      if (state.keys.e) { state.camera.position.y -= speed; state.controls.target.y -= speed; }
    }
    if (state.tilesRenderer) {
      state.camera.updateMatrixWorld(true);
      state.tilesRenderer.setResolutionFromRenderer(state.camera, state.renderer);
      state.tilesRenderer.update();
      // 每帧强制应用偏移；倾斜校正放在外层 wrapper 上，避免改库的 group.rotation 导致子节点被清空
      if (state.tilesetPositionOffset) {
        state.tilesRenderer.group.position.copy(state.tilesetPositionOffset);
      }
      state.tilesRenderer.group.rotation.x = -Math.PI / 2;
      state.tilesRenderer.group.rotation.y = 0;
      state.tilesRenderer.group.rotation.z = 0;
      if (state.tilesetWrapper) {
        state.tilesetWrapper.rotation.x = state.tilesetCorrectionX;
        state.tilesetWrapper.rotation.y = state.tilesetCorrectionY;
        state.tilesetWrapper.rotation.z = state.tilesetTiltCorrection;
      }
      syncTilesetMeshes();
    }
    state.renderer.render(state.scene, state.camera);
    updateCalloutOverlay();
  }
  animate();
}

// 等待 DOM 布局完成后再初始化，避免 canvas 尺寸为 0
function start() {
  requestAnimationFrame(() => {
    init().catch(err => {
      console.error(err);
      document.getElementById('loader').textContent = '初始化失败: ' + (err.message || err);
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
