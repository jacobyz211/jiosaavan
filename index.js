/**
 * Eclipse Music addon — JioSaavn (direct)
 *
 * Talks directly to JioSaavn's raw internal API (api.php). Every call
 * carries spoofed India geo headers (X-Forwarded-For / Client-IP +
 * language cookie) so India-licensed catalog (mainstream Western
 * tracks included) is unlocked without needing the self-hosted
 * jiosaavn-api backend as a middle hop.
 *
 * Endpoint names (confirmed against a working reference config):
 *   songs:     search.getResults        <-- fixed, was search.getSongResults
 *   albums:    search.getAlbumResults
 *   artists:   search.getArtistResults
 *   playlists: search.getPlaylistResults
 *   song:      song.getDetails
 *   album:     content.getAlbumDetails
 *   artist:    artist.getArtistPageDetails
 *   playlist:  playlist.getDetails
 *
 * Stream URLs come back DES-ECB encrypted (key "38346591") and are
 * decrypted here.
 *
 * CACHING POLICY:
 * - /search and /stream/:id are ALWAYS fetched fresh, no cache.
 * - /album, /artist, /playlist are cached via Upstash Redis.
 *
 * Deploy: wrangler deploy
 * wrangler.toml: compatibility_flags = ["global_fetch_strictly_public"]
 */

import { Redis } from "@upstash/redis/cloudflare";

/* ------------------------------------------------------------------ */
/* DES-ECB decryption (JioSaavn's media URL encryption scheme)         */
/* ------------------------------------------------------------------ */

