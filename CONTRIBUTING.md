# Contributing to pulse

Thanks for helping out. Bug reports, new AI providers, UI polish and docs fixes are all welcome.

## Getting set up

You need **Node 22+** and the **[GitHub CLI](https://cli.github.com)**, logged in (`gh auth login`).

```sh
git clone https://github.com/tadiPro250/gh-pulse.git
cd gh-pulse
npm install        # installs deps and builds dist/cli.js
npm link           # optional: puts `pulse` on your PATH
npm run dev        # rebuilds dist/ whenever src/ changes
```

Run your build with `node bin/pulse.js` (or `pulse` if you linked it).

To keep your real config and API keys out of the way while you develop, point pulse at a scratch folder:

```sh
GH_PULSE_HOME=/tmp/pulse-dev node bin/pulse.js          # macOS / Linux
$env:GH_PULSE_HOME="$env:TEMP\pulse-dev"; node bin/pulse.js   # PowerShell
```

## Tests

| Command | Needs | What it checks |
| --- | --- | --- |
| `node test/actions.test.js` | nothing | AI menu suggestions and merge rules (pure unit tests, these run in CI) |
| `npm test` | a logged-in `gh` | the above, plus headless TUI runs against your **live** GitHub data with a mock AI server and a fake coding agent |

`npm test` runs with `GH_PULSE_HOME=test/.home`, so it never touches your real `~/.gh-pulse`. It reads real data from your account, so some assertions depend on what is in your dashboard.

## Where things live

| Path | What it does |
| --- | --- |
| `bin/pulse.js` | the `pulse` command; loads the bundled `dist/cli.js` |
| `gh-pulse` | entry point when installed as a `gh` extension (`gh pulse`) |
| `src/cli.js` | argument parsing, print mode, scripting commands |
| `src/gh.js`, `src/github.js` | everything that talks to GitHub through `gh` (GraphQL search, notifications, merges) |
| `src/view.js`, `src/model.js` | turns raw GitHub data into dashboard sections and rows |
| `src/render.js`, `src/theme.js` | plain-text rendering and the accent color system |
| `src/state.js`, `src/secrets.js` | config, "seen" state and API keys under `~/.gh-pulse` |
| `src/accounts.js` | switching between multiple `gh` accounts |
| `src/clones.js` | finds your local clones by reading `.git/config` remotes |
| `src/ai/catalog.js` | **every supported AI and how to call it; add new providers here** |
| `src/ai/providers/` | `anthropic.js` (official SDK), `openai.js` (any OpenAI-compatible API), `cli.js` (coding agents) |
| `src/ai/actions.js` | what the AI menu suggests for each PR / issue state |
| `src/ai/tasks.js`, `src/ai/context.js` | agent task prompts and chat context |
| `src/tui/` | the Ink (React) interface: `index.jsx` is the app shell, one file per screen |

## Adding an AI provider

1. Add an entry to `src/ai/catalog.js`. Copy the closest existing one: a CLI agent like `codex`, an OpenAI-compatible API like `openrouter`, or a local server like `ollama`.
2. If it speaks the OpenAI chat API you're usually done. Otherwise add a module in `src/ai/providers/` and wire it up in `src/ai/index.js`.
3. Link it in **Settings → AI**, press `t` to test the connection, and try both chat and an agent task.
4. In the PR, say which version of the tool you tested with.

## Updating the demo GIF

If your change affects what's shown in `docs/demo.gif`, regenerate it:

```sh
pip install pillow fonttools    # once; you also need ffmpeg on your PATH
npm run demo
```

`scripts/demo/` runs the real UI against made-up data (`fake-gh.js`, a fictional `acme` org) and a mock AI, so no GitHub login is needed and nothing personal ends up in the GIF. The steps it takes are in `record.jsx`; colors and fonts are in `render.py`.

## Pull requests

- Keep each PR focused on one thing, and match the style of the code around it (small functions, short comments explaining *why*).
- Run `npm run build` and `node test/actions.test.js` before pushing. CI runs both on Linux, macOS and Windows.
- For UI changes, paste a snippet of terminal output or a screenshot.
- Never commit `test/.home/`, `.env` files with real values, tokens or API keys.

## Reporting security issues

If you find a way pulse could leak a token or API key, or run something it shouldn't, please don't open a public issue. Use [GitHub's private vulnerability reporting](https://github.com/tadiPro250/gh-pulse/security/advisories/new) instead.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
