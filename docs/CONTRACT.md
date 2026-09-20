# 接口与数据约定

精确字段以 server/types.ts、server/validation.ts、web/types.ts 为准，端点以 server/index.ts 与 bridge/mcp.ts 为准；本文件用于智能体快速定位。

## 数据

- Document：id、taskId、revision、images、settings、layout、updatedAt。
- settings.psdMode：2、3、4（BiRefNet）或5（Lucida）；vectorEngine：vectorizerCom、recraft、vectorizer、vectorizer302。
- CanvasImage：id、source（不可替换）、url、width/height、画布x/y、layers、vectorLayers、annotations、opinion、version、status、parentId/sourceJobId等来源信息。
- Layer：id/name/url、图片坐标与尺寸、visible/opacity、opinion、keep/rebuild、raster/text/vector类型、可选cutoutBox（未扩边的原始物体框）及PSD原生信息。数组顺序从底到顶。
- Annotation：image内归属、layerId或null、arrow/ellipse/box/pen/text、points、text、颜色、线宽、字号/字重、笔刷大小/透明度。允许图外坐标，不跟随浏览器缩放改写。
- Job：taskId/documentId/imageId、type、status、version、snapshot、可选layerIds、引擎、发送状态和输出结果。冻结输入不随前端切换改变。

## 浏览器入口

- GET /api/document?taskId=...：读取或创建该对话文档。
- PUT /api/document/:id：document和expectedRevision；冲突409。
- POST /api/document/:id/import：multipart files；PNG/JPEG/WebP/PSD/SVG。
- GET /api/document/:id/images/:imageId/reference：只读原图url及complete，不返回本机路径。
- POST /api/document/:id/jobs：当前imageId、type、可选layerIds/mode/engine/useVectorLayers等。
- GET /api/document/:id/jobs；POST /api/jobs/:id/cancel。
- GET /api/document/:id/export：imageId、format与view；UI原图对比不改变导出。
- GET/PUT /api/settings：只读脱敏状态/写入当前服务商凭据。

/api/health 公开；其余网页请求需本机访问令牌并符合Host/Origin要求。资产必须属于对应文档，不能跨文档引用。

## 可信 MCP 入口

内部端点另需 X-Canvas-Bridge，并验证真实taskId。通过 canvas_open / canvas_import / 请求领取、packet、plan、apply、fail 等工具操作；完整清单从 MCP listTools 读取。

领取包 sourcePath 是当前节点干净输入，originalSourcePath 为来源链可用参考，originalReference.complete 说明是否找到了根节点。参考只读，不继承上游意见；当前节点和本次意见优先。layers 仅对已完成的真实图层提供素材路径；预览层仅含名称、归属、坐标、顺序及意见，coordinateAnnotations 提供坐标与独立选区。

`referencePolicy` 由 `shared/reconstruction-policy.ts` 统一生成，也附在 Adobe 交接提示中。每次 Codex 生图/编辑必须携带该原则：最初导入原图约束未要求变化的视觉内容，保留当前节点已确认修改，本次意见仅在对应作用域覆盖；补全按周边材质/光照/透视延续。缺失或不完整参考必须明示，最终须核对实际合成结果，不以提示词代替验证。此字段不改变冻结任务归属，不触发上游执行。

apply必须带对应baseVersion及真实输出文件。服务核验尺寸、格式、图层身份、归属和任务状态；正式结果分支为新节点，保留源节点及后来编辑。取消/已结束请求不重复执行。仅预分层计划可更新源节点计划状态。

## Python

worker.py status查询模型；segment读取实际图片，输出透明预览及JSON元数据。当前矢量化执行不使用本地模型。独立蒙版不是生图工具硬约束；工具不支持蒙版时只能作为定位参考。


## 精细抠图与默认参数

shared/cutout.ts 是 Web/服务共用的校验和默认值。settings.cutoutOptions 按 coarse / birefnet / lucida 保存；Job.cutoutOptions 提交时深拷贝冻结，旧任务缺字段时取工厂值。新画布默认方案4，已有2/3不强制切换。GET/PUT /api/cutout-defaults 读写 data/cutout-defaults.json，仅保存参数，不包含图片或凭据。保存当前文档和全局默认由前端分别提交。

