import { spawn } from "node:child_process";

const USER_AGENT = "Anivexa/2.2.1";
const ACTIVE_DOWNLOADS = new Set();
const MAX_DOWNLOADS = Number(process.env.DOWNLOAD_CONCURRENCY) || 2;

function candidateUrl(value) {
  if (typeof value !== "string") return "";
  const url = value.trim();
  return /^https?:\/\//i.test(url) || url.startsWith("/") ? url : "";
}

function isDirectVideo(url) {
  return /\.(?:m3u8|mp4|webm)(?:$|[?#])/i.test(url);
}

/*
 * Keep this traversal in the same order as the APK's api.js normaliser.
 * `source` is the zero-based index of direct video candidates only, so
 * embeds do not consume a downloadable quality slot.
 */
function collectDirectCandidates(data) {
  const candidates = [];
  const seen = new Set();
  let sourceIndex = 0;

  const add = (value, preferredKind = "", meta = {}) => {
    if (Array.isArray(value)) {
      value.forEach((item) => add(item, preferredKind, meta));
      return;
    }

    const direct = candidateUrl(value);
    if (direct) {
      if (!isDirectVideo(direct) || seen.has(direct)) return;
      seen.add(direct);
      candidates.push({
        url: direct,
        source: sourceIndex++,
        referer: meta.referer || meta.referrer || "",
      });
      return;
    }

    if (!value || typeof value !== "object") return;
    const nextMeta = {
      referer: value.referer || value.referrer || meta.referer || meta.referrer || "",
    };

    if (value.embed) add(value.embed, "iframe", nextMeta);
    if (value.stream_url) add(value.stream_url, "", nextMeta);
    if (value.url) add(value.url, "", nextMeta);
    if (value.file) add(value.file, "", nextMeta);
    if (value.src) add(value.src, "", nextMeta);
    if (value.link) add(value.link, "", nextMeta);
  };

  add(data?.embeds, "iframe");
  add(data?.allServers, "iframe");
  add(data?.streams);
  add(data?.sources);
  add(data?.stream_url);
  return candidates;
}

function safePart(value, fallback) {
  const clean = String(value || fallback)
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return clean || fallback;
}

function internalUrl(port, path) {
  return `http://127.0.0.1:${port}${path}`;
}

function responseJson(res, status, data) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function ffmpegArgs(input, referer) {
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
    "-user_agent", USER_AGENT,
  ];

  if (referer) {
    args.push("-headers", `Referer: ${referer}\r\n`);
  }

  args.push(
    "-i", input,
    "-map", "0:v:0?",
    "-map", "0:a:0?",
    "-c", "copy",
    "-movflags", "frag_keyframe+empty_moov+faststart",
    "-f", "mp4",
    "pipe:1",
  );
  return args;
}

/*
 * Node/Railway download handler. This intentionally lives outside the edge
 * worker because ffmpeg requires a native process and cannot run in a
 * serverless edge function.
 */
export async function handleDownloadRequest(req, res, { worker, port }) {
  const host = req.headers.host || `localhost:${port}`;
  const url = new URL(req.url, `http://${host}`);
  const match = url.pathname.match(
    /^\/download\/([a-z0-9-]+)\/(\d+)\/(sub|dub)\/([a-z0-9-]+)-(\d+)\/?$/i,
  );

  if (!match) return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    });
    res.end();
    return true;
  }

  if (req.method !== "GET") {
    responseJson(res, 405, { error: "Download only supports GET" });
    return true;
  }

  if (ACTIVE_DOWNLOADS.size >= MAX_DOWNLOADS) {
    responseJson(res, 429, {
      error: "Too many downloads are active",
      retryAfterSeconds: 15,
    });
    return true;
  }

  const [, provider, anilistId, audio, , episode] = match;
  const source = Math.max(0, Number.parseInt(url.searchParams.get("source") || "0", 10) || 0);
  const jobKey = `${provider}:${anilistId}:${audio}:${episode}:${source}`;
  ACTIVE_DOWNLOADS.add(jobKey);

  let ffmpeg;
  try {
    const watchPath = `/watch/${provider}/${anilistId}/${audio}/${provider}-${episode}`;
    const watchRequest = new Request(internalUrl(port, watchPath), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const watchResponse = await worker.fetch(watchRequest, {});
    const data = await watchResponse.json().catch(() => null);

    if (!watchResponse.ok || !data) {
      responseJson(res, watchResponse.status || 502, {
        error: data?.error || "Could not resolve the episode sources",
      });
      return true;
    }

    const candidates = collectDirectCandidates(data);
    const candidate = candidates.find((item) => item.source === source) || candidates[0];
    if (!candidate) {
      responseJson(res, 404, {
        error: "This episode has no direct downloadable video source",
        available: "Use an embed server for playback instead",
      });
      return true;
    }

    const input = candidate.url.startsWith("/")
      ? internalUrl(port, candidate.url)
      : candidate.url;
    const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
    const filename = [
      safePart(provider, "anivexa"),
      safePart(anilistId, "anime"),
      `ep-${safePart(episode, "1")}`,
      audio,
      `q-${source + 1}`,
    ].join("-") + ".mp4";

    ffmpeg = spawn(ffmpegPath, ffmpegArgs(input, candidate.referer), {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let headersSent = false;
    let stderr = "";
    ffmpeg.stderr.setEncoding("utf8");
    ffmpeg.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });

    ffmpeg.stdout.on("data", (chunk) => {
      if (!headersSent) {
        headersSent = true;
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
          "X-Anivexa-Source": String(source),
        });
      }
      res.write(chunk);
    });

    ffmpeg.on("error", (error) => {
      if (!headersSent) {
        responseJson(res, 503, {
          error: "FFmpeg is not available on this server",
          detail: error.message,
        });
      } else {
        res.destroy(error);
      }
    });

    ffmpeg.on("close", (code) => {
      ACTIVE_DOWNLOADS.delete(jobKey);
      if (!headersSent) {
        responseJson(res, 502, {
          error: "The source could not be converted into an MP4 download",
          detail: stderr.trim() || `ffmpeg exited with code ${code}`,
        });
        return;
      }
      if (!res.writableEnded) res.end();
    });

    res.on("close", () => {
      if (ffmpeg && !ffmpeg.killed) ffmpeg.kill("SIGTERM");
      ACTIVE_DOWNLOADS.delete(jobKey);
    });
  } catch (error) {
    ACTIVE_DOWNLOADS.delete(jobKey);
    if (ffmpeg && !ffmpeg.killed) ffmpeg.kill("SIGTERM");
    responseJson(res, 500, { error: error.message });
  }

  return true;
}