# 架构与维护入口

## 数据流

```text
当前 Codex 对话 → MCP bridge → 本机服务 127.0.0.1:18774
                              ↕
                         React 多图画布
                              ↓ 冻结当前节点请求
                   任务队列 / 对话发送 / 引擎执行
                              ↓ 验证并回传产物
                        新结果节点 + 来源连线
```

- `web/`：React UI，当前节点选择、图层列表、标注、意见与任务显示。`App.tsx` 为主入口。
- `server/index.ts`：HTTP 路由、鉴权、输入校验和任务提交。
- `server/store.ts`：对话文档、资产、历史与任务保存。默认 `data/`，可用 `LAYER_CANVAS_DATA` 指定测试目录。
- `server/results.ts`：结果提交、图层身份匹配、取消/版本检查和新节点分支。
- `server/references.ts`：沿来源链只读查找原图，支持删除节点存档、缺失和循环终止。
- `server/media.ts`、`svg.ts`：PSD 导入导出、文字效果、SVG 校验与合成。
- `server/annotations.ts`：图片坐标与独立选区蒙版。
- `server/dispatch.ts`、`app-tools.ts`：官方工具发送到同一任务，区分失败、回执不确定、已领取。
- `server/providers.ts`：收费矢量服务；`external-vector.ts`、`vectorizer-browser.ts`、`web-vector-download.ts`：网页转换及文件导回。
- `server/adobe.ts`、`scripts/adobe-*`：可选 Adobe MCP/脚本连接与受控路径。
- `bridge/`：MCP、CLI、客户端与 Adobe 交接提示词；插件技能说明位于 `plugins/layer-canvas/skills/`。
- `python/`：仅保留 U2NetP、BiRefNet HR-matting、Lucida v7 的预览推理及安装。退役的本地矢量适配器、ISNet 分支和专用依赖已移除。
- `shared/canvas.ts`：前后端共用文档、图像、图层、标注类型，避免重复定义发生偏移。
- `server/layer-import.ts`：真实图层文件导入、尺寸检查和文字/效果预览；`web/CanvasMarks.tsx`：纯标注和统一工具图标绘制，保持原有事件传递。
- `server/models.ts`：并发状态读取共用一次 Python 检查，成功缓存 15 秒；失败不缓存，安装后可重新检查。
- `shared/cutout.ts`：三个本地模型的参数校验、通用默认值和四个流程名称；Web 与服务共用。
- `shared/reconstruction-policy.ts`：Codex 重建/补图的一致性原则，共用于任务包和 Adobe 交接；技能要求每次实际生成时传入。
- `server/cutouts.ts`、`cutout-settings.ts`：冻结参数的本地抠图预览和跨新画布默认值。`python/matting.py` 离线加载固定快照，`download_matting.py` 负责下载和摘要校验。

## 必须保留的约束

文档 revision 防止过时保存覆盖；节点 version 绑定内容修改；任务 snapshot 冻结提交时输入。移动图片或切换显示不是重新生成。完成回传需再次核对取消状态与当前节点，不覆盖后来编辑。

图层从底到顶保存。标注使用图片像素，允许图外坐标。节点平移只改变画布位置，不改变标注本地坐标。

正式生成、修改、矢量化输出新的子节点；预分层属于当前节点的计划阶段。执行不遍历来源链，只有参考读取允许追溯。删除节点保留素材与删除快照，不连带删除子节点。

“显示原图”是独立 UI 状态；任务与导出仍读取当前节点的结果。矢量节点自动展示它自己的矢量层，不用全局视图强迫所有图片显示同一种内容。

## 本机安全边界

只监听回环地址，校验 Host / Origin。网页与可信 MCP 使用不同令牌；内部变更需要任务归属匹配。SVG 禁止脚本、外部资源与内嵌位图，资产路径限制在对应文档目录。密钥通过 Windows DPAPI 按用户加密保存。详见 SECURITY.md。

- `server/reconstruction-inputs.ts`：剥离重建包里的预览像素路径，统一原图与标注输入，拒收直接复用的预览像素（包括重编码副本）。真实分层精抠准备入口已停用。

- `shared/layer-frame.ts`、`web/LayerFrame.tsx`：可撤销的独立图层画幅与拖动几何；`server/layer-frames.ts`：冻结生成画幅、合并映射、实际文件尺寸校验和无拉伸回传。
