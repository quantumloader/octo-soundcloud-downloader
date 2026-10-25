const CLIENT_ID_TTL_MS = 12 * 60 * 60 * 1000;
const API_V2 = "https://api-v2.soundcloud.com";

let memoryClientId = null;
let memoryOauthToken = null;

export function setSessionAuth({ clientId, oauthToken } = {}) {
  if (clientId) {
    memoryClientId = clientId;
    chrome.storage.local.set({ clientId, clientIdAt: Date.now() }).catch(() => {});
  }
  if (oauthToken) {
    memoryOauthToken = oauthToken;
    chrome.storage.local.set({ oauthToken }).catch(() => {});
  }
}

async function readCachedClientId() {
  if (memoryClientId) return memoryClientId;
  const { clientId, clientIdAt } = await chrome.storage.local.get([
    "clientId",
    "clientIdAt"
  ]);
  if (clientId && clientIdAt && Date.now() - clientIdAt < CLIENT_ID_TTL_MS) {
    memoryClientId = clientId;
    return clientId;
  }
  return null;
}

async function readCachedOauthToken() {
  if (memoryOauthToken) return memoryOauthToken;
  const fromCookie = await readOauthCookie();
  if (fromCookie) {
    memoryOauthToken = fromCookie;
    return fromCookie;
  }
  const { oauthToken } = await chrome.storage.local.get(["oauthToken"]);
  if (oauthToken) {
    memoryOauthToken = oauthToken;
    return oauthToken;
  }
  return null;
}

async function readOauthCookie() {
  if (!chrome.cookies?.get) return null;
  try {
    const cookie =
      (await chrome.cookies.get({
        url: "https://soundcloud.com",
        name: "oauth_token"
      })) ||
      (await chrome.cookies.get({
        url: "https://api-v2.soundcloud.com",
        name: "oauth_token"
      }));
    return cookie?.value || null;
  } catch {
    return null;
  }
}

async function writeCachedClientId(clientId) {
  memoryClientId = clientId;
  await chrome.storage.local.set({ clientId, clientIdAt: Date.now() });
}

