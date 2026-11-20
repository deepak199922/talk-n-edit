# Changelog

## 0.5.1

- Fixed: link_info, link imports and discover_videos could fail with "not valid JSON" on long YouTube videos (especially signed in): yt-dlp's video details are now read in full instead of only the last 200 KB.
- If yt-dlp's output still can't be read, its own error is shown instead of a JSON error.
- YouTube's "confirm you're not a bot" check gets its own message: it's about the network (VPN, shared or busy connection), so it suggests switching network or waiting, not only signing in.

## 0.5.0: Windows

- **Windows 10 and 11 support**, with a one-line PowerShell installer (`install.ps1`) and setup (`scripts/setup_windows.ps1`) that installs ffmpeg (with captions support), Node and uv with winget, builds everything and connects the Claude desktop app (including the Microsoft Store version).
- Finds ffmpeg and Python where Windows keeps them (winget, Scoop, Chocolatey; `.venv\Scripts`), uses directory junctions instead of symlinks, relative LUT paths in filters, case-insensitive folder checks, and the Videos and OneDrive folders as import locations.
- Child processes: UTF-8 for Python on every system (Hindi and emoji titles stay intact), no console windows popping up, `\r\n` output handled, and cancelling stops the whole process tree on Windows.
- Computers with under 6 GB of memory use the lighter `base` speech model by default.
- Link imports hint the spoken language from the title's script when the site doesn't list one (Devanagari → Hindi, Gurmukhi → Punjabi).
- Clearer message when Chrome or Edge block reading their sign-in cookies.
- Tests: run on Windows in CI (setup script included), Windows speech for test audio, a LUT test, zoom check stable across ffmpeg 6/8/9, MCP render check fails cleanly.

## 0.4.0: links and discovery

- `media_import_url`: download from YouTube, Shorts, Twitch, Instagram, Vimeo, X and many more sites into the Inbox and import, optionally just a section (exact cuts). Keeps title, channel, chapters and YouTube's most-replayed moments (`analysis_get` kind `source`). Uses your browser's sign-in when asked.
- `link_info`: look at a link before downloading (chapters, most-replayed moments for the whole video, resolutions, thumbnail).
- `discover_videos`: YouTube search (relevance, newest, most viewed), a channel's videos/Shorts/streams, Twitch top clips or past broadcasts, any listable link; duration filters; thumbnails.
- New `inboxDir` setting. Setup installs and always updates yt-dlp.

## 0.3.0: Talk-n-Edit

- New name: **Talk-n-Edit** (formerly Video Studio). The connector is now `talk-n-edit`; setup replaces the old `video-studio` entry. Existing installs keep their `~/VideoStudio` and `~/Downloads/Video Studio` folders.
- One-line installer (`install.sh`): installs or updates, sets up Homebrew tools and connects Claude.
- Setup builds the skill package (`~/Downloads/talk-n-edit-skill.zip`) ready to upload.
- Warns when back-to-back clips would repeat words; caption lines can no longer overlap at transitions.
- The server always runs from its own folder, so Remotion finds its browser when started by Claude Desktop.

## 0.2.1

- Hinglish, translated or corrected captions (`captions.source: "lines"`), caption size.
- Widescreen films and trailers: trim letterbox bars, blurred or black fill.
- Homebrew's `ffmpeg-full` is found and used automatically (captions need libass).
- Output is always standard-range BT.709 video.

## 0.2.0

- Prompt-driven editing: briefs, saved styles, revisions by version, draft previews.
- 22 transitions, keyframed zooms, auto punch-ins, speed ramps, freeze frames, reverse, stabilise, colour looks and LUTs, masks, picture-in-picture and B-roll layers, voice clean-up, beat sync.
- Animated graphics with Remotion, plus custom graphics with safety checks and previews.
- 11 sound effects, 6 built-in styles.

## 0.1.0

- Import, transcription (word level), faces, scenes, silence removal, face-aware reframing, word-by-word captions in English, Hindi and Punjabi, hook text, end cards, music ducking, loudness, QA.
