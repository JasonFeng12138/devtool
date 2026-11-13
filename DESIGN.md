# DESIGN

DevTool 的架构、各工具的实现细节与共享库接口。必须遵守的约束见 [AGENTS.md](AGENTS.md)，功能介绍见 [README.md](README.md)。

## 架构

### 工具模块

每个工具是 `public/js/tools/` 下的一个 ES 模块，默认导出：

```js
export default {
  id: 'video-frames',        // 用作 URL hash（#video-frames）与导航 data-id
  name: '视频抽帧',           // 侧栏名称 + 页面标题
  description: '…',          // 标题栏下方的简短用途
  icon: '<svg …>',           // 24×24 线性图标，stroke="currentColor"
  mount(root) {              // 渲染到 root，返回清理函数
    root.innerHTML = TEMPLATE;
    const $ = collectRefs(root);   // 模板中 data-ref="xxx" → $.xxx
    // …
    return () => { /* 移除全局监听、取消异步任务、revoke object URL、释放 ImageBitmap */ };
  },
};
```

`app.js` 负责：切换工具时先调用上一个工具的清理函数，再清空 `#tool-root`、设置标题与简短用途，然后 `mount` 并将正文滚动到顶部；当前导航设置 `aria-current="page"`。`tools` 数组顺序即侧栏顺序，第一个是默认工具。工具不渲染自己的页面标题，页面只有 `index.html` 里那一个标题栏。

### 应用外壳

- **主题**：`<html data-theme="light|dark">`，存储于 `localStorage['devtool-theme']`，首次跟随系统。`<head>` 内联脚本在首帧前设置主题与侧栏模式。
- **侧栏**：`<html data-sidebar="pinned|collapsed">`，存储于 `localStorage['devtool-sidebar']`，默认 `pinned`。
  - `pinned`：固定展开，正文让出完整宽度。
  - `collapsed`：收起为图标栏；鼠标移入 120ms 后由 JS 给 `.sidebar` 加 `.is-peek`，侧栏悬浮展开、不挤压正文。键盘聚焦（`:focus-visible`）也会展开。
  - 点击「收起侧栏」时鼠标仍在侧栏上，用 `suppressPeek` 阻止立刻重新展开，需移出后再移入。
  - 宽度 ≤760px 时侧栏变为顶部悬浮导航条，不显示固定按钮。
- **布局**：`.main` 是唯一的滚动容器，`.titlebar` 在其中 `position: sticky`，所以标题栏和正文共享同一宽度、同一个居中容器 `.container`。
  - 正文容器命名为 `workspace`，使用容器查询：可用宽度 ≤860px 时预览与设置改为上下排列，输出表单改为两列；≤520px 时输出表单改为单列、工具栏字段铺满一行，保存按钮纵向排列。布局跟随正文实际宽度变化，侧栏展开、收起时均适用。
  - 预览与设置统一使用 `.tool-split`；宽屏设置区宽度为 `--settings-w`（300px），与预览顶部对齐，普通预览可随设置区拉高。智能切图的交互画布保持独立高度，避免选中框的属性区显隐时改变画布尺寸。设置区用浅背景分组，同级面板的标题和分隔线保持一致。

### 服务器

