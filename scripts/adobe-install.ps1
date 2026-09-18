param([string]$Registry='https://registry.npmmirror.com')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$destination=Join-Path $projectRoot 'vendor\photoshop-mcp'
$package='@alisaitteke/photoshop-mcp@1.7.16'
$integrity='sha512-qp6EpobTmu0YrsP9Akhj9Jl/2TBryKD5PPK7p94T68DR2HnzD75964yhDBp0GRpVT6Ni12ODzK1f/PpQPxOdmQ=='
if($Registry -notin @('https://registry.npmmirror.com','https://registry.npmjs.org')){throw 'Use the trusted mirror or official npm registry.'}
$actual=(& npm.cmd view $package dist.integrity "--registry=$Registry" 2>$null | Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $actual -ne $integrity){
  $Registry='https://registry.npmjs.org'
  $actual=(& npm.cmd view $package dist.integrity "--registry=$Registry" | Out-String).Trim()
  if($LASTEXITCODE -ne 0 -or $actual -ne $integrity){throw 'Package integrity could not be verified.'}
}
& npm.cmd install --prefix $destination --ignore-scripts --no-audit --no-fund "--registry=$Registry" $package
if($LASTEXITCODE -ne 0){throw 'Photoshop MCP installation failed.'}
Write-Output 'Installed isolated MCP server. No external AI account, Chat UI, global Codex config or Adobe application was started.'
