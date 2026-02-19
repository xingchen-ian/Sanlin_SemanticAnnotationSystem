# 仅 WorldBox 方案：需要做的修改清单

采用「仅用 WorldBox、不选模型/面」时，现有编辑流程需要做如下修改。分两类：**取消对模型/面的选择**、**改为直接创建 WorldBox**，以及由此带动的其它改动。

**本方案还需整合的扩展能力：**
- **文本描述**：新建 WorldBox 时支持输入一段文字（500 字以内）描述该 box 包含的模型结构；需在表单与数据/后端中支持。
- **WorldBox 编辑（新建与二次编辑一致）**：  
  - 整体：box 可通过 **Gizmo 移动、旋转**。  
  - 顶点：box 的**顶点可选择**，选中后通过 **Gizmo 拖拽**该顶点以调整形状。  
  已建好的 WorldBox 支持**二次编辑**，即同样支持整体移动/旋转与顶点选择+拖拽。细节见**第四节**。

---

## 一、取消对模型的选择（含物体与面）

目标：**不再通过点击/框选场景中的 mesh 或面来产生“当前选择”**。

### 1.1 交互与入口

| 位置 | 当前行为 | 修改方式 |
|------|----------|----------|
| **选择模式 UI** | 「物体」「面」两个按钮，切换后点击/框选作用于 mesh | **隐藏或移除**「选择模式」整块（物体/面切换 + 高精度选择）。或保留 UI 但在「WorldBox 模式」下禁用，点击/框选不参与“选择模型”。 |
| **画布点击** | `onPointerClick` → `performClickSelect`，射线打 mesh，写入 `selectedTargets` | 在 WorldBox 模式下：**不调用** `performClickSelect`，或让 `performClickSelect` 直接 return（不 raycast mesh）。 |
| **画布框选** | `onPointerDown` + `onPointerUp` 内 Alt+拖拽 → `performBoxSelect`，按 mesh/面写入 `selectedTargets` | 在 WorldBox 模式下：**不进入框选逻辑**（或 Alt+拖拽改为“在场景中绘制 3D 框”的起点，见下文）。 |

### 1.2 选择相关状态与逻辑

| 位置 | 当前行为 | 修改方式 |
|------|----------|----------|
| **state.selectedTargets** | `Map<meshId, null \| number[]>`，表示当前选中的 mesh/面 | WorldBox 模式下可**不再使用**该 Map 表示“待创建标注的选区”；或仅用于“当前正在编辑的 box”（见后文编辑方案）。若完全不用，则相关 UI 不再依赖“已选 N 个物体/面”。 |
| **performClickSelect** | Raycaster 打 `getActiveMeshes()`，按 meshId/faceIndex 写入 selectedTargets | WorldBox 模式下**不执行** raycast 到 mesh，或改为：射线只用于“点选已有标注 box”“放置新 box 的起点”等，不写入 mesh/面选择。 |
| **performBoxSelect** | 遍历 getActiveMeshes()，按物体或面写入 selectedTargets | WorldBox 模式下**不执行**；或改为“屏幕框选 + 深度”生成一个 3D box（见下文“直接创建 WorldBox”）。 |
| **getActiveMeshes()** | 供点击/框选使用 | WorldBox 模式下创建新标注时**不再依赖**；高亮等仍可能用（若还有“按 mesh 高亮”的需求可再收窄）。 |

### 1.3 高亮与提示

| 位置 | 当前行为 | 修改方式 |
|------|----------|----------|
| **updateHighlight()** | 用 `computeWorldBoxFromSelection()` 为**当前选区**画一个半透明 box | WorldBox 模式下没有“当前选区”时，**不再画“未保存选区”的 box**；或改为：仅在“正在绘制新 box”时临时画一个预览 box。 |
| **getSelectedTargetsSummary()** | 统计 selectedTargets 的物体数/面数 | WorldBox 模式下创建标注不依赖选择时，**不再显示**“已选 N 个物体/面”，或改为“正在绘制 box”等提示。 |
| **updateSelectionUI()** | 有 selectedTargets 时显示“已选 …”、显示标注表单 | 改为：**不依赖 selectedTargets** 显示“新建标注”入口；例如改为常显“新建标注”按钮，点击后进入“绘制 box”流程，或先放置再调大小。 |
| **hint 文案** | “物体模式：左键选择 · …”“面模式：…” | 改为与当前模式一致，例如“左键拖拽绘制标注框 · 点击已有框可编辑”等。 |

