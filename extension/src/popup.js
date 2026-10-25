import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings
} from "./settings.js";

const form = document.getElementById("settings-form");
const status = document.getElementById("save-status");
const resetBtn = document.getElementById("reset-btn");

const fields = [
  "filenamePattern",
  "playlistFilenamePattern",
  "preferOriginal",
  "addTrackNumbers",
  "showTrackButtons",
  "showPlaylistButton",
  "concurrentDownloads"
];

init();

async function init() {
  await applyToForm(await loadSettings());

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const next = readFromForm();
    await saveSettings(next);
    showSaved();
  });

  resetBtn.addEventListener("click", async () => {
    await saveSettings({ ...DEFAULT_SETTINGS });
    await applyToForm(DEFAULT_SETTINGS);
    showSaved();
  });
}

async function applyToForm(settings) {
  for (const key of fields) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (el.type === "checkbox") {
      el.checked = Boolean(settings[key]);
    } else {
      el.value = settings[key];
    }
  }
}

function readFromForm() {
  const data = {};
  for (const key of fields) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (el.type === "checkbox") {
      data[key] = el.checked;
    } else if (key === "concurrentDownloads") {
      data[key] = Number(el.value);
    } else {
      data[key] = el.value.trim();
    }
  }
  return data;
}

function showSaved() {
  status.hidden = false;
  clearTimeout(showSaved._t);
  showSaved._t = setTimeout(() => {
    status.hidden = true;
  }, 1400);
}
