# Reading QA results and fixing renders

`qa_check` returns checks with pass / warn / fail, a contact sheet and frames just after the first cuts.

| Check | Typical cause | Fix in the timeline |
| --- | --- | --- |
| hook in first 0.6 s (warn) | Clip starts on a pause or breath | Move `in` to the first word, or add HookText at `{at: 0}` |
| dead air | Pause inside the clip | Add `removeSilences` (minGap 0.5) or trim |
| black frames | Source has black, or a fade landed mid-word | Adjust in/out; remove `fade-black` |
| loudness (draft) | Drafts use one-pass normalisation | Ignore on drafts; re-check the final |
| duration off | Rare; very short pieces after silence removal | Raise `minGap` |

## Looking at frames

- Face cut off or off-centre: use `reframe: {mode: "manual", x: 0.4}` for that clip (x = face centre as a fraction of source width), or re-run `analyze` with `faces` if it was missing.
- Hook covering the face: set HookText `position: "center"` is worse; prefer captions `position: "lower"` and keep the hook at the top, or shorten the hook.
- Captions over a busy background: switch preset to `boxed`.
- Two people in a wide shot and only one shown: try `split`.
