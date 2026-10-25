(() => {
  const DOWNLOAD_ICON = `
    <span class="octo-sc-btn__icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 1.5a.75.75 0 0 1 .75.75v6.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 0 1 1.06-1.06l2.22 2.22V2.25A.75.75 0 0 1 8 1.5Z"/>
        <path d="M2.5 10.75a.75.75 0 0 1 .75.75v1.5h9.5v-1.5a.75.75 0 0 1 1.5 0v2.25a.75.75 0 0 1-.75.75h-11a.75.75 0 0 1-.75-.75V11.5a.75.75 0 0 1 .75-.75Z"/>
      </svg>
    </span>
  `;

  let settings = {
    showTrackButtons: true,
    showPlaylistButton: true
  };

  init();

  async function init() {
    settings = await loadSettings();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      for (const [key, { newValue }] of Object.entries(changes)) {
        settings[key] = newValue;
      }
      scheduleEnhance();
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "STATUS") {
        updatePlaylistStatus(message.jobs || []);
      }
    });

    const observer = new MutationObserver(() => scheduleEnhance());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scheduleEnhance();
  }

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(
        {
          showTrackButtons: true,
          showPlaylistButton: true
        },
        (result) => resolve(result)
      );
    });
  }

  let enhanceQueued = false;
  function scheduleEnhance() {
    if (enhanceQueued) return;
    enhanceQueued = true;
    requestAnimationFrame(() => {
      enhanceQueued = false;
      enhancePage();
    });
  }

  function enhancePage() {
    if (settings.showPlaylistButton) {
      injectPlaylistButton();
    } else {
      document.querySelectorAll("[data-octo-playlist-btn]").forEach((el) => el.remove());
    }

    if (settings.showTrackButtons) {
      injectHeroTrackButton();
      injectListTrackButtons();
    } else {
      document.querySelectorAll("[data-octo-track-btn]").forEach((el) => el.remove());
    }
  }

  function pagePermalink() {
    return `${location.origin}${location.pathname.replace(/\/+$/, "")}`;
  }

  function isPlaylistPath(pathname = location.pathname) {
    return /\/sets\//.test(pathname);
  }

  function isTrackPath(pathname = location.pathname) {
    const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length < 2) return false;
    if (parts[1] === "sets") return false;
    const reserved = new Set([
      "discover",
      "stream",
      "you",
      "search",
      "messages",
      "settings",
      "pages",
      "upload",
      "charts",
      "library",
      "notifications",
      "feed"
    ]);
    if (reserved.has(parts[0])) return false;
    const profileTabs = new Set([
      "tracks",
      "albums",
      "sets",
      "reposts",
      "popular-tracks",
      "comments",
      "followers",
      "following"
    ]);
    if (profileTabs.has(parts[1])) return false;
    return true;
  }

  function injectPlaylistButton() {
    if (!isPlaylistPath()) return;
    const actions =
      document.querySelector(".listenEngagement__actions .sc-button-group") ||
      document.querySelector(".soundActions .sc-button-group") ||
      document.querySelector(".fullHero__toolbar .sc-button-group");
    if (!actions) return;
    if (actions.querySelector("[data-octo-playlist-btn]")) return;

    const btn = createButton({
      label: "Download playlist",
      primary: true,
      attrs: { "data-octo-playlist-btn": "1" }
    });

    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await runButtonAction(btn, async () => {
        const response = await send({
          type: "DOWNLOAD_PLAYLIST",
          url: pagePermalink()
        });
        setStatus(
          `Saved ${response.downloaded}/${response.downloaded + response.failed}`
        );
      });
    });

    actions.appendChild(btn);

    if (!document.querySelector("[data-octo-status]")) {
      const status = document.createElement("span");
      status.className = "octo-sc-status";
      status.setAttribute("data-octo-status", "1");
      actions.appendChild(status);
    }
  }

  function injectHeroTrackButton() {
    if (!isTrackPath()) return;
    const actions =
      document.querySelector(".listenEngagement__actions .sc-button-group") ||
      document.querySelector(".soundActions .sc-button-group") ||
      document.querySelector(".fullHero__toolbar .sc-button-group");
    if (!actions) return;
    if (actions.querySelector("[data-octo-track-btn='hero']")) return;

    const btn = createButton({
      label: "Download",
      attrs: { "data-octo-track-btn": "hero" }
    });

    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await runButtonAction(btn, async () => {
        await send({ type: "DOWNLOAD_TRACK", url: pagePermalink() });
      });
    });

    actions.appendChild(btn);
  }

  function injectListTrackButtons() {
    const items = document.querySelectorAll(
      ".soundList__item, .trackList__item, .systemPlaylistTrackList__item, li[class*='trackList__item']"
    );

    items.forEach((item) => {
      if (item.querySelector("[data-octo-track-btn='row']")) return;

      const link =
        item.querySelector("a.soundTitle__title") ||
        item.querySelector("a.trackItem__trackTitle") ||
        item.querySelector("a[href*='soundcloud.com/'][class*='title']") ||
        item.querySelector("a[href^='/'][class*='Title']");

      if (!link) return;
      const href = absoluteSoundUrl(link.getAttribute("href"));
      if (!href || /\/sets\//.test(href)) return;

      const actions =
        item.querySelector(".soundActions .sc-button-group") ||
        item.querySelector(".trackItem__actions") ||
        item.querySelector(".sound__soundActions") ||
        link.parentElement;

      if (!actions) return;

      const btn = createButton({
        label: "Download",
        compact: true,
        attrs: { "data-octo-track-btn": "row" }
      });

      btn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await runButtonAction(btn, async () => {
          const playlistTitle = isPlaylistPath()
            ? document.querySelector(".soundTitle__title span, .fullHero__title .soundTitle__title")
                ?.textContent?.trim()
            : undefined;
          await send({
            type: "DOWNLOAD_TRACK",
            url: href,
            options: playlistTitle ? { playlistTitle } : {}
          });
        });
      });

      actions.appendChild(btn);
    });
  }

  function createButton({ label, primary = false, compact = false, attrs = {} }) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "octo-sc-btn";
    if (primary) btn.classList.add("octo-sc-btn--primary");
    if (compact) btn.classList.add("octo-sc-btn--compact");
    btn.innerHTML = `${DOWNLOAD_ICON}<span class="octo-sc-btn__label">${label}</span>`;
    btn.setAttribute("title", label);
    for (const [key, value] of Object.entries(attrs)) {
      btn.setAttribute(key, value);
    }
    return btn;
  }

  async function runButtonAction(btn, action) {
    if (btn.classList.contains("is-busy")) return;
    btn.classList.remove("is-done", "is-error");
    btn.classList.add("is-busy");
    btn.disabled = true;
    const label = btn.querySelector(".octo-sc-btn__label");
    const previous = label?.textContent;
    if (label) label.textContent = "Saving…";
    try {
      await action();
      btn.classList.add("is-done");
      if (label) label.textContent = "Saved";
      setTimeout(() => {
        btn.classList.remove("is-done");
        if (label && previous) label.textContent = previous;
      }, 1600);
    } catch (error) {
      btn.classList.add("is-error");
      if (label) label.textContent = "Failed";
      console.warn("[octo-sc]", error);
      setTimeout(() => {
        btn.classList.remove("is-error");
        if (label && previous) label.textContent = previous;
      }, 2200);
      throw error;
    } finally {
      btn.classList.remove("is-busy");
      btn.disabled = false;
    }
  }

  function send(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "Request failed"));
          return;
        }
        resolve(response.result);
      });
    });
  }

  function absoluteSoundUrl(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      if (!url.hostname.endsWith("soundcloud.com")) return null;
      url.hash = "";
      url.search = "";
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      return null;
    }
  }

  function setStatus(text) {
    const el = document.querySelector("[data-octo-status]");
    if (!el) return;
    el.textContent = text;
    el.classList.add("is-visible");
  }

  function updatePlaylistStatus(jobs) {
    const running = jobs.find((j) => j.type === "playlist" && j.status === "running");
    if (!running) return;
    setStatus(`${running.done}/${running.total}`);
  }
})();
