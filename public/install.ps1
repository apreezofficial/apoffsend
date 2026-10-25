# ApOffSend installer for Windows
#   irm https://raw.githubusercontent.com/apreezofficial/apoffsend/main/public/install.ps1 | iex
# Installs to %LOCALAPPDATA%\ApOffSend and adds Desktop + Start Menu shortcuts.
# Your transferred files live in %USERPROFILE%\ApOffSend and are never touched.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$dest = Join-Path $env:LOCALAPPDATA 'ApOffSend'
$zip = Join-Path $env:TEMP 'apoffsend.zip'
$tmp = Join-Path $env:TEMP 'apoffsend-extract'

Write-Host ''
Write-Host '  ApOffSend installer' -ForegroundColor DarkYellow
Write-Host ''

Write-Host '  Downloading...'
Invoke-WebRequest 'https://github.com/apreezofficial/apoffsend/archive/refs/heads/main.zip' -OutFile $zip -UseBasicParsing

if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive $zip $tmp -Force
$src = Get-ChildItem $tmp -Directory | Select-Object -First 1
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Move-Item $src.FullName $dest
Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "  Installed to $dest"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host '  Node.js not found - installing it with winget...'
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  } else {
    Write-Host '  Node.js is required. Install it from https://nodejs.org, then open ApOffSend from your desktop.' -ForegroundColor Yellow
  }
}

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'ApOffSend.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'ApOffSend.lnk')
)
foreach ($path in $targets) {
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = Join-Path $dest 'start.bat'
  $lnk.WorkingDirectory = $dest
  $lnk.Description = 'Send files between this PC and your phone'
  $lnk.IconLocation = "$env:SystemRoot\System32\imageres.dll,-25"
  $lnk.Save()
}
Write-Host '  Added ApOffSend to your Desktop and Start Menu.'
Write-Host ''

if (Get-Command node -ErrorAction SilentlyContinue) {
  Write-Host '  Starting ApOffSend...' -ForegroundColor Green
  Start-Process (Join-Path $dest 'start.bat') -WorkingDirectory $dest
}
