# Download backend replacement

This change adds an MP4 download route for direct HLS, MP4, and WebM sources.
It does not alter the provider implementations.

## Files to replace or add

Copy these files into the **root of the `anivexa-api` repository**:

```text
server.js              replace the existing file
download.js            add this new file
nixpacks.toml          add this new file
README.md              replace the existing file if you want the route docs
```

The existing provider files and `index.js` stay in place.

## Railway requirement

`nixpacks.toml` installs FFmpeg during the Railway build. Redeploy the service
after pushing the files. The download route is available on the Node/Railway
server; the Vercel edge handler does not run native FFmpeg.

## Route

```text
GET /download/:provider/:anilistId/sub|dub/:provider-:episode?source=0
```

`source` is the zero-based direct-video quality index. The APK creates this
URL from the stream variants returned by `/watch/...`.

Embed-only sources cannot be downloaded. The route converts direct HLS,
MP4, or WebM sources into a progressive MP4 response with
`Content-Disposition: attachment`.

## Test after deployment

Use an AniList ID and provider that already returns direct streams:

```bash
curl -I \
  "https://YOUR-RAILWAY-DOMAIN/download/reanime/21/sub/reanime-1?source=0"
```

The response should eventually report `Content-Type: video/mp4` and an
attachment filename. Do not test this by launching the APK first; the backend
route can be checked independently.