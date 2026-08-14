// Runs on mail.google.com. Watches the currently open thread and tells the
// background worker who the other participant is, so the side panel can show
// notes for them.
//
// Gmail's DOM has no public API and its class names are obfuscated, but the
// sender header (`span.gD`, with `email` and `name` attributes) and the
// per-message timestamp (`span.g3`, with a human-readable `title` attribute)
// have been stable across Gmail's layout for years and are the same hooks
// most Gmail userscripts/extensions rely on. If Gmail changes markup, this
// selector is the one thing to update.

let selfEmail = null;
chrome.storage.local.get("myEmail", (r) => {
  selfEmail = r.myEmail ?? null;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.myEmail) selfEmail = changes.myEmail.newValue ?? null;
});

function parseThread() {
  const senderEls = Array.from(document.querySelectorAll("span.gD"));
  if (senderEls.length === 0) return null;

  const bySelf = (email) => selfEmail && email?.toLowerCase() === selfEmail.toLowerCase();

  // Dedupe, keeping the last-seen name for each email, preserving DOM order.
  const seen = new Map();
  for (const el of senderEls) {
    const email = el.getAttribute("email");
    const name = el.getAttribute("name") || el.textContent?.trim() || email;
    if (!email || bySelf(email)) continue;
    seen.set(email.toLowerCase(), { email, name });
  }
  if (seen.size === 0) return null;

  // Most recent non-self participant wins (last one in DOM order).
  const contact = Array.from(seen.values()).at(-1);

  const dateEls = Array.from(document.querySelectorAll("span.g3[title]"));
  let lastMessageDate = null;
  const lastTitle = dateEls.at(-1)?.getAttribute("title");
  if (lastTitle) {
    const parsed = new Date(lastTitle);
    if (!Number.isNaN(parsed.getTime())) lastMessageDate = parsed.toISOString();
  }

  return { ...contact, lastMessageDate };
}

let lastSentKey = undefined;

function report() {
  const contact = parseThread();
  const key = contact ? contact.email + "|" + contact.lastMessageDate : null;
  if (key === lastSentKey) return;
  lastSentKey = key;
  chrome.runtime.sendMessage({ type: "ACTIVE_CONTACT", contact });
}

const debounced = (() => {
  let handle;
  return () => {
    clearTimeout(handle);
    handle = setTimeout(report, 300);
  };
})();

const observer = new MutationObserver(debounced);
observer.observe(document.body, { childList: true, subtree: true });

window.addEventListener("hashchange", debounced);
debounced();

// The background service worker is ephemeral (Chrome kills it after ~30s
// idle) and loses whatever it cached in memory, so the side panel asks us
// directly for current state on open rather than trusting that cache.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "REQUEST_CONTACT") {
    sendResponse(parseThread());
    return false;
  }
});