---

## 二、不通过选择面创建 WorldBox，改为直接创建 WorldBox

目标：**新建标注时不再从 `selectedTargets` + `computeWorldBoxFromSelection()` 得到 worldBox**，而是通过“直接绘制/放置一个 3D 框”得到 worldBox。

### 2.1 创建标注的入口与数据流

| 位置 | 当前行为 | 修改方式 |
|------|----------|----------|
| **addAnnotation()** | `if (state.selectedTargets.size === 0) return`；用 `computeWorldBoxFromSelection()` 和 `selectedTargets` 得到 worldBox 和 meshId/faceIndices，写入 target | **不再依赖 selectedTargets**。改为：从“当前正在绘制的 box”或“刚放置的 box”取得 worldBox；target 只写 `{ worldBox }`，**不写 meshId / faceIndices**（或写 null/省略）。 |
| **addToAnnotation()** | 同上，从 selectedTargets + computeWorldBoxFromSelection 得到一个新 target，追加到已有标注 | 同上，新 target 只含 **worldBox**，来源为“当前绘制的 box”。 |
| **mergeTargetsIntoAnnotation()** | 按 meshId/faceIndices 合并，再对每个 target 用 computeWorldBoxForTarget 算 worldBox | WorldBox 模式下若只存在“仅 worldBox”的 target，可**不再使用**该函数，或改为“按 worldBox 列表合并”（若仍有“合并多个 box 为一个标注”的需求）。 |

### 2.2 直接创建 WorldBox 的交互（需新增）

- **方式 A（推荐）**：在场景中**拖拽绘制一个 3D 包围盒**（例如第一次点击定起点，拖拽定对角，或两次点击定 min/max）。
- **方式 B**：点击一次在射线与某平面交点放置“默认大小”的 box，再通过**编辑 box（面/边/点 + Gizmo）**调大小与位置。
- **方式 C**：屏幕矩形框选 + 固定/可选深度，生成一个 3D box。

无论哪种，都需要：
- 一段**新逻辑**：根据交互得到 `{ min, max }`（世界坐标），并规范成 worldBox 格式（例如 `worldBox: { min: [x,y,z], max: [x,y,z] }`）；
- 在**确认**时调用现有 `addAnnotation()` 的“后半段”：用 label/category/color 和这一个（或一组）worldBox 生成 `targets: [{ worldBox }]`，push 到 annotations，刷新列表和高亮。

### 2.3 新建 WorldBox 时的扩展功能

在现有 label / category / color 之外，新建每个 WorldBox（或每条标注/每个 target）需增加：

| 功能 | 说明 | 实现要点 |
|------|------|----------|
| **文本描述** | 支持输入一段文字（**500 字以内**）描述该 box 所包含的模型结构 | **描述加在子标注（target）上**，即每个 target 有独立字段 `description`。新建时表单中的「描述」写入当前创建的这一个 target；编辑时在子标注列表中每个子标注有独立的描述输入框。数据存在 `targets[i].description`（JSONB 内），无需 annotations 表单独列。 |

新建阶段对 box 的编辑（与下文「二次编辑」能力一致）：
- **整体 Gizmo**：支持对当前正在绘制的 box 做**移动（Translate）**、**旋转（Rotate）**，确认后再写入 worldBox。
- **顶点编辑**：box 的**顶点可选择**，选中后通过 **Gizmo 拖拽**该顶点，实时更新 box 范围（若仍为 AABB 则更新 min/max 的对应分量；若支持旋转则见下文数据格式）。

### 2.4 依赖“选择”的 UI 显示

| 位置 | 当前行为 | 修改方式 |
|------|----------|----------|
| **#annotation-form 显示条件** | `updateSelectionUI()` 里：有 `getSelectedTargetsSummary()` 才显示表单和“新建标注” | 改为：**不依赖“已选物体/面”**即可显示表单；例如进入“标注模式”就显示，或点击“新建标注”后显示“请绘制框”+ 绘制中的预览。 |
| **#selection-info** | 显示“未选择”或“已选 N 个物体/面” | 改为：显示“未选择”或“正在绘制框”“已选中的标注 box”等，与是否选中 mesh 解耦。 |
| **「添加到已有标注」** | 依赖当前 selectedTargets，再选一个已有标注，把当前选区作为新 target 加入 | 改为：当前“正在绘制的 box”或“当前选中的已有 box”作为新 target 加入所选标注，数据格式为仅 worldBox。 |

---

