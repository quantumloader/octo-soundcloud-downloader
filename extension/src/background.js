import { putBlob } from "./blob-store.js";
import {
  applyFilenamePattern,
  loadSettings
} from "./settings.js";
import {
  fetchPlaylistTracks,
  getTrackDownloadSource,
  normalizePermalink,
  resolveResource,
  resolveUrl,
  setSessionAuth,
  trackMeta
} from "./soundcloud-api.js";

const activeJobs = new Map();
let creatingOffscreen = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OFFSCREEN_CREATE_BLOB_URL") {
    return false;
  }

  handleMessage(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) =>
      sendResponse({ ok: false, error: error?.message || String(error) })
    );
  return true;
});

async function handleMessage(message) {
  if (message?.session) {
    setSessionAuth(message.session);
  }

  switch (message?.type) {
    case "DOWNLOAD_TRACK":
      return downloadTrack(message);
    case "DOWNLOAD_PLAYLIST":
      return downloadPlaylist(message);
    case "GET_PAGE_INFO":
      return getPageInfo(message.url);
    case "GET_STATUS":
      return { jobs: [...activeJobs.values()] };
    case "SET_SESSION":
      setSessionAuth(message.session || {});
      return { ok: true };
    default:
      throw new Error(`Unknown message: ${message?.type}`);
  }
}

async function getPageInfo(rawUrl) {
  const permalink = normalizePermalink(rawUrl);
  const resource = await resolveUrl(permalink);
  if (resource.kind === "track") {
    return { kind: "track", track: trackMeta(resource), permalink };
  }
  if (resource.kind === "playlist") {
    const tracks = await fetchPlaylistTracks(resource);
    return {
      kind: "playlist",
      playlist: {
        id: String(resource.id),
        title: resource.title || "Playlist",
        trackCount: resource.track_count || tracks.length,
        permalink
      },
      tracks: tracks.map(trackMeta)
    };
  }
  throw new Error("Unsupported SoundCloud page");
}

async function downloadTrack(message) {
  const options = message.options || {};
  const resource = await resolveResource({
    url: message.url,
    id: message.id || options.id,
    kind: "track",
    hydrationResource: message.resource
  });
  if (resource.kind && resource.kind !== "track") {
    throw new Error("URL is not a track");
  }
  return enqueueTrackDownload(resource, {
    playlistTitle: options.playlistTitle,
    index: options.index
  });
}

async function downloadPlaylist(message) {
  const options = message.options || {};
  const settings = await loadSettings();

  // Prefer tracks collected from the open page (works for private sets)
  if (Array.isArray(options.tracks) && options.tracks.length) {
    return downloadTrackList(options.tracks, {
      playlistTitle: options.playlistTitle || "Playlist",
      playlistId: options.playlistId || "dom"
    });
  }

  let resource = null;
  try {
    resource = await resolveResource({
      url: message.url,
      id: message.id || options.id,
      kind: "playlist",
      hydrationResource: message.resource
    });
  } catch (error) {
    throw new Error(
      `${error?.message || error}. Open the playlist while logged in, wait until tracks appear, then try again.`
    );
  }

  if (resource.kind && resource.kind !== "playlist") {
    throw new Error("URL is not a playlist");
  }

  const tracks = await fetchPlaylistTracks(resource);
  const selectedIds = options.trackIds
    ? new Set(options.trackIds.map(String))
    : null;
  const queue = tracks.filter((t) => !selectedIds || selectedIds.has(String(t.id)));

  if (!queue.length) {
    throw new Error(
      "No tracks found. Scroll the playlist so tracks load, then try again."
    );
  }

  return downloadTrackObjects(queue, {
    playlistTitle: resource.title || options.playlistTitle || "Playlist",
    playlistId: resource.id
  });
}