const DES = (function () {
  const IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7];
  const FP = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25];
  const E = [32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,16,17,18,19,20,21,20,21,22,23,24,25,24,25,26,27,28,29,28,29,30,31,32,1];
  const P = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
  const S = [
    [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
    [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
    [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
    [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
    [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
    [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
    [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
    [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
  ];
  const PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4];
  const PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32];
  const SHIFTS = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];

  function permute(bits, table) {
    const out = new Array(table.length);
    for (let i = 0; i < table.length; i++) out[i] = bits[table[i] - 1];
    return out;
  }
  function bytesToBits(bytes) {
    const bits = [];
    for (let i = 0; i < bytes.length; i++) for (let j = 7; j >= 0; j--) bits.push((bytes[i] >> j) & 1);
    return bits;
  }
  function bitsToBytes(bits) {
    const bytes = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bytes.length; i++) {
      let val = 0;
      for (let j = 0; j < 8; j++) val = (val << 1) | bits[i * 8 + j];
      bytes[i] = val;
    }
    return bytes;
  }
  function generateSubkeys(keyBytes) {
    const keyBits = bytesToBits(keyBytes);
    const pc1Bits = permute(keyBits, PC1);
    let C = pc1Bits.slice(0, 28);
    let D = pc1Bits.slice(28, 56);
    const subkeys = [];
    for (let r = 0; r < 16; r++) {
      const shift = SHIFTS[r];
      C = C.slice(shift).concat(C.slice(0, shift));
      D = D.slice(shift).concat(D.slice(0, shift));
      subkeys.push(permute(C.concat(D), PC2));
    }
    return subkeys;
  }
  function feistel(R, K) {
    const expandedR = permute(R, E);
    const xored = new Array(48);
    for (let i = 0; i < 48; i++) xored[i] = expandedR[i] ^ K[i];
    const sOutput = new Array(32);
    for (let i = 0; i < 8; i++) {
      const chunk = xored.slice(i * 6, (i + 1) * 6);
      const row = (chunk[0] << 1) | chunk[5];
      const col = (chunk[1] << 3) | (chunk[2] << 2) | (chunk[3] << 1) | chunk[4];
      const val = S[i][row * 16 + col];
      sOutput[i * 4] = (val >> 3) & 1;
      sOutput[i * 4 + 1] = (val >> 2) & 1;
      sOutput[i * 4 + 2] = (val >> 1) & 1;
      sOutput[i * 4 + 3] = val & 1;
    }
    return permute(sOutput, P);
  }
  function decryptBlock(blockBytes, subkeys) {
    const blockBits = bytesToBits(blockBytes);
    const permutedBlock = permute(blockBits, IP);
    let L = permutedBlock.slice(0, 32);
    let R = permutedBlock.slice(32, 64);
    for (let r = 15; r >= 0; r--) {
      const temp = R;
      const fOut = feistel(R, subkeys[r]);
      const newR = new Array(32);
      for (let i = 0; i < 32; i++) newR[i] = L[i] ^ fOut[i];
      L = temp;
      R = newR;
    }
    return bitsToBytes(permute(R.concat(L), FP));
  }

  const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function parseBase64(b64) {
    const str = b64.replace(/[^A-Za-z0-9+/=]/g, "");
    let binStr = "";
    for (let i = 0; i < str.length; i += 4) {
      const enc1 = B64_CHARS.indexOf(str.charAt(i));
      const enc2 = B64_CHARS.indexOf(str.charAt(i + 1));
      const enc3 = B64_CHARS.indexOf(str.charAt(i + 2));
      const enc4 = B64_CHARS.indexOf(str.charAt(i + 3));
      const chr1 = (enc1 << 2) | (enc2 >> 4);
      const chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
      const chr3 = ((enc3 & 3) << 6) | enc4;
      binStr += String.fromCharCode(chr1);
      if (enc3 !== 64 && enc3 !== -1 && str.charAt(i + 2) !== "=") binStr += String.fromCharCode(chr2);
      if (enc4 !== 64 && enc4 !== -1 && str.charAt(i + 3) !== "=") binStr += String.fromCharCode(chr3);
    }
    return binStr;
  }
  function base64ToBytes(b64) {
    const binStr = typeof atob === "function" ? atob(b64) : parseBase64(b64);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    return bytes;
  }
  function bytesToUtf8(bytes) {
    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);
    let str = "";
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(str));
  }
  function decrypt(encryptedB64, keyStr) {
    const keyBytes = new Uint8Array(8);
    for (let i = 0; i < 8 && i < keyStr.length; i++) keyBytes[i] = keyStr.charCodeAt(i);
    const subkeys = generateSubkeys(keyBytes);
    const cipherBytes = base64ToBytes(encryptedB64);
    if (cipherBytes.length % 8 !== 0) throw new Error("Invalid cipher text length");
    const decryptedBytes = new Uint8Array(cipherBytes.length);
    for (let i = 0; i < cipherBytes.length; i += 8) {
      decryptedBytes.set(decryptBlock(cipherBytes.subarray(i, i + 8), subkeys), i);
    }
    const padLen = decryptedBytes[decryptedBytes.length - 1];
    if (padLen > 0 && padLen <= 8) {
      let validPad = true;
      for (let i = decryptedBytes.length - padLen; i < decryptedBytes.length; i++) {
        if (decryptedBytes[i] !== padLen) { validPad = false; break; }
      }
      if (validPad) return bytesToUtf8(decryptedBytes.subarray(0, decryptedBytes.length - padLen));
    }
    return bytesToUtf8(decryptedBytes);
  }

  return { decrypt };
})();

/* ------------------------------------------------------------------ */
/* JioSaavn raw API config                                             */
/* ------------------------------------------------------------------ */

const API_BASE = "https://www.jiosaavn.com/api.php";
const DES_KEY = "38346591";

const INDIA_IP = "49.36.0.1";
const INDIA_LANGUAGE_COOKIE =
  "L=english%2Chindi%2Cpunjabi%2Ctamil%2Ctelugu%2Cmarathi%2Cgujarati%2Cbengali%2Ckannada%2Cmalayalam%2Cbhojpuri%2Crajasthani%2Curdu%2Charyanvi; gdpr_acceptance=true;";

