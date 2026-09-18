param(
  [Parameter(Mandatory=$true)][ValidateSet('photoshop','illustrator')][string]$App,
  [ValidateSet('Probe','Run')][string]$Operation='Probe',
  [string]$ScriptPath
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$progid=if($App -eq 'photoshop'){'Photoshop.Application'}else{'Illustrator.Application'}
$registered=$null -ne [Type]::GetTypeFromProgID($progid)
$application=$null
try {
  try {$application=[Runtime.InteropServices.Marshal]::GetActiveObject($progid)} catch {}
  if($Operation -eq 'Probe') {
    $status=@{installed=$registered;running=($null -ne $application);route='com';application=$App}
    $status.scriptConnected=$false
    if($application){
      $status.version=[string]$application.Version;$status.documentCount=[int]$application.Documents.Count
      try {$reply=[string]$application.DoJavaScript('app.version');$status.scriptConnected= -not [string]::IsNullOrWhiteSpace($reply)} catch {$status.scriptError=$_.Exception.Message}
    }
    $status | ConvertTo-Json -Compress
  } else {
    if(-not $registered){throw "Adobe application is not registered: $progid"}
    if(-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)){throw 'Script file missing'}
    if(-not $application){$application=New-Object -ComObject $progid}
    $source=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $ScriptPath).Path,[Text.Encoding]::UTF8)
    $result=if($App -eq 'photoshop'){$application.DoJavaScript($source)}else{$application.DoJavaScript($source)}
    @{application=$App;version=[string]$application.Version;result=[string]$result} | ConvertTo-Json -Compress -Depth 8
  }
} finally {
  if($application){[void][Runtime.InteropServices.Marshal]::ReleaseComObject($application)}
}