## 三、其它受影响逻辑（与“仅 WorldBox”一致）

这些在**保留 mesh 模式**的同时增加 WorldBox 模式时，需要做**分支**（按模式走不同逻辑）；若**完全切到仅 WorldBox**，可改为只保留 worldBox 分支。

### 3.1 标注列表点击“聚焦”到选区

| 位置 | 当前行为 | 修改方式 |
|------|----------|----------|
| **handleFocus（标注项点击）** | 把该标注的 targets 写回 `state.selectedTargets`（meshId + faceIndices），用于高亮和“当前选择” | 若 target 只有 worldBox、没有 meshId：**不能** set meshId/faceIndices。应改为：仅记录“当前聚焦的 annotation + targetIndex”，高亮只根据 **worldBox** 绘制（现有 updateHighlight 已支持）；不再往 selectedTargets 写 mesh 信息。 |

### 3.2 编辑已有标注时“加载”其 target 为选区

| 位置 | 当前行为 | 修改方式 |
|------|----------|----------|
| **编辑按钮 / 进入编辑** | 可能把该 annot 的 targets 填入 selectedTargets，用于显示“当前在编辑哪些面” | 仅 WorldBox 时：不填 selectedTargets；改为“正在编辑的 annot + targetIndex”，在场景中**选中对应 box**，进入 WorldBox 编辑（见下文「四、WorldBox 编辑能力」）。 |

### 3.3 仅 worldBox 的 target 的兼容

| 位置 | 当前行为 | 修改方式 |
|------|----------|----------|
| **ensureWorldBoxesForAnnotation(annot)** | 对没有 worldBox 的 target 用 `computeWorldBoxForTarget(meshId, faceIndices)` 补全 | 若 target **没有 meshId**（仅 worldBox）：**已有** `if (t.worldBox) return`，不会误调 computeWorldBoxForTarget；无需改。 |
| **getAnnotationAnchorPoints(annot)** | 优先用 t.worldBox 中心，否则用 mesh + faceIndices | 仅 worldBox 的 target 会走第一个分支，**无需改**。 |
| **computeWorldBoxForTarget(meshId, faceIndices)** | 依赖 state.meshes 和 mesh.geometry | 仅 WorldBox 模式下创建/编辑不再调用（或只对“混合模式”里带 meshId 的 target 调用），**无需改实现**，只需不在纯 worldBox 流程里调用。 |

### 3.4 展示与导出

| 位置 | 当前行为 | 修改方式 |
|------|----------|----------|
| **targetsSummary(targets)** | 统计“N 物体、M 面” | 仅 worldBox 时可为“N 个框”或“N 个区域”，避免依赖 faceIndices。 |
| **导出 / API** | targets 已支持只含 worldBox | 无需改 schema；确保前端写入的 target 为 `{ worldBox }` 或 `{ worldBox, meshId: null }` 等一致格式即可。 |

---

## 四、WorldBox 编辑能力（新建与二次编辑）

**新建**时绘制的 box 与**已建好**的 WorldBox 均需支持同一套编辑能力，便于在创建阶段微调、以及对已有标注做二次编辑。

### 4.1 整体变换（Gizmo）

| 能力 | 说明 | 实现要点 |
|------|------|----------|
| **移动** | 整个 box 沿任意方向平移 | 使用 Three.js **TransformControls** 的 **translate** 模式，约束到当前 box 的 Group；拖拽结束后将位移应用到 worldBox 的 min/max（各点同位移）。若后续支持旋转，则需先对 box 做旋转变换再取 AABB 或存为定向 box。 |
| **旋转** | 整个 box 绕中心或某轴旋转 | 使用 TransformControls 的 **rotate** 模式。注意：当前 target 若仅存 `worldBox: { min, max }`（AABB），旋转后需决定存储方式：（1）**仍存 AABB**：旋转后取 8 顶点外包的新的 min/max；（2）**存定向 box**：增加 `orientation`（如四元数）和 half-extents，渲染与 Gizmo 按定向 box 计算。产品上若需保留“旋转后仍是斜 box”，需扩展 target 数据结构。 |

### 4.2 顶点选择与拖拽（Gizmo）

