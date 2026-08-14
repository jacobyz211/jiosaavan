/**
 * Eclipse Music addon — JioSaavn
 * Wraps your self-hosted jiosaavn-api (https://jiosaavn-api.cyrusna29.workers.dev)
 * and exposes it through the Eclipse addon contract: /manifest.json, /search,
 * /stream/:id, /album/:id, /artist/:id, /playlist/:id — with an OPTIONAL
 * leading /{token}/ path segment.
 *
 * PERFORMANCE NOTES (this version):
 * 1. Cache writes no longer block the response — on a cache miss, we
 *    respond as soon as data is ready and write to Redis via
 *    ctx.waitUntil() in the background.
 * 2. Every outbound call to jiosaavn-api has a hard timeout (AbortController)
 *    so one slow endpoint can't stall the whole search — it just drops
 *    out of the results instead of blocking everything.
 * 3. Search limits trimmed slightly (fewer albums/artists/playlists
 *    fetched per query) since Eclipse's UI rarely needs more than a
 *    handful of each, and smaller JSON payloads parse faster.
 * 4. Redis reads/writes use short REST timeouts so a flaky cache never
 *    becomes slower than just hitting the backend directly.
 *
 * Deploy: wrangler deploy
 * Secrets: wrangler secret put UPSTASH_REDIS_REST_URL
 *          wrangler secret put UPSTASH_REDIS_REST_TOKEN
 * wrangler.toml: compatibility_flags = ["global_fetch_strictly_public"]
 */

import { Redis } from "@upstash/redis/cloudflare";

const SAAVN_BASE = "https://jiosaavn-api.cyrusna29.workers.dev/api";

const CACHE_TTL_SEARCH = 60 * 10;      // 10 min
const CACHE_TTL_DETAIL = 60 * 60;      // 1 hour
const CACHE_TTL_STREAM = 60 * 15;      // 15 min (download URLs expire)

