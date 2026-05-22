# Product updates page (website)

The public **Updates** page is at `/updates` on the web console (same host as the landing site).

## Edit the list

Add a new entry at the **top** of:

`server/web-console/src/data/productUpdates.json`

Each entry:

| Field | Meaning |
|-------|---------|
| `version` | Short version label (e.g. `1.13`) — bump when you ship |
| `date` | ISO date `YYYY-MM-DD` |
| `title` | One-line summary |
| `changes` | Array of simple bullet strings (no jargon) |

After editing, commit and push to `main`; Railway redeploy publishes the page.

## Who sees it

- Anyone can open `/updates` without signing in.
- Footer links on the home page and legal pages point to Updates.
