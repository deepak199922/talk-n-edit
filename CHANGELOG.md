# Changelog

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
