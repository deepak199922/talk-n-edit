# Talk-n-Edit: one-time Windows setup + Claude Desktop connector.
# Usually run for you by install.ps1. To run it yourself, in PowerShell:
#   cd $HOME\talk-n-edit; powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1
# Safe to run again (that's also how you update). It never deletes files, and it backs up
# your Claude config before changing it.
# (Plain ASCII on purpose: Windows PowerShell 5.1 misreads other characters in scripts.)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-Location (Split-Path -Parent $PSScriptRoot)
$ROOT = (Get-Location).Path

function Say($t)  { Write-Host ""; Write-Host $t -ForegroundColor Cyan }
function Ok($t)   { Write-Host "  OK  $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  !   $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host ""; Write-Host "  X   $t" -ForegroundColor Red; exit 1 }

# Run a program; stop with a clear message if it fails. (Native programs write progress to stderr,
# which Windows PowerShell would otherwise treat as an error.)
function Run {
  param([string]$What, [string]$Exe, [string[]]$Arguments)
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & $Exe @Arguments
  $code = $LASTEXITCODE
  $ErrorActionPreference = $old
  if ($code -ne 0) { Fail "$What failed (exit code $code). Scroll up for the reason, fix it, then run this setup again." }
}

# Ask a program something; returns its output as one string, or "" if it can't run.
function Ask {
  param([string]$Exe, [string[]]$Arguments)
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & $Exe @Arguments 2>$null } catch { $out = "" }
  $ErrorActionPreference = $old
  return (($out | Out-String).Trim())
}

# Newly installed programs are on the PATH of new windows only; reload it for this one.
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Winget-Install($id, $label) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Fail "$label is needed, and winget (Windows' package installer) isn't available. Install 'App Installer' from the Microsoft Store, or install $label yourself, then run this setup again."
  }
  Warn "Installing $label with winget (this can take a few minutes)..."
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & winget install --id $id -e --accept-source-agreements --accept-package-agreements --disable-interactivity
  $ErrorActionPreference = $old
  Refresh-Path
}

function Has-Subtitles($exe) {
  if (-not $exe -or -not (Test-Path $exe)) { return $false }
  return ((Ask $exe @('-hide_banner', '-filters')) -match ' subtitles ')
}

# ffmpeg.exe from PATH or from where winget puts Gyan's build.
function Find-Ffmpeg {
  $cands = @()
  $c = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($c) { $cands += $c.Source }
  $links = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\ffmpeg.exe'
  if (Test-Path $links) { $cands += $links }
  $pkgs = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  if (Test-Path $pkgs) {
    Get-ChildItem $pkgs -Directory -Filter 'Gyan.FFmpeg*' -ErrorAction SilentlyContinue | ForEach-Object {
      Get-ChildItem $_.FullName -Recurse -Filter 'ffmpeg.exe' -ErrorAction SilentlyContinue | ForEach-Object { $cands += $_.FullName }
    }
  }
  foreach ($x in $cands) { if (Has-Subtitles $x) { return $x } }
  return $null
}

if ($env:OS -ne 'Windows_NT') { Fail "This script is for Windows. On a Mac use scripts/setup_mac.sh." }
if (-not [Environment]::Is64BitOperatingSystem) { Fail "Talk-n-Edit needs 64-bit Windows." }

Say "1/7  Checking tools"
$FFMPEG = Find-Ffmpeg
if (-not $FFMPEG) {
  # Gyan's "full" build includes libass, which captions need.
  Winget-Install 'Gyan.FFmpeg' 'ffmpeg (with captions support)'
  $FFMPEG = Find-Ffmpeg
}
if (-not $FFMPEG) { Fail "Couldn't get an ffmpeg that can draw captions (libass). Run 'winget install Gyan.FFmpeg', open a new PowerShell window and run this setup again." }
$ffv = ((Ask $FFMPEG @('-version')) -split "`n")[0]
Ok "$ffv"
Ok "  at $FFMPEG"

