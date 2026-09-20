param([string]$TaskId,[string]$NodePath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime-paths.ps1')
$nodeExe=Resolve-CanvasNode $NodePath
Set-Location -LiteralPath $projectRoot
if (-not $TaskId) { $TaskId = $env:CODEX_THREAD_ID }
if (-not $TaskId) { throw '请从当前 Codex 对话使用插件打开，或传入真实 -TaskId。' }
$argsFolder=Join-Path $projectRoot 'data'
New-Item -ItemType Directory -Force $argsFolder | Out-Null
$argsFile = Join-Path $argsFolder ('open-arguments-'+[guid]::NewGuid().ToString()+'.json')
[IO.File]::WriteAllText($argsFile,(@{taskId=$TaskId} | ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
try {
  & $nodeExe --import tsx bridge/cli.ts canvas_open $argsFile
  if ($LASTEXITCODE -ne 0) { throw '画布启动失败' }
} finally { Remove-Item -LiteralPath $argsFile -ErrorAction SilentlyContinue }
