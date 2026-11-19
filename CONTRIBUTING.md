# Contributing to Talk-n-Edit

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

[Open an issue](https://github.com/deepak199922/talk-n-edit/issues/new/choose) with what you asked Claude, what happened, and the output of the health check: ask Claude to *"run the Talk-n-Edit system doctor"*, or run `node dist/index.js --check` in the app folder. Please don't attach videos you don't have the rights to share.

## Development setup

```bash
git clone https://github.com/deepak199922/talk-n-edit.git && cd talk-n-edit
bash scripts/setup_mac.sh        # on a Mac; see README "Other systems" for Linux
npm run build                    # after changing src/
npm test -- --quick              # ~6 minutes; npm test for the full suite
```

The [developer reference](docs/REFERENCE.md) explains the layout, tools and timeline format.

## Guidelines

- **Never delete user files.** Write new files next to old ones instead; the toolkit's promise is that nothing is ever deleted.
- **Add a test** in `test/e2e.mjs` for new behaviour. Tests make their own media; don't commit videos.
- **Keep errors helpful.** Timeline errors name the JSON path and say how to fix it.
- **Update the skill** (`skills/talk-n-edit/`) when you add a feature Claude should know about, and the timeline spec when the format changes.
- Run `shellcheck install.sh scripts/setup_mac.sh` if you touch the scripts.

By contributing you agree your work is released under the MIT License.
