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

`web/tests/` 是连接本机服务的较早浏览器验收脚本，部分要求显式测试任务环境变量；仅在隔离画布与测试素材中运行，不要让其操作设计师正在编辑的文档。`python/test_models.py` 是历史研究验收，依赖未公开的样例文件、旧矢量产物及额外 Python 依赖，不作为新安装命令，也不包含在 npm test 中。验证当前抠图请用自己的非敏感测试图调用 worker.py segment。

旧模型/样例脚本不属于当前用户工作流；被排除的个人测试素材不可作为安装前提。添加新测试应自行生成无隐私 fixture。

## 改动约定

- 数据结构变更同步 `server/types.ts`、`server/validation.ts`、`web/types.ts` 及接口说明。
- 维护当前 taskId / jobId / imageId / baseVersion 绑定，验证取消、并发、重入与重复回传。
- 不静默降级为不同模型，不伪造下载或生成成功。
- 修改费用、服务商或真实付费路径时，不用用户账户做未授权测试。
- 设计师界面先显示简短成功/失败原因，技术细节折叠；保持紧凑、统一图标与可调整面板。

## 发布

此仓库首次公开发布只含当前源码快照，不带本机开发历史。源码发布不包含 node_modules、dist、data、模型、运行时和本机 .mcp.json。

`scripts/prepare-release.py` 可将白名单文件导出到一个全新的空目录，不读取旧 Git 历史。先审核输出和扫描报告，再在该目录提交/推送。不要覆盖已有发布目录。打包前更新 README、CHANGELOG、需求与验收记录。

检查依赖安装、构建、测试与文档链接，并扫描凭据、私人路径和大文件。真实外部服务的成功不能仅凭模拟测试宣称。保存公开提交 ID，后续发布在公开仓库历史上更新，避免强推覆盖别人的提交。
