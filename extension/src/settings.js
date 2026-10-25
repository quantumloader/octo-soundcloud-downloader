export const DEFAULT_SETTINGS = {
  filenamePattern: "{artist} - {title}",
  playlistFilenamePattern: "{playlist}/{index}. {artist} - {title}",
  preferOriginal: true,
  addTrackNumbers: true,
  concurrentDownloads: 2,
  showTrackButtons: true,
  showPlaylistButton: true
};

export const FILENAME_PATTERN_HELP =
  "Tokens: {artist}, {title}, {playlist}, {index}, {id}";

export async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(partial) {
  const next = { ...(await loadSettings()), ...partial };
  await chrome.storage.sync.set(next);
  return next;
}

export function sanitizeFilename(name) {
  let value = String(name ?? "unknown")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Chrome rejects components that are empty, "." / ".." or start/end with a dot
  value = value.replace(/^\.+/, "").replace(/\.+$/, "").trim();
  if (!value || value === "." || value === "..") value = "unknown";
  return value.slice(0, 120);
}

export function applyFilenamePattern(pattern, values) {
  const hasIndex = values.index !== undefined && values.index !== null && values.index !== "";
  let filled = String(pattern || "{artist} - {title}");

  // Avoid leftovers like "/. Artist - Title" when index is missing
  if (!hasIndex) {
    filled = filled
      .replace(/\{index\}\.\s*/g, "")
      .replace(/\{index\}\s*/g, "");
  }

  filled = filled
    .replaceAll("{artist}", values.artist ?? "Unknown")
    .replaceAll("{title}", values.title ?? "Untitled")
    .replaceAll("{playlist}", values.playlist ?? "Playlist")
    .replaceAll("{index}", hasIndex ? String(values.index) : "")
    .replaceAll("{id}", values.id ?? "");

  filled = filled
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([./])/g, "$1")
    .replace(/([./])\s+/g, "$1")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");

  const parts = filled
    .split("/")
    .map((part) => sanitizeFilename(part))
    .filter(Boolean);

  return parts.join("/") || "track";
}
