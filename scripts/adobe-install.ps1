param([string]$Registry='https://registry.npmmirror.com',[string]$NodePath)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime-paths.ps1')
$nodeExe=Resolve-CanvasNode $NodePath
$npmCmd=Get-CanvasNpm $nodeExe
$env:PATH=(Split-Path -Parent $nodeExe)+';'+$env:PATH
$destination=Join-Path $projectRoot 'vendor\photoshop-mcp'
$package='@alisaitteke/photoshop-mcp@1.7.16'
$integrity='sha512-qp6EpobTmu0YrsP9Akhj9Jl/2TBryKD5PPK7p94T68DR2HnzD75964yhDBp0GRpVT6Ni12ODzK1f/PpQPxOdmQ=='
if($Registry -notin @('https://registry.npmmirror.com','https://registry.npmjs.org')){throw 'Use the trusted mirror or official npm registry.'}
$actual=(& $npmCmd view $package dist.integrity "--registry=$Registry" 2>$null | Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $actual -ne $integrity){
  $Registry='https://registry.npmjs.org'
  $actual=(& $npmCmd view $package dist.integrity "--registry=$Registry" | Out-String).Trim()
  if($LASTEXITCODE -ne 0 -or $actual -ne $integrity){throw 'Package integrity could not be verified.'}
}
& $npmCmd install --prefix $destination --ignore-scripts --no-audit --no-fund "--registry=$Registry" $package
if($LASTEXITCODE -ne 0 -and $Registry -ne 'https://registry.npmjs.org') {
  & $npmCmd install --prefix $destination --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org $package
}
if($LASTEXITCODE -ne 0){throw 'Photoshop MCP 安装失败。请检查网络后重跑 scripts/adobe-install.ps1；基础画布与原生脚本可继续使用。'}
& $nodeExe -e "const fs=require('fs');const lock=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const entry=lock.packages['node_modules/@alisaitteke/photoshop-mcp'];if(entry?.version!=='1.7.16'||entry?.integrity!==process.argv[2])process.exit(1);" (Join-Path $destination 'package-lock.json') $integrity
if($LASTEXITCODE -ne 0){throw 'Photoshop MCP 安装包版本或摘要不符，不能报告安装成功。'}
Write-Output 'Installed isolated MCP server. No external AI account, Chat UI, global Codex config or Adobe application was started.'
