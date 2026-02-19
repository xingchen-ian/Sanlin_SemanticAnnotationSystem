# Gaussian Splatting (PLY) 支持可行性分析

## 当前项目状态

- **渲染**：Three.js + `3d-tiles-renderer`，加载 **b3dm**（3D Tiles）LOD 模型。
- **标注数据**：`targets` 为 `[{ meshId?, faceIndices?, worldBox? }]`；展示与引线**优先用 worldBox**，没有 worldBox 时才用 meshId/faceIndices 算 box。
- **选择与创建标注**：基于 **mesh + 面**：Raycaster 打 mesh、取 `faceIndex`，再算 `worldBox` 存库。

## 是否支持 Gaussian Splatting（PLY）渲染？

**结论：技术上可行，需要单独集成渲染管线。**

- **渲染层**：Three.js 生态有现成方案，例如 **[GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D)**：
  - 支持 **.ply**（INRIA 等）、**.splat**、**.ksplat**（压缩）。
  - 与 Three.js 场景/相机兼容，可和现有 OrbitControls、相机、灯光共存。
  - 无 mesh、无三角面，是**点云式渲染**（splat 点），不能走现有 `Raycaster.intersectObjects(mesh)` 的“选面”逻辑。
- **集成方式**：在现有场景中增加“模型类型”：当前为 b3dm/gltf/obj 时走现有逻辑；为 **splat/ply** 时用 GaussianSplats3D 渲染，并关闭或分支“按 mesh/面选择”的逻辑。

## 对标注逻辑的影响（核心矛盾）

| 能力           | 当前（mesh/b3dm）     | Gaussian Splatting（PLY） |
|----------------|------------------------|---------------------------|
| 射线选“面”     | ✅ Raycaster + faceIndex | ❌ 无三角面，无法选“面”   |
| 射线选“物体”   | ✅ 选整个 mesh         | ❌ 无“物体”概念，只有点云 |
| 框选 mesh/面   | ✅ 基于 geometry/面中心 | ❌ 无 mesh/面             |
| 标注存储格式   | meshId + faceIndices + worldBox | 只能 **worldBox（或点）** |
| 高亮/显示      | 用 worldBox 画半透明 box | ✅ 可继续用 worldBox 画 box |

因此：**在 Splat 场景下不能沿用“点选/框选 mesh 或面 → 自动得到 worldBox”的流程**，需要改为**基于 3D 空间区域**的标注方式。

## 可行的标注模型（仅 Splat 时）

1. **仅用 worldBox 的 target**
   - 后端已支持：`targets` 为 JSONB，不强制 `meshId`；前端 `getAnnotationAnchorPoints`、`ensureWorldBoxesForAnnotation`、高亮都已支持“仅有 worldBox”的 target（有 worldBox 时优先用，不依赖 mesh）。
   - 即：**Splat 模式下，target 只存 `{ worldBox: { min, max } }`** 即可，无需 meshId/faceIndices。

2. **如何产生 worldBox（创建标注）**
   - **方案 A**：**3D 框选**  
     用户在场景里拖拽出一个 3D 包围盒（例如两次点击定对角，或拖拽控制点），得到 `worldBox`，直接作为新 target。不依赖射线打 mesh。
   - **方案 B**：**点击取点 + 固定大小/半径**  
     点击射线与某平面（如地面）或与 splat 中心估计的交点作为中心，用固定或可调半径生成一个小的 worldBox。需要定义“射线 vs splat”的交互（例如用 splat 中心点做简单相交测试）。
   - **方案 C**：**屏幕矩形 + 深度**  
     框选屏幕矩形，取近远裁剪面或固定深度区间，生成一个视锥内的 3D box 作为 worldBox。实现简单，但语义是“视野内一块区域”而非“物体”。

推荐优先做 **方案 A**，与现有“高亮用 worldBox 画 box”一致，语义清晰。

## 需要改动的代码模块（概要）

1. **模型加载与类型**
   - 增加“模型类型”：如 `b3dm` / `gltf` / `obj` / `splat`（或 `ply`）。
   - 若 URL 或选择为 `.ply` / `.splat`：走 **GaussianSplats3D** 加载与渲染，**不**调用 `extractMeshesFromObject`、不往 `state.meshes` 塞 mesh。

2. **渲染循环**
   - 每帧在 Splat 模式下调用 GaussianSplats3D 的渲染/更新；现有 3D Tiles 的 `tilesRenderer.update()` 仅在 b3dm 时执行。

3. **选择与创建标注**
   - **Splat 模式**：
     - 关闭或隐藏“物体/面”选择模式（或保留 UI 但点击/框选不写 meshId/faceIndices）。
     - 实现 3D 框选（或上述 B/C 之一）生成 `worldBox`。
     - `addAnnotation()` 在 Splat 模式下只添加 `targets: [{ worldBox }]`（无 meshId/faceIndices）。
   - **现有 mesh 模式**：逻辑不变。

4. **辅助逻辑**
   - `computeWorldBoxFromSelection` / `computeWorldBoxForTarget`：在 Splat 模式下不依赖 `state.meshes`，改为从“当前 3D 框选结果”或“当前点击/框选得到的 worldBox”读取。
   - `getActiveMeshes()`：Splat 模式下返回空或仅用于非 Splat 的 overlay；高亮与列表仍基于 `state.annotations` 的 worldBox。
   - `ensureWorldBoxesForAnnotation`：对“仅 worldBox”的 target 已是 no-op（已有 worldBox 则 return），无需改。

5. **后端**
   - 无需改 schema；`targets` 已支持只含 `worldBox` 的项。

## 小结

| 问题                     | 结论 |
|--------------------------|------|
| 是否支持 GS/PLY 渲染？   | ✅ 支持，用 GaussianSplats3D 等库在 Three 里渲染 PLY。 |
| 是否要改标注逻辑？       | ✅ 要改：Splat 下不能按 mesh/面选择，需改为“按 3D 区域（worldBox）”创建标注。 |
| 存储与展示是否兼容？     | ✅ 兼容：现有 worldBox 优先的展示与 API 已支持“仅 worldBox”的 target。 |
| 工作量预估               | 渲染集成：小～中；3D 框选/交互与模式分支：中。 |

建议步骤：  
1）先接 GaussianSplats3D，实现 PLY 加载与渲染（与 b3dm 二选一或切换）；  
2）在 Splat 模式下禁用 mesh/面选择，并实现“3D 框选 → worldBox → 仅 worldBox 的 target”；  
3）复用现有高亮、列表、API 与持久化。
