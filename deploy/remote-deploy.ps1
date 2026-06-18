param(
  [string]$Host = "50.28.103.1",
  [string]$User = "root",
  [int]$Port = 22,
  [string]$AppDir = "/var/www/chatbotpro",
  [switch]$Force,
  [string]$IdentityFile = ""
)

$ErrorActionPreference = "Stop"

$forceArg = if ($Force.IsPresent) { " --force" } else { "" }
$remoteCmd = "cd $AppDir && chmod +x deploy/quick-deploy.sh && ./deploy/quick-deploy.sh$forceArg"

$sshArgs = @("-p", "$Port")
if ($IdentityFile -and $IdentityFile.Trim().Length -gt 0) {
  $sshArgs += @("-i", $IdentityFile)
}
$sshArgs += @("$User@$Host", $remoteCmd)

Write-Host "Running remote deploy on $User@$Host:$Port ..." -ForegroundColor Cyan
& ssh @sshArgs
