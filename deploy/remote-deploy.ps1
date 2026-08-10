param(
  [string]$RemoteHost = "50.28.103.1",
  [string]$User = "root",
  [int]$Port = 22,
  [string]$AppDir = "/var/www/chatbotpro",
  [string]$Branch = "main",
  [string]$Pm2App = "chatbotpro",
  [string]$HealthUrl = "http://127.0.0.1:3003/",
  [switch]$Force,
  [string]$IdentityFile = ""
)

$ErrorActionPreference = "Stop"

if ($AppDir -notmatch '^/[A-Za-z0-9._/-]+$') { throw "AppDir remoto no válido" }
if ($Branch -notmatch '^[A-Za-z0-9._/-]+$') { throw "Branch no válido" }
if ($Pm2App -notmatch '^[A-Za-z0-9._-]+$') { throw "Nombre PM2 no válido" }
if ($HealthUrl -notmatch '^http://127\.0\.0\.1:[0-9]{2,5}/') { throw "HealthUrl debe apuntar a localhost" }

# El restart de PM2 puede devolver código 0 aunque Node falle segundos después.
# El deploy sólo se considera exitoso cuando la aplicación responde realmente.
$remoteCmd = @'
set -eu
cd "__APP_DIR__"
git fetch origin "__BRANCH__" --prune
git reset --hard "origin/__BRANCH__"
git clean -fd
npm ci --omit=dev
pm2 restart "__PM2_APP__"
i=1
while [ "$i" -le 30 ]; do
  if curl -fsS --max-time 5 "__HEALTH_URL__" >/dev/null; then
    pm2 save
    echo '==> Deploy OK: health check exitoso'
    exit 0
  fi
  sleep 2
  i=$((i + 1))
done
echo 'ERROR: la aplicación no respondió después del restart' >&2
pm2 logs "__PM2_APP__" --lines 80 --nostream >&2
exit 1
'@
$remoteCmd = $remoteCmd.Replace('__APP_DIR__', $AppDir).Replace('__BRANCH__', $Branch).Replace('__PM2_APP__', $Pm2App).Replace('__HEALTH_URL__', $HealthUrl)

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
