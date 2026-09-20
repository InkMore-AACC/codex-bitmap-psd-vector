param(
  [switch]$SkipModels, [switch]$CpuOnly, [switch]$SkipPluginInstall,
  [switch]$SkipAdobeMcp, [switch]$WithAdobeMcp, [switch]$CheckOnly,
  [string]$NodePath, [string]$PythonPath, [string]$CodexPath, [string]$PluginCreatorPath
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime-paths.ps1')
if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or -not [Environment]::Is64BitProcess) { throw '请使用 Windows x64 的 PowerShell 运行安装。' }
if ($SkipAdobeMcp -and $WithAdobeMcp) { throw '不能同时指定 SkipAdobeMcp 和 WithAdobeMcp。' }
$nodeExe = Resolve-CanvasNode $NodePath
$npmCmd = Get-CanvasNpm $nodeExe
$pythonExe = $null
$pythonProblem = $null
try { $pythonExe = Resolve-CanvasPython $PythonPath } catch { $pythonProblem = $_.Exception.Message }
$pluginSource = Join-Path $projectRoot 'plugins\layer-canvas'
$pluginTarget = Join-Path $env:USERPROFILE 'plugins\layer-canvas'
$marketplaceFile = Join-Path $env:USERPROFILE '.agents\plugins\marketplace.json'
$marketplaceName = 'personal'
$existingEntry = $false
if (-not $SkipPluginInstall) {
  if (-not $pythonExe) { throw $pythonProblem }
  $codexExe = Resolve-CanvasCodex $CodexPath
  $helper = Resolve-CanvasPluginHelper $PluginCreatorPath
  $helperDir = Split-Path -Parent $helper
  if (Test-Path -LiteralPath $marketplaceFile) {
    $marketplaceName = (& $pythonExe -X utf8 (Join-Path $helperDir 'read_marketplace_name.py') | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $marketplaceName -notmatch '^[A-Za-z0-9_-]+$') { throw '现有个人插件市场信息无效，已保留。请让 Codex 检查后重试。' }
    $marketplace = Get-Content -Raw -LiteralPath $marketplaceFile | ConvertFrom-Json
    $entry = @($marketplace.plugins | Where-Object { $_.name -eq 'layer-canvas' })
    $existingEntry = $entry.Count -gt 0
    if ($existingEntry -and ($entry.Count -ne 1 -or $entry[0].source.source -ne 'local' -or $entry[0].source.path -ne './plugins/layer-canvas')) { throw '已有同名插件来自其他来源，已保留。请先明确更新哪一个安装位置。' }
  }
  if (Test-Path -LiteralPath $pluginTarget) {
    # realpath handles an existing junction without depending on its textual Target spelling.
    $realTarget = (& $nodeExe -e "console.log(require('fs').realpathSync(process.argv[1]))" $pluginTarget | Out-String).Trim()
    $realSource = (& $nodeExe -e "console.log(require('fs').realpathSync(process.argv[1]))" $pluginSource | Out-String).Trim()
    if ($realTarget -ne $realSource) { throw '已有分层画布安装在其他目录。请在原目录更新以保留历史；如要迁移，请先备份整个 data 目录，不能直接覆盖旧安装。' }
  }
}
if ($CheckOnly) {
  [pscustomobject]@{mode='check-only';node=$nodeExe;python=$pythonExe;pythonIssue=$pythonProblem;codex=$codexExe;pluginHelper=$helper;photoshopMcp=(-not $SkipAdobeMcp);models=(-not $SkipModels);project=$projectRoot} | ConvertTo-Json
  return
}
# All host registration preconditions were checked before touching dependencies or configs.
$env:PATH = (Split-Path -Parent $nodeExe) + ';' + $env:PATH
Set-Location -LiteralPath $projectRoot
$report = [ordered]@{startedAt=(Get-Date).ToUniversalTime().ToString('o');status='installing';components=@();notes=@('Illustrator 官方 MCP 内置于支持它的 Adobe 软件，需用户启用并填写自己的地址和密钥。','Adobe 软件、许可证和付费 API 密钥不由插件安装。')}
$reportPath = Join-Path $projectRoot 'data\install-report.json'
function Save-InstallReport {
  New-Item -ItemType Directory -Force (Split-Path -Parent $reportPath) | Out-Null
  [IO.File]::WriteAllText($reportPath,($report | ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
}
function Add-InstallResult([string]$Name,[string]$Status,[string]$Message) {
  $report.components += [pscustomobject]@{name=$Name;status=$Status;message=$Message}
  Save-InstallReport
  Write-Host ("{0}：{1} — {2}" -f $Name,$Status,$Message)
}
try {
  & $npmCmd ci --registry=https://registry.npmmirror.com
  if ($LASTEXITCODE -ne 0) { & $npmCmd ci --registry=https://registry.npmjs.org }
  if ($LASTEXITCODE -ne 0) { throw 'Node 依赖安装失败，请检查网络、代理或目录写入权限。' }
  & $npmCmd run build
  if ($LASTEXITCODE -ne 0) { throw '界面构建失败，请检查安装日志。' }
  & $nodeExe scripts/configure-plugin.mjs
  if ($LASTEXITCODE -ne 0) { throw '本机插件配置生成失败。' }
  & $nodeExe scripts/verify-install.mjs
  if ($LASTEXITCODE -ne 0) { throw '基础运行自检失败，不能报告安装成功。请查看 data/install-verification.json。' }
  Add-InstallResult '基础画布与脚本' '成功' '界面已构建，PS/AI 脚本随源码提供，本机路径已生成。'
  if (-not $SkipPluginInstall) {
    if (-not $existingEntry) {
      & $pythonExe -X utf8 $helper layer-canvas --path (Join-Path $projectRoot 'plugins') --with-skills --with-mcp --with-marketplace --force
      if ($LASTEXITCODE -ne 0) { throw '插件市场注册失败。' }
      & $nodeExe scripts/configure-plugin.mjs
      if ($LASTEXITCODE -ne 0) { throw '本机插件配置重新生成失败。' }
    }
    if (-not (Test-Path -LiteralPath $pluginTarget)) {
      New-Item -ItemType Directory -Force (Split-Path -Parent $pluginTarget) | Out-Null
      New-Item -ItemType Junction -Path $pluginTarget -Target $pluginSource | Out-Null
    }
    & $pythonExe -X utf8 (Join-Path $helperDir 'update_plugin_cachebuster.py') $pluginSource
    if ($LASTEXITCODE -ne 0) { throw '插件版本更新失败。' }
    & $codexExe plugin add "layer-canvas@$marketplaceName"
    if ($LASTEXITCODE -ne 0) { throw 'Codex 插件安装失败。' }
    Add-InstallResult 'Codex 插件' '成功' '已通过官方 CLI 安装；工具加载与当前对话自动发送还需在 Codex 中验收。'
  } else { Add-InstallResult 'Codex 插件' '跳过' '指定了 SkipPluginInstall，不会修改宿主插件配置。' }
  if (-not $SkipAdobeMcp) {
    try { & (Join-Path $PSScriptRoot 'adobe-install.ps1') -NodePath $nodeExe; Add-InstallResult 'Photoshop MCP' '成功' '连接组件已安装；用户需自己安装并打开 Photoshop，编辑能力另行检查。' }
    catch { Add-InstallResult 'Photoshop MCP' '失败' $_.Exception.Message }
  } else { Add-InstallResult 'Photoshop MCP' '跳过' 'Windows 脚本仍可使用，前提是 Adobe 已正确注册。' }
  if (-not $SkipModels) {
    try {
      if (-not $pythonExe) { throw $pythonProblem }
      & (Join-Path $PSScriptRoot 'setup-models.ps1') -CpuOnly:$CpuOnly -FineMatting -PythonPath $pythonExe
      Add-InstallResult '本地抠图模型' '成功' '权重已下载并校验；真实推理效果需用图片检查。'
    } catch { Add-InstallResult '本地抠图模型' '失败' $_.Exception.Message }
  } else { Add-InstallResult '本地抠图模型' '跳过' '生成流程和网页/API 矢量化可先使用；本地抠图需补装模型。' }
  $report.status = if (@($report.components | Where-Object status -eq '失败').Count) { 'partial' } else { 'success' }
} catch {
  $report.status='failed'
  Add-InstallResult '安装' '失败' $_.Exception.Message
  throw
} finally { Save-InstallReport }
if ($report.status -eq 'partial') { Write-Warning '基础画布已安装，但部分可选组件失败。请按安装报告补装；不要删除 data/models/.runtime。' }
elseif ($SkipPluginInstall) { Write-Host '源码安装完成，尚未注册为 Codex 插件。' }
else { Write-Host '安装完成。在 Codex 中说“打开分层画布”。Illustrator 官方 MCP 首次仍需启用并配置自己的密钥。' }
Write-Host "安装报告：$reportPath"
