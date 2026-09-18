param([switch]$CpuOnly, [string]$PythonPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not $PythonPath) {
  $bundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
  if (Test-Path -LiteralPath $bundledPython) { $PythonPath = $bundledPython }
  elseif (Get-Command python -ErrorAction SilentlyContinue) { $PythonPath = (Get-Command python).Source }
  else { throw '需要 Python 3.10–3.12。可通过 -PythonPath 指定现有解释器。' }
}
$venvPython = Join-Path $projectRoot '.runtime\python\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
  & $PythonPath -m venv (Join-Path $projectRoot '.runtime\python')
  if ($LASTEXITCODE -ne 0) { throw '无法创建独立 Python 环境' }
}
# Mainland trusted PyPI mirror first; official PyPI only if mirror install fails.
& $venvPython -m pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple -r python/requirements.txt
if ($LASTEXITCODE -ne 0) {
  & $venvPython -m pip install --index-url https://pypi.org/simple -r python/requirements.txt
  if ($LASTEXITCODE -ne 0) { throw 'Python 依赖安装失败' }
}
& $venvPython python/download_models.py
if ($LASTEXITCODE -ne 0) { throw '模型下载或完整性校验失败' }
& $venvPython python/worker.py status
if ($LASTEXITCODE -ne 0) { throw '模型状态检查失败' }
