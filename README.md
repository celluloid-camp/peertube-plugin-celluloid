# peertube-plugin-celluloid

A [PeerTube](https://joinpeertube.org/) plugin that links a video to a
[Celluloid](https://celluloid.me) project and shows the project's annotations
on the player.

## Features

- Link a video to a Celluloid project (id or `https://celluloid.me/project/<id>`
  URL), from the video form or from a button on the watch page (owner, moderators
  and admins only).
- On the watch page, displays the project's annotations as a synced text overlay,
  progress-bar markers, and a clickable list below the player.

## Configuration

In **Administration → Plugins → peertube-plugin-celluloid → Settings**, set the
**Celluloid instance URL** (default `https://celluloid.me`).

## Development

```bash
npm install      # also builds dist/
npm run build    # bundle server + client scripts
```

## Releases

Releases are automated with [Release Please](https://github.com/googleapis/release-please) on `main`.

1. Merge PRs using [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, …).
2. Release Please opens/updates a release PR that bumps `package.json`, updates `CHANGELOG.md`, and prepares the next version.
3. Merging that release PR creates a GitHub tag/release and publishes to npm via [Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers/) — no npm token secret.

On npmjs.com → package **Settings → Trusted Publisher**, configure:

- **Organization or user:** `celluloid-camp`
- **Repository:** `peertube-plugin-celluloid`
- **Workflow filename:** `release-please.yml` (filename only, with extension)