function extractClientId(text) {
  const patterns = [
    /client_id["']?\s*[:=]\s*["']([a-zA-Z0-9]{16,44})["']/,
    /"clientId"\s*:\s*"([a-zA-Z0-9]{16,44})"/,
    /client_id=([a-zA-Z0-9]{16,44})/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function scrapeClientIdFromSite() {
  const html = await fetch("https://soundcloud.com", {
    credentials: "include",
    cache: "no-cache"
  }).then((r) => {
    if (!r.ok) throw new Error(`SoundCloud home failed (${r.status})`);
    return r.text();
  });

  const fromHtml = extractClientId(html);
  if (fromHtml) return fromHtml;

  const fromHydra = html.match(
    /"hydratable":"apiClient","data":\{"id":"([a-zA-Z0-9]{16,44})"/
  );
  if (fromHydra?.[1]) return fromHydra[1];

  const scriptUrls = [
    ...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)
  ]
    .map((m) => m[1])
    .slice(0, 25);

  for (const url of scriptUrls) {
    try {
      const js = await fetch(url, { credentials: "omit" }).then((r) => r.text());
      const id = extractClientId(js);
      if (id) return id;
    } catch {
      // try next asset
    }
  }

  throw new Error("Could not locate SoundCloud client_id");
}

export async function getClientId(force = false) {
  if (!force) {
    const cached = await readCachedClientId();
    if (cached) return cached;
  }
  const clientId = await scrapeClientIdFromSite();
  await writeCachedClientId(clientId);
  return clientId;
}

async function authHeaders() {
  const headers = { Accept: "application/json" };
  const oauthToken = await readCachedOauthToken();
  if (oauthToken) {
    headers.Authorization = `OAuth ${oauthToken}`;
  }
  return headers;
}

async function apiFetch(path, params = {}, attempt = 0) {
  const clientId = await getClientId(attempt > 0);
  const url = new URL(path.startsWith("http") ? path : `${API_V2}${path}`);
  url.searchParams.set("client_id", clientId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  let response;
  try {
    response = await fetch(url.toString(), {
      credentials: "include",
      headers: await authHeaders()
    });
  } catch (error) {
    throw new Error(`Failed to fetch ${url.pathname}: ${error?.message || error}`);
  }

  if ((response.status === 401 || response.status === 403) && attempt < 1) {
    await chrome.storage.local.remove(["clientId", "clientIdAt"]);
    memoryClientId = null;
    return apiFetch(path, params, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`SoundCloud API ${response.status} for ${url.pathname}`);
  }

  return response.json();
}

export async function fetchPlaylistById(id) {
  return apiFetch(`/playlists/${id}`, { representation: "full" });
}

export async function fetchTrackById(id) {
  return apiFetch(`/tracks/${id}`);
}

export async function fetchPlaylistTracks(playlist) {
  const tracks = [];
  const initial = (playlist.tracks || []).filter(
    (t) => t && (t.kind === "track" || t.title) && t.id
  );
  const missingIds = (playlist.tracks || [])
    .filter((t) => t && t.id && !t.title)
    .map((t) => t.id);

  tracks.push(...initial);

  for (let i = 0; i < missingIds.length; i += 50) {
    const chunk = missingIds.slice(i, i + 50);
    const batch = await apiFetch("/tracks", {
      ids: chunk.join(","),
      limit: chunk.length
    });
    if (Array.isArray(batch)) tracks.push(...batch);
  }

  const byId = new Map();
  for (const track of tracks) {
    if (track?.id) byId.set(track.id, track);
  }

  const ordered = [];
  for (const stub of playlist.tracks || []) {
    const full = byId.get(stub.id) || stub;
    if (full?.id) ordered.push(full);
  }
  return ordered.length ? ordered : [...byId.values()];
}

function pickTranscoding(track) {
  const transcodings = track?.media?.transcodings || [];

  const progressive = transcodings.find(
    (t) =>
      t.format?.protocol === "progressive" &&
      (t.format?.mime_type?.includes("mpeg") || t.preset?.includes("mp3"))
  );
  if (progressive) {
    return {
      kind: "progressive",
      transcoding: progressive,
      mime: "audio/mpeg",
      ext: "mp3"
    };
  }

  const ranked = [...transcodings].filter((t) => t.format?.protocol === "hls");
  const preference = (t) => {
    const preset = t.preset || "";
    if (preset === "aac_160k") return 100;
    if (preset.includes("aac_160")) return 95;
    if (preset === "aac_96k") return 80;
    if (preset.includes("aac")) return 70;
    if (preset.includes("mp3") || t.format?.mime_type?.includes("mpeg")) return 60;
    if (preset.startsWith("abr")) return 10;
    return 20;
  };
  ranked.sort((a, b) => preference(b) - preference(a));
  const best = ranked[0];
  if (!best) return null;

  const preset = best.preset || "";
  const mime = best.format?.mime_type || "";
  const isAac =
    preset.includes("aac") || mime.includes("mp4") || mime.includes("aac");
  return {
    kind: "hls",
    transcoding: best,
    mime: isAac ? "audio/mp4" : "audio/mpeg",
    ext: isAac ? "m4a" : "mp3"
  };
}

async function resolveTranscodingUrl(transcoding) {
  const clientId = await getClientId();
  const url = new URL(transcoding.url);
  url.searchParams.set("client_id", clientId);

  const data = await fetch(url.toString(), {
    credentials: "include",
    headers: await authHeaders()
  }).then((r) => {
    if (!r.ok) throw new Error(`Stream lookup failed (${r.status})`);
    return r.json();
  });

  if (!data?.url) throw new Error("Stream URL missing");
  return data.url;
}

async function fetchOriginalDownloadUrl(track) {
  if (!track?.downloadable || !track?.id) return null;
  try {
    const clientId = await getClientId();
    const url = new URL(`${API_V2}/tracks/${track.id}/download`);
    url.searchParams.set("client_id", clientId);
    const response = await fetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      credentials: "include",
      headers: await authHeaders()
    });
    const location = response.headers.get("Location");
    if (location) return { url: location, ext: guessExt(location, "bin") };
    if (response.ok) {
      const data = await response.json().catch(() => null);
      if (data?.redirectUri) {
        return { url: data.redirectUri, ext: guessExt(data.redirectUri, "bin") };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function guessExt(url, fallback) {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".mp3")) return "mp3";
  if (clean.endsWith(".m4a") || clean.endsWith(".mp4")) return "m4a";
  if (clean.endsWith(".wav")) return "wav";
  if (clean.endsWith(".flac")) return "flac";
  if (clean.endsWith(".aac")) return "aac";
  return fallback;
}

function parseHlsMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const initMaps = [];
  const segments = [];

  for (const line of lines) {
    if (line.startsWith("#EXT-X-MAP:")) {
      const match = line.match(/URI="([^"]+)"/) || line.match(/URI=([^,]+)/);
      if (match?.[1]) initMaps.push(new URL(match[1], baseUrl).toString());
      continue;
    }
    if (line.startsWith("#")) continue;
    segments.push(new URL(line, baseUrl).toString());
  }

  return { initMaps, segments };
}

async function fetchPlaylistText(url) {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error(`HLS playlist failed (${response.status})`);
  return response.text();
}

async function resolveMediaPlaylist(playlistUrl) {
  const text = await fetchPlaylistText(playlistUrl);
  if (text.includes("#EXT-X-STREAM-INF")) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let best = null;
    let pendingBandwidth = 0;
    for (const line of lines) {
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        pendingBandwidth = Number(line.match(/BANDWIDTH=(\d+)/)?.[1] || 0);
        continue;
      }
      if (line.startsWith("#")) continue;
      if (!best || pendingBandwidth >= best.bandwidth) {
        best = {
          bandwidth: pendingBandwidth,
          url: new URL(line, playlistUrl).toString()
        };
      }
    }
    if (!best) throw new Error("HLS master playlist has no variants");
    const mediaText = await fetchPlaylistText(best.url);
    return { text: mediaText, baseUrl: best.url };
  }
  return { text, baseUrl: playlistUrl };
}