$needNode = $true
if (Get-Command node -ErrorAction SilentlyContinue) {
  $v = Ask node @('-p', 'process.versions.node')
  $p = $v.Split('.')
  if ([int]$p[0] -gt 22 -or ([int]$p[0] -eq 22 -and [int]$p[1] -ge 13)) { $needNode = $false }
}
if ($needNode) { Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js' }
$NODE = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NODE) { Fail "Node.js isn't available. Install it from https://nodejs.org (LTS), open a new PowerShell window and run this setup again." }
Ok "Node $(Ask $NODE @('-v')) at $NODE"

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { Winget-Install 'astral-sh.uv' 'uv (Python manager)' }
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { Fail "uv isn't available. See https://docs.astral.sh/uv/ to install it, then run this setup again." }
Ok "uv $(Ask uv @('--version'))"

# The speech and face models need Microsoft's C++ runtime (most PCs already have it).
$vcKey = 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64'
$vc = Get-ItemProperty $vcKey -ErrorAction SilentlyContinue
if ((-not $vc -or $vc.Installed -ne 1) -and (Get-Command winget -ErrorAction SilentlyContinue)) {
  Winget-Install 'Microsoft.VCRedist.2015+.x64' 'Microsoft Visual C++ runtime'
  $vc = Get-ItemProperty $vcKey -ErrorAction SilentlyContinue
}
if ($vc -and $vc.Installed -eq 1) { Ok "Microsoft Visual C++ runtime" }
else { Warn "Couldn't confirm the Microsoft Visual C++ runtime. If transcription fails, install it from https://aka.ms/vs/17/release/vc_redist.x64.exe" }

Say "2/7  Building the server"
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = Join-Path (Split-Path $NODE) 'npm.cmd' }
Run "npm install" $npm @('install', '--no-audit', '--no-fund', '--loglevel=error')
Run "Build" $npm @('run', 'build', '--silent')
Ok "Built dist\"

Say "3/7  Python environment (transcription, faces, scenes, downloads)"
$PY = Join-Path $ROOT 'python\.venv\Scripts\python.exe'
Push-Location python
if (-not (Test-Path $PY)) { Run "Creating the Python environment" 'uv' @('venv', '--python', '3.12', '.venv') }
Run "Installing Python packages" 'uv' @('pip', 'install', '--python', $PY, '-r', 'pyproject.toml')
# Sites change often, so always take the newest downloader.
$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& uv pip install --python $PY -q --upgrade 'yt-dlp[default]'
if ($LASTEXITCODE -ne 0) { Warn "Couldn't update yt-dlp now; link downloads may fail until it updates." }
$ErrorActionPreference = $old
Pop-Location
Ok "Installed into python\.venv (yt-dlp $(Ask $PY @('-m', 'yt_dlp', '--version')))"

$PATHS = (Ask $NODE @('--disable-warning=ExperimentalWarning', 'dist\index.js', '--paths')) | ConvertFrom-Json
$MODEL = $PATHS.whisperModel

Say "4/7  Speech model (one time: about 470 MB for small, 140 MB for base)"
$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& $PY -c "from faster_whisper import download_model; download_model('$MODEL'); print('  OK  Whisper $MODEL ready')"
if ($LASTEXITCODE -ne 0) { Warn "Couldn't download the speech model now. It downloads automatically the first time you transcribe." }
$ErrorActionPreference = $old
if ($MODEL -eq 'base') { Ok "This PC has under 6 GB of memory, so the lighter 'base' model is used (change whisperModel in config.json for more accuracy)." }

Say "5/7  Browser for animated graphics (one time, about 100 MB)"
$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& $NODE -e "import('@remotion/renderer').then(m => m.ensureBrowser()).then(() => process.exit(0), e => { console.error(e.message); process.exit(1); })"
if ($LASTEXITCODE -eq 0) { Ok "Headless browser ready" } else { Warn "Couldn't download the headless browser now; it downloads on the first animated graphic." }
$ErrorActionPreference = $old

Say "6/7  Your folders"
$WORKSPACE = $PATHS.workspace; $INBOX = $PATHS.inbox; $CLIPS = $PATHS.clips
foreach ($d in @($WORKSPACE, $INBOX, $CLIPS, (Join-Path $WORKSPACE 'tmp'))) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
Ok "Put videos in:  $INBOX"
Ok "Finished clips: $CLIPS"
Ok "Working files:  $WORKSPACE"
$CHECK = Join-Path $WORKSPACE 'setup-check.json'
$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& $NODE --disable-warning=ExperimentalWarning dist\index.js --check *> $CHECK
$checkCode = $LASTEXITCODE
$ErrorActionPreference = $old
if ($checkCode -eq 0) { Ok "Self-check passed" } else { Warn "Self-check found problems:"; Get-Content $CHECK -Tail 25 | ForEach-Object { Write-Host "      $_" } }

