# 架构与维护入口

重建v4：server/generation-workflow.ts管理元素归属、跨层关系、实际合成与文件绑定审核；generation-placement.ts分离设计框和素材边界，避免二次contain。generation-alignment.ts使用生成前冻结对应点，保留越框完整素材。新任务显式启用reconstructionWorkflowVersion=4，旧任务兼容。详见[重建v4](RECONSTRUCTION_V4.md)。

PS原生路线：`shared/photoshop.ts`设置/计划校验 → `server/photoshop-rebuild.ts`任务内计划、素材、SeedVR2异步队列与审查 → `server/photoshop-native.ts`受控PS副本渲染、实际分组验证 → 原生PSD与真实合成绑定新节点。浏览器不重新合成复杂PS子层；显隐/透明度/排序通过PS副本刷新并回读，其他修改继续PS任务。普通分层流程保持独立。详见[PS重建](PHOTOSHOP_REBUILD.md)。

独立超分：`shared/upscale.ts` 校验设置 → `server/upscale.ts` 冻结当前节点的干净/可见合成输入 → `python/seedvr2.py` SeedVR2 离线推理 → 精确宽高和透明度验证 → `commitImage` 创建关联节点。与独立抠图共享本地串行队列，不进入 Codex 分层协议。模型来源和摘要在 `python/seedvr2-models.json`，设置默认值保存在 `data/upscale-defaults.json`。维护细节见 [UPSCALE](UPSCALE.md)。

## 数据流

正式分层超分由 `server/upscale-layers.ts` 接管：全层预检查→统一倍率缩放全局边界→逐层RGB推理/独立alpha缩放→保留文字与常用效果的结构化缩放→合成。`server/upscale-psd.ts` 拦截不能完整往返的特殊PSD结构，缩放原生文字/样式元数据，导出后校验各层画幅与顺序，再绑定新PSD索引，防止下一次导出引用旧位置。失败不提交部分节点；旧生成来源字段留在冻结父节点，不错误套用到新像素。

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

PS重建v2新增`server/photoshop-quality.ts`（实际alpha、参考副本、来源记录及逐组分离检查）和`server/photoshop-text.ts`（新文档副本中按实测文字边界拟合）。`photoshop-native.ts`从PS导出透明与深浅底真实预览并回读原生字形/warp；`photoshop-rebuild.ts`统一验证surface、路线、文字目标、逐层checks和渲染摘要，先分离检查再超分。旧已完成节点保持原生文件，不自动迁移或重做。

## 本机安全边界

只监听回环地址，校验 Host / Origin。网页与可信 MCP 使用不同令牌；内部变更需要任务归属匹配。SVG 禁止脚本、外部资源与内嵌位图，资产路径限制在对应文档目录。密钥通过 Windows DPAPI 按用户加密保存。详见 SECURITY.md。

## 服务生命周期

- `bridge/lifecycle.ts`：MCP 连接建立后异步启动服务，不阻塞工具初始化；每10秒检查服务可用性。`service-owners/` 记录当前连接及经祖先进程识别的 Codex/ChatGPT 宿主身份，不读取私有数据库。识别不到宿主时退回 MCP 连接存活判断。
- `shared/process-owner.ts`：只读 Windows 进程 PID、父 PID、进程名和创建时间。宿主同时核对 PID 与创建时间，避免 PID 重用；与本插件无关的 Codex 进程不延长服务寿命。宿主查询失败时保留服务，不贸然停止。
- `server/service-lock.ts`：按数据目录互斥启动，防止多连接产生多个写入者；恢复异常退出遗留的死进程锁，只处理本服务锁，不删除用户数据。
- `server/lifecycle.ts`：每5秒检测所有关联宿主/连接；全部退出且本地队列、模型操作、导出、HTTP请求和对话发送均空闲约15–20秒后停止监听。关闭单一标签或单一连接不停止其他活跃宿主的服务。仅手动启动且从未关联插件的服务不会自动退出。
- 保留 `service.json` 的端口及凭证，不删除文档、视图或任务。待 Codex 执行的旧请求不会因重启自动重做；本地运行任务正常结束并保存后才退出。网页初次读取遇到网络启动延迟最多重试30秒，不自动重放写操作。
- 页面恢复早于服务且浏览器显示自身的“无法访问”页时，网页代码尚未加载，仍可能需要刷新；插件不操作未保存的页面或宿主私有恢复协议。


- `server/reconstruction-inputs.ts`：剥离重建包里的预览像素路径，统一原图与标注输入，拒收直接复用的预览像素（包括重编码副本）。真实分层精抠准备入口已停用。

- `shared/layer-frame.ts`、`web/LayerFrame.tsx`：可撤销的独立图层画幅与拖动几何；`server/layer-frames.ts`：冻结生成画幅、合并映射、实际文件尺寸校验和无拉伸回传。

- 独立抠图：shared/standalone-matting.ts（独立参数与默认值）、server/matting-settings.ts（默认持久化）、server/standalone-matting.ts（输入合成及真实PNG检查）、python/worker.py matte（全图精细透明度）、web/MattingSettings.tsx（独立设置）。server/index.ts的本地串行队列与原有Codex/矢量队列隔离。

SeedVR2分支：`settings.upscale.model=seedvr2-7b-int8` → worker路由 → `python/seedvr2.py`。固定Comfy推理核心从`.runtime/seedvr2-comfy`加载，只作本地库；不启动服务器或加载用户节点。使用同一PNG/alpha/PSD验证返回通路，安装器与固定摘要位于`download_seedvr2.py`和`seedvr2-models.json`。

## 视频超分
`server/video.ts`导入及结果适配，`python/video_upscale.py`检查媒体、连续帧联合推理、时间重叠融合、H.264编码和AAC音轨合并。每个worker只加载一次模型，批次有界，不把整段视频留在内存。`video-progress.json`传递进度；与图片/抠图共用串行队列，取消终止进程树。只在媒体校验通过后commitImage，新节点不改变来源。
