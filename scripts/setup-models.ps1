param([switch]$CpuOnly, [switch]$FineMatting, [string]$PythonPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
. (Join-Path $PSScriptRoot 'runtime-paths.ps1')
$PythonPath=Resolve-CanvasPython $PythonPath
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
if ($FineMatting) {
  & $venvPython -c "import torch, torchvision; print('Existing PyTorch:', torch.__version__)"
  if ($LASTEXITCODE -ne 0) {
    if ($CpuOnly -or -not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
      & $venvPython -m pip install torch==2.7.1 torchvision==0.22.1 --index-url https://pypi.tuna.tsinghua.edu.cn/simple
      if ($LASTEXITCODE -ne 0) { & $venvPython -m pip install torch==2.7.1 torchvision==0.22.1 --index-url https://download.pytorch.org/whl/cpu }
    } else {
      # No verified mainland CUDA wheel index is configured; use the official wheel source.
      & $venvPython -m pip install torch==2.7.1 torchvision==0.22.1 --index-url https://download.pytorch.org/whl/cu128
    }
    if ($LASTEXITCODE -ne 0) { throw 'PyTorch 安装失败' }
  }
  & $venvPython -m pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple -r python/requirements-matting.txt
  if ($LASTEXITCODE -ne 0) { & $venvPython -m pip install --index-url https://pypi.org/simple -r python/requirements-matting.txt }
  if ($LASTEXITCODE -ne 0) { throw '精细抠图依赖安装失败' }
  & $venvPython python/download_matting.py
  if ($LASTEXITCODE -ne 0) { throw '精细抠图模型下载或校验失败' }
}
& $venvPython python/worker.py status
if ($LASTEXITCODE -ne 0) { throw '模型状态检查失败' }
