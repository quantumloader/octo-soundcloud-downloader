export const DEFAULT_SETTINGS = {
  filenamePattern: "{artist} - {title}",
  playlistFilenamePattern: "{playlist}/{index}. {artist} - {title}",
  preferOriginal: true,
  addTrackNumbers: true,
  concurrentDownloads: 2,
  showTrackButtons: true,
  showPlaylistButton: true,
  openDownloadsShelf: false
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
  return String(name || "unknown")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "unknown";
}

export function applyFilenamePattern(pattern, values) {
  const filled = pattern
    .replaceAll("{artist}", values.artist ?? "Unknown")
    .replaceAll("{title}", values.title ?? "Untitled")
    .replaceAll("{playlist}", values.playlist ?? "Playlist")
    .replaceAll("{index}", values.index ?? "")
    .replaceAll("{id}", values.id ?? "");

  return filled
    .split("/")
    .map((part) => sanitizeFilename(part))
    .filter(Boolean)
    .join("/");
}
