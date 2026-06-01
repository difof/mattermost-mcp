---
"@bryanberger/mattermost-mcp": minor
---

Add `mattermost-mcp login --gitlab` (alias `--sso`): a browser-driven SSO login for servers whose
only login path is an external IdP (e.g. GitLab) when you are **not** an admin — so Personal Access
Tokens and OAuth2 apps (both admin-gated) are unavailable. It opens the system Chrome/Chromium at
`{server}/login`, waits for you to complete the SSO login, reads the resulting `MMAUTHTOKEN` session
cookie via CDP, and saves it (0600) as a token. Chrome discovery honors `MM_CHROME_PATH`. Adds an
optional, lazy-imported `puppeteer-core` dependency that never loads on the MCP server path.
