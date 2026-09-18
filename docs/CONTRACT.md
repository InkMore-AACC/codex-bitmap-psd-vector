# 接口与数据约定

精确字段以 server/types.ts、server/validation.ts、web/types.ts 为准，端点以 server/index.ts 与 bridge/mcp.ts 为准；本文件用于智能体快速定位。

## 数据

- Document：id、taskId、revision、images、settings、layout、updatedAt。
- settings.psdMode：2或3；vectorEngine：vectorizerCom、recraft、vectorizer、vectorizer302。
- CanvasImage：id、source（不可替换）、url、width/height、画布x/y、layers、vectorLayers、annotations、opinion、version、status、parentId/sourceJobId等来源信息。
- Layer：id/name/url、图片坐标与尺寸、visible/opacity、opinion、keep/rebuild、raster/text/vector类型、可选PSD原生信息。数组顺序从底到顶。
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

领取包 sourcePath 是当前节点干净输入，originalSourcePath 为来源链可用参考，originalReference.complete 说明是否找到了根节点。参考只读，不继承上游意见；当前节点和本次意见优先。layers 提供实际素材路径，coordinateAnnotations 提供坐标与独立选区。

apply必须带对应baseVersion及真实输出文件。服务核验尺寸、格式、图层身份、归属和任务状态；正式结果分支为新节点，保留源节点及后来编辑。取消/已结束请求不重复执行。仅预分层计划可更新源节点计划状态。

## Python

worker.py status查询模型；segment读取实际图片，输出透明预览及JSON元数据。当前矢量化执行不使用本地模型。独立蒙版不是生图工具硬约束；工具不支持蒙版时只能作为定位参考。
