import { takeBlob } from "./blob-store.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "OFFSCREEN_CREATE_BLOB_URL") return;

  (async () => {
    const record = await takeBlob(message.blobId);
    if (!record?.buffer) throw new Error("Audio buffer not found");
    const blob = new Blob([record.buffer], {
      type: record.mime || message.mime || "application/octet-stream"
    });
    const url = URL.createObjectURL(blob);
    sendResponse({ ok: true, url });
  })().catch((error) => {
    sendResponse({ ok: false, error: error?.message || String(error) });
  });

  return true;
});
