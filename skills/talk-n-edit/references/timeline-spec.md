# Timeline spec (schemaVersion 1, v0.2 features)

Times are seconds. `clips` play in order. Unknown fields are rejected; errors name the JSON path.
Anchors: `{ "at": t }` = timeline time; `{ "clip": "c1", "sourceTime": t }` = follows the footage through cuts, speed changes and transitions (use it for anything tied to a word or moment).

```jsonc
{
  "projectId": "prj_…", "name": "reel-01-slug",            // same name + project = next version
  "style": "clean-creator",                                  // optional saved style: its values are defaults, the timeline wins
  "output": { "aspect": "9:16", "fps": 30, "platform": "instagram-reels" }, // 9:16 | 16:9 | 1:1 | 4:5; platform sets safe areas
  "brandKit": "default",

  // ---- global edit settings
  "look": { "preset": "cinematic", "vignette": 0.4, "grain": 0.2 },   // presets: none vivid warm cool cinematic teal-orange bw noir vintage matte moody bright sepia punchy
                                                                    // adjustments: brightness(-0.5..0.5) contrast(0.5..2) saturation(0..3) gamma warmth(-1..1) vignette grain sharpen blur (0..1) lut ("file.cube")
  "transition": { "type": "crossfade", "duration": 0.3 },          // default between clips; see catalog_list transitions
  "autoPunch": { "scale": 1.12, "every": "cut" },                  // jump-cut zoom alternating per cut or per sentence
  "sfxOnTransitions": "sfx/whoosh",                                 // sound on every transition
  "beatSync": { "audioId": "m1", "every": 2 },                     // snap clip ends to every 2nd beat of audio item m1 (needs analyze beats; music must start {at})

  "clips": [
    {
      "id": "c1", "assetId": "ast_…",
      "sentences": { "from": "s0042", "to": "s0051" },             // or "in": 12.3, "out": 41.0
      "removeSilences": { "minGap": 0.5, "keepPad": 0.1 },
      "reframe": { "mode": "auto-face" },                           // fit | fill-center | auto-face | split | manual {x,y,zoom}
                                                                    // fit: { "mode": "fit", "background": "blur" | "black", "trim": { "top": 0.13, "bottom": 0.13 } } (trim = cut built-in letterbox bars)
      "speed": 1,                                                   // 0.25–4
      "speedRamp": [ { "at": 30.0, "speed": 1.6 }, { "at": 36.0, "speed": 1 } ],  // from source time on, play at speed
      "freezes": [ { "at": 33.2, "duration": 0.8, "flash": true } ],               // hold a frame (source time), optional white flash
      "reverse": false,                                             // play backwards (≤ 20 s)
      "stabilize": false,
      "look": { "preset": "bw" },                                   // per-clip look (merged over the global one)
      "audio": { "denoise": true, "enhance": true, "mute": false }, // voice cleanup
      "transitionIn": { "type": "whip-left", "duration": 0.25 },    // overrides the default; "cut" = none
      "motion": { "type": "punch-in", "strength": 0.5 },            // video: punch-in; images: kenburns-in | kenburns-out
      "volume": 1
    },
    { "id": "p1", "assetId": "ast_photo…", "duration": 3 }        // image clip (Ken Burns by default)
  ],

  "zooms": [ { "start": { "clip": "c1", "sourceTime": 15.2 }, "duration": 1.5, "scale": 1.35, "x": 0.5, "y": 0.4, "ease": "smooth", "ramp": 0.3 } ],
                                                                    // x/y = focus point in the output frame; ease smooth | snap | linear
  "masks": [ { "id": "m1", "start": { "at": 0 }, "duration": 30, "rect": { "x": 0.7, "y": 0.02, "w": 0.28, "h": 0.08 }, "type": "blur" } ],
                                                                    // blur | pixelate | box (+ color); rect in 0..1 of the output frame
  "layers": [
    { "id": "broll1", "assetId": "ast_…", "in": 4.0, "start": { "clip": "c1", "sourceTime": 20 }, "duration": 3, "mode": "full" },  // cutaway, speech continues
    { "id": "cam", "assetId": "ast_…", "start": { "at": 0 }, "duration": 10, "mode": "pip", "rect": { "x": 0.62, "y": 0.06, "w": 0.33 }, "border": 6 }
  ],
  "overlays": [
    { "id": "hook", "component": "HookText", "start": { "at": 0 }, "duration": 2.5, "props": { "text": "Nobody tells you this", "style": "boxed", "position": "top", "uppercase": true } },
    { "id": "t", "component": "AnimatedTitle", "start": { "at": 3 }, "duration": 2, "props": { "text": "3 mistakes", "style": "bounce" } },
    { "id": "e", "component": "Emoji", "start": { "clip": "c1", "sourceTime": 18 }, "duration": 1.2, "props": { "emoji": "🤯", "animation": "pop", "x": 0.8, "y": 0.3 } },
    { "id": "n", "component": "CountUp", "start": { "at": 6 }, "duration": 2, "props": { "to": 200000, "prefix": "₹", "locale": "en-IN", "label": "Price" } },
    { "id": "x", "component": "fx:slot-price", "start": { "at": 9 }, "duration": 2.5, "props": { "value": "149999" } }
  ],
  "captions": { "source": "transcript", "preset": "karaoke-highlight", "emphasis": "auto", "position": "auto", "size": 1 },
                                                                    // size: 0.5–2 multiplier. Own text instead of the transcript (Hinglish, translation, fixed spelling):
                                                                    // "source": "lines", "lines": [ { "start": { "clip": "c1", "sourceTime": 84.0 }, "end": { "clip": "c1", "sourceTime": 85.7 }, "text": "Kahan ke Constitution mein likha hai," } ]
                                                                    // words follow the voice inside each range; keep each line to one spoken phrase
  "audio": [
    { "id": "m1", "assetId": "ast_music…", "role": "music", "volume": 0.35, "fadeOut": 1.5, "loop": true },
    { "id": "s1", "library": "sfx/pop", "role": "sfx", "start": { "at": 3 } }
  ],
  "mix": { "targetLufs": -14, "duckMusicDb": -12 }
}
```

## Components (catalog_list components has the prop schemas)

| Component | Engine | Use |
| --- | --- | --- |
| HookText, LowerThird, TitleCard | text (fast) | hook line, name tag, full-screen title / end card |
| AnimatedTitle | animated | pop, slide-up, typewriter, bounce, glitch, highlight |
| Emoji | animated | pop, float, shake, spin, pulse at a point |
| Arrow, Callout | animated | point at / circle a feature, optional label, dim outside |
| CountUp | animated | prices, numbers, percentages (en-IN gives 2,00,000) |
| ProgressBar | animated | watch-time bar (duration = whole video) |
| FollowCTA | animated | follow / subscribe button with tap |
| Confetti, Checklist | animated | celebration, ticked list |
| fx:<name> | custom | anything made with fx_create |

## Notes

- Transitions overlap the clips, so total duration = sum of clips − transition durations. `timeline_validate` gives the real numbers.
- Transitions: cut crossfade fade-black fade-white dissolve slide-left/right/up/down wipe-left/right/up/down whip-left/right zoom-in circle-open circle-close pixelize radial blur squeeze.
- Sounds: `catalog_list sfx` (whoosh, swoosh-fast, swipe, pop, click, ding, riser, boom, camera-shutter, notification, glitch). Music: import the user's file; only use music they own or licensed.
- Limits: 200 clips, 100 zooms, 50 overlays, 20 masks, 20 layers, 40 audio items, 15 min output.
