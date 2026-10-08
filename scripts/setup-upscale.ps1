param([string]$PythonPath)
# Compatibility alias; only SeedVR2 is installed.
& (Join-Path $PSScriptRoot 'setup-seedvr2.ps1') -PythonPath $PythonPath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
