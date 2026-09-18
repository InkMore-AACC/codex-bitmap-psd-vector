param([switch]$SkipModels,[switch]$CpuOnly,[switch]$SkipPluginInstall,[switch]$WithAdobeMcp)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { $nodeExe = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $nodeExe)) { throw '需要 Node.js 22+；可使用 Codex 自带的 Node 运行时。' }
$env:PATH = (Split-Path -Parent $nodeExe) + ';' + $env:PATH
& $nodeExe -e "if(Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw '需要 Node.js 22 或更高版本。' }
$npmCmd = Join-Path (Split-Path -Parent $nodeExe) 'npm.cmd'
if (-not (Test-Path -LiteralPath $npmCmd)) { $npmCmd = (Get-Command npm.cmd).Source }
& $npmCmd ci --registry=https://registry.npmmirror.com
if ($LASTEXITCODE -ne 0) { & $npmCmd ci --registry=https://registry.npmjs.org }
if ($LASTEXITCODE -ne 0) { throw 'Node 依赖安装失败' }
& $npmCmd run build
if ($LASTEXITCODE -ne 0) { throw '界面构建失败' }
& $nodeExe scripts/configure-plugin.mjs
if ($LASTEXITCODE -ne 0) { throw '插件配置失败' }
if (-not $SkipModels) { & (Join-Path $PSScriptRoot 'setup-models.ps1') -CpuOnly:$CpuOnly }
if ($WithAdobeMcp) { & (Join-Path $PSScriptRoot 'adobe-install.ps1') }
if (-not $SkipPluginInstall) {
  $helper = Join-Path $env:USERPROFILE '.codex\skills\.system\plugin-creator\scripts\create_basic_plugin.py'
  $pythonExe = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
  if (-not (Test-Path -LiteralPath $helper) -or -not (Test-Path -LiteralPath $pythonExe)) { throw '未找到 Codex 插件创建工具。源码和界面已安装，可在 Codex 中要求安装 plugins/layer-canvas。' }
  & $pythonExe -X utf8 $helper layer-canvas --path (Join-Path $projectRoot 'plugins') --with-skills --with-mcp --with-marketplace --force
  if ($LASTEXITCODE -ne 0) { throw '插件目录注册失败' }
  & $nodeExe scripts/configure-plugin.mjs
  if ($LASTEXITCODE -ne 0) { throw '本机插件配置重新生成失败。' }
  $target = Join-Path $env:USERPROFILE 'plugins\layer-canvas'
  $source = Join-Path $projectRoot 'plugins\layer-canvas'
  if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Junction -Path $target -Target $source | Out-Null }
  elseif ((Get-Item -LiteralPath $target).FullName -ne $source -and (Get-Item -LiteralPath $target).Target -ne $source) { throw '已有同名插件位于其他目录，已保留，请在 Codex 中处理安装路径。' }
  $cachebuster = Join-Path (Split-Path -Parent $helper) 'update_plugin_cachebuster.py'
  & $pythonExe -X utf8 $cachebuster $source
  codex plugin add layer-canvas@personal
  if ($LASTEXITCODE -ne 0) { throw 'Codex 插件安装失败，应用源码和已有数据均保留。' }
}
if ($SkipPluginInstall) { Write-Host '依赖和界面安装完成；已跳过 Codex 插件注册。' }
else { Write-Host '分层画布已安装。请在 Codex 对话中说：打开分层画布。' }
