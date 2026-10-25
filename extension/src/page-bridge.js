(() => {
  const CHANNEL = "octo-sc-bridge";
  let capturedOauth = null;
  let capturedClientId = null;

  hookNetwork();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.direction !== "request") return;

    const payload = {
      href: location.href,
      clientId: capturedClientId || readClientId(),
      oauthToken: capturedOauth || readOauthToken(),
      hydration: summarizeHydration(window.__sc_hydration)
    };

    window.postMessage(
      {
        channel: CHANNEL,
        direction: "response",
        requestId: data.requestId,
        payload
      },
      "*"
    );
  });

  function hookNetwork() {
    try {
      const originalFetch = window.fetch;
      if (typeof originalFetch === "function") {
        window.fetch = function patchedFetch(input, init) {
          captureFromRequest(input, init);
          return originalFetch.apply(this, arguments).then((response) => {
            try {
              const url = String(response?.url || input?.url || input || "");
              captureFromUrl(url);
            } catch {
              // ignore
            }
            return response;
          });
        };
      }
    } catch {
      // ignore
    }

    try {
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
        this.__octoUrl = url;
        return originalOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.setRequestHeader = function patchedSetHeader(
        name,
        value
      ) {
        if (/^authorization$/i.test(name) && /oauth/i.test(String(value))) {
          capturedOauth = String(value).replace(/^OAuth\s+/i, "");
        }
        return originalSetHeader.apply(this, arguments);
      };
    } catch {
      // ignore
    }
  }

  function captureFromRequest(input, init) {
    try {
      const url = typeof input === "string" ? input : input?.url;
      captureFromUrl(url);
      const headers = init?.headers;
      if (!headers) return;
      if (headers instanceof Headers) {
        const auth = headers.get("Authorization") || headers.get("authorization");
        if (auth && /oauth/i.test(auth)) {
          capturedOauth = auth.replace(/^OAuth\s+/i, "");
        }
      } else if (Array.isArray(headers)) {
        for (const [name, value] of headers) {
          if (/^authorization$/i.test(name) && /oauth/i.test(String(value))) {
            capturedOauth = String(value).replace(/^OAuth\s+/i, "");
          }
        }
      } else if (typeof headers === "object") {
        for (const [name, value] of Object.entries(headers)) {
          if (/^authorization$/i.test(name) && /oauth/i.test(String(value))) {
            capturedOauth = String(value).replace(/^OAuth\s+/i, "");
          }
        }
      }
    } catch {
      // ignore
    }
  }

  function captureFromUrl(url) {
    if (!url) return;
    try {
      const parsed = new URL(url, location.href);
      const clientId = parsed.searchParams.get("client_id");
      if (clientId) capturedClientId = clientId;
    } catch {
      // ignore
    }
  }

  function readClientId() {
    try {
      const fromHydra = (window.__sc_hydration || []).find(
        (x) => x?.hydratable === "apiClient"
      )?.data?.id;
      if (fromHydra) return fromHydra;
    } catch {
      // ignore
    }
    return null;
  }

  function readOauthToken() {
    try {
      const cookie = document.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("oauth_token="));
      if (cookie) return decodeURIComponent(cookie.slice("oauth_token=".length));
    } catch {
      // ignore
    }

    const keys = ["oauth_token", "access_token", "token"];
    for (const key of keys) {
      try {
        const value = window.localStorage?.getItem(key);
        if (value && value.length > 10) return value.replace(/^OAuth\s+/i, "");
      } catch {
        // ignore
      }
    }

    try {
      const raw = window.localStorage?.getItem("redux-store") || "";
      const match = raw.match(/"accessToken":"([^"]+)"/) || raw.match(/oauth_token","value":"([^"]+)"/);
      if (match?.[1]) return match[1];
    } catch {
      // ignore
    }

    return null;
  }

  function summarizeHydration(hydration) {
    if (!Array.isArray(hydration)) return null;
    const playlist = hydration.find((x) => x?.hydratable === "playlist")?.data;
    const sound = hydration.find((x) => x?.hydratable === "sound")?.data;
    const user = hydration.find((x) => x?.hydratable === "user")?.data;
    return {
      playlist: playlist
        ? {
            id: playlist.id,
            kind: playlist.kind || "playlist",
            title: playlist.title,
            permalink_url: playlist.permalink_url,
            track_count: playlist.track_count,
            tracks: Array.isArray(playlist.tracks)
              ? playlist.tracks.map((t) => ({
                  id: t.id,
                  kind: t.kind || "track",
                  title: t.title,
                  permalink_url: t.permalink_url,
                  user: t.user ? { username: t.user.username } : undefined,
                  media: t.media,
                  downloadable: t.downloadable
                }))
              : []
          }
        : null,
      sound: sound
        ? {
            id: sound.id,
            kind: sound.kind || "track",
            title: sound.title,
            permalink_url: sound.permalink_url,
            user: sound.user ? { username: sound.user.username } : undefined,
            media: sound.media,
            downloadable: sound.downloadable
          }
        : null,
      user: user ? { id: user.id, username: user.username } : null
    };
  }
})();
