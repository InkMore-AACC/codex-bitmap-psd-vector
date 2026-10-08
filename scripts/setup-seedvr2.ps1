param([string]$PythonPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
. (Join-Path $PSScriptRoot 'runtime-paths.ps1')
$venvPython = Join-Path $projectRoot '.runtime\python\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
  $PythonPath = Resolve-CanvasPython $PythonPath
  & $PythonPath -m venv (Join-Path $projectRoot '.runtime\python')
  if ($LASTEXITCODE -ne 0) { throw '无法创建本地 Python 环境' }
}
& $venvPython -c "import torch, torchvision; assert torch.cuda.is_available()"
if ($LASTEXITCODE -ne 0) {
  if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) { throw 'SeedVR2 需要 NVIDIA CUDA 显卡' }
  & $venvPython -m pip install torch==2.7.1+cu128 torchvision==0.22.1+cu128 --index-url https://download.pytorch.org/whl/cu128
  if ($LASTEXITCODE -ne 0) { throw 'CUDA PyTorch 安装失败' }
}
& $venvPython -m pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple -r python/requirements-seedvr2.txt
if ($LASTEXITCODE -ne 0) { & $venvPython -m pip install --index-url https://pypi.org/simple -r python/requirements-seedvr2.txt }
if ($LASTEXITCODE -ne 0) { throw 'SeedVR2 依赖安装失败' }
& $venvPython -X utf8 python/download_seedvr2.py
if ($LASTEXITCODE -ne 0) { throw 'SeedVR2 下载或完整性校验失败' }
& $venvPython -X utf8 python/worker.py upscale-status --model seedvr2-7b-int8
if ($LASTEXITCODE -ne 0) { throw 'SeedVR2 状态检查失败' }
& $venvPython -X utf8 -c "import sys; sys.path.insert(0, 'python'); import seedvr2; s=seedvr2.status(); assert s['available'], s['message']"
if ($LASTEXITCODE -ne 0) { throw 'SeedVR2 尚未就绪' }
