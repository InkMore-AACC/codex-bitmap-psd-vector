# 开发指南

## 准备与检查

在 Windows、Node.js 22+、Edge 环境中：

```powershell
npm ci --registry=https://registry.npmmirror.com
# 镜像失败时使用 npm ci --registry=https://registry.npmjs.org
node scripts/configure-plugin.mjs
npm run typecheck
npm run build
npm test
```

MCP 配置生成后包含本机绝对路径，已加入忽略规则；不要提交。npm test 包含使用 Edge 的本地 UI 测试与临时数据目录服务测试，不需要模型权重、真实生成额度、收费 API 凭据或 Adobe 安装。部分测试需要空闲测试端口18779；并行运行多个完整测试实例会冲突。

`npm start` / `npm run dev` 启动后端；前端默认由 dist 提供，修改 UI 后需重新 build。使用 bridge 的 canvas_open 获取正确任务绑定及浏览器访问令牌，不把任意 UUID 当成当前对话。

## 额外测试

`web/tests/` 是连接本机服务的额外浏览器验收脚本，部分要求显式测试任务环境变量；仅在隔离画布与测试素材中运行，不要让其操作设计师正在编辑的文档。默认 `npm test` 自行创建隔离测试数据。

Python 测试使用自动生成的素材和模拟模型输出，不依赖私人样例或退役模型：

```powershell
.runtime/python/Scripts/python.exe -m unittest discover -s python -p "test_*.py"
.runtime/python/Scripts/python.exe -X utf8 python/worker.py status
npm run format:check
```

Python 单元测试证明参数、坐标、透明度和预览契约，不代表真实模型的抠图质量。验证实际推理请使用非敏感测试图运行 `worker.py segment --model coarse|birefnet|lucida`，三个名称选择其一。

## 改动约定

- 图像、图层、标注和文档类型统一在 `shared/canvas.ts`，前后端从此处导出；校验规则在 `server/validation.ts`。服务端任务结构与浏览器任务摘要有意分开，避免将冻结快照发给界面。
- 运行 `npm run format` 统一核心源码排版。不要再把整个请求处理或组件写成难以检查的单行。
- 模型新增/移除时同步 worker、安装下载器、依赖、状态页及验收测试。旧设置迁移只在读取/正常保存时进行，不批量改写用户历史。
- 维护当前 taskId / jobId / imageId / baseVersion 绑定，验证取消、并发、重入与重复回传。
- 不静默降级为不同模型，不伪造下载或生成成功。
- 修改费用、服务商或真实付费路径时，不用用户账户做未授权测试。
- 设计师界面先显示简短成功/失败原因，技术细节折叠；保持紧凑、统一图标与可调整面板。

## 发布

此仓库首次公开发布只含当前源码快照，不带本机开发历史。源码发布不包含 node_modules、dist、data、模型、运行时和本机 .mcp.json。

`scripts/prepare-release.py` 可将白名单文件导出到一个全新的空目录，不读取旧 Git 历史。先审核输出和扫描报告，再在该目录提交/推送。不要覆盖已有发布目录。打包前更新 README、CHANGELOG、需求与验收记录。

检查依赖安装、构建、测试与文档链接，并扫描凭据、私人路径和大文件。真实外部服务的成功不能仅凭模拟测试宣称。保存公开提交 ID，后续发布在公开仓库历史上更新，避免强推覆盖别人的提交。