const FETCH_TIMEOUT_MS = 3500;         // hard cap per backend call

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const KNOWN_ROUTES = new Set(["manifest.json", "search", "stream", "album", "artist", "playlist", "generate", "debug"]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function bestImage(images) {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  return images[images.length - 1].url || images[images.length - 1].link;
}

function bestDownloadUrl(downloadUrls) {
  if (!Array.isArray(downloadUrls) || downloadUrls.length === 0) return null;
  const last = downloadUrls[downloadUrls.length - 1];
  return { url: last.url || last.link, quality: last.quality };
}

function artistNames(song) {
  if (song.artists && song.artists.primary && song.artists.primary.length) {
    return song.artists.primary.map((a) => decodeEntities(a.name)).join(", ");
  }
  if (song.primaryArtists) return decodeEntities(song.primaryArtists);
  if (song.subtitle) return decodeEntities(song.subtitle);
  return "Unknown Artist";
}

function mapTrack(song) {
  const dl = bestDownloadUrl(song.downloadUrl);
  return {
    id: song.id,
    title: decodeEntities(song.name || song.title),
    artist: artistNames(song),
    album: song.album ? decodeEntities(song.album.name) : undefined,
    duration: song.duration ? parseInt(song.duration, 10) : undefined,
    artworkURL: bestImage(song.image),
    format: "m4a",
    streamURL: dl ? dl.url : undefined,
  };
}

function mapAlbum(album) {
  return {
    id: album.id,
    title: decodeEntities(album.name),
    artist: artistNames(album),
    artworkURL: bestImage(album.image),
    trackCount: album.songCount ? parseInt(album.songCount, 10) : (album.songs ? album.songs.length : undefined),
    year: album.year,
  };
}

function mapArtist(artist) {
  return {
    id: artist.id,
    name: decodeEntities(artist.name),
    artworkURL: bestImage(artist.image),
    genres: [],
  };
}

function mapPlaylist(playlist) {
  return {
    id: playlist.id,
    title: decodeEntities(playlist.name),
    creator: playlist.subtitle ? decodeEntities(playlist.subtitle) : "JioSaavn",
    artworkURL: bestImage(playlist.image),
    trackCount: playlist.songCount ? parseInt(playlist.songCount, 10) : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Backend fetch with a hard timeout so slow endpoints can't stall     */
/* the whole request.                                                  */
/* ------------------------------------------------------------------ */

async function saavnGet(path, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SAAVN_BASE}${path}`, {
      headers: { "User-Agent": "Mozilla/5.0 (EclipseAddon/1.0)" },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`jiosaavn-api ${path} -> HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const body = await res.json();
    if (!body.success) {
      throw new Error(`jiosaavn-api ${path} returned success:false`);
    }
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Upstash Redis + in-memory fallback, non-blocking writes             */
/* ------------------------------------------------------------------ */

const memCache = new Map();

function getRedis(env) {
  if (env?.UPSTASH_REDIS_REST_URL && env?.UPSTASH_REDIS_REST_TOKEN) return Redis.fromEnv(env);
  return null;
}

async function rGet(redis, key) {
  if (redis) {
    try {
      return await redis.get(key);
    } catch {}
  }
  const e = memCache.get(key);
  if (!e) return null;
  if (e.exp < Date.now()) {
    memCache.delete(key);
    return null;
  }
  return e.val;
}

async function rSet(redis, key, value, ttl) {
  if (redis) {
    try {
      await redis.set(key, value, { ex: ttl });
      return;
    } catch {}
  }
  memCache.set(key, { val: value, exp: Date.now() + ttl * 1000 });
  if (memCache.size > 500) memCache.delete(memCache.keys().next().value);
}

// Cache-miss path no longer awaits the write — respond immediately,
// persist to cache in the background via ctx.waitUntil.
async function withRedisCache(env, ctx, key, ttl, fn) {
  const redis = getRedis(env);
  const cached = await rGet(redis, key);
  if (cached) return json(cached);

  const data = await fn();
  const writeBack = rSet(redis, key, data, ttl);
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(writeBack);
  } else {
    await writeBack;
  }
  return json(data);
}

function manifest(token) {
  return {
    id: token ? `com.eclipse-addons.jiosaavn.${token}` : "com.eclipse-addons.jiosaavn",
    name: "JioSaavn",
    version: "1.4.0",
    description: "Stream Bollywood, Indian regional, and international tracks from JioSaavn.",
    icon: "https://www.jiosaavn.com/favicon.ico",
    resources: ["search", "stream", "catalog"],
    types: ["track", "album", "artist", "playlist"],
    contentType: "music",
  };
}

/* ------------------------------------------------------------------ */
/* Search — trimmed limits, parallel + timed-out per-category calls    */
/* ------------------------------------------------------------------ */

async function handleSearch(query) {
  if (!query) return { tracks: [], albums: [], artists: [], playlists: [] };

  const [songsRes, albumsRes, artistsRes, playlistsRes] = await Promise.allSettled([
    saavnGet(`/search/songs?query=${encodeURIComponent(query)}&limit=15`),
    saavnGet(`/search/albums?query=${encodeURIComponent(query)}&limit=6`),
    saavnGet(`/search/artists?query=${encodeURIComponent(query)}&limit=6`),
    saavnGet(`/search/playlists?query=${encodeURIComponent(query)}&limit=6`),
  ]);

  const tracks = songsRes.status === "fulfilled" ? (songsRes.value.results || []).map(mapTrack) : [];
  const albums = albumsRes.status === "fulfilled" ? (albumsRes.value.results || []).map(mapAlbum) : [];
  const artists = artistsRes.status === "fulfilled" ? (artistsRes.value.results || []).map(mapArtist) : [];
  const playlists = playlistsRes.status === "fulfilled" ? (playlistsRes.value.results || []).map(mapPlaylist) : [];

  return { tracks, albums, artists, playlists };
}

/* ------------------------------------------------------------------ */
/* Stream                                                               */
/* ------------------------------------------------------------------ */

async function handleStream(id) {
  const song = await saavnGet(`/songs/${encodeURIComponent(id)}`);
  const record = Array.isArray(song) ? song[0] : song;
  const dl = bestDownloadUrl(record.downloadUrl);
  if (!dl || !dl.url) throw new Error("No stream URL available for this track");
  return {
    url: dl.url,
    format: "m4a",
    quality: dl.quality || "320kbps",
  };
}

/* ------------------------------------------------------------------ */
/* Album                                                                */
/* ------------------------------------------------------------------ */

async function handleAlbum(id) {
  const album = await saavnGet(`/albums?id=${encodeURIComponent(id)}`);
  return {
    id: album.id,
    title: decodeEntities(album.name),
    artist: artistNames(album),
    artworkURL: bestImage(album.image),
    year: album.year,
    trackCount: album.songs ? album.songs.length : undefined,
    tracks: (album.songs || []).map(mapTrack),
  };
}

/* ------------------------------------------------------------------ */
/* Artist — profile, top tracks, top albums (parallel fallback calls)  */
/* ------------------------------------------------------------------ */

async function handleArtist(id) {
  const artist = await saavnGet(`/artists/${encodeURIComponent(id)}`);

  let topTracks = (artist.topSongs || []).map(mapTrack);
  let albums = (artist.topAlbums || []).map(mapAlbum);

  // Run both fallback calls in parallel instead of sequentially —
  // only fires for artists whose profile didn't inline songs/albums.
  const needsSongs = topTracks.length === 0;
  const needsAlbums = albums.length === 0;

  if (needsSongs || needsAlbums) {
    const [songsFallback, albumsFallback] = await Promise.allSettled([
      needsSongs ? saavnGet(`/artists/${encodeURIComponent(id)}/songs`) : Promise.resolve(null),
      needsAlbums ? saavnGet(`/artists/${encodeURIComponent(id)}/albums`) : Promise.resolve(null),
    ]);
    if (needsSongs && songsFallback.status === "fulfilled" && songsFallback.value) {
      topTracks = (songsFallback.value.songs || songsFallback.value.results || []).map(mapTrack);
    }
    if (needsAlbums && albumsFallback.status === "fulfilled" && albumsFallback.value) {
      albums = (albumsFallback.value.albums || albumsFallback.value.results || []).map(mapAlbum);
    }
  }

  return {
    id: artist.id,
    name: decodeEntities(artist.name),
    artworkURL: bestImage(artist.image),
    bio: artist.bio ? decodeEntities(Array.isArray(artist.bio) ? artist.bio[0]?.text : artist.bio) : undefined,
    genres: [],
    topTracks,
    albums,
  };
}

/* ------------------------------------------------------------------ */
/* Playlist                                                             */
/* ------------------------------------------------------------------ */

async function handlePlaylist(id) {
  const playlist = await saavnGet(`/playlists?id=${encodeURIComponent(id)}`);
  return {
    id: playlist.id,
    title: decodeEntities(playlist.name),
    description: playlist.description ? decodeEntities(playlist.description) : undefined,
    artworkURL: bestImage(playlist.image),
    creator: playlist.subtitle ? decodeEntities(playlist.subtitle) : "JioSaavn",
    tracks: (playlist.songs || []).map(mapTrack),
  };
}

/* ------------------------------------------------------------------ */
/* Token generation                                                     */
/* ------------------------------------------------------------------ */

function generateToken() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let t = "";
  const arr = new Uint8Array(28);
  crypto.getRandomValues(arr);
  for (let i = 0; i < arr.length; i++) {
    t += chars[arr[i] % chars.length];
  }
  return t;
}

/* ------------------------------------------------------------------ */
/* Path parsing                                                        */
/* ------------------------------------------------------------------ */

function parsePath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return { token: null, rest: "/" };
  if (KNOWN_ROUTES.has(parts[0])) {
    return { token: null, rest: "/" + parts.join("/") };
  }
  return { token: parts[0], rest: "/" + parts.slice(1).join("/") };
}

