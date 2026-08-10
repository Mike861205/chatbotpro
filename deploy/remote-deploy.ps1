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
if ($HealthUrl -notmatch '^http://127\.0\.0\.1:[0-9]{2,5}/[A-Za-z0-9._~/?=&%-]*$') { throw "HealthUrl debe apuntar a localhost y contener una ruta segura" }

# El restart de PM2 puede devolver código 0 aunque Node falle segundos después.
# El deploy sólo se considera exitoso cuando la aplicación responde realmente.
$remoteCmd = @'
set -eu
cd "__APP_DIR__"
git fetch origin "__BRANCH__" --prune
if [ "__FORCE_DEPLOY__" = "1" ]; then
  echo '==> Modo forzado: descartando cambios remotos'
  git reset --hard "origin/__BRANCH__"
  git clean -fd
else
  # Se comprueban por separado cambios rastreados, preparados y archivos nuevos.
  if ! git diff --quiet --ignore-submodules -- || \
     ! git diff --cached --quiet --ignore-submodules -- || \
     git ls-files --others --exclude-standard | grep -q .; then
    echo 'ERROR: el servidor tiene cambios locales. Revisa los archivos o activa Forzar.' >&2
    git status --short >&2
    exit 2
  fi
  git merge --ff-only "origin/__BRANCH__"
fi
npm ci --omit=dev
echo '==> Recargando PM2 con configuración de producción'
pm2 startOrReload ecosystem.config.js --only "__PM2_APP__" --env production --update-env
echo '==> Esperando a que la aplicación inicie en __HEALTH_URL__'
i=1
while [ "$i" -le 45 ]; do
  if curl -fsS --max-time 5 "__HEALTH_URL__" >/dev/null 2>&1; then
    pm2 save
    echo "==> Commit activo: $(git log -1 --oneline)"
    echo '==> Deploy OK: health check exitoso'
    exit 0
  fi
  if [ $((i % 5)) -eq 0 ]; then
    echo "    Inicio en progreso... intento $i de 45"
  fi
  sleep 2
  i=$((i + 1))
done
echo 'ERROR: la aplicación no respondió en __HEALTH_URL__ después de 90 segundos' >&2
pm2 status "__PM2_APP__" >&2
pm2 logs "__PM2_APP__" --lines 80 --nostream >&2
exit 1
'@
$forceDeployValue = if ($Force) { "1" } else { "0" }
$remoteCmd = $remoteCmd.Replace('__APP_DIR__', $AppDir).Replace('__BRANCH__', $Branch).Replace('__PM2_APP__', $Pm2App).Replace('__HEALTH_URL__', $HealthUrl).Replace('__FORCE_DEPLOY__', $forceDeployValue)
$remoteCmdLf = $remoteCmd.Replace("`r`n", "`n")
$remoteCmdBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteCmdLf))

$sshArgs = @(
  "-p", "$Port",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=30",
  "-o", "StrictHostKeyChecking=accept-new"
)
if ($IdentityFile -and $IdentityFile.Trim().Length -gt 0) {
  $sshArgs += @("-i", $IdentityFile)
}
# El script viaja en Base64 porque el paso directo como argumento de un proceso
# nativo en Windows puede eliminar comillas y reinterpretar caracteres como >.
$sshArgs += @("$User@$RemoteHost", "printf %s $remoteCmdBase64 | base64 -d | bash")

Write-Host "Running remote deploy on ${User}@${RemoteHost}:$Port ..." -ForegroundColor Cyan
& ssh @sshArgs
if ($LASTEXITCODE -ne 0) {
  Write-Error "SSH deploy failed with exit code $LASTEXITCODE"
  exit $LASTEXITCODE
}