`server.js` 只托管 `public/`，每次请求都从磁盘读取文件并返回 `Cache-Control: no-cache`。所有响应带 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp`（跨源隔离，AI 补帧的 WASM 后端才能多线程）。`.mjs` 返回 `text/javascript`、`.wasm` 返回 `application/wasm`（模块脚本要求正确的 MIME）。

### 样式

`style.css` 分节：设计令牌 → 基础 → 侧栏 → 主区域 → 通用组件 → 工具通用 → 视频抽帧 → 图片批处理 → 智能切图 → 屏幕占比预览 → 像素规整 → 可缩放视图 → 响应式。

可复用的类：

- 通用组件：`.panel`、`.panel-header`、`.section-title`、`.badge`/`.badge-success`、`.btn`/`.btn-primary`、`.icon-btn`、`.segmented`、`.field`/`.field-row`、`.plan`/`.plan-note`、`.stage`、`.dropzone`、`.dims`、`.tiles`/`.tile`、`.actions`/`.actions-stack`。
- 「工具通用」分节：`.tool-split`（左预览右控件）、`.controls`/`.control-group`（设置区与参数分组）、`.zoom-stage`、`.stage-canvas`、`.checker`、`.check`、`.field-label`、取色相关的 `.color-list`/`.color-chip`/`.swatch`/`.picker-row`/`.color-input`/`.pick-hover`、`.tiles-scroll`、`.tile-actions`/`.tile-action`、`.tool-toolbar`（独立编辑操作栏）、`.inline-field`（操作栏里的“标签 + 下拉框”）、`.box-fields`（X / Y / 宽 / 高一组小号数字输入）、`.export-grid`/`.export-actions`（输出选项网格与右对齐按钮）、`.interp-bar`（帧列表上方的补帧操作条）。
- 状态色：`.plan b.is-warning` / `.is-error`、`.plan-note.is-warning` 等。
- 「可缩放视图」分节：灯箱 `.lightbox*`、`.lightbox-name`，预览区左右切换 `.stage-nav`，说明标签 `.stage-caption`。
- 工具专属前缀：视频抽帧 `vf-`，图片批处理 `ib-`，智能切图 `ss-`，屏幕占比预览 `sp-`，像素规整 `pc-`。

### 视觉规范

具体数值（全部来自 `style.css` 顶部的 CSS 变量）：

- **亮暗两套令牌**：`:root` / `[data-theme="light"]` 与 `[data-theme="dark"]` 定义同名变量。
- **圆角三档**：面板 `--radius-panel` 14px、条目 `--radius-item` 10px、控件 `--radius-control` 8px。
- **间距尺度**：`--space-1..5` = 4 / 8 / 12 / 16 / 24；组间距（24）大于组内距（4~8）。
- **字号层级**：页面标题 23 > 对话框标题 18 > 区块标题 16 > 正文 14 > 说明 13 > 徽标 12（`--fs-page` … `--fs-badge`）；侧栏导航文字 15。
- **控件高度**：标准 `--h-control` 40px，小号 `--h-control-sm` 32px。表单默认标准档；面板标题栏、编辑栏、补帧栏、对话框标题栏、悬浮播放器和坐标输入组通过 `--control-height` / `--control-font-size` 使用小号档。同一区域的按钮、下拉框、输入框和分段控件同高、同字号；图标按钮为正方形。
- **信息层级**：页面用途只保留一句短文案，快捷键与操作方法放入对应控件的 `title`；初始空态不重复显示“请先上传”。`.plan` 使用普通段落排版，数字以行内 `b` 强调，必要提醒通过 `.plan-note` 单独成行，避免 Flex 将一句摘要拆成多行。屏幕像素基准、裁切边界、尚未应用的去背景参数等影响数据含义或输出的提醒仍保留。
- **上传与预览**：上传空态使用浅色虚线区域与共享 `ui.js` 的 `ICON_UPLOAD`，文件输入保留键盘聚焦，聚焦时显示外框。导入后切换为深色预览背景。预览高度由 `--stage-min` / `--stage-height` / `--stage-max`（360px / 56vh / 640px）控制；宽屏时可随右侧设置区拉高。屏幕设备选择框在宽屏占三列，避免长设备名挤压分辨率输入。
- **颜色**：语义变量 `--primary`、`--success`、`--warning`、`--error`、`--text-secondary` 等，图表色 `--chart-1..4`。状态色阈值：≥80% 警告色，≥90% 错误色。
- **毛玻璃**：侧栏、移动端导航、对话框、抽屉、下拉菜单、toast 用 `.glass`（半透明 + `backdrop-filter` 模糊与饱和度 + 1px 高光边框 + 柔和阴影），不支持时退回实色。页面底部有两团渐变光晕 `.glow`。
- **侧栏**：悬浮，距屏幕边缘 12px，圆角 14px；品牌区和底部操作区固定，只有中间导航滚动；图标 14px、文字 15px、图文间距 12px，每行高度 ≥44px。
- **滚动条**：滚动区域加 `.scroll-area`，平时透明，悬停时淡入细滚动条；侧栏与移动端导航完全隐藏滚动条。

## 工具实现

### 矢量图（SVG）支持

只支持 SVG。`createImageBitmap` 不能直接解码 SVG，所以统一用 `lib/vector.js`：

- `readSvg(file)` 解析固有尺寸：优先取 width / height 的绝对单位（px、pt、mm 等）；缺失或为百分比时用 viewBox 推算；都没有时用 300×150。
- `resolveScale(choice, info)` 计算渲染倍数：「自动」把长边放大到约 1024px（最多 8×）；长边始终不超过 8192px。下拉选项是 `SVG_SCALE_OPTIONS`。
- `rasterizeSvg(info, scale, name)` 经 `<img>` 渲染为 PNG 文件。含 foreignObject 等会污染画布的 SVG 会给出明确错误。
- `cropSvg(info, scale, rect, frame?)` 生成保留矢量的切片：外层新 SVG 用 viewBox 只显示裁切区域，内层嵌套完整原图（所以每个切片文件都包含全部矢量内容）；输出宽高与对应 PNG 相同。

各工具的接入方式：

- **图片切分 / 智能切图**：SVG 先按「矢量图渲染倍数」渲染为位图，用于显示、切割 / 识别，切块尺寸和框坐标都按渲染后的像素计算。输出格式多一个「SVG（保留矢量）」，只在原图是 SVG 时可选；选它时从原始矢量内容裁切，「背景透明」不适用。智能切图改变倍数时，已有的框按比例换算后保留，撤销历史清空。
- **图片批处理**：导入时按面板标题栏的「SVG 渲染」倍数转为 PNG（`item.vector` 记录倍数，卡片显示 `SVG n×`），之后与普通位图一样处理，输出为 PNG。智能切图发送过来的 SVG 切片也走这条路。

### 图片切分（image-slicer.js）

- 上传 / 拖拽 / Ctrl+V 粘贴图片，显示原图宽高像素。
- 输入每块宽高后，在图片上叠加 canvas 绘制白色虚线网格（下面垫一层半透明深色实线，保证浅色图片上也看得清），块足够大时标注序号。
- 从左上到右下按行切分，最右列 / 最底行不足时按剩余像素切出；输出格式 PNG / JPEG（透明区域填白）/ WebP。
- 结果网格可勾选、全选 / 全不选 / 反选；文件名 `{原名}_{序号}_r{行}c{列}.{ext}`，序号补零以保证排序。

### 智能切图（smart-slicer.js）

一张图里有多个大小不一的素材时，自动识别并框选裁切。

- **识别流程**（`lib/sprite-detect.js` 的 `detectSprites`，在 `workers/sprite-detect.js` 模块 Worker 中运行；Worker 创建或加载失败时自动退回主线程）：
  1. 背景：`auto` 采样最外一圈像素，多数透明则为透明背景，否则取出现最多的颜色；`alpha` 透明像素为背景；`color` 使用吸管指定的颜色。alpha ≤ 16 的像素始终是背景。
  2. 前景掩码：与背景色距离 > 容差的像素为前景。
  3. 8 连通找块；块数超过 5 万时返回 `error: 'too-many'`（通常是背景判断错了）。
  4. 合并直线距离 ≤ 合并距离的框（两框最近边之间的欧氏距离，重叠、包含为 0），用网格加速，反复直到稳定。
  5. 宽高**都**小于最小尺寸的框作为噪点丢弃；按外扩值扩边（不超出图片）。
  6. `sortReading` 阅读顺序：与某行纵向重叠达到较矮者高度一半的框归入该行，行从上到下、行内从左到右。
- **参数变化自动重新识别**（250ms 防抖）。但识别后只要手动改过框（`state.edited`），新结果就不会覆盖框，只更新掩码，并提示点「重新识别」应用（`forceApply`，可撤销）。
- **框的数据**：`state.boxes = [{ id, x, y, w, h }]`（原图像素，整数），每次提交修改后都按阅读顺序重排，序号始终是阅读顺序。画布选中（编辑用）是 `state.selected`，输出勾选是 `state.unchecked`（不输出的 id），两者互相独立。
- **编辑**：
  - 选择模式：点选、Shift 点选多选、Shift 拖拽空白处框选；拖动框移动，拖动 8 个手柄缩放；方向键微调 1px（Shift 10px），连续微调合并为一步撤销。
  - 点选以 `pointerdown` 命中的框为准；处理点选、Shift 切换或编辑手势后，吞掉紧随的 `click`，不再按可能已重排的坐标判断空白并取消选中。下一次主按钮按下时重置抑制标记，避免上一次手势没有产生 click 时误吞新点击或取色。真正点击空白处仍会取消选中，平移后的 click 继续由 `zoom.js` 拦截。
  - 画框模式：拖拽新建。
  - 合并 M、贴合 F（`tightBox` 收紧到框内掩码前景）、删除 Delete；右侧 X / Y / 宽 / 高可精确输入。
  - 合并按钮引用为 `mergeSelected`，合并距离滑杆引用为 `merge`，两者独立绑定事件与禁用状态。
  - 撤销 / 重做 Ctrl+Z / Ctrl+Y：快照式，最多 100 步。
  - 平移交给 `zoom.js` 的情况由 `shouldPan` 决定：中键、空格按住、取色中，或选择模式下按在空白处且未按 Shift；其余按下由本工具处理。拖拽结束后用 `suppressClick` 吞掉随后的 click。
- **叠加层**：`.ss-wrap`（画布 + SVG）整体作为 `zoom.js` 的缩放目标。SVG 的 viewBox 用原图像素坐标，线条用 `vector-effect: non-scaling-stroke` 保持 1 屏幕像素；手柄、序号字号按 `zoom.getScale()` 反算，缩放变化时通过 `onChange` 重绘。
- **结果卡片**：缩略图直接从源画布 `drawImage`，按 `位置尺寸|透明参数` 缓存，只重绘变化的卡片。悬停卡片高亮画布中的框；单击画布中的框会在结果网格内滚动到对应卡片并闪烁（只滚网格，不滚页面）；卡片「定位」用 `zoom.showRect` 把框移到画布中央。
- **输出**：PNG / WebP；背景透明（用识别得到的背景色和容差，加单独的羽化；透明背景图无需处理）；统一尺寸（取勾选素材的最大宽高，居中或底部居中）；可附带 `{原名}_sprites.json`（`image`、`width`、`height`、`frameSize`、`sprites[{ name, x, y, w, h, offsetX?, offsetY? }]`）。文件名 `{原名}_{序号}_{宽}x{高}.{ext}`，序号按勾选素材在阅读顺序中的位置。
- **发送到图片批处理**：生成勾选素材的图片后调用 `handoff('image-batch', files)`，切换到图片批处理并自动导入。

### 视频抽帧（video-frames.js）

四个面板依次出现：

1. **上传并抽帧**：读取分辨率、时长（对 MediaRecorder 产出的 `duration = Infinity` 的 WebM，会先跳到末尾让浏览器算出真实时长）；用 `requestVideoFrameCallback` 播放约 16 帧估算原始帧率并吸附到常见帧率。抽帧方式是逐帧 `seek` 到每个采样区间的**中点**后 `drawImage`，避免落在帧边界取到前一帧。可设起止时间、抽帧帧率、输出尺寸（可锁定宽高比，上限 8192）。超过 600 帧会二次确认，抽帧过程中可停止。
   - **GIF**：`<video>` 不能播放 GIF，改用 `lib/gif-decode.js` 解码（`state.gif`），预览区用 `<img>` 显示动图。时间轴由各帧延时累加（小于 2/100 秒按 10/100 秒，与浏览器一致）；所有帧延时相同时才显示原始帧率，否则显示「不固定」。默认勾选「抽取每一个原始帧」，取显示时段与起止时间有交集的每一帧，忽略帧率；取消勾选则与视频一样按帧率在区间中点采样（`gifFrameAt` 找该时刻显示的帧）。之后的去背景、选帧、导出流程与视频相同。
2. **去除背景**：吸管在参考帧上取色（Shift 连续取色，Esc 取消），也可以手动选色；支持多个背景色。按 RGB 欧氏距离判断：距离 ≤ 容差的像素变为全透明，容差到“容差 + 羽化”之间的像素线性降低 alpha。预览画布用 `zoom.js`，可放大到单像素。参数变化只实时重绘参考帧，点「应用到全部帧」才批量处理。
3. **选择帧**：点击切换选中，Shift 点击批量选择区间；悬停卡片可放大预览（`<dialog>` lightbox，←/→ 切帧、空格切换选中）或单独下载。
   - **补帧**：帧列表上方的 `.interp-bar`，可选补帧方式（见下方 interpolate.js，选择存于 `localStorage['devtool-interp-method']`，两个工具共用，默认「AI + 像素化修正」）。在相邻的选中帧之间插入 1~3 帧，「首尾衔接」时最后一帧和第一帧之间也补。用 `f.blob`（去背景前的原始帧）补帧，补出的帧 `generated: true`、带「补帧」标记，作为普通帧插入到前一帧之后（`insertFrames` → `reindexFrames` 重新编号），之后与其他帧一样去背景。文件名 `{前一帧名}_interp{k}.png`，时间按两帧之间线性插值。全部完成后动画帧率乘以（插入数 + 1），上限 50。「移除补帧」删除所有 `generated` 帧。补帧期间 `state.busy`，用 `state.interp.token` 取消。
4. **动画预览与导出 GIF**：只用选中帧循环播放（预览画布最大 640×480，按需解码缩小后的 `ImageBitmap`，并预取后 3 帧）；导出 GIF 时可设宽度、循环、透明或纯色填充背景，帧率上限 50fps（GIF 帧间隔最小 2/100 秒）。

实现要点：

- 每帧保存原始 PNG `blob` 与去背景后的 `procBlob`；`appliedKey` 记录处理时的参数（`颜色|容差|羽化`），与当前 `bgKey()` 不一致即为“待应用”。保存、导出前都会先 `applyBackground()`，保证输出与当前参数一致；单帧下载 / lightbox 预览走 `frameOutput()`，只处理该帧。
- 异步任务用递增 token 取消：`loadToken`、`extractToken`、`bgToken`、`refToken`、`lightbox.token`、`interp.token`。
- `state.busy`（补帧 / 保存 / 导出中）与 `state.extracting` 期间会禁用相关按钮，状态变化后统一调用 `updatePlan()` / `updateSelection()` 刷新界面。

### 图片批处理（image-batch.js）

- **导入**：多选、拖拽或粘贴，也接收其他工具（智能切图）通过 `handoff` 发送的图片；每张图片是一张独立卡片（一个 `item`），原始 `File` 直接保存为 `blob`，不重新编码。导入中再次导入会被拒绝，清空 / 卸载通过 `importToken` 取消。
- **排序**：卡片 `draggable`，用 HTML5 拖放排序，插入位置由鼠标在目标卡片左 / 右半边决定（`.drop-before` / `.drop-after` 指示条）。外部文件拖入通过 `dataTransfer.types` 是否含 `Files` 区分，追加到末尾。键盘：聚焦卡片内控件后按 Alt + ← / →。`state.items` 的数组顺序就是唯一的顺序来源，排序后统一调用 `syncOrder()`。
- **去除背景**：取色、容差、羽化与视频抽帧一致（共用 `lib/color-key.js`）。参考图按 `refId` 跟踪，排序后不会变；可用画面两侧的 `.stage-nav` 箭头、鼠标停在画面上按 ← / →、滑块，或卡片上的吸管按钮切换，画面左上角 `.stage-caption` 显示当前是第几张，参考图卡片带「取色参考」标记。切换参考图时保留取色状态和缩放位置（同尺寸时），方便从多张图里分别取色。「应用到所选图片」只处理**勾选的**且 `appliedKey` 与当前参数不一致的图片；「还原所选图片」清除处理结果。与视频抽帧不同，保存 / 导出**不会**自动应用参数，按卡片当前显示的效果输出（所见即所得），导出说明里会提示有几张尚未按当前参数处理。
- **动画预览**：页面右下角的悬浮小窗 `.ib-player`（毛玻璃），默认 `data-mode="mini"`。点放大按钮或双击画面切换为右侧抽屉 `expanded`，可以缩放平移；小窗模式下隐藏缩放条，但滚轮仍只缩放画布，不滚动主页面；Esc 缩回小窗。标题栏的隐藏按钮可把小窗收成右下角的「动画预览」按钮 `.ib-player-show`，隐藏期间 `animLoop` 不绘制也不解码；隐藏状态存于 `localStorage['devtool-image-batch-player-hidden']`，显隐统一走 `updatePlayerVisibility()`。只播放勾选的图片，按当前顺序。画布取所选图片的最大宽高（长边 ≤1024），尺寸不同的图片居中。帧率输入框在小窗内，GIF 导出也用这个帧率。正文底部有 `.ib-player-spacer` 留白，避免内容被小窗挡住。
  - 小窗和恢复按钮在 `collectRefs` 后移到 `body`，避免正文的容器查询影响 fixed 定位；工具卸载时移除这两个节点。
- **放大预览**：lightbox 可以在「去背景后 / 原图」之间切换，切换时保留缩放位置；← / → 按当前顺序切换。
- **补帧**：与视频抽帧相同的 `.interp-bar` 和补帧方式，按当前顺序在相邻的勾选图片之间补帧。尺寸不同的图片居中放到所选图片的最大宽高画布上，补出的帧取这个尺寸。用原图（`it.blob`）补帧；前后两张都已按当前参数去背景时，补出的帧也立即按同样参数去背景。补出的帧通过 `addItem(…, { generated: true, after })` 插入到前一张之后，名称 `{前一张基名}_interp{k}.png`。
- **输出命名**：`{序号}_{原名}.{ext}`，序号按勾选图片在当前顺序中的位置重新编号（至少两位）。去过背景的输出 PNG，未处理的保留原文件和原扩展名。

### 像素规整（pixel-cleanup.js）

- **输入**：多选 / 拖拽 / 粘贴 PNG、JPEG、WebP、BMP、AVIF 静态图片，也可通过 `takeHandoff('pixel-cleanup')` 接收全部图片。重复导入追加到列表，格式不支持或解码失败的文件跳过并汇总提示。导入时依次解码并生成长边不超过 128 的 PNG 缩略图，只保留原始 `File`、尺寸和缩略图 object URL；不为每张图片保留完整 RGBA。每张最长边 8192、总像素 1600 万以内，使用后的 bitmap 均关闭。
- **图片状态**：`state.items` 按导入顺序记录 `{ id, file, name, width, height, url, outputName, selected, options, result, error, processing }`；`result` 是逻辑尺寸 RGBA，`options` 是生成该结果时实际采用的参数。`currentId` 是预览图片，与导出勾选状态独立；`state.recipe` 保存当前统一设定，切换图片不覆盖。首次导入后选择第一张自动识别；之后切换时按需解码原图、显示该图缓存结果，无结果时用统一设定生成当前预览。修改右侧参数更新 recipe，先废弃并重算当前预览，再由批量按钮应用到其余图片。快速点击 / 连续箭头切换允许覆盖正在解码的请求，以最新 `loadToken` 为准。移除、清空及卸载时撤销缩略图 URL、释放结果和原图数据。
- **自动网格**：在两个方向各采样最多 128 条扫描线，以预乘 alpha 的 RGBA 差异累计边缘投影；提取高于背景能量的局部峰值，匹配 2～128 像素的共同周期与两个方向的相位。评分扣除随机命中率；评分至少 0.55 且逻辑尺寸不超过 512 才标记为可靠，单方向有足够边缘时降权。无可用周期时建议长边约 128 的逻辑分辨率，明确提示可手动修改。
- **参数**：逻辑宽高各 1～512 且不超过原图尺寸，长边预设 32 / 64 / 128 / 256 / 512，默认保持原图比例。网格步长为 `原图尺寸 / 逻辑尺寸`，内部边界加整数偏移并取整；偏移限制为 `±floor((步长 - 1) / 2)`，首尾边界固定在原图边缘，避免空格或边缘丢失。
- **重建**：每格中心 70% 区域最多采样 9×9 个点，以粗量化 RGBA 桶投票选主色簇，再选该簇距格子中心最近的原始样本。完全透明样本统一为 RGBA 0；默认保留样本 alpha，可选以 128 阈值硬边透明。逻辑图每格只有一个 RGBA 像素。
- **调色板**：默认最多 32 色，也可保留原色或最多 16 / 64 / 128 色。从重建后的可见像素提取 5 位 RGB 桶及 alpha 权重，按加权色域中位切分，选各组接近加权中心的实际样本作为颜色；按加权 RGB 距离吸附，并缓存相同颜色的映射。透明度单独保留，不抖动。可选删除八邻域全透明的孤立像素，使用修改前快照判断，默认关闭。
- **批量处理**：设置区主按钮「应用到全部图片」对所有图片建立顺序队列，不受导出复选框影响；网格区「应用到勾选图片」只处理勾选子集。统一复制启动时的逻辑宽高、偏移、颜色、硬边透明和孤立点设定，不再逐张自动识别覆盖用户参数，也不按图片尺寸偷偷缩放。非当前图片处理前才解码，完成后只缓存逻辑 RGBA，释放原图数据；当前预览原图保留。某张失败时记录原因并继续后续图片；取消会停止后续任务、丢弃进行中的结果，保留已完成和尚未开始的旧结果。
- **异步**：每个分析 / 重建任务创建模块 Worker，传入源 RGBA 的副本，保留主线程原始数据；按阶段回报按钮进度，批量按钮同时显示第几张 / 总张数。Worker 不可用时退回主线程，以 `nextTick` 分段让出执行。参数修改使用 240ms 防抖，立即废弃当前旧结果并禁用导出；递增 `token` 和 `terminate()` 取消旧任务。导入 / 切换和导出分别使用 `loadToken` / `exportToken`，每次等待后检查。批量处理时冻结图片切换与参数；导入、处理和导出均可取消。卸载停止 Worker、计时器、监听器、主题观察器并释放画布数据。
- **预览**：复用 `zoom.js`，支持原图 / 结果 / 直接拖动分界线对比，移除下方 range 控件。分界线是画布视口中的 slider 按钮，按可见图片范围定位，缩放和平移后保持可操作；pointer capture 区分分界拖拽与画布平移，按动画帧合并重绘，支持方向键、Shift 微调和 Home / End。结果按当前输出尺寸绘制，原图映射到同一画布便于比较；网格采用该图实际 options，避免缓存结果与当前 recipe 不同时误画。左右 `.stage-nav` 和键盘 ← / → 按导入顺序切图，含未勾选图片；表单输入和分界线的方向键不触发切图。
- **网格与放大**：图片网格复用 `.tile` / `.tile-thumb` / `.tile-actions`，当前预览高亮与勾选状态分离。已处理图片用逻辑结果绘制长边不超过 128 的缩略画布，未处理图片显示原图缩略图；仅结果变化时更新。点击缩略图显示对应图片，单独放大按钮、双击图片或工具栏「放大查看」打开 `.lightbox.glass`。将同一画布视口移入原生 dialog，共用分界线、箭头和缩放器；关闭后移回原占位位置，避免另建原图副本或两套视图状态。卸载关闭 dialog、释放 pointer capture、取消重绘帧并移除键盘监听。预览网格和分界线不进入导出。
- **输出**：按列表顺序导出勾选结果；所有选中图片必须已生成且尺寸有效，避免无提示漏图。统一倍数 1 / 2 / 4 / 8 / 16，单张最长边 8192、总像素 1600 万以内。逐张创建临时逻辑画布和输出画布、关闭 Canvas 平滑、编码为 PNG 后释放画布，按钮和进度卡显示编码进度。文件名经过 `baseName()` 清理，为 `{列表序号}_{当前文件名}_{输出宽}x{输出高}.png`；序号至少两位，保留列表位置，避免重名文件覆盖。统一通过 `save.js` 批量保存 / 打包；也可一次 `handoff('image-batch', files)` 发送所有选中结果。导出期间冻结图片列表、处理参数、文件名及倍数，防止保存结果与当前状态混用。

### 屏幕占比预览（screen-preview.js）

- **屏幕**：`PRESETS` 按电脑 / 平板 / 手机 / 其他分组。每项记录物理分辨率 `w × h`（电脑横屏、平板和手机竖屏）与设备像素比 `dpr`。
  - 支持横屏 / 竖屏、自定义宽高（1 ~ 8192）。
  - 「像素基准」可选物理像素，或逻辑像素（物理 ÷ dpr，自定义屏幕不适用）。
  - 屏幕设置和背景存于 `localStorage['devtool-screen-preview']`。
- **素材**：`state.items`（数组顺序就是图层顺序，从底到顶）。每个素材记录 `{ id, name, url, img, el, natW, natH, vector, x, y, w, h }`，坐标是屏幕像素。添加时按原始像素尺寸放在屏幕中央（依次错开 24px）。SVG 的原始尺寸取固有尺寸，按 4 倍渲染以便放大后清晰。删除的素材保留在 `state.pool` 中供撤销使用，清空 / 卸载时统一释放。
- **编辑**：
  - 画布模式 `state.mode`：「移动」（默认，V）只能拖动位置，不显示手柄，`hitHandle` 返回 null，宽 / 高 / 锁定比例 / 原始尺寸控件禁用；「编辑」（E）显示四角手柄可缩放，拖动素材本体仍可移动。
  - 拖动移动：素材的左 / 中 / 右（上 / 中 / 下）吸附屏幕边缘和中线，按住 Alt 关闭吸附。
  - 四角缩放：锁定宽高比时取两方向中较大的比例。
  - 方向键微调、Delete、上移 / 下移一层、原始尺寸、水平 / 垂直居中、X / Y / 宽 / 高精确输入。
  - 撤销 / 重做：快照**包含屏幕设置**，撤销「随屏幕等比缩放」时能同时恢复屏幕。
  - 平移交给 `zoom.js` 的方式与智能切图相同（`shouldPan`）。
- **切换屏幕**：「保持像素尺寸」不动素材；「随屏幕等比缩放」时，素材中心按宽、高比例分别换算，尺寸按两者中较小的比例换算。
- **叠加层**：`.sp-wrap`（屏幕背景 + 素材 `<img>` + SVG）整体作为缩放目标。SVG 用 even-odd 路径把屏幕外区域压暗，并画屏幕边框、选中框、手柄、尺寸与面积标签、吸附参考线。
- **占比**：
  - 选中素材：显示宽 / 高 / 面积占屏幕的百分比；超出屏幕时显示屏幕内可见部分的占比。
  - 整体：在长边 ≤480 的采样画布上绘制全部素材，统计 alpha > 16 的像素，得到不透明像素覆盖率（重叠只算一次）。按状态色阈值着色。
- **预览 / 导出**：按屏幕尺寸合成一张 PNG（屏幕外裁掉，背景为透明或所选颜色），在灯箱中用 `zoom.js` 查看，可导出为 `{设备名}_{宽}x{高}.png`。

## 共享库

- **color-key.js**：`removeBackground(data, { colors, tolerance, feather })` 原地修改 RGBA 数据；另有 `hexToRgb` / `rgbToHex`。视频抽帧和图片批处理共用。
- **zoom.js**：`createZoomView(viewport, target, options?)` 返回 `{ refresh, fit, showRect, getScale, destroy }`。
  - 滚轮在捕获阶段通过非 passive 监听器处理，先 `preventDefault` / `stopPropagation` 再检查画布尺寸；空画布、缩放到上限或下限时也不透传页面滚动。`.zoom-viewport` 的 `overscroll-behavior: contain` 阻止滚动链传递到父级。图片批处理的小窗与展开预览复用同一逻辑。
  - `destroy()` 移除视口、缩放条和 window 上的事件监听，并断开尺寸观察器。
  - `options.size()` 让 target 可以是任意容器（如智能切图的画布 + SVG）。`options.shouldPan(e)` 返回 false 时该次按下不平移，交给调用方处理。`options.onChange(scale)` 在缩放或平移后回调。
  - 内容尺寸不变时 `refresh()` 保留当前缩放和位置（便于逐帧对比同一处细节）。`showRect(r)` 把原图坐标中的矩形移到中央，当前缩放放不下时缩小。缩放 ≥2 倍时切换为像素化渲染。
  - 拖拽结束后会吞掉随后的那次 click，避免误触发取色；视口内的按钮（缩放条、左右切换）不会触发平移。
- **sprite-detect.js**：`detectSprites(data, w, h, opts)` 返回 `{ boxes, mask, colors, components, filtered }` 或 `{ error, mask, colors }`；另导出 `estimateBackground`、`buildMask`、`findComponents`、`mergeBoxes`、`sortReading`、`tightBox`。纯函数。
- **handoff.js**：`handoff(toolId, files)` 暂存文件并切换 hash；目标工具在 `mount` 时调用 `takeHandoff(toolId)` 取走（只存在内存，取走即清空）。目前图片批处理与像素规整会接收。
- **gif.js**：`new GifEncoder(w, h, { loop })` → `addFrame(rgba, delayCs)` → `finish()` 得到 Blob。每帧使用独立的 256 色局部调色板（中位切分量化 + LZW）；alpha < 128 视为透明，有透明像素时使用“恢复背景”处置方式。
- **gif-decode.js**：`parseGif(bytes)` 只解析结构，返回 `{ width, height, duration, frames[{ time, delay, … }] }`（秒），文件截断时保留已完整读取的帧；`createGifRenderer(gif).render(i)` 返回第 i 帧合成后的整幅 RGBA（内部缓冲区，下次 render 前有效），顺序访问只合成新增帧，往回访问从头合成；`gifFrameAt(gif, time)` 返回某时刻显示的帧序号。
- **zip.js**：`createZip([{ name, blob }], onProgress?)`，仅存储不压缩，UTF-8 文件名，每打包完一个文件回调 `onProgress(done, total)`；不支持 ZIP64（单包最多 65535 个文件、4GB）。
- **interpolate.js**：`await createInterpolator(method)` 返回 `{ backend, run(a, b, w, h, times), dispose() }`。`method` 取 `INTERP_METHODS`（下拉选项 `INTERP_METHOD_OPTIONS`）：
  - `ai-pixel` AI + 像素化修正：`detectPixelGrid` 缩回原生像素 → 最近邻放大到长边约 256 送入 RIFE → `pixelate` 吸附调色板、按方块取色缩回 → 按网格放大回原尺寸。补出的帧没有新颜色、透明度二值化、对齐像素网格。
  - `shift` 像素位移：`shiftTween`，不用模型。
  - `hold` 帧保持：复制前一帧。
  - `ai` AI 平滑：RIFE 原始输出，适合高清非像素素材。
  - `backend` 为 `webgpu` / `wasm`（AI 方式）或 `null`。AI 方式的细节：
    - 首次调用时动态 `import()` onnxruntime-web 并 `fetch` 模型（约 50MB），之后在页面内缓存；每次补帧任务创建一个补帧器，结束时 `dispose()` 释放会话。
    - 有 WebGPU 时用 `webgpu` 执行（失败自动退回），否则用 `wasm`（跨源隔离时最多 4 线程）。界面显示为 GPU / CPU。
    - 会话按尺寸创建并缓存，创建时用 `freeDimensionOverrides` 固定输入尺寸（WebGPU 下整个计算图才能都在 GPU 上运行）。
    - 模型输入 `input [1,6,H,W]`（两帧的平面 RGB，0~1）与标量 `timestep`，输出 `output [1,3,H,W]`。
    - 两帧完全相同时直接复制（保持停顿帧的节奏）。有透明像素时：颜色按预乘 alpha 补帧，alpha 作为灰度图再补一次（推理次数翻倍），最后还原为非预乘颜色；全不透明时只推理一次。
- **pixel-tween.js**：像素风补帧的纯函数，原则是不产生源帧没有的颜色、只按整像素移动。
  - `detectPixelGrid(frames, w, h)`：所有颜色边界都落在同一网格上时返回 `{ k, ox, oy }`（放大倍数 2~16 与网格起点），否则 `k = 1`；`toNative` / `fromNative` 按网格缩小 / 放大，对源帧无损。`scaleUp(n, s)` 最近邻放大。
  - `pixelate(out, w, h, s, sources)`：透明度二值化（源帧有半透明时以最小透明度的一半为界），颜色吸附到源帧调色板（超过 4096 色视为非像素画，不吸附），每个 s×s 方块取出现最多的颜色；源帧没有孤立像素时去掉孤立像素。
  - `shiftTween(a, b, w, h, times)`：用 sprite-detect 的掩码和连通块找物体（相距 ≤2px 合并），在整个画面内（最多 ±64 原生像素）找每个物体到另一帧的整像素位移；t < 0.5 用前一帧造型、否则用后一帧造型，物体按 `round(位移 × 进度)` 移动，平均差异过大时视为没有对应物体、不移动。
- **pixel-cleanup.js**：`await analyzeGrid(rgba, w, h, hooks?)` 返回 `{ cols, rows, offsetX, offsetY, confidence, reliable }`；`await cleanupPixels(rgba, w, h, { cols, rows, offsetX?, offsetY?, colors?, hardAlpha?, removeNoise? }, hooks?)` 返回 `{ data, width, height, colorCount }`。`colors = 0` 保留代表色；`hooks` 可提供 `progress(done, total, title)`、`yield()` 与 `check()`；分段等待后调用 `check()` 支持取消。`gridBoundary(index, count, size, offset?)` 供处理和网格预览共用。
  - `await processPixelBatch(items, process, hooks?)` 顺序调用异步的 `process(item, index)`，返回 `{ completed, failed }`。`hooks` 支持 `onStart(item, index, total)`、`onResult(item, result)`、`onError(item, error)`、`yield()` 和 `check()`；单项出错继续，取消检查抛出或遇到 `AbortError` 时立即退出，不提交过期结果。
- **ui.js 的 `startProgress(title, total?)`**：显示右下角进度卡片（`.progress-card`，毛玻璃，挂在 body 上，切换工具后仍然可见），返回 `{ update(done, total?, title?), finish(message), fail(message) }`。
  - `total` 为 0 时显示不确定进度（来回滑动的进度条）。
  - `finish` 后变为绿色完成提醒，3.5 秒后自动消失；`fail` 显示红色，6 秒后消失；两种状态都可以手动关闭。
  - 同一时间只显示一个任务，新任务会接管卡片。

## 保存到本地（save.js）

```js
const dir = asZip ? null : await pickFolder('tool-id'); // null = 不支持文件夹（改用 ZIP），undefined = 未选择 / 被拒绝
if (dir === undefined) return;
const task = startProgress('准备保存', files.length);
try {
  // 需要先生成或处理图片时，用 task.update(i, n, '正在生成图片') 报告进度
  await writeFiles(files, { dir, zipName, task, summary: `${n} 张图片` }); // 内部报告写入 / 打包进度并 finish
} catch (err) {
  task.fail(`保存失败：${err.message}`);
}
```

- 浏览器支持 `showDirectoryPicker`（Chrome / Edge）时直接写入用户选择的文件夹（同名文件会被覆盖），否则退化为 ZIP 下载；另有一个「打包 ZIP 下载」按钮始终可用。ZIP 只能确认已交给浏览器下载，提醒文案是“浏览器开始下载”。
- `pickFolder` 遇到 `AbortError`（取消选择、选了浏览器禁止写入的文件夹如桌面 / 下载 / 文档本身、拒绝“允许修改文件”提示）会提示原因并返回 `undefined`。
- 导出 GIF、智能切图的「发送到图片批处理」、补帧也用同一个进度卡片。视频抽帧保存或导出前的「应用去除背景」，会通过 `state.progressTask` 把进度写进同一张卡片。
- 单张下载是即时的，不显示进度卡片。
- `writeFiles(files, options)` 可传入 `check()`，在开始写入、每次文件系统等待后、ZIP 进度回调和下载前检查任务是否取消；抛出时中止尚未提交的文件流。像素规整通过导出 token 使用此能力，既有调用不传时保持原行为。

## 测试参考

- `sprite-detect.js` 可以直接在 Node 中 import，对 `test-images/` 的三张图跑 `detectSprites`。默认参数（合并距离 4、最小尺寸 8、容差 10）下，透明底、品红底应识别出 31 个素材、过滤 14 个噪点；白底是 30 个，因为浅色云朵 `#ececec` 与白底的距离在容差内，容差调到 5 后也是 31 个。
- `gif-decode.js` 可以用 `GifEncoder` 生成 GIF 做往返测试。
- `interpolate.js` 在 Node 里把 `fetch` 换成读文件即可用 WASM 后端运行。
- `pixel-tween.js` 可以用放大的合成像素精灵测试：补出的帧应没有新颜色、没有半透明、网格方块完整，像素位移的中心位置应线性前进。
- `node scripts/test-pixel-cleanup.mjs`：检查 2 / 3 / 4 / 8 / 12 / 16 倍网格、横纵偏移、模糊边缘重建、纯色 / 噪声不误报、透明度与硬边阈值、颜色上限与实际源色、可选孤立点删除、非法参数、分段任务取消，以及文件夹流中止和 ZIP 下载前取消。批量检查覆盖不同原图尺寸的逐张识别、统一逻辑尺寸 / 偏移 / 颜色 / 透明设定、处理顺序、独立结果缓存、单张出错后继续、空队列和中途取消不提交过期结果。界面由用户在浏览器检查应用到全部图片、网格点选与快速连续切图、直接拖动分界线、放大窗口开关与缩放、勾选导出和重名文件序号。