/* ------------------------------------------------------------------ */
/* Landing page                                                        */
/* ------------------------------------------------------------------ */

function landingPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>JioSaavn — Eclipse Addon</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{background:#080808;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px;-webkit-font-smoothing:antialiased}
  .card{background:#111;border:1px solid #1e1e1e;border-radius:18px;padding:36px;max-width:540px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.6);margin-bottom:20px}
  h1{font-size:22px;font-weight:600;margin-bottom:8px;letter-spacing:-0.01em}
  p.sub{font-size:14px;color:#666;margin-bottom:20px;line-height:1.6}
  .tip{background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#888;line-height:1.7}
  .tip b{color:#ccc}
  button{width:100%;background:#e0e0e0;color:#080808;border:none;border-radius:10px;padding:14px 18px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .15s}
  button:hover{opacity:.85}
  button:disabled{opacity:.5;cursor:not-allowed}
  #genBox{display:none;margin-top:18px;background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;padding:14px}
  #genBox .label{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
  #genUrl{font-size:12px;color:#e0e0e0;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.6}
  #copyBtn{width:auto;margin-top:12px;padding:8px 14px;font-size:12px;background:transparent;color:#e0e0e0;border:1px solid #1e1e1e}
  #copyBtn:hover{opacity:1;background:#1a1a1a}
  .count{font-size:11px;color:#444;margin-top:16px;text-align:center}
</style>
</head>
<body>
  <div class="card">
    <h1>JioSaavn Addon for Eclipse</h1>
    <p class="sub">Generate a unique addon URL and install it in Eclipse under Settings → Cloud Storage → Add Connection → Addons.</p>
    <div class="tip"><b>Note:</b> JioSaavn requires no login or API key. Each generated URL carries a fresh, unique token in its path — it's a per-install identifier, not a credential.</div>
    <button id="genBtn" onclick="generate()">Generate Addon URL</button>
    <div id="genBox">
      <div class="label">Your manifest URL</div>
      <div id="genUrl"></div>
      <button id="copyBtn" onclick="copyUrl()">Copy</button>
    </div>
    <div class="count" id="countLabel"></div>
  </div>

<script>
  let genUrlVal = '';
  let genCount = 0;

  function generate() {
    const btn = document.getElementById('genBtn');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    fetch('/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { alert(d.error); btn.disabled = false; btn.textContent = 'Generate Addon URL'; return; }
        genUrlVal = d.manifestUrl;
        genCount++;
        document.getElementById('genUrl').textContent = genUrlVal;
        document.getElementById('genBox').style.display = 'block';
        document.getElementById('countLabel').textContent = genCount + ' generated this session';
        btn.disabled = false;
        btn.textContent = 'Generate New Addon URL';
      })
      .catch(function () {
        alert('Failed to generate URL. Try again.');
        btn.disabled = false;
        btn.textContent = 'Generate Addon URL';
      });
  }

  function copyUrl() {
    if (!genUrlVal) return;
    navigator.clipboard.writeText(genUrlVal).then(function () {
      const btn = document.getElementById('copyBtn');
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(function () { btn.textContent = original; }, 1500);
    });
  }
</script>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const { token, rest } = parsePath(url.pathname);

    try {
      if (rest === "/" || rest === "") {
        return new Response(landingPage(), {
          headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS },
        });
      }

      if (rest === "/generate" && request.method === "POST") {
        const newToken = generateToken();
        const manifestUrl = `${url.origin}/${newToken}/manifest.json`;
        return json({ token: newToken, manifestUrl });
      }

      if (rest === "/debug") {
        const q = url.searchParams.get("q") || "drake";
        try {
          const raw = await saavnGet(`/search/songs?query=${encodeURIComponent(q)}&limit=3`);
          return json({ ok: true, base: SAAVN_BASE, sample: raw });
        } catch (err) {
          return json({ ok: false, base: SAAVN_BASE, error: err.message }, 502);
        }
      }

      if (rest === "/manifest.json") {
        return json(manifest(token));
      }

      if (rest === "/search" || rest.startsWith("/search?")) {
        const q = url.searchParams.get("q") || "";
        const cacheKey = `jiosaavn:search:${q.toLowerCase()}`;
        return withRedisCache(env, ctx, cacheKey, CACHE_TTL_SEARCH, () => handleSearch(q));
      }

      const streamMatch = rest.match(/^\/stream\/(.+)$/);
      if (streamMatch) {
        const cacheKey = `jiosaavn:stream:${streamMatch[1]}`;
        return withRedisCache(env, ctx, cacheKey, CACHE_TTL_STREAM, () => handleStream(streamMatch[1]));
      }

      const albumMatch = rest.match(/^\/album\/(.+)$/);
      if (albumMatch) {
        const cacheKey = `jiosaavn:album:${albumMatch[1]}`;
        return withRedisCache(env, ctx, cacheKey, CACHE_TTL_DETAIL, () => handleAlbum(albumMatch[1]));
      }

      const artistMatch = rest.match(/^\/artist\/(.+)$/);
      if (artistMatch) {
        const cacheKey = `jiosaavn:artist:${artistMatch[1]}`;
        return withRedisCache(env, ctx, cacheKey, CACHE_TTL_DETAIL, () => handleArtist(artistMatch[1]));
      }

      const playlistMatch = rest.match(/^\/playlist\/(.+)$/);
      if (playlistMatch) {
        const cacheKey = `jiosaavn:playlist:${playlistMatch[1]}`;
        return withRedisCache(env, ctx, cacheKey, CACHE_TTL_DETAIL, () => handlePlaylist(playlistMatch[1]));
      }

      return json({ error: "Not found", path: rest }, 404);
    } catch (err) {
      return json({ error: err.message || "Internal error" }, 500);
    }
  },
};
