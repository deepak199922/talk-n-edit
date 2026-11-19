# Talk-n-Edit installer for Windows. Paste this into PowerShell:
#   irm https://raw.githubusercontent.com/deepak199922/talk-n-edit/main/install.ps1 | iex
# It downloads Talk-n-Edit to %USERPROFILE%\talk-n-edit (or updates it if it's already there) and runs the setup.
# Choose another folder first with:  $env:TALK_N_EDIT_DIR = 'D:\somewhere'
# (Plain ASCII on purpose: Windows PowerShell 5.1 misreads other characters.)

$ErrorActionPreference = 'Stop'
$repo = 'https://github.com/deepak199922/talk-n-edit.git'
$dir = if ($env:TALK_N_EDIT_DIR) { $env:TALK_N_EDIT_DIR } else { Join-Path $HOME 'talk-n-edit' }

function Say($t)  { Write-Host ""; Write-Host $t -ForegroundColor Cyan }
function Warn($t) { Write-Host "  !   $t" -ForegroundColor Yellow }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }

& {
  Say "Talk-n-Edit installer"
  if ($env:OS -ne 'Windows_NT') { Warn "This installer is for Windows. On a Mac, use install.sh (see the README)."; return }

  # git downloads Talk-n-Edit and its updates.
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      Warn "Git is needed. Install it from https://git-scm.com/download/win (or install 'App Installer' from the Microsoft Store for winget), then run this installer again."
      return
    }
    Say "Installing Git with winget"
    $ErrorActionPreference = 'Continue'
    & winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements --disable-interactivity
    $ErrorActionPreference = 'Stop'
    Refresh-Path
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Warn "Git finished installing but isn't on the PATH yet. Open a new PowerShell window and run this installer again."; return }
  }

  $ErrorActionPreference = 'Continue'
  if (Test-Path (Join-Path $dir '.git')) {
    Say "Updating Talk-n-Edit in $dir"
    & git -C $dir pull --ff-only
    if ($LASTEXITCODE -ne 0) { Warn "Couldn't update automatically (did you change files there?). Run: git -C `"$dir`" status"; return }
  } elseif (Test-Path $dir) {
    Warn "$dir already exists and isn't a Talk-n-Edit download."
    Warn "Move or rename it, or pick another folder first:  `$env:TALK_N_EDIT_DIR = 'D:\somewhere'"
    return
  } else {
    Say "Downloading Talk-n-Edit to $dir"
    & git clone --depth 1 $repo $dir
    if ($LASTEXITCODE -ne 0) { Warn "Download failed. Check your internet connection and try again."; return }
  }

  # Run the setup in its own PowerShell, allowed to run this one script whatever the machine's policy.
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'scripts\setup_windows.ps1')
}
