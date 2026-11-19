# Developer reference

## Layout

| Path | What |
| --- | --- |
| `src/` | MCP server (TypeScript): tools, job queue, timeline resolver, FFmpeg renderer, QA |
| `src/schema/timeline.ts` | The timeline format (zod); errors name the exact JSON path |
| `remotion/` | Animated graphics (React + Remotion), rendered as transparent frame sequences |
| `python/` | Analysis sidecar: transcription (mlx-whisper on Apple Silicon, faster-whisper elsewhere), faces (YuNet), scenes (PySceneDetect), beats |
| `library/` | Fonts, face model, sound effects, built-in styles, LUTs, brand kits |
| `skills/talk-n-edit/` | The Claude skill: how to run a brief, build edits, review and revise |
| `scripts/setup_mac.sh` | Mac setup and Claude Desktop connector (re-runnable) |
| `scripts/setup_windows.ps1` | Windows setup (winget) and Claude Desktop connector (re-runnable) |
| `install.sh`, `install.ps1` | One-line installers for Mac and Windows: download or update, then run the setup |
| `install.sh` | One-line installer: clone or update, then setup |
| `test/e2e.mjs` | End-to-end tests; makes its own test videos |

## Tools (MCP)

`system_doctor`, `project_open`, `media_import`, `media_import_url` (download from a link, optionally only `start`–`end`; `cookiesFromBrowser` for signed-in videos), `link_info` (look at a link without downloading: chapters, most-replayed moments, resolutions), `discover_videos` (YouTube search, channel videos/Shorts/streams, Twitch clips/VODs, any listable link), `media_inspect`, `analyze` (transcript, faces, scenes, beats), `analysis_get`, `transcript_get`, `frames_get`, `catalog_list`, `timeline_validate`, `timeline_get`, `render_start`, `job_status`, `job_cancel`, `qa_check`, `style_save`, `fx_create`, `open_in_player`.

`analysis_get` with `kind: "source"` returns a link import's title, channel, views, chapters and YouTube's most-replayed moments, in the downloaded file's time.

Downloads use [yt-dlp](https://github.com/yt-dlp/yt-dlp) from the Python environment (setup always updates it) with this app's Node as its JavaScript runtime, and save into the Inbox.

Long work (import, download, analysis, render, QA) runs as jobs: tools return a `jobId`, and `job_status` waits up to 45 s.

## Timeline format

Full field list: [skills/talk-n-edit/references/timeline-spec.md](../skills/talk-n-edit/references/timeline-spec.md). Examples: [skills/talk-n-edit/examples](../skills/talk-n-edit/examples).

## Settings

`~/TalkNEdit/config.json` (created on first run) can override:

| Key | Default |
| --- | --- |
| `importRoots` | Downloads, Movies, Desktop, Documents, Developer (folders media may be imported from) |
| `exportDir` | `~/Downloads/Talk-n-Edit/Clips` |
| `inboxDir` | `~/Downloads/Talk-n-Edit/Inbox` (downloads from links are saved here; always importable) |
| `whisperModel` | `large-v3-turbo` on Apple Silicon; elsewhere `small`, or `base` with under 6 GB of memory |
| `transcriptionBackend` | `auto` (`mlx` or `faster-whisper`) |
| `limits` | `{ "maxImportGB": 20, "maxOutputMinutes": 15 }` |
| `ffmpeg`, `ffprobe`, `python`, `chrome` | Auto-detected (on Windows also in winget, Scoop and Chocolatey folders); set a path to override |

Environment: `TALK_N_EDIT_HOME` moves the working folder. Installs from before the rename keep using `~/VideoStudio` and `~/Downloads/Video Studio`.

## Brand kits

Add `library/brand-kits/<id>.json`:

```json
{ "name": "My brand", "fonts": { "heading": "Anton", "body": "Poppins ExtraBold" },
  "colors": { "text": "#FFFFFF", "highlight": "#00E0A0", "emphasis": "#00E0A0", "outline": "#000000", "box": "#000000" },
  "captionPreset": "word-pop", "handle": "@yourbrand" }
```

Fonts must be in `library/fonts` (TTF/OTF). Bundled: Poppins, Anton, Mukta (Devanagari) and Mukta Mahee (Gurmukhi), all under the SIL Open Font License.

## Command line

```bash
npm run cli -- doctor
npm run cli -- project "My podcast"
npm run cli -- import <projectId> ~/Downloads/Talk-n-Edit/Inbox
npm run cli -- analyze <assetId> transcript,faces,scenes
npm run cli -- transcript <assetId>
npm run cli -- render timeline.json final
```

`node dist/index.js --check` prints a health report; `--paths` prints the working, Inbox and Clips folders.

## Tests

```bash
npm test               # full end-to-end suite (~10 min) in a temp folder
npm test -- --quick    # skips 4K, multi-process and MCP cases
```

Set `FACE_IMAGE=/path/to/portrait.jpg` to include the face-tracking and split-screen cases, and `VS_TEST_MODEL=<model or path>` to pick the Whisper model. The suite never touches your real workspace.

## Design rules

- Originals are copied read-only; nothing in the toolkit deletes files.
- Every render is reproducible from its saved timeline version (`resolved.json` and `ffmpeg-args.json` sit next to each output).
- Custom graphics written by Claude are checked (only `react` and `remotion` imports, no network or file access) and previewed before use; a broken draft never replaces a working graphic.
