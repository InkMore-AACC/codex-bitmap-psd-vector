# 安装指南（Windows）

建议直接让 Codex 按本文安装。用户不需要手工编辑配置文件或理解代码。

## 1. 准备环境

- Windows 10 / 11，当前版本仅支持 Windows。
- Codex 桌面端，能够安装本地插件并运行本机工具。
- Node.js 22+ 与 npm；可使用 Codex 随附运行时。安装脚本会检查常见位置，找不到时请让 Codex 定位实际路径。
- Microsoft Edge：浏览器自动化及界面回归测试使用它。内置浏览器操作需要 Codex 的浏览器控制工具。
- 只有本地预览方案需要 Python 3.10–3.12 和抠图权重；方案3及网页/API 矢量化可先跳过模型。
- 自动发送依赖官方 Codex App Tools 提供 `send_message_to_thread`，并由宿主传入 `CODEX_APP_TOOLS_PIPE_PATH`。不要伪造连接或改写 Codex 私有数据库。
- Photoshop / Illustrator 和 API Key 均为可选项，基础安装不需要购买它们。

## 2. 下载与安装

从 [GitHub 仓库](https://github.com/InkMore-AACC/codex-bitmap-psd-vector) 下载源码 ZIP 并解压到长期保留的目录，或让 Codex 克隆仓库。不要从 ZIP 内直接运行。移动目录后需重新生成插件路径。

在项目目录中运行（可以交给 Codex）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -SkipModels
```

先装画布最容易排查环境问题。脚本会安装 Node 依赖、构建界面、生成本机 MCP 配置并尝试注册个人插件市场；它依赖当前 Codex 自带的插件注册脚本和 CLI。不同 Codex 版本可能需要由 Codex 使用当前支持的本地插件安装方式完成最后一步，不能把构建成功当成注册成功。

**如果提示插件创建工具不存在：** 源码和依赖不会因此丢失。让 Codex 检查本地 `plugin-creator` 能力与 CLI 帮助，安装 `plugins/layer-canvas`。不要直接从其他人的电脑复制带绝对路径的 `.mcp.json`。

完成后重新载入插件；若当前对话未发现新工具，可在新对话检查。然后说：**“打开分层画布”**。正式使用时始终在你希望绑定画布的那个对话打开。

## 3. 添加本地预览模型（可选）

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-models.ps1
```

会创建独立 `.runtime/python`，下载 U2NetP 以及兼容工具使用的 ISNet 抠图权重，写入 `models/`。当前方案2使用 U2NetP 粗抠；并不恢复已删除的方案1。不下载 SuperSVG / AdaVec。

Python 不在默认位置时，可向脚本传 `-PythonPath` 指定现有解释器。优先尝试国内镜像，失败或摘要不符时回退官方源；不要关闭文件校验。当前默认 ONNX 依赖为 CPU 运行时，不要求 NVIDIA 显卡。`-CpuOnly` 参数为兼容保留，并不会安装 CUDA。

## 4. 配置矢量化

在画布“设置 → 矢量化”选择网站或 API。没有密钥时先选 Vectorizer.com；“Codex 操作网页”会使用当前对话额度。API 用户自行到服务商申请密钥、查看报价，在画布内填写，禁止写入仓库。

## 5. 可选 Adobe 连接

使用 `-WithAdobeMcp` 可安装项目隔离的社区 Photoshop MCP，或单独运行 `scripts/adobe-install.ps1`。需要用户自己已安装的 Adobe 软件；不自动安装 Beta 或购买订阅。连接检查中 MCP、Windows 脚本可能分别成功或失败，实际能力取决于本机软件版本。Illustrator 官方 MCP 与正式版脚本渠道不同，不能保证任意“2026”版本均支持官方 MCP。

## 6. 安装验收

让 Codex 分开报告：依赖已装、插件工具可见、当前对话画布打开、测试图导入成功、请求送达到正确对话、实际结果导回成功。未实际调用的生图、收费 API、Adobe 编辑必须标为未验证。

可使用自己无隐私的测试图进行一次操作。**任务进入列表不是完成；看到新结果节点并能导出才算完成。**

## 更新与备份

升级前等任务结束、确认“已保存”，备份整个 `data/` 目录。JSON 导出不包含素材，不能单独作为完整备份。保留原安装目录，更新源码后重新构建和注册；不要删除 `data`、`models` 或 `.runtime` 来“清理”。密钥由 Windows 用户加密，换账户或换电脑需重新填写。当前没有一键升级/卸载程序。
