#!/usr/bin/env bash
# Talk-n-Edit installer for macOS. Paste this into Terminal:
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/deepak199922/talk-n-edit/main/install.sh)"
# It downloads Talk-n-Edit to ~/talk-n-edit (or updates it if it's already there) and runs the setup.
# Choose another folder with:  TALK_N_EDIT_DIR=/path/to/folder  before the command.
set -euo pipefail
REPO="https://github.com/deepak199922/talk-n-edit.git"
DIR="${TALK_N_EDIT_DIR:-$HOME/talk-n-edit}"
say(){ printf "\n\033[1m%s\033[0m\n" "$*"; }
warn(){ printf "  ! %s\n" "$*"; }

say "Talk-n-Edit installer"
if [ "$(uname -s)" != "Darwin" ]; then
  warn "This installer is for macOS. For Linux and others, see 'Other systems' in the README."; exit 1
fi

# git comes with Apple's Command Line Tools.
if ! xcode-select -p >/dev/null 2>&1; then
  warn "Apple's Command Line Tools are needed first (they include git)."
  warn "A window will open: click Install, wait until it finishes, then run this installer again."
  xcode-select --install >/dev/null 2>&1 || true
  exit 1
fi

# Homebrew installs ffmpeg, Node and uv for us.
brew_env(){ for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do if [ -x "$b" ]; then eval "$("$b" shellenv)"; return 0; fi; done; return 1; }
command -v brew >/dev/null 2>&1 || brew_env || true
if ! command -v brew >/dev/null 2>&1; then
  say "Homebrew (the standard Mac package manager) isn't installed."
  answer="n"
  read -r -p "  Install it now? It will ask for your Mac password. [Y/n] " answer </dev/tty || answer="n"
  case "${answer:-Y}" in
    [Nn]*) warn "Install Homebrew from https://brew.sh, then run this installer again."; exit 1 ;;
  esac
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  brew_env || { warn "Homebrew finished but isn't on the PATH yet. Open a new Terminal window and run this installer again."; exit 1; }
fi

if [ -d "$DIR/.git" ]; then
  say "Updating Talk-n-Edit in $DIR"
  git -C "$DIR" pull --ff-only || { warn "Couldn't update automatically (did you change files there?). Run 'git -C \"$DIR\" status' to see why."; exit 1; }
elif [ -e "$DIR" ]; then
  warn "$DIR already exists and isn't a Talk-n-Edit download."
  warn "Move or rename it, or pick another folder:  TALK_N_EDIT_DIR=~/somewhere-else  in front of the install command."
  exit 1
else
  say "Downloading Talk-n-Edit to $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

exec bash "$DIR/scripts/setup_mac.sh"
