# octo-soundcloud-downloader

Browser extension for downloading SoundCloud tracks and playlists.

Download controls appear on SoundCloud pages. The toolbar popup is for settings only.

## Features

- **Download** on track pages and track rows
- **Download playlist** on set pages
- Filename patterns, original-file preference, and parallel playlist downloads

## Install (Chrome / Chromium / Edge)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension` folder in this repository

## Settings

Open the extension popup to configure:

| Setting | Default |
| --- | --- |
| Track filename | `{artist} - {title}` |
| Playlist filename | `{playlist}/{index}. {artist} - {title}` |
| Prefer original when available | on |
| Zero-pad playlist indexes | on |
| Parallel playlist downloads | 2 |

Filename tokens: `{artist}`, `{title}`, `{playlist}`, `{index}`, `{id}`.

## Notes

- Works with public streamable tracks and playlists.
- Private or geo-blocked items may not download.
- When an artist enables SoundCloud’s own download, that original file is preferred.