async function downloadHlsBuffer(playlistUrl) {
  const { text, baseUrl } = await resolveMediaPlaylist(playlistUrl);
  const { initMaps, segments } = parseHlsMediaPlaylist(text, baseUrl);
  const urls = [...initMaps, ...segments];
  if (!urls.length) throw new Error("HLS playlist has no segments");

  const parts = [];
  for (const segmentUrl of urls) {
    const buf = await fetch(segmentUrl, { credentials: "omit" }).then((r) => {
      if (!r.ok) throw new Error(`HLS segment failed (${r.status})`);
      return r.arrayBuffer();
    });
    parts.push(new Uint8Array(buf));
  }

  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged.buffer;
}

export function trackMeta(track) {
  return {
    id: String(track.id),
    title: track.title || "Untitled",
    artist: track.user?.username || track.publisher_metadata?.artist || "Unknown",
    duration: track.duration || 0,
    permalinkUrl: track.permalink_url || "",
    downloadable: Boolean(track.downloadable)
  };
}

export async function getTrackDownloadSource(track, { preferOriginal = true } = {}) {
  let fullTrack = track;
  if (!track?.media?.transcodings?.length && track?.id) {
    fullTrack = await fetchTrackById(track.id);
  }

  if (preferOriginal) {
    const original = await fetchOriginalDownloadUrl(fullTrack);
    if (original) {
      return {
        mode: "url",
        url: original.url,
        ext: original.ext,
        quality: "original"
      };
    }
  }

  const picked = pickTranscoding(fullTrack);
  if (!picked) {
    throw new Error("No streamable media for this track");
  }

  const streamUrl = await resolveTranscodingUrl(picked.transcoding);

  if (picked.kind === "progressive") {
    return {
      mode: "url",
      url: streamUrl,
      ext: "mp3",
      quality: "progressive"
    };
  }

  const buffer = await downloadHlsBuffer(streamUrl);
  return {
    mode: "buffer",
    buffer,
    mime: picked.mime,
    ext: picked.ext,
    quality: picked.transcoding.preset || "hls"
  };
}

export function normalizePermalink(rawUrl) {
  const url = new URL(rawUrl, "https://soundcloud.com");
  const path = decodeURIComponent(url.pathname)
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
  return `https://soundcloud.com${path}`;
}

export async function resolveUrl(permalink) {
  const normalized = normalizePermalink(permalink);
  try {
    return await apiFetch("/resolve", { url: normalized });
  } catch (error) {
    if (!String(error?.message || "").includes("404")) throw error;
    const trimmed = normalized.replace(
      /\/(likes|reposts|comments|popular-tracks|tracks|albums|followers|following)$/i,
      ""
    );
    if (trimmed !== normalized && !trimmed.endsWith("/sets")) {
      return apiFetch("/resolve", { url: trimmed });
    }
    throw error;
  }
}

export async function resolveResource({ url, id, kind, hydrationResource } = {}) {
  if (hydrationResource?.id && hydrationResource?.media) {
    return hydrationResource;
  }
  if (hydrationResource?.id && hydrationResource?.tracks) {
    return hydrationResource;
  }
  if (id && kind === "playlist") {
    try {
      return await fetchPlaylistById(id);
    } catch {
      // fall through
    }
  }
  if (id && kind === "track") {
    try {
      return await fetchTrackById(id);
    } catch {
      // fall through
    }
  }
  if (url) return resolveUrl(url);
  throw new Error("Nothing to resolve");
}