# The skill teaches Claude how to edit well. Claude installs skills from a ZIP you upload.
# Built with forward-slash entry names (Compress-Archive on Windows PowerShell writes backslashes).
$DOWNLOADS = Join-Path $HOME 'Downloads'
New-Item -ItemType Directory -Force -Path $DOWNLOADS | Out-Null
$SKILL_ZIP = Join-Path $DOWNLOADS 'talk-n-edit-skill.zip'
$TMPZIP = Join-Path $WORKSPACE "tmp\talk-n-edit-skill-$PID.zip"
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$skillDir = Join-Path $ROOT 'skills\talk-n-edit'
$zip = [System.IO.Compression.ZipFile]::Open($TMPZIP, 'Create')
try {
  Get-ChildItem $skillDir -Recurse -File | Where-Object { $_.Name -ne '.DS_Store' } | ForEach-Object {
    $rel = 'talk-n-edit/' + $_.FullName.Substring($skillDir.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel) | Out-Null
  }
} finally { $zip.Dispose() }
Move-Item -Force $TMPZIP $SKILL_ZIP
Ok "Skill package:  $SKILL_ZIP"

Say "7/7  Connecting to the Claude desktop app"
# The installer version keeps its config in %APPDATA%\Claude; the Microsoft Store version
# in its own package folder. Update whichever exist (the first one always).
$cfgs = @(Join-Path $env:APPDATA 'Claude\claude_desktop_config.json')
Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter '*Claude*' -ErrorAction SilentlyContinue | ForEach-Object {
  $d = Join-Path $_.FullName 'LocalCache\Roaming\Claude'
  if (Test-Path $d) { $cfgs += (Join-Path $d 'claude_desktop_config.json') }
}
$js = @'
const fs = require("fs");
const path = require("path");
const [cfg, root, node] = process.argv.slice(2);
let data = {};
if (fs.existsSync(cfg) && fs.statSync(cfg).size > 0) data = JSON.parse(fs.readFileSync(cfg, "utf8").replace(/^\uFEFF/, ""));
data.mcpServers = data.mcpServers || {};
if (data.mcpServers["video-studio"]) {
  delete data.mcpServers["video-studio"];
  console.log("  OK  Replaced the old video-studio connector (Talk-n-Edit's earlier name)");
}
data.mcpServers["talk-n-edit"] = { command: node, args: ["--disable-warning=ExperimentalWarning", path.join(root, "dist", "index.js")] };
fs.mkdirSync(path.dirname(cfg), { recursive: true });
fs.writeFileSync(cfg, JSON.stringify(data, null, 2));
console.log("  OK  Added the talk-n-edit connector to " + cfg + " (your other connectors are unchanged)");
'@
$jsFile = Join-Path $WORKSPACE 'tmp\connect-claude.js'
[System.IO.File]::WriteAllText($jsFile, $js, (New-Object System.Text.UTF8Encoding $false))
foreach ($cfg in $cfgs) {
  if (Test-Path $cfg) {
    $b = "$cfg.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $cfg $b
    Ok "Backed up your current config to: $b"
  }
  Run "Updating the Claude config" $NODE @($jsFile, $cfg, $ROOT, $NODE)
}

Write-Host ""
Write-Host "  All set. Three last steps:" -ForegroundColor Green
Write-Host ""
Write-Host "  1. Quit the Claude app completely (right-click its icon by the clock -> Quit; closing the"
Write-Host "     window isn't enough) and open it again."
Write-Host "  2. Add the skill: in Claude, open Customize -> Skills -> '+' -> Create skill ->"
Write-Host "     Upload a skill, and choose  $SKILL_ZIP"
Write-Host "  3. Drop a video into  $INBOX"
Write-Host "     and ask Claude: `"Make 3 Reels from the video in my Talk-n-Edit inbox.`""
Write-Host ""
if ([Environment]::UserInteractive -and -not $env:CI) { Start-Process explorer.exe "/select,`"$SKILL_ZIP`"" -ErrorAction SilentlyContinue }
