/**
 * 3D 模型加载、选择、简单标注 - 最小 Demo
 * 本地运行需通过 HTTP 服务器 (如 npx serve)
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';

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
  faceOverlayMeshes: new Map(),  // meshId -> THREE.Mesh (face highlight overlay)
  overlayOpacity: 0.45,
  currentModelId: null,  // 当前模型的 Supabase ID，用于保存/加载
  editingIndex: null,    // 正在编辑的标注索引
};

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
function extractMeshesFromObject(obj, parentMatrix = new THREE.Matrix4()) {
  const mat = new THREE.Matrix4().copy(parentMatrix).multiply(obj.matrixWorld);
  if (obj.isMesh && obj.geometry) {
    const meshId = obj.uuid;
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
  const toRemove = scene.children.filter(c =>
    c.name === 'default_building' || c.userData?.isLoadedModel
  );
  toRemove.forEach(c => scene.remove(c));
  state.meshes = [];
  state.selectedTargets.clear();
  state.annotations = [];
  state.meshIdCounter = 0;
}

// ----- 加载 glTF/GLB -----
async function loadModel(urlOrFile) {
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
  const intersects = state.raycaster.intersectObjects(
    state.meshes.map(m => m.mesh),
    true
  );

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

  if (state.selectionMode === 'object') {
    state.meshes.forEach(({ mesh, meshId }) => {
      mesh.getWorldPosition(proj);
      proj.project(state.camera);
      if (proj.x >= left && proj.x <= right && proj.y >= bottom && proj.y <= top) {
        selected.set(meshId, null);
      }
    });
  } else {
    state.meshes.forEach(({ mesh, meshId }) => {
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

// ----- 计算标注的 3D 中心（世界坐标） -----
function getAnnotationWorldCenter(annot) {
  const center = new THREE.Vector3();
  let count = 0;
  annot.targets.forEach((t) => {
    const entry = state.meshes.find(m => m.meshId === t.meshId);
    if (!entry) return;
    const { mesh } = entry;
    if (!t.faceIndices || t.faceIndices.length === 0) {
      const box = new THREE.Box3().setFromObject(mesh);
      const c = box.getCenter(new THREE.Vector3());
      center.add(c);
      count++;
    } else {
      t.faceIndices.forEach(fi => {
        const fc = getFaceWorldCenter(mesh, fi);
        center.add(fc);
        count++;
      });
    }
  });
  if (count === 0) return null;
  center.divideScalar(count);
  return center;
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
  const LINE_LENGTH = 80;
  const FONT = '14px sans-serif';

  state.annotations.forEach((annot) => {
    const worldCenter = getAnnotationWorldCenter(annot);
    if (!worldCenter) return;
    proj.copy(worldCenter).project(state.camera);
    if (proj.z > 1 || proj.z < -1) return;

    const px = (proj.x + 1) / 2 * canvas.width;
    const py = (1 - proj.y) / 2 * canvas.height;

    const label = annot.label || '未命名';
    ctx.font = FONT;
    const textW = ctx.measureText(label).width;

    const dx = px < canvas.width / 2 ? 1 : -1;
    const tx = px + dx * LINE_LENGTH;
    const ty = py;

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(tx, ty);
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
    const sel = state.selectedTargets.get(meshId);
    const annots = getAnnotationsForMesh(meshId);

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
    return `
      <li class="annot-item" data-index="${i}" title="点击聚焦">
        <div class="annot-item-main">
          <span style="color:${a.color}">■</span>
          <span class="annot-item-label">${a.label || '未命名'}</span>
          <div class="annot-item-actions">
            <button type="button" class="btn-edit-annot" title="编辑">编辑</button>
            <button type="button" class="btn-delete-annot" title="删除">删除</button>
          </div>
        </div>
        <div class="annot-meta">${a.category || '-'} · ${targetsSummary(a.targets)}</div>
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

    li.querySelector('.annot-item-main')?.addEventListener('click', (e) => {
      if (e.target.closest('.annot-item-actions')) return;
      state.selectedTargets.clear();
      annot.targets.forEach(t => {
        state.selectedTargets.set(t.meshId, t.faceIndices?.length ? [...t.faceIndices] : null);
      });
      updateHighlight();
      updateSelectionUI();
    });

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
        headers: { 'Content-Type': 'application/json' },
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
      await fetch(`${base}/api/models/${modelId}/annotations/${a.id}`, { method: 'DELETE' });
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

function setPersistStatus(msg, isError = false) {
  const el = document.getElementById('persist-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#e57373' : '#666';
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
  setPersistStatus('加载中...');
  try {
    const r = await fetch(`${base}/api/models/${modelId}/annotations`);
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
  setPersistStatus('保存中...');
  try {
    const payload = state.annotations.map((a) => ({
      targets: a.targets,
      label: a.label,
      category: a.category,
      color: a.color,
    }));
    const r = await fetch(`${base}/api/models/${modelId}/annotations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ annotations: payload }),
    });
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

// ----- 确保 Canvas 有有效尺寸 -----
function getCanvasSize(canvas) {
  const container = canvas?.parentElement;
  const w = canvas?.clientWidth || container?.offsetWidth || window.innerWidth;
  const h = canvas?.clientHeight || container?.offsetHeight || window.innerHeight;
  return { width: Math.max(1, w || 800), height: Math.max(1, h || 600) };
}

// ----- 将模型居中并调整相机 -----
function frameModelInView(scene, model) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const dist = maxDim * 1.5;
  state.camera.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist * 0.7);
  state.controls.target.copy(center);
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
  state.renderer.toneMappingExposure = 1.3;

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

  const ambient = new THREE.AmbientLight(0xffffff, 1.0);
  state.scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(10, 15, 10);
  state.scene.add(dir);
  const fill = new THREE.DirectionalLight(0xffffff, 0.4);
  fill.position.set(-8, 8, -8);
  state.scene.add(fill);

  createDefaultBuilding(state.scene);
  loaderEl.classList.add('hidden');

  state.currentModelId = await ensureDefaultModel();
  if (state.currentModelId) await loadAnnotationsFromApi();

  canvas.addEventListener('mousedown', onPointerDown);
  canvas.addEventListener('click', onPointerClick);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);

  document.getElementById('model-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    clearModel(state.scene);
    state.currentModelId = null;
    loaderEl.classList.remove('hidden');
    try {
      await loadModel(file);
    } catch (err) {
      console.error('加载模型失败:', err);
      alert('加载模型失败: ' + (err.message || err));
      createDefaultBuilding(state.scene);
      state.currentModelId = await ensureDefaultModel();
      if (state.currentModelId) await loadAnnotationsFromApi();
    } finally {
      loaderEl.classList.add('hidden');
      e.target.value = '';
    }
  });

  document.getElementById('btn-default-model').addEventListener('click', async () => {
    clearModel(state.scene);
    createDefaultBuilding(state.scene);
    state.currentModelId = await ensureDefaultModel();
    if (state.currentModelId) await loadAnnotationsFromApi();
    updateAnnotationList();
    updateSelectionUI();
  });

  document.getElementById('btn-save').addEventListener('click', saveAnnotationsToApi);
  document.getElementById('btn-load').addEventListener('click', loadAnnotationsFromApi);

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

  updateSelectionUI();
  updateAnnotationList();

  function animate() {
    requestAnimationFrame(animate);
    state.controls.update();
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