const FETCH_TIMEOUT_MS = 3500;
const STREAM_TIMEOUT_MS = 3000;
const STREAM_RETRY_TIMEOUT_MS = 2500;
const CACHE_TTL_DETAIL = 60 * 60;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const KNOWN_ROUTES = new Set(["manifest.json", "search", "stream", "album", "artist", "playlist", "generate", "debug"]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

function sanitizeText(text) {
  if (!text) return "";
  return String(text).replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function upgradeArtwork(url) {
  if (!url) return "";
  return url.replace("http:", "https:").replace(/-(50x50|150x150|250x250)\./g, "-500x500.");
}

function formatArtist(item) {
  if (!item) return "Unknown Artist";
  const more = item.more_info || {};
  if (more.artistMap && more.artistMap.primary_artists && more.artistMap.primary_artists.length) {
    return more.artistMap.primary_artists.map((a) => a.name).join(", ");
  }
  if (more.music) return more.music;
  if (item.subtitle) return item.subtitle;
  if (item.primary_artists) return item.primary_artists;
  return "Unknown Artist";
}

async function jioFetch(callName, params, timeoutMs = FETCH_TIMEOUT_MS) {
  const queryObj = Object.assign(
    {
      __call: callName,
      _format: "json",
      _marker: "0",
      api_version: "4",
      ctx: "web6dot0",
      language: "english,hindi,punjabi,tamil,telugu,marathi,gujarati,bengali,kannada,malayalam,bhojpuri,rajasthani,urdu,haryanvi",
    },
    params || {}
  );
  const searchParams = new URLSearchParams();
  Object.keys(queryObj).forEach((k) => searchParams.append(k, queryObj[k]));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}?${searchParams.toString()}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Cookie": INDIA_LANGUAGE_COOKIE,
        "X-Forwarded-For": INDIA_IP,
        "Client-IP": INDIA_IP,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`JioSaavn ${callName} -> HTTP ${response.status}`);
    const data = await response.json();
    if (data && data.error) {
      throw new Error(`JioSaavn ${callName} -> ${data.error.code || ""} ${data.error.msg || JSON.stringify(data.error)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Mapping — raw JioSaavn item -> Eclipse track/album/artist/playlist  */
/* ------------------------------------------------------------------ */

function mapTrack(item) {
  if (!item) return null;
  const more = item.more_info || {};
  const id = String(item.id || item.song_id || "");
  if (!id) return null;
  return {
    id,
    title: sanitizeText(item.title || item.song || "Untitled"),
    artist: sanitizeText(formatArtist(item)),
    album: sanitizeText(more.album || item.album || ""),
    duration: parseInt(more.duration || item.duration || 0, 10),
    artworkURL: upgradeArtwork(item.image),
    format: "mp4",
  };
}

function mapAlbum(item) {
  return {
    id: String(item.id || ""),
    title: sanitizeText(item.title || item.name || "Untitled Album"),
    artist: sanitizeText(formatArtist(item)),
    artworkURL: upgradeArtwork(item.image),
    trackCount: item.more_info && item.more_info.song_count ? parseInt(item.more_info.song_count, 10) : undefined,
    year: item.year,
  };
}

function mapArtist(item) {
  return {
    id: String(item.id || item.artistid || ""),
    name: sanitizeText(item.title || item.name || "Unknown Artist"),
    artworkURL: upgradeArtwork(item.image),
    genres: [],
  };
}

function mapPlaylist(item) {
  return {
    id: String(item.id || item.listid || ""),
    title: sanitizeText(item.title || item.listname || "Untitled Playlist"),
    creator: sanitizeText(item.firstname || item.subtitle || "JioSaavn"),
    artworkURL: upgradeArtwork(item.image),
    trackCount: item.more_info && item.more_info.song_count ? parseInt(item.more_info.song_count, 10) : undefined,
  };
}

function formatAudioUrl(decryptedUrl, preferredQuality) {
  if (!decryptedUrl) return "";
  const bitrate = preferredQuality || "320";
  return decryptedUrl.replace(/_(12|48|96|128|160|320)\.(mp4|mp3)$/i, `_${bitrate}.$2`);
}

/* ------------------------------------------------------------------ */
/* Upstash Redis — used ONLY for /album, /artist, /playlist            */
/* ------------------------------------------------------------------ */

const memCache = new Map();

function getRedis(env) {
  if (env?.UPSTASH_REDIS_REST_URL && env?.UPSTASH_REDIS_REST_TOKEN) return Redis.fromEnv(env);
  return null;
}

async function rGet(redis, key) {
  if (redis) { try { return await redis.get(key); } catch {} }
  const e = memCache.get(key);
  if (!e) return null;
  if (e.exp < Date.now()) { memCache.delete(key); return null; }
  return e.val;
}

async function rSet(redis, key, value, ttl) {
  if (redis) { try { await redis.set(key, value, { ex: ttl }); return; } catch {} }
  memCache.set(key, { val: value, exp: Date.now() + ttl * 1000 });
  if (memCache.size > 500) memCache.delete(memCache.keys().next().value);
}

async function withRedisCache(env, ctx, key, ttl, fn) {
  const redis = getRedis(env);
  const cached = await rGet(redis, key);
  if (cached) return json(cached);
  const data = await fn();
  const writeBack = rSet(redis, key, data, ttl);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(writeBack);
  else await writeBack;
  return json(data);
}

function manifest(token) {
  return {
    id: token ? `com.eclipse-addons.jiosaavn.${token}` : "com.eclipse-addons.jiosaavn",
    name: "JioSaavn",
    version: "2.0.1",
    description: "Stream Bollywood, Indian regional, and international tracks from JioSaavn — direct API, India-region headers.",
    icon: "https://www.jiosaavn.com/favicon.ico",
    resources: ["search", "stream", "catalog"],
    types: ["track", "album", "artist", "playlist"],
    contentType: "music",
  };
}

/* ------------------------------------------------------------------ */
/* Search — always fresh, four parallel raw-API calls                  */
/* ------------------------------------------------------------------ */

async function handleSearch(query) {
  if (!query) return { tracks: [], albums: [], artists: [], playlists: [] };

  const [songsRes, albumsRes, artistsRes, playlistsRes] = await Promise.allSettled([
    jioFetch("search.getResults", { q: query, p: "1", n: "15" }),
    jioFetch("search.getAlbumResults", { q: query, p: "1", n: "6" }),
    jioFetch("search.getArtistResults", { q: query, p: "1", n: "6" }),
    jioFetch("search.getPlaylistResults", { q: query, p: "1", n: "6" }),
  ]);

  const tracks = songsRes.status === "fulfilled" ? ((songsRes.value.results || []).map(mapTrack).filter(Boolean)) : [];
  const albums = albumsRes.status === "fulfilled" ? ((albumsRes.value.results || []).map(mapAlbum)) : [];
  const artists = artistsRes.status === "fulfilled" ? ((artistsRes.value.results || []).map(mapArtist)) : [];
  const playlists = playlistsRes.status === "fulfilled" ? ((playlistsRes.value.results || []).map(mapPlaylist)) : [];

  return { tracks, albums, artists, playlists };
}

/* ------------------------------------------------------------------ */
/* Stream — song.getDetails + DES decrypt, always fresh, one retry     */
/* ------------------------------------------------------------------ */

async function resolveStream(id, timeoutMs) {
  const data = await jioFetch("song.getDetails", { pids: id }, timeoutMs);
  const songObj = data[id] || (data.songs && data.songs[0]);
  if (!songObj) throw new Error("Track not found");
  const encUrl = (songObj.more_info && songObj.more_info.encrypted_media_url) || songObj.encrypted_media_url;
  if (!encUrl) throw new Error("No encrypted media URL found for this track");
  const decrypted = DES.decrypt(encUrl, DES_KEY);
  const finalUrl = formatAudioUrl(decrypted, "320");
  return {
    url: finalUrl,
    format: finalUrl.indexOf(".mp3") !== -1 ? "mp3" : "mp4",
    quality: finalUrl.indexOf("_320") !== -1 ? "320kbps" : "160kbps",
  };
}

async function handleStream(id) {
  try {
    return await resolveStream(id, STREAM_TIMEOUT_MS);
  } catch (firstErr) {
    try {
      return await resolveStream(id, STREAM_RETRY_TIMEOUT_MS);
    } catch {
      throw firstErr;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Album (cached)                                                       */
/* ------------------------------------------------------------------ */

async function handleAlbum(id) {
  const data = await jioFetch("content.getAlbumDetails", { albumid: id });
  const tracks = (data.list || data.songs || []).map(mapTrack).filter(Boolean);
  return {
    id: String(data.id || id),
    title: sanitizeText(data.title || data.name || "Untitled Album"),
    artist: sanitizeText(formatArtist(data)),
    artworkURL: upgradeArtwork(data.image),
    year: data.year,
    trackCount: tracks.length,
    tracks,
  };
}

/* ------------------------------------------------------------------ */
/* Artist (cached)                                                      */
/* ------------------------------------------------------------------ */

async function handleArtist(id) {
  const data = await jioFetch("artist.getArtistPageDetails", { artistId: id });

  const rawSongs = (data.topSongs && (data.topSongs.songs || data.topSongs)) || data.top_songs || [];
  const rawAlbums = (data.topAlbums && (data.topAlbums.albums || data.topAlbums)) || data.top_albums || [];

  const topTracks = Array.isArray(rawSongs) ? rawSongs.map(mapTrack).filter(Boolean) : [];
  const albums = Array.isArray(rawAlbums) ? rawAlbums.map(mapAlbum) : [];

  return {
    id: String(data.artistId || data.id || id),
    name: sanitizeText(data.name || data.title || "Unknown Artist"),
    artworkURL: upgradeArtwork(data.image),
    bio: data.bio ? sanitizeText(Array.isArray(data.bio) ? data.bio[0]?.text : data.bio) : undefined,
    genres: [],
    topTracks,
    albums,
  };
}

/* ------------------------------------------------------------------ */
/* Playlist (cached)                                                    */
/* ------------------------------------------------------------------ */

async function handlePlaylist(id) {
  const data = await jioFetch("playlist.getDetails", { listid: id });
  const tracks = (data.list || data.songs || []).map(mapTrack).filter(Boolean);
  return {
    id: String(data.id || id),
    title: sanitizeText(data.title || data.listname || "Untitled Playlist"),
    description: data.subtitle ? sanitizeText(data.subtitle) : undefined,
    artworkURL: upgradeArtwork(data.image),
    creator: sanitizeText(data.firstname || data.username || "JioSaavn"),
    tracks,
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
  for (let i = 0; i < arr.length; i++) t += chars[arr[i] % chars.length];
  return t;
}

/* ------------------------------------------------------------------ */
/* Path parsing                                                        */
/* ------------------------------------------------------------------ */

function parsePath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return { token: null, rest: "/" };
  if (KNOWN_ROUTES.has(parts[0])) return { token: null, rest: "/" + parts.join("/") };
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
    <div class="tip"><b>Note:</b> Direct JioSaavn API, India-region headers applied. Each generated URL carries a fresh, unique token in its path.</div>
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
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const { token, rest } = parsePath(url.pathname);

    try {
      if (rest === "/" || rest === "") {
        return new Response(landingPage(), { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS } });
      }

      if (rest === "/generate" && request.method === "POST") {
        const newToken = generateToken();
        return json({ token: newToken, manifestUrl: `${url.origin}/${newToken}/manifest.json` });
      }

      if (rest === "/debug") {
        const q = url.searchParams.get("q") || "drake";
        try {
          const raw = await jioFetch("search.getResults", { q, p: "1", n: "3" });
          return json({ ok: true, sample: raw });
        } catch (err) {
          return json({ ok: false, error: err.message }, 502);
        }
      }

      if (rest === "/manifest.json") return json(manifest(token));

      if (rest === "/search" || rest.startsWith("/search?")) {
        const q = url.searchParams.get("q") || "";
        return json(await handleSearch(q));
      }

      const streamMatch = rest.match(/^\/stream\/(.+)$/);
      if (streamMatch) return json(await handleStream(streamMatch[1]));

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
