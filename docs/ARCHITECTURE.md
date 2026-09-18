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
- `python/`：本地抠图工作进程；旧矢量实验代码保留但正常工作流不调用。

## 必须保留的约束

文档 revision 防止过时保存覆盖；节点 version 绑定内容修改；任务 snapshot 冻结提交时输入。移动图片或切换显示不是重新生成。完成回传需再次核对取消状态与当前节点，不覆盖后来编辑。

图层从底到顶保存。标注使用图片像素，允许图外坐标。节点平移只改变画布位置，不改变标注本地坐标。

正式生成、修改、矢量化输出新的子节点；预分层属于当前节点的计划阶段。执行不遍历来源链，只有参考读取允许追溯。删除节点保留素材与删除快照，不连带删除子节点。

“显示原图”是独立 UI 状态；任务与导出仍读取当前节点的结果。矢量节点自动展示它自己的矢量层，不用全局视图强迫所有图片显示同一种内容。

## 本机安全边界

只监听回环地址，校验 Host / Origin。网页与可信 MCP 使用不同令牌；内部变更需要任务归属匹配。SVG 禁止脚本、外部资源与内嵌位图，资产路径限制在对应文档目录。密钥通过 Windows DPAPI 按用户加密保存。详见 SECURITY.md。
