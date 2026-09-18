param([string]$TaskId)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { $nodeExe = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $nodeExe)) { throw '找不到 Node.js，请先运行安装脚本。' }
if (-not $TaskId) { $TaskId = $env:CODEX_THREAD_ID }
if (-not $TaskId) { throw '请从当前 Codex 对话使用插件打开，或传入真实 -TaskId。' }
$argsFile = Join-Path $projectRoot 'data\open-arguments.json'
New-Item -ItemType Directory -Force (Split-Path -Parent $argsFile) | Out-Null
@{taskId=$TaskId} | ConvertTo-Json | Set-Content -LiteralPath $argsFile -Encoding utf8
& $nodeExe --import tsx bridge/cli.ts canvas_open $argsFile
if ($LASTEXITCODE -ne 0) { throw '画布启动失败' }
