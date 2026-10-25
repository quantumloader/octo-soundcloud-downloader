import { putBlob } from "./blob-store.js";
import {
  applyFilenamePattern,
  loadSettings
} from "./settings.js";
import {
  fetchPlaylistTracks,
  getTrackDownloadSource,
  normalizePermalink,
  resolveUrl,
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
  switch (message?.type) {
    case "DOWNLOAD_TRACK":
      return downloadTrackByUrl(message.url, message.options || {});
    case "DOWNLOAD_PLAYLIST":
      return downloadPlaylistByUrl(message.url, message.options || {});
    case "GET_PAGE_INFO":
      return getPageInfo(message.url);
    case "GET_STATUS":
      return { jobs: [...activeJobs.values()] };
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

async function downloadTrackByUrl(rawUrl, options = {}) {
  const permalink = normalizePermalink(rawUrl);
  const resource = await resolveUrl(permalink);
  if (resource.kind !== "track") {
    throw new Error("URL is not a track");
  }
  return enqueueTrackDownload(resource, {
    playlistTitle: options.playlistTitle,
    index: options.index
  });
}

async function downloadPlaylistByUrl(rawUrl, options = {}) {
  const permalink = normalizePermalink(rawUrl);
  const resource = await resolveUrl(permalink);
  if (resource.kind !== "playlist") {
    throw new Error("URL is not a playlist");
  }

  const settings = await loadSettings();
  const tracks = await fetchPlaylistTracks(resource);
  const selectedIds = options.trackIds
    ? new Set(options.trackIds.map(String))
    : null;
  const queue = tracks.filter((t) => !selectedIds || selectedIds.has(String(t.id)));

  if (!queue.length) throw new Error("No tracks to download");

  const jobId = `playlist-${resource.id}-${Date.now()}`;
  const job = {
    id: jobId,
    type: "playlist",
    title: resource.title || "Playlist",
    total: queue.length,
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
    while (cursor < queue.length) {
      const index = cursor++;
      const track = queue[index];
      try {
        await enqueueTrackDownload(track, {
          playlistTitle: resource.title || "Playlist",
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

  const pattern = context.playlistTitle
    ? settings.playlistFilenamePattern
    : settings.filenamePattern;

  const baseName = applyFilenamePattern(pattern, {
    artist: meta.artist,
    title: meta.title,
    playlist: context.playlistTitle || "",
    index: indexValue,
    id: meta.id
  });

  const filename = `${baseName}.${source.ext}`;
  const downloadUrl =
    source.mode === "buffer"
      ? await bufferToDownloadUrl(source.buffer, source.mime)
      : source.url;

  const downloadId = await chrome.downloads.download({
    url: downloadUrl,
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });

  return {
    downloadId,
    filename,
    quality: source.quality,
    track: meta
  };
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
    { url: ["https://soundcloud.com/*", "https://m.soundcloud.com/*"] },
    (tabs) => {
      for (const tab of tabs || []) {
        if (tab.id != null) {
          chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
        }
      }
    }
  );
}
