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

  const safe = {
    artist: sanitizeFilename(values.artist ?? "Unknown"),
    title: sanitizeFilename(values.title ?? "Untitled"),
    playlist: sanitizeFilename(values.playlist ?? "Playlist"),
    index: hasIndex ? sanitizeFilename(String(values.index)) : "",
    id: sanitizeFilename(values.id ?? "")
  };

  filled = filled
    .replaceAll("{artist}", safe.artist)
    .replaceAll("{title}", safe.title)
    .replaceAll("{playlist}", safe.playlist)
    .replaceAll("{index}", safe.index)
    .replaceAll("{id}", safe.id);

  filled = filled
    .replace(/\s{2,}/g, " ")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();

  const parts = filled
    .split("/")
    .map((part) => sanitizeFilename(part))
    .filter(Boolean);

  return parts.join("/") || "track";
}
