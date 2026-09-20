# 安装指南（Windows）

建议直接让 Codex 按本文安装。用户不需要手工编辑配置文件或理解代码。

## 1. 准备环境

- Windows 10 / 11 x64，使用 64 位 PowerShell；当前未验证 Windows ARM 原生环境。
- Codex 桌面端，能够安装本地插件并运行本机工具。
- Node.js 22+ 与 npm；可使用 Codex 随附运行时。安装脚本检查 PATH、环境变量和 Codex 随附运行时；旧 Node 会跳过。找不到时让 Codex 用工作区依赖工具定位，再传实际路径，不要求设计师找目录。
- Microsoft Edge：浏览器自动化及界面回归测试使用它。内置浏览器操作需要 Codex 的浏览器控制工具。
- 本地粗抠和精细抠图需要 Python 3.10–3.12 和抠图权重；方案3及网页/API 矢量化可先跳过模型。
- 自动发送依赖官方 Codex App Tools 提供 `send_message_to_thread`，并由宿主传入 `CODEX_APP_TOOLS_PIPE_PATH`。不要伪造连接或改写 Codex 私有数据库。
- Photoshop / Illustrator 和 API Key 均为可选项，基础安装不需要购买它们。

## 2. 下载与安装

从 [GitHub 仓库](https://github.com/InkMore-AACC/codex-bitmap-psd-vector) 下载源码 ZIP 并解压到长期保留的目录，或让 Codex 克隆仓库。不要从 ZIP 内直接运行。移动目录后需重新生成插件路径。

在项目目录中运行（可以交给 Codex）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
```

默认安装画布、PS/AI 脚本、Photoshop MCP、粗抠和两款精细抠图模型，并通过官方 Codex CLI 注册插件。安装前先检查运行时、Codex 插件工具及同名旧安装，避免下载完成后才发现不能注册。组件状态分开报告，某个可选组件失败不撤销已完成的基础安装，也不会假装全部成功。正常需要网络和较大的磁盘空间（模型、PyTorch、Node 依赖会占用数 GB），不包含 Adobe 软件或账号。

**如果提示插件创建工具不存在：** 源码和依赖不会因此丢失。让 Codex 检查本地 `plugin-creator` 能力与 CLI 帮助，安装 `plugins/layer-canvas`。不要直接从其他人的电脑复制带绝对路径的 `.mcp.json`。

完成后重新载入插件；若当前对话未发现新工具，可在新对话检查。然后说：**“打开分层画布”**。正式使用时始终在你希望绑定画布的那个对话打开。

## 3. 添加本地抠图模型（可选）

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-models.ps1 -FineMatting
```

会创建独立 `.runtime/python`，下载 U2NetP 粗抠权重，写入 `models/`。当前方案2使用 U2NetP 粗抠；并不恢复已删除的方案1。不下载 SuperSVG / AdaVec。

Python 不在默认位置时，可向脚本传 `-PythonPath` 指定现有解释器。优先尝试国内镜像，失败或摘要不符时回退官方源；不要关闭文件校验。粗抠 ONNX 使用 CPU。加 `-FineMatting` 安装 PyTorch 依赖和 BiRefNet_HR-matting、Lucida v7：优先国内 Hugging Face 镜像，按固定版本和摘要校验；不符则回退官方。权重约 444 MB / 885 MB，另需 PyTorch 等运行依赖。不含权重的源码包不会假装模型就绪。没有显卡可加 `-CpuOnly`，精细抠图会更慢。已有可用的 PyTorch 环境会保留，界面可选择实际可用的 CPU/CUDA。正常 install.ps1 不加 SkipModels 时包括两款精细模型。

## 4. 配置矢量化

在画布“设置 → 矢量化”选择网站或 API。没有密钥时先选 Vectorizer.com；“Codex 操作网页”会使用当前对话额度。API 用户自行到服务商申请密钥、查看报价，在画布内填写，禁止写入仓库。

## 5. 可选 Adobe 连接

Photoshop MCP 默认安装在项目的 vendor/photoshop-mcp 内，可用 `-SkipAdobeMcp` 跳过；旧 `-WithAdobeMcp` 参数仍兼容。也可单独运行 `scripts/adobe-install.ps1` 补装。PS/AI Windows 脚本随源码一起提供，无需另外安装。需要用户自己已安装的 Adobe 软件；不自动安装 Beta 或购买订阅。连接检查中 MCP、Windows 脚本可能分别成功或失败，实际能力取决于本机软件版本。Illustrator 官方 MCP 与正式版脚本渠道不同，不能保证任意“2026”版本均支持官方 MCP。

## 6. 安装验收

让 Codex 分开报告：依赖已装、插件工具可见、当前对话画布打开、测试图导入成功、请求送达到正确对话、实际结果导回成功。未实际调用的生图、收费 API、Adobe 编辑必须标为未验证。

可使用自己无隐私的测试图进行一次操作。**任务进入列表不是完成；看到新结果节点并能导出才算完成。**

## 更新与备份

升级前等任务结束、确认“已保存”，备份整个 `data/` 目录。JSON 导出不包含素材，不能单独作为完整备份。保留原安装目录，更新源码后重新构建和注册；不要删除 `data`、`models` 或 `.runtime` 来“清理”。密钥由 Windows 用户加密，换账户或换电脑需重新填写。当前没有一键升级/卸载程序。


## Adobe 集成到底包含什么

| 能力 | 安装插件会做什么 | 用户电脑仍需具备什么 |
|---|---|---|
| Photoshop 社区 MCP | 默认下载固定版本，校验包摘要，安装在项目内；不污染全局 Codex 配置 | 用户自己的 Photoshop；连接工具不等于真实编辑已验证 |
| Illustrator 官方 MCP | 安装我们的连接端；Adobe 的服务本身内置于支持它的 Illustrator Beta，不是可单独打包安装的服务 | 在 Illustrator 的 MCP & Tools 中启用服务，填写该用户自己的本机地址与密钥 |
| PS / AI Windows 脚本 | 脚本跟随源码，无额外服务要启动 | 软件已正确注册 Windows COM；未启动时检查会提示先打开 |

官方 Illustrator 说明：[MCP 与 Illustrator Beta](https://helpx.adobe.com/in/illustrator/desktop/connect-with-other-apps-and-tools/about-using-ai-tools-with-illustrator.html)。不能仅凭“2026”名称认定支持官方 MCP。不同软件版本的可用工具与编辑能力仍需检查。

不要求安装在开发者的 PS 目录或 C 盘。原生脚本通过 Windows 注册的 Photoshop.Application / Illustrator.Application 寻找应用；社区 Photoshop MCP 也会查 Adobe 注册表及常见位置。注册损坏、便携版或多版本并存时，实际 COM 指向的版本可能不同，需要修复安装/注册，不能通过填写任意文件夹假装连接成功。不会自动改写注册表、关闭用户文档或安装 Adobe Beta。

## 自动检测之外的明确覆盖参数

正常由 Codex 自动安装，以下参数用于它在不同环境中适配，不要求用户手工改代码：

| 参数 | 用途 |
|---|---|
| -CheckOnly | 只检查环境，不改文件或注册插件 |
| -NodePath | 明确指定完整 Node 22+ x64 运行时中的 node.exe（同目录需有 npm.cmd） |
| -PythonPath | 明确指定 Python 3.10–3.12 x64；忽略 Windows 商店占位程序 |
| -CodexPath | 指定当前 Codex 提供的 CLI，须支持 plugin add |
| -PluginCreatorPath | 指定当前 plugin-creator 技能目录或 create_basic_plugin.py 文件 |
| -SkipModels | 暂时跳过本地模型，先用生成流程/矢量化；之后可补装 |
| -SkipAdobeMcp | 跳过社区 PS MCP，保留已随包提供的原生脚本 |
| -SkipPluginInstall | 仅安装源码运行环境，供隔离验收；不能称为已注册插件 |
| -CpuOnly | 新装 PyTorch 时选 CPU 版本；保留已有可用运行时，实际设备在画布设置中选择 |

支持环境变量 LAYER_CANVAS_NODE、LAYER_CANVAS_PYTHON、CODEX_CLI_PATH；插件技能优先查 CODEX_HOME，再查当前用户默认位置。覆盖路径只保存在本机生成文件中，不发布开发者的绝对路径。

## 安装结果与异常处理

安装会生成 data/install-report.json（各组件成功/失败/跳过）和 data/install-verification.json（真实内存 PNG 生成回读、目录写入、MCP 握手与工具发现）。把报告交给 Codex，它应直接解释哪些可用、哪些待补装，不要求设计师阅读 JSON。该自检不执行生图、收费 API、Adobe 编辑或用户画布任务。

- 中文、空格目录支持；建议解压在当前用户可写的本地目录，避免 Program Files、系统目录、云同步占用或网络盘导致权限/锁文件问题。
- 已有同名插件指向别处时，在原目录更新；安装器会停止而不覆盖或自动搬走历史。移动源码目录后不能沿用旧 .mcp.json；虚拟环境也可能需要重新建立。先完整备份 data。
- 默认端口冲突时尝试邻近空闲端口；不会结束其他程序。服务身份同时绑定安装目录和数据目录，不能把别的安装误认作当前画布。明确指定 LAYER_CANVAS_PORT 被占用时直接报错。
- 自动任务发送仍需桌面端实际提供官方工具与宿主连接环境；缺失时显示失败，不能通过私有协议或独立推理进程冒充已连接。
- 缺显卡可用 CPU；CUDA/驱动兼容性、显存和内存不足会影响推理。文件下载始终校验，不以禁用校验“解决”网络问题。
- API Key、Illustrator 密钥必须由各用户自己提供。不会复制开发者密钥、个人画布、素材、字体或软件许可证；缺字体会影响可编辑文字复现。
