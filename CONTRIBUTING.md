# Contributing to Talk-n-Edit

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

[Open an issue](https://github.com/deepak199922/talk-n-edit/issues/new/choose) with what you asked Claude, what happened, and the output of the health check: ask Claude to *"run the Talk-n-Edit system doctor"*, or run `node dist/index.js --check` in the app folder. Please don't attach videos you don't have the rights to share.

## Development setup

```bash
git clone https://github.com/deepak199922/talk-n-edit.git && cd talk-n-edit
bash scripts/setup_mac.sh        # on a Mac; on Windows: powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1; Linux: README "Other systems"
npm run build                    # after changing src/
npm test -- --quick              # ~6 minutes; npm test for the full suite
```

The [developer reference](docs/REFERENCE.md) explains the layout, tools and timeline format.

## Guidelines

- **Never delete user files.** Write new files next to old ones instead; the toolkit's promise is that nothing is ever deleted.
- **Add a test** in `test/e2e.mjs` for new behaviour. Tests make their own media; don't commit videos.
- **Keep errors helpful.** Timeline errors name the JSON path and say how to fix it.
- **Update the skill** (`skills/talk-n-edit/`) when you add a feature Claude should know about, and the timeline spec when the format changes.
- Run `shellcheck install.sh scripts/setup_mac.sh` if you touch the shell scripts. Keep the PowerShell scripts plain ASCII and compatible with Windows PowerShell 5.1 (no `??`, ternaries or `&&`); CI parses and runs them on Windows.

## Sign your commits (Developer Certificate of Origin)

Every commit in a pull request must be signed off, to certify that you wrote it or otherwise have the right to submit it under the project's license, as described in the [Developer Certificate of Origin 1.1](https://developercertificate.org/). Add the sign-off with `git commit -s`, which appends a line like:

```text
Signed-off-by: Your Name <you@example.com>
```

Please don't submit code, media, models or fonts copied from somewhere else unless their license allows it, and say where they came from in the pull request (and in `THIRD_PARTY_NOTICES.md`).

By contributing you agree your work is released under the MIT License, and that it's provided as described in [DISCLAIMER.md](DISCLAIMER.md).