async function downloadTrackList(entries, { playlistTitle, playlistId }) {
  const settings = await loadSettings();
  const jobId = `playlist-${playlistId}-${Date.now()}`;
  const job = {
    id: jobId,
    type: "playlist",
    title: playlistTitle,
    total: entries.length,
    done: 0,
    failed: 0,
    status: "running"
  };
  activeJobs.set(jobId, job);
  broadcastStatus();

  const concurrency = Math.max(1, Math.min(4, settings.concurrentDownloads || 2));
  let cursor = 0;
  const errors = [];

  async function worker() {
    while (cursor < entries.length) {
      const index = cursor++;
      const entry = entries[index];
      try {
        if (entry.resource || entry.id) {
          const resource = await resolveResource({
            url: entry.url,
            id: entry.id,
            kind: "track",
            hydrationResource: entry.resource
          });
          await enqueueTrackDownload(resource, {
            playlistTitle,
            index: entry.index || index + 1
          });
        } else {
          await downloadTrack({
            url: entry.url,
            options: {
              playlistTitle,
              index: entry.index || index + 1
            }
          });
        }
        job.done += 1;
      } catch (error) {
        job.failed += 1;
        errors.push({
          url: entry.url,
          title: entry.title,
          error: error?.message || String(error)
        });
      }
      activeJobs.set(jobId, { ...job });
      broadcastStatus();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return finishJob(jobId, job, errors);
}

async function downloadTrackObjects(tracks, { playlistTitle, playlistId }) {
  const settings = await loadSettings();
  const jobId = `playlist-${playlistId}-${Date.now()}`;
  const job = {
    id: jobId,
    type: "playlist",
    title: playlistTitle,
    total: tracks.length,
    done: 0,
    failed: 0,
    status: "running"
  };
  activeJobs.set(jobId, job);
  broadcastStatus();

  const concurrency = Math.max(1, Math.min(4, settings.concurrentDownloads || 2));
  let cursor = 0;
  const errors = [];

  async function worker() {
    while (cursor < tracks.length) {
      const index = cursor++;
      const track = tracks[index];
      try {
        await enqueueTrackDownload(track, {
          playlistTitle,
          index: index + 1
        });
        job.done += 1;
      } catch (error) {
        job.failed += 1;
        errors.push({
          trackId: track.id,
          title: track.title,
          error: error?.message || String(error)
        });
      }
      activeJobs.set(jobId, { ...job });
      broadcastStatus();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return finishJob(jobId, job, errors);
}

function finishJob(jobId, job, errors) {
  job.status = job.failed ? "completed_with_errors" : "completed";
  activeJobs.set(jobId, { ...job });
  broadcastStatus();
  setTimeout(() => {
    activeJobs.delete(jobId);
    broadcastStatus();
  }, 60_000);
  return {
    jobId,
    downloaded: job.done,
    failed: job.failed,
    errors
  };
}

async function enqueueTrackDownload(track, context = {}) {
  const settings = await loadSettings();
  const meta = trackMeta(track);
  const source = await getTrackDownloadSource(track, {
    preferOriginal: settings.preferOriginal
  });

  const indexValue =
    context.index && settings.addTrackNumbers
      ? String(context.index).padStart(2, "0")
      : context.index
        ? String(context.index)
        : "";

  const usePlaylistPattern = Boolean(context.playlistTitle) && Boolean(indexValue);
  const pattern = usePlaylistPattern
    ? settings.playlistFilenamePattern
    : settings.filenamePattern;

  const baseName = applyFilenamePattern(pattern, {
    artist: meta.artist,
    title: meta.title,
    playlist: context.playlistTitle || "",
    index: indexValue,
    id: meta.id
  });

  const filename = buildDownloadFilename(baseName, source.ext);
  const downloadUrl =
    source.mode === "buffer"
      ? await bufferToDownloadUrl(source.buffer, source.mime)
      : source.url;

  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: downloadUrl,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
  } catch (error) {
    if (/invalid filename/i.test(error?.message || "")) {
      const fallback = buildDownloadFilename(
        applyFilenamePattern("{artist} - {title}", {
          artist: meta.artist,
          title: meta.title,
          id: meta.id
        }),
        source.ext
      );
      downloadId = await chrome.downloads.download({
        url: downloadUrl,
        filename: fallback,
        conflictAction: "uniquify",
        saveAs: false
      });
    } else {
      throw error;
    }
  }

  return {
    downloadId,
    filename,
    quality: source.quality,
    track: meta
  };
}

function buildDownloadFilename(baseName, ext) {
  const safeExt = String(ext || "m4a").replace(/[^a-z0-9]/gi, "") || "m4a";
  const cleaned = String(baseName || "track")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
  const withExt = `${cleaned}.${safeExt}`;
  return withExt.length > 200 ? `${cleaned.slice(0, 180)}.${safeExt}` : withExt;
}

async function bufferToDownloadUrl(buffer, mime) {
  await ensureOffscreenDocument();
  const blobId = `track-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await putBlob(blobId, buffer, mime);
  const response = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_CREATE_BLOB_URL",
    blobId,
    mime
  });
  if (!response?.ok || !response.url) {
    throw new Error(response?.error || "Could not create download URL");
  }
  return response.url;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error("Offscreen documents are required for HLS downloads");
  }

  const contexts = await chrome.runtime.getContexts?.({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  if (contexts?.length) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Create blob URLs for assembled SoundCloud audio downloads"
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

function broadcastStatus() {
  const payload = { type: "STATUS", jobs: [...activeJobs.values()] };
  chrome.runtime.sendMessage(payload).catch(() => {});
  chrome.tabs.query(
    { url: ["https://soundcloud.com/*", "https://m.soundcloud.com/*", "https://www.soundcloud.com/*"] },
    (tabs) => {
      for (const tab of tabs || []) {
        if (tab.id != null) {
          chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
        }
      }
    }
  );
}
