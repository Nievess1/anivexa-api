# Deploy Anivexa API on Railway

This bundle is ready for Railway. Railway detects `package.json`, installs
the dependencies, and runs `npm start`. The server already reads Railway's
dynamic `PORT` environment variable.

## Easiest method: deploy from GitHub

1. Create a new GitHub repository, for example `anivexa-api`.
2. Upload all files in this folder to the repository root.
3. Open [railway.com](https://railway.com) and sign in.
4. Create a new project.
5. Choose **Deploy from GitHub repo** and select `anivexa-api`.
6. Railway should automatically detect the Node.js app and deploy it.
7. Open the service's **Settings → Networking → Generate Domain**.
8. Copy the generated HTTPS domain.

Test the deployment in a browser:

```text
https://YOUR-RAILWAY-DOMAIN/
https://YOUR-RAILWAY-DOMAIN/map/1535
https://YOUR-RAILWAY-DOMAIN/episodes/1535
```

The root URL should return the Anivexa API information JSON. The map endpoint
should return Death Note's AniList mapping.

## Railway CLI method

From this folder:

```bash
railway login
railway init
railway up
railway domain
```

Use the HTTPS domain Railway gives you as the Anivexa API URL in the APK.

## Environment variables

Start with no Redis variables. The API works with its default in-memory and
disk cache behavior:

```text
CACHE_ENABLED=false
```

Only add these later if you intentionally configure an Upstash Redis database:

```text
CACHE_ENABLED=true
DEFAULT_REDIS_TTL=900
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

Do not commit secrets or paste them into chat. Add them in Railway's service
Variables panel.

## Connect the APK

In the Astralanime app source, open `api.js` and change:

```js
const DEFAULT_ANIVEXA_API_BASE = 'http://localhost:4000';
```

to:

```js
const DEFAULT_ANIVEXA_API_BASE = 'https://YOUR-RAILWAY-DOMAIN';
```

Then rebuild the APK. The APK itself does not need to be hosted. MegaPlay
remains the fallback if Railway or an Anivexa provider is unavailable.