| 能力 | 说明 | 实现要点 |
|------|------|----------|
| **顶点可选** | 用户可点击选中 box 的 8 个顶点之一 | 在 box 的 8 个角点处放置可射线检测的小物体（如小球或不可见 proxy），或射线打 box 后根据交点与各顶点距离判定最近顶点；选中后高亮该顶点并进入“顶点拖拽”状态。 |
| **顶点拖拽** | 选中顶点后通过 Gizmo 拖拽该顶点，实时更新 box 形状 | 使用 **Translate Gizmo** 绑定到该顶点；拖拽时只更新该顶点对应的 min/max 分量（AABB 下每个顶点对应 min 或 max 在 x/y/z 上的组合）。拖拽结束写回 `worldBox: { min, max }`，并刷新 box 显示。若为定向 box，则更新对应顶点坐标并可能重算 AABB 或存储 8 顶点。 |

### 4.3 新建与二次编辑的统一

- **新建阶段**：用户绘制或放置一个 box 后，在点击「确认」之前，即可对该预览 box 做**整体移动/旋转**和**顶点选择+拖拽**；确认后写入 `targets: [{ worldBox, … }]` 并加入标注。
- **二次编辑**：在标注列表中选中某条标注（或某个 target），进入编辑；在场景中**选中对应 box** 后，同样提供**整体移动/旋转**与**顶点选择+拖拽**，修改结果写回该 target 的 worldBox（及若有的 orientation），并持久化到后端。

### 4.4 数据与后端

- 顶点编辑与整体移动仅改变 **worldBox**（及可选的 orientation），不新增字段；**旋转**若采用定向 box，需在 target 或 schema 中增加朝向信息。
- **文本描述**（500 字以内）若按 target 存，可在 target 对象中增加 `description`；若按标注存，在 annotations 表增加 `description` 字段并在 API 中透传。

---

## 五、修改汇总表（按文件/模块）

| 模块 | 修改要点 |
|------|----------|
| **状态** | WorldBox 模式下可不再用 selectedTargets 表示“待创建选区”；增加 `state.drawingBox` / `state.editingBoxTarget` 等；若支持旋转可增加 orientation。 |
| **选择** | performClickSelect、performBoxSelect 在 WorldBox 模式下不向 selectedTargets 写入 mesh/面；点击用于“选已有 box”“选 box 顶点”或“开始绘制”。 |
| **创建标注** | addAnnotation / addToAnnotation 只从“当前绘制的 box”取 worldBox，target 只写 worldBox；支持**文本描述**（500 字以内），需后端/字段支持。 |
| **UI** | 隐藏/禁用“物体/面”选择模式；增加「描述」输入框（500 字限制）；selection-info 与表单显示不再依赖“已选物体/面”；hint 与 targetsSummary 适配“仅框”。 |
| **高亮** | 未保存的“选区”box 仅在“正在绘制”时显示；已有标注的高亮继续用 worldBox；编辑时可选高亮顶点/边。 |
| **列表聚焦/编辑** | 点击标注项不写 meshId/faceIndices；**二次编辑**：选场景中的 box 后提供 Gizmo **移动、旋转**，以及**顶点选择 + Gizmo 拖拽**，写回 worldBox。 |
| **新增** | 直接创建 WorldBox 的交互；新建时即可对 box **移动、旋转**与**顶点选择+拖拽**；已建 WorldBox 支持同套编辑（见第四节）。 |

---

## 六、建议实施顺序

1. **先收口“创建”**：实现“直接绘制/放置一个 box”得到 worldBox，并让 addAnnotation 只接受 worldBox（不依赖 selectedTargets）；表单中增加**文本描述**输入（500 字以内），后端/数据库增加 description 字段并参与 API。
2. **再关掉模型选择**：在 WorldBox 模式下禁用 performClickSelect/performBoxSelect 对 mesh 的写入，并调整 UI（选择模式、selection-info、hint）。
3. **WorldBox 编辑（新建阶段）**：在确认新建之前，对当前绘制的 box 支持 **Gizmo 移动、旋转**，以及 **顶点可选择 + Gizmo 拖拽**；确认时把最终 worldBox 写入 target。
4. **二次编辑**：已建好的 WorldBox 支持同套编辑——在场景中选中 box 后，提供 Gizmo **移动、旋转**与**顶点选择 + 拖拽**，结果写回该 target 的 worldBox 并持久化；列表/编辑入口与“选中 box”联动。

若需支持旋转且保留斜 box 形状，再在 target 或 schema 中增加朝向（如 orientation）；否则旋转后可取外包 AABB 仅存 min/max。

这样在保留现有“mesh + face”逻辑的前提下，可增加完整的“仅 WorldBox”流程（含描述与编辑）；若日后完全移除 mesh 标注，再删除或折叠上述“当前行为”分支即可。
