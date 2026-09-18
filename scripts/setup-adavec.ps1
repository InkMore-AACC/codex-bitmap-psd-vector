param([switch]$SkipCheckpoint)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$modelPython = Join-Path $projectRoot '.runtime/python/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $modelPython)) { throw '先运行 setup-models.ps1 安装本地模型基础环境。' }
$adavecPython = Join-Path $projectRoot '.runtime/adavec/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $adavecPython)) {
  & $modelPython -m venv --system-site-packages (Join-Path $projectRoot '.runtime/adavec')
  if ($LASTEXITCODE -ne 0) { throw '无法创建 AdaVec 隔离环境' }
}
# Read-only reuse of large Torch/CUDA packages; pip installs go to AdaVec's own environment.
$sharedModels = Join-Path $projectRoot '.runtime/python/Lib/site-packages'
Set-Content -LiteralPath (Join-Path $projectRoot '.runtime/adavec/Lib/site-packages/layer_canvas_shared_models.pth') -Value $sharedModels -Encoding utf8
& $adavecPython -m pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple -r python/requirements-adavec.txt
if ($LASTEXITCODE -ne 0) {
  & $adavecPython -m pip install --index-url https://pypi.org/simple -r python/requirements-adavec.txt
  if ($LASTEXITCODE -ne 0) { throw 'AdaVec Python 依赖安装失败' }
}
$adavecSource = Join-Path $projectRoot 'vendor/AdaVec'
if (-not (Test-Path -LiteralPath (Join-Path $adavecSource 'main.py'))) {
  git clone https://github.com/IMU-Group/AdaVec.git $adavecSource
  if ($LASTEXITCODE -ne 0) { throw 'AdaVec 官方源码下载失败' }
}
git -C $adavecSource checkout d4c03c3480d9ab595f729e59a33b596bef9bec3f
if ($LASTEXITCODE -ne 0) { throw 'AdaVec 版本校验失败' }
$thrustSource = Join-Path $projectRoot 'vendor/adavec-thrust'
if (-not (Test-Path -LiteralPath (Join-Path $thrustSource 'thrust/version.h'))) {
  git clone --depth 1 --branch 1.17.2 https://github.com/NVIDIA/thrust.git $thrustSource
  if ($LASTEXITCODE -ne 0) { throw 'NVIDIA Thrust 官方头文件下载失败' }
}
$thrustRevision = git -C $thrustSource rev-parse HEAD
if ($thrustRevision -ne '1ac51f2b6219ff17d15d93f2e0be85038556f346') { throw 'Thrust 版本与已验证构建版本不一致，未继续编译。' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw '缺少 Microsoft Visual Studio 2022 C++ Build Tools；安装 C++ 工作负载后重试。' }
$compiler = & $vswhere -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $compiler) { throw '缺少 MSVC C++ 编译器或安装尚未完成。' }
& $adavecPython python/build_adavec_diffvg.py
if ($LASTEXITCODE -ne 0) { throw 'DiffVG 原生 CPU 渲染器编译失败，未启用替代矢量引擎。' }
if (-not $SkipCheckpoint) {
  & $adavecPython python/download_adavec.py
  if ($LASTEXITCODE -ne 0) { throw 'SAM 权重下载或完整性校验失败' }
}
& $adavecPython python/adavec_adapter.py --status
if ($LASTEXITCODE -ne 0) { throw 'AdaVec 状态检查失败' }
