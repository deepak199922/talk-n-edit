#!/usr/bin/env bash
# Talk-n-Edit: one-time Mac setup + Claude Desktop connector.
# Usually run for you by install.sh. To run it yourself:  cd ~/talk-n-edit && bash scripts/setup_mac.sh
# Safe to run again (that's also how you update). It never deletes files, and it backs up
# your Claude config before changing it.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
say(){ printf "\n\033[1m%s\033[0m\n" "$*"; }
ok(){ printf "  ✓ %s\n" "$*"; }
warn(){ printf "  ! %s\n" "$*"; }

if [ "$(uname -s)" != "Darwin" ]; then
  warn "This script is for macOS. For other systems, see 'Other systems' in README.md."; exit 1
fi

say "1/7  Checking tools"
if ! command -v brew >/dev/null 2>&1; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do if [ -x "$b" ]; then eval "$("$b" shellenv)"; break; fi; done
fi
if ! command -v brew >/dev/null 2>&1; then
  warn "Homebrew isn't installed. Install it from https://brew.sh (or use install.sh, which can do it for you), then run this script again."; exit 1
fi
ok "Homebrew"
# Captions need ffmpeg built with libass. Homebrew's regular "ffmpeg" no longer has it,
# so use its "ffmpeg-full" formula (installed side by side; your regular ffmpeg is left alone).
# (Read the whole list first: piping into grep -q would cut ffmpeg off and, with pipefail, report failure.)
has_subtitles(){ local f; f="$("$1" -hide_banner -filters 2>/dev/null || true)"; case "$f" in *" subtitles "*) return 0 ;; *) return 1 ;; esac; }
FULL="$(brew --prefix)/opt/ffmpeg-full/bin/ffmpeg"
FFMPEG=""
if [ -x "$FULL" ] && has_subtitles "$FULL"; then FFMPEG="$FULL"
elif command -v ffmpeg >/dev/null 2>&1 && has_subtitles "$(command -v ffmpeg)"; then FFMPEG="$(command -v ffmpeg)"
else
  warn "Installing Homebrew's ffmpeg-full (needed for captions; this can take a few minutes)…"
  brew install ffmpeg-full
  if [ -x "$FULL" ] && has_subtitles "$FULL"; then FFMPEG="$FULL"; fi
fi
if [ -z "$FFMPEG" ]; then
  warn "Couldn't get an ffmpeg that can draw captions (libass). Run 'brew install ffmpeg-full' and then this script again."; exit 1
fi
ok "ffmpeg $("$FFMPEG" -version | head -1 | awk '{print $3}') with captions support ($FFMPEG)"
need_node=1
if command -v node >/dev/null 2>&1; then
  v="$(node -p 'process.versions.node')"; maj="${v%%.*}"; rest="${v#*.}"; min="${rest%%.*}"
  if [ "$maj" -gt 22 ] || { [ "$maj" -eq 22 ] && [ "$min" -ge 13 ]; }; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then brew install node; fi
NODE="$(command -v node)"
ok "Node $(node -v) at $NODE"
command -v uv >/dev/null 2>&1 || brew install uv
ok "uv $(uv --version | awk '{print $2}')"

say "2/7  Building the server"
npm install --no-audit --no-fund --loglevel=error
npm run build --silent
ok "Built dist/"

say "3/7  Python analysis environment (transcription, faces, scenes)"
cd python
[ -x .venv/bin/python ] || uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r pyproject.toml   # shows download progress
cd "$ROOT"
ok "Installed into python/.venv"

say "4/7  Speech model (one time, about 1.6 GB)"
if [ "$(uname -m)" = "arm64" ]; then
  python/.venv/bin/python - <<'PY'
from huggingface_hub import snapshot_download
try:
    snapshot_download("mlx-community/whisper-large-v3-turbo")
    print("  ✓ Whisper large-v3-turbo ready")
