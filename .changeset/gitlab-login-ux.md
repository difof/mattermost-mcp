---
"@bryanberger/mattermost-mcp": minor
---

Improve the `login` auth UX:

- **Default browser** — `login --gitlab` now drives your OS default browser when it is Chromium-based
  (Chrome, Chromium, Brave, Edge, Opera, Vivaldi, Arc, Dia…), falling back to the first installed
  Chromium engine. Override with `MM_CHROME_PATH`. Detection is best-effort and degrades gracefully.
- **`gitlab` in the menu** — `gitlab / SSO` is now a selectable option in `mattermost-mcp login`
  (after entering the server URL), in addition to the `--gitlab` / `--sso` flag.
- **Keyboard-navigable picker** — the auth-mode selector is now an arrow-key menu (↑/↓ or `j`/`k`,
  digits to jump, Enter to confirm, Esc/Ctrl-C to abort), with a numbered fallback for non-TTY input.
