# Changelog

## 0.5.4: faster editing, video effects, sound packs (switchable)

Every speed change has a switch under `features` in config.json; off = the 0.5.3 behaviour. Final-render quality is unchanged.

- **New graphics are drawn in one pass.** Graphics next to each other in stacking order are drawn together (one screenshot per frame instead of one per graphic per frame). Switch: `graphicsOnePass`.
- **Faster drafts on a Mac:** drafts use the hardware encoder; finals still use x264 at the same quality. Switch: `hwDraftEncode`.
- **`timeline_preview`:** still pictures at chosen seconds, drawn exactly like a render (cuts, framing, zooms, effects, captions, graphics), in seconds instead of a full render.
- **`timeline_patch`:** change one value by path (e.g. `overlays[id=panel].props.rows[2].text`) without resending the timeline; validated and saved as the next version.
- **Times tied to speech:** inside overlay props, `{"$at": {"clip": "c1", "word": "shift"}}` becomes seconds from the overlay's start, so graphics stay in sync when clips are trimmed. Switch: `propTimeAnchors`.
- **Video effects (`vfx`):** flash, shake, rgbSplit, glitch, blur, vignette, blackWhite, invert, punch, ghost, motionBlur, letterbox and grain, each for a stretch of time; zooms accept `shake`.
- **Sound packs with licence records:** `sound_pack_import` adds sounds you downloaded (Sonniss GDC bundles, Pixabay, CC0 Freesound, your own recordings) as `packs/<pack>/<name>`. Non-commercial licences are refused and CC-BY needs a credit line. Every render writes `credits.json` (and returns `credits`) listing each sound and its licence.
- **Graphics are reused between renders.** Each animated graphic is drawn once into `cache/graphics` and reused by any render that needs exactly the same one, so a fix to one overlay redraws only that overlay, and graphics shared by several videos (a credit badge, an end card) are drawn once. Render results show `graphics: { drawn, reused }`. Switch: `features.graphicsCache`.
- **Nothing is removed automatically.** Renders add a note when the cache passes `features.graphicsCacheWarnGB` (default 20 GB).
- **New tools:** `storage_report` shows what is using space (cached graphics by project, Reel and age; leftover frames and in-between video in old renders). `storage_clean` removes what you pick, as a dry run unless `apply: true`; finished videos, sources, analyses and timelines are never touched, and graphics used in the last 6 hours are skipped.
- Tests: `npm run test:storage`, `npm run test:stage2`.

## 0.5.3: low-risk speed and fixes (switchable)

Every change below has a switch under `features` in config.json; off = the 0.5.2 behaviour. See docs/REFERENCE.md.

- **Fixed: broken Gurmukhi and Devanagari captions** (vowel signs in the wrong place, or dotted circles ◌ਿ). Captions now use ffmpeg's `ass` filter with complex shaping, and Indic lines use letter spacing 0 (libass shapes each letter separately when spacing isn't 0). English captions are unchanged. `system_doctor` shows `captionShaping`.
- **Link details are read once:** `link_info` and downloads keep a link's details for an hour and hand them to yt-dlp, instead of reading the page up to three times (slow, and YouTube rate-limits it). Stale details fall back to reading the page again.
- **Parts of a video you already have are cut locally:** a `start`/`end` import of a video whose full copy is in the project is cut from that copy (exact times, no download).
- **`job_cancel` says what happened:** cancelling a job that already finished says so (`cancelled: false`, results untouched) instead of looking like it worked; and it can stop a job that the other server process (Claude Desktop vs Claude Code) is running.
- Mixed versions: a server leaves queued jobs of kinds it doesn't know for a server that does, instead of failing them.
- **Fixed: wrong "sign in" and "rate-limited" messages for links.** Words like "webpage" matched the age-restriction check and any number containing 429 looked like a rate limit, so the real problem was hidden. Checks now match whole phrases, and every link error also shows yt-dlp's own words ("yt-dlp said: …").
- Clearer errors: a transition of 0 s explains the 0.05–2 s range and how to make a hard cut; the custom-effect `inputRange … [102,102]` error explains the fix.
- Tests: `npm run test:features` tests every switch on and off and forces each fallback.

## 0.5.2: safety

- **Custom effects are locked down further:** besides Node modules, network calls and `eval`, effects can no longer use bundler features (`require.context`, `import.meta`, `new URL(…)`) or bracket access to globals, which could have pulled files from disk into an effect.
- CI runs with a read-only token.

## 0.5.1

- Fixed: link_info, link imports and discover_videos could fail with "not valid JSON" on long YouTube videos (especially signed in): yt-dlp's video details are now read in full instead of only the last 200 KB.
- If yt-dlp's output still can't be read, its own error is shown instead of a JSON error.
- YouTube's "confirm you're not a bot" check gets its own message: it's about the network (VPN, shared or busy connection), so it suggests switching network or waiting, not only signing in.
- Docs: added [DISCLAIMER.md](DISCLAIMER.md) (no warranty, responsible use, no DRM bypass, no data collection, results and speed vary, not affiliated) and [SECURITY.md](SECURITY.md) (private reports, rights concerns); README "Responsible use" section; contributor sign-off (DCO); more third-party notices; video files can't be committed by accident.

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