except Exception as e:
    print("  ! Couldn't download the speech model now:", str(e)[:200])
    print("    It will download automatically the first time you transcribe.")
PY
else
  ok "Intel Mac: the speech model (Whisper small) downloads the first time you transcribe"
fi

say "5/7  Browser for animated graphics (one time, about 100 MB)"
if "$NODE" -e "import('@remotion/renderer').then(m => m.ensureBrowser()).then(() => process.exit(0), e => { console.error(e.message); process.exit(1); })"; then
  ok "Headless browser ready"
else
  warn "Couldn't download the headless browser now; it downloads on the first animated graphic."
fi

say "6/7  Your folders"
PATHS="$("$NODE" --disable-warning=ExperimentalWarning dist/index.js --paths)"
field(){ "$NODE" -e 'const p = JSON.parse(process.argv[1]); console.log(p[process.argv[2]]);' "$PATHS" "$1"; }
WORKSPACE="$(field workspace)"; INBOX="$(field inbox)"; CLIPS="$(field clips)"
mkdir -p "$WORKSPACE" "$INBOX" "$CLIPS"
ok "Put videos in:  $INBOX"
ok "Finished clips: $CLIPS"
ok "Working files:  $WORKSPACE"
CHECK="$WORKSPACE/setup-check.json"
if "$NODE" --disable-warning=ExperimentalWarning dist/index.js --check > "$CHECK" 2>&1; then ok "Self-check passed"
else warn "Self-check found problems:"; sed 's/^/      /' "$CHECK" | tail -25; fi
# The skill teaches Claude how to edit well. Claude installs skills from a ZIP you upload.
SKILL_ZIP="$HOME/Downloads/talk-n-edit-skill.zip"
mkdir -p "$WORKSPACE/tmp"
TMPZIP="$WORKSPACE/tmp/talk-n-edit-skill-$$.zip"
(cd skills && zip -qr -X "$TMPZIP" talk-n-edit -x '*.DS_Store')
mv -f "$TMPZIP" "$SKILL_ZIP"
ok "Skill package:  $SKILL_ZIP"

say "7/7  Connecting to the Claude desktop app"
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
mkdir -p "$(dirname "$CFG")"
if [ -f "$CFG" ]; then B="$CFG.backup-$(date +%Y%m%d-%H%M%S)"; cp "$CFG" "$B"; ok "Backed up your current config to: $B"; fi
"$NODE" - "$CFG" "$ROOT" "$NODE" <<'JS'
const fs = require("fs");
const [cfg, root, node] = process.argv.slice(2);
let data = {};
if (fs.existsSync(cfg) && fs.statSync(cfg).size > 0) data = JSON.parse(fs.readFileSync(cfg, "utf8"));
data.mcpServers = data.mcpServers || {};
if (data.mcpServers["video-studio"]) {
  // Same tool under its old name: replace it so Claude doesn't see the tools twice.
  delete data.mcpServers["video-studio"];
  console.log("  ✓ Replaced the old video-studio connector (Talk-n-Edit's earlier name)");
}
data.mcpServers["talk-n-edit"] = {
  command: node,
  args: ["--disable-warning=ExperimentalWarning", `${root}/dist/index.js`],
};
fs.writeFileSync(cfg, JSON.stringify(data, null, 2));
console.log("  ✓ Added the talk-n-edit connector (your other connectors are unchanged)");
JS

cat <<EOF

  All set. Three last steps:

  1. Quit the Claude app completely (Cmd+Q) and open it again.
  2. Add the skill: in Claude, open Customize → Skills → "+" → Create skill →
     Upload a skill, and choose  $SKILL_ZIP
  3. Drop a video into  $INBOX
     and ask Claude: "Make 3 Reels from the video in my Talk-n-Edit inbox."

EOF
if [ -t 1 ] && command -v open >/dev/null 2>&1; then open -R "$SKILL_ZIP" 2>/dev/null || true; fi
