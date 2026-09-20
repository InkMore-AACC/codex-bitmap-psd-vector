[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
# Shared runtime discovery. No registry, global PATH or machine configuration writes.
function Get-CanvasRuntimeCandidates {
  param([string]$Kind)
  $relative = if ($Kind -eq 'node') { 'node\bin\node.exe' } else { 'python\python.exe' }
  if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME "runtimes\codex-primary-runtime\dependencies\$relative" }
  if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Codex\dependencies\$relative" }
  Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\$relative"
}
function Resolve-CanvasNode {
  param([string]$ExplicitPath)
  if (-not $ExplicitPath) { $ExplicitPath = $env:LAYER_CANVAS_NODE }
  $candidates = if ($ExplicitPath) { @($ExplicitPath) } else {
    @(Get-Command node.exe -All -ErrorAction SilentlyContinue | ForEach-Object Source)
    @(Get-CanvasRuntimeCandidates node)
    if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'nodejs\node.exe' }
  }
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
      $result = & $candidate -p "JSON.stringify({version:process.versions.node,arch:process.arch})" 2>$null | ConvertFrom-Json
      if ($LASTEXITCODE -eq 0 -and [int]($result.version.Split('.')[0]) -ge 22 -and $result.arch -eq 'x64') { return (Resolve-Path -LiteralPath $candidate).Path }
    } catch {}
  }
  throw '未找到可用的 Node.js 22+ x64。请让 Codex 定位随附运行时，并使用 -NodePath 指定 node.exe；不会覆盖系统 Node。'
}
function Resolve-CanvasPython {
  param([string]$ExplicitPath)
  if (-not $ExplicitPath) { $ExplicitPath = $env:LAYER_CANVAS_PYTHON }
  $candidates = if ($ExplicitPath) { @($ExplicitPath) } else {
    @(Get-CanvasRuntimeCandidates python)
    @(Get-Command python.exe -All -ErrorAction SilentlyContinue | ForEach-Object Source)
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
      foreach ($version in @('-3.12','-3.11','-3.10')) {
        try { & $launcher.Source $version -c 'import sys; print(sys.executable)' 2>$null } catch {}
      }
    }
  }
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (-not $candidate -or $candidate -like '*\Microsoft\WindowsApps\*' -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
      $result = & $candidate -c "import sys,struct,json; print(json.dumps({'major':sys.version_info.major,'minor':sys.version_info.minor,'bits':struct.calcsize('P')*8}))" 2>$null | ConvertFrom-Json
      if ($LASTEXITCODE -eq 0 -and $result.major -eq 3 -and $result.minor -ge 10 -and $result.minor -le 12 -and $result.bits -eq 64) { return (Resolve-Path -LiteralPath $candidate).Path }
    } catch {}
  }
  throw '未找到 Python 3.10–3.12 x64。请让 Codex 定位随附 Python，并传 -PythonPath；Windows 商店占位程序不会被当作可用解释器。'
}
function Resolve-CanvasCodex {
  param([string]$ExplicitPath)
  if (-not $ExplicitPath) { $ExplicitPath = $env:CODEX_CLI_PATH }
  $candidates = if ($ExplicitPath) { @($ExplicitPath) } else { @(Get-Command codex -All -ErrorAction SilentlyContinue | ForEach-Object Source) }
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      try { $null = & $candidate plugin add --help 2>$null; if ($LASTEXITCODE -eq 0) { return (Resolve-Path -LiteralPath $candidate).Path } } catch {}
    }
  }
  throw '找不到支持 plugin add 的 Codex CLI。请更新 Codex，或用 -CodexPath 指定当前桌面端提供的 CLI；不会另外安装或启动推理会话。'
}
function Resolve-CanvasPluginHelper {
  param([string]$ExplicitPath)
  $candidates = if ($ExplicitPath) { @($ExplicitPath) } else {
    if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'skills\.system\plugin-creator\scripts\create_basic_plugin.py' }
    Join-Path $env:USERPROFILE '.codex\skills\.system\plugin-creator\scripts\create_basic_plugin.py'
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Container) { $candidate = Join-Path $candidate 'scripts\create_basic_plugin.py' }
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $folder = Split-Path -Parent $candidate
      if ((Test-Path -LiteralPath (Join-Path $folder 'read_marketplace_name.py')) -and (Test-Path -LiteralPath (Join-Path $folder 'update_plugin_cachebuster.py'))) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
  }
  throw '未找到当前 Codex 的 plugin-creator 工具。请让 Codex 从已提供的技能位置定位，并传 -PluginCreatorPath；不会修改私人数据库或猜测插件协议。'
}
function Get-CanvasNpm {
  param([string]$NodePath)
  $npm = Join-Path (Split-Path -Parent $NodePath) 'npm.cmd'
  if (-not (Test-Path -LiteralPath $npm)) { throw '选中的 Node 目录缺少 npm.cmd，请使用完整的 Node 运行时。' }
  return $npm
}
