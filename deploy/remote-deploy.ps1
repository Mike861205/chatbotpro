param(
  [string]$RemoteHost = "50.28.103.1",
  [string]$User = "root",
  [int]$Port = 22,
  [string]$AppDir = "/var/www/chatbotpro",
  [string]$Branch = "main",
  [string]$Pm2App = "chatbotpro",
  [switch]$Force,
  [string]$IdentityFile = ""
)

$ErrorActionPreference = "Stop"

# Siempre reset --hard + clean: más robusto que pull en servidores con archivos extra
$remoteCmd = "cd $AppDir && git fetch origin $Branch --prune && git reset --hard origin/$Branch && git clean -fd && npm ci --omit=dev && pm2 restart $Pm2App && pm2 save && echo '==> Deploy OK'"

$sshArgs = @(
  "-p", "$Port",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=30",
  "-o", "StrictHostKeyChecking=accept-new"
)
if ($IdentityFile -and $IdentityFile.Trim().Length -gt 0) {
  $sshArgs += @("-i", $IdentityFile)
}
$sshArgs += @("$User@$RemoteHost", $remoteCmd)

Write-Host "Running remote deploy on ${User}@${RemoteHost}:$Port ..." -ForegroundColor Cyan
& ssh @sshArgs
if ($LASTEXITCODE -ne 0) {
  Write-Error "SSH deploy failed with exit code $LASTEXITCODE"
  exit $LASTEXITCODE
}
