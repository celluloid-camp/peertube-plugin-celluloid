# peertube-plugin-celluloid

A [PeerTube](https://joinpeertube.org/) plugin that links a video to a
[Celluloid](https://celluloid.me) project and displays the project's
annotations on top of the player.

## What it does

- Adds a **Celluloid project** field to the video form (upload / update / import
  / live). Enter a Celluloid project id or a project URL
  (`https://celluloid.me/project/<id>`).
- On the watch page, fetches the linked project's annotations from the Celluloid
  API and displays them:
  - a synced **text overlay** over the video for annotations active at the
    current time,
  - clickable **markers** on the progress bar,
  - a scrollable **annotations list** below the player (click to seek).

## How it works

Celluloid exposes a tRPC API at `<celluloid-url>/api/trpc`. The annotations
endpoint (`annotation.byProjectId`) is public, so no credentials are required to
read them.

The plugin server acts as a small proxy (`/plugins/peertube-plugin-celluloid/router/videos/:uuid/annotations`)
to avoid cross-origin requests from the browser to the Celluloid instance.

## Configuration

In **Administration → Plugins/Extensions → peertube-plugin-celluloid → Settings**:

- **Celluloid instance URL** — base URL of the Celluloid instance
  (default `https://celluloid.me`).

## Development

```bash
npm install
npm run typecheck
npm run build      # bundles server + client scripts into dist/
```

Then install the local plugin on a PeerTube instance:

```bash
# on the PeerTube server
npm run plugin:install -- --plugin-path /path/to/peertube-plugin-celluloid
```

## Notes / limitations

- Linking is stored per video via PeerTube's plugin storage. Set the project on
  the video's **Edit** page to guarantee persistence across PeerTube versions.
- Only the annotation text is rendered as an overlay. Celluloid shape overlays
  (rect/circle/polygon) are available in the API (`annotation.extra`) and can be
  drawn as a future enhancement.