方案2/4/5的 plan 从干净输入运行对应模型供用户预览，方案3只读取干净图，提交名称、box（整数 x/y/宽/高）、role、opinion 与底到顶顺序；禁止生图或抠图，拒绝 path/url/svg/previewUrl，服务创建 kind=plan 的无像素层。plan 提交即完成预分层任务，不自动进入 layer。所有模式在真实 layer 阶段统一为原图与结构化标注驱动的生成重建。generationInputs.allowedImagePaths 明确列出允许引用的干净原图、当前输入和已完成真实图层；任务包所有预览层均移除 path/url/previewUrl/svg 等像素入口，仅留语义与坐标。canvas_prepare_cutouts 旧入口返回409，真实分层不再运行本地抠图；不再提供像素拼回脚本入口。提交显式预览或与输入预览解码像素相同的副本将拒绝，即使改名或重编码也不接受。该检查能识别直接复用，不能证明任意重绘或拼接的来源；实际生图引用及生成后处理仍须按技能验证。

segment --model coarse|birefnet|lucida --options <JSON文件>；精细模型仅加载本地固定版本、校验过的代码/权重，离线推理。输出携带实际执行设备/精度。角色背景使用前景蒙版并集反集作为待补全预览，不把它当完整背景。

## 图层画幅约束

Layer.frame 为独立的整数图片局部坐标 {x,y,width,height}，可在图片外；x/y/width/height 仍描述预览或最终位图自身的放置，不因编辑 frame 而缩放预览。缺省读取旧预览几何，背景缺省整图。cutoutBox 仅是模型提示，不等于重建画幅。

新提交的预览节点 layer/revise 请求冻结 frame 并携带 frameContractVersion=1；packet.frameContract.version=2 提供逐层生成与回传要求；历史没有 frameContractVersion 的任务保持原处理。返回图层 path 应为实际生图原文件，服务从文件读取 generationSize，校验冻结位置及尺寸，拒绝超过1%相对宽高比偏差、位置错误及缺失图层；不因低分辨率或实际超过请求像素预算拒绝。使用 contain 等比例放大或缩小适配，保留原有 alpha、颜色与细碎元素，不裁透明包围盒。sourceLayerIds 用于明确合并：必须覆盖全部目标来源且不重复，输出 frame 为并集，标注重关联。整图输出尺寸变化时冻结框按坐标比例换算；局部任务不能改整图尺寸。

这些检查验证几何和文件，不证明视觉一致性，也不能证明调用者在提交文件前从未篡改过图像。仍需按 Skill 查看实际生图产物并合成验收。粗抠/精抠预览像素禁止参与重建。

规划层契约：kind=plan、preview=true、disposition=rebuild，必须有 frame，不得有 url/previewUrl/svg/text/psdStyle。只允许存在于 status=preview 的 layers，不得进入 vectorLayers 或正式回传。用户可手动新建规划层并与本地预览混合；保存、标注与任务冻结使用稳定 layerId。确认时所有层（包括无文件的规划层）按 frameContract 参与重建；局部重建后仍有规划层则保持 preview。未完成预览不能导出正式 PSD 或进行矢量化。

## 生成分辨率与实际回传（v2）

- shared/generation-geometry.ts 为 UI 与服务共用算法。generation.size 按 1,550,000 像素预算等比取整，不改 frame。generation 提供 scale、offset、restoreScale、imageToGeneration；annotations 是该层生成坐标，原始 annotations 不修改。合并或总图改尺寸通过 canvas_get_request.generationPlan（groups、width、height）重算。预算是本插件请求策略，不是对上游真实输出能力的声明。
- 回传以实际文件尺寸为准。相对比例偏差 `abs((actualWidth/actualHeight)/(frameWidth/frameHeight)-1)` ≤0.01 时统一等比缩放；整数栅格四舍五入，补边按文件画幅中心分配，不按主体轮廓重新定位。背景补边只允许完全不透明图，复制边缘像素并标明需视觉检查。原生文字/矢量不使用生图像素预算。
- generationSize 记录原始实际宽高；generationSourceUrl 保留导入的原始生成 PNG；generationAdaptation 记录实际 scale、offsetX/Y、contentWidth/Height、aspectError、padding 与 crop。sourceCrop 必须显式给定且只可删除全透明像素，偏移保留；不自动按 alpha 裁边。
- canvas_complete_request(stageOnly:true) 仅用于已有冻结画幅的真实图层。逐层检查并保存 jobs/<jobId>/staged-layers.json，不完成任务、不修改文档或创建节点。packet.stagedLayers 返回 originalPath/adaptedPath 及元数据；取消后不能再提交。最终仍需提交所有目标图层及冻结 baseVersion。暂存及尺寸校验不是视觉验收。
