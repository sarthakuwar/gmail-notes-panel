import { SUPABASE_FUNCTION_URL, SUPABASE_BILLING_URL } from "./config.js";

const screens = {
  signedOut: document.getElementById("signed-out"),
  paywall: document.getElementById("paywall"),
  loading: document.getElementById("loading"),
  app: document.getElementById("app"),
};

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) el.classList.toggle("hidden", key !== name);
}

function sendMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

async function getToken(interactive) {
  const res = await sendMessage({ type: "GET_AUTH_TOKEN", interactive });
  if (res?.error) throw new Error(res.error);
  return res.token;
}

async function fetchUserInfo(token) {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Failed to fetch user info");
  return res.json();
}

class SubscriptionRequiredError extends Error {}

async function authedFetch(baseUrl, pathWithQuery, options = {}, retry = true) {
  const token = await getToken(false).catch(() => getToken(true));
  const res = await fetch(baseUrl + pathWithQuery, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 && retry) {
    await sendMessage({ type: "SIGN_OUT" });
    return authedFetch(baseUrl, pathWithQuery, options, false);
  }
  if (res.status === 402) throw new SubscriptionRequiredError();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Backend error: ${res.status}`);
  }
  return res.json();
}

const api = (pathWithQuery, options) => authedFetch(SUPABASE_FUNCTION_URL, pathWithQuery, options);
const billingApi = (pathWithQuery, options) => authedFetch(SUPABASE_BILLING_URL, pathWithQuery, options);

let activeContact = null;
let saveTimer = null;
let saveToken = 0;
let allContacts = [];
let activeTagFilters = new Set();
let statusPollTimer = null;

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

function isDue(remindAt) {
  return Boolean(remindAt) && remindAt <= todayISODate();
}

async function trySignInSilently() {
  try {
    const token = await getToken(false);
    const info = await fetchUserInfo(token);
    chrome.storage.local.set({ myEmail: info.email });
    return true;
  } catch {
    return false;
  }
}

async function handleSignIn() {
  document.getElementById("auth-error").classList.add("hidden");
  try {
    const token = await getToken(true);
    const info = await fetchUserInfo(token);
    chrome.storage.local.set({ myEmail: info.email });
    await afterSignedIn();
  } catch (err) {
    const el = document.getElementById("auth-error");
    el.textContent = err.message || "Sign-in failed";
    el.classList.remove("hidden");
  }
}

async function signOut() {
  stopStatusPolling();
  await sendMessage({ type: "SIGN_OUT" });
  chrome.storage.local.remove("myEmail");
  showScreen("signedOut");
}

function formatDate(iso) {
  if (!iso) return "No record yet";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// --- Billing / paywall ---

function renderTrialBanner(status) {
  const banner = document.getElementById("trial-banner");
  const text = document.getElementById("trial-banner-text");
  if (status.status === "trialing" && status.current_period_end) {
    text.textContent = `Trial — ends ${formatDate(status.current_period_end)}`;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

function showPaywall(status) {
  stopStatusPolling();
  const title = document.getElementById("paywall-title");
  const copy = document.getElementById("paywall-copy");
  const btn = document.getElementById("paywall-btn");
  if (status === "canceled" || status === "past_due" || status === "unpaid") {
    title.textContent = "Your subscription needs attention";
    copy.textContent = "Your trial or subscription has ended. Resubscribe to keep using Noterra.";
    btn.textContent = "Resubscribe — $3.99/month";
  } else {
    title.textContent = "Start your free trial";
    copy.textContent =
      "7 days free, then $3.99/month. Cancel anytime from the subscription management page — no charge until your trial ends.";
    btn.textContent = "Start 7-day free trial";
  }
  document.getElementById("paywall-error").classList.add("hidden");
  document.getElementById("paywall-waiting").classList.add("hidden");
  showScreen("paywall");
}

function stopStatusPolling() {
  clearInterval(statusPollTimer);
  statusPollTimer = null;
}

async function startCheckout() {
  const btn = document.getElementById("paywall-btn");
  const errorEl = document.getElementById("paywall-error");
  const waitingEl = document.getElementById("paywall-waiting");
  errorEl.classList.add("hidden");
  btn.disabled = true;
  try {
    const { url } = await billingApi("/checkout", { method: "POST" });
    chrome.tabs.create({ url });
    waitingEl.classList.remove("hidden");
    pollForActiveSubscription();
  } catch (err) {
    errorEl.textContent = err.message || "Couldn't start checkout";
    errorEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
}

function pollForActiveSubscription() {
  stopStatusPolling();
  const deadline = Date.now() + 2 * 60_000;
  statusPollTimer = setInterval(async () => {
    if (Date.now() > deadline) {
      stopStatusPolling();
      return;
    }
    try {
      const status = await billingApi("/status", { method: "GET" });
      if (status.status === "trialing" || status.status === "active") {
        stopStatusPolling();
        renderTrialBanner(status);
        showScreen("app");
        await refreshActiveContact();
        await loadContactsList();
      }
    } catch {
      // keep polling — a transient failure here shouldn't stop the wait
    }
  }, 3000);
}

async function openBillingPortal() {
  const btn = document.getElementById("manage-sub-btn");
  const originalText = btn.textContent;
  btn.disabled = true;
  try {
    const { url } = await billingApi("/portal", { method: "POST" });
    chrome.tabs.create({ url });
  } catch (err) {
    btn.textContent = "Couldn't open — try again";
    setTimeout(() => {
      btn.textContent = originalText;
    }, 3000);
    console.error("openBillingPortal failed:", err);
  } finally {
    btn.disabled = false;
  }
}

async function afterSignedIn() {
  showScreen("loading");
  let status;
  try {
    status = await billingApi("/status", { method: "GET" });
  } catch {
    status = { status: "none" };
  }
  if (status.status !== "trialing" && status.status !== "active") {
    showPaywall(status.status);
    return;
  }
  renderTrialBanner(status);
  showScreen("app");
  await refreshActiveContact();
  await loadContactsList();
}

// --- Current-thread contact view ---

async function renderContact(contact) {
  activeContact = contact;
  document.getElementById("empty-current").classList.add("hidden");
  document.getElementById("contact").classList.add("hidden");

  const params = new URLSearchParams({ contact_email: contact.email });
  let row;
  try {
    row = await api(`?${params}`, { method: "GET" });
  } catch (err) {
    if (err instanceof SubscriptionRequiredError) {
      showPaywall("none");
      return;
    }
    row = { note: "", tags: [], last_contacted: null, remind_at: null };
  }

  document.getElementById("contact").classList.remove("hidden");
  document.getElementById("contact-name").textContent = contact.name || contact.email;
  document.getElementById("contact-email").textContent = contact.email;
  document.getElementById("note-input").value = row.note || "";
  document.getElementById("tags-input").value = (row.tags || []).join(", ");
  document.getElementById("remind-input").value = row.remind_at || "";
  document.getElementById("reminder-badge").classList.toggle("hidden", !isDue(row.remind_at));

  const lastContacted =
    contact.lastMessageDate && (!row.last_contacted || contact.lastMessageDate > row.last_contacted)
      ? contact.lastMessageDate
      : row.last_contacted;
  document.getElementById("last-contacted").textContent = formatDate(lastContacted);

  // Silently keep last_contacted fresh even if the user doesn't edit anything.
  if (contact.lastMessageDate && contact.lastMessageDate !== row.last_contacted) {
    api("", {
      method: "POST",
      body: JSON.stringify({
        contact_email: contact.email,
        contact_name: contact.name,
        observed_last_message_at: contact.lastMessageDate,
      }),
    }).catch(() => {});
  }
}

function showEmptyCurrent() {
  activeContact = null;
  document.getElementById("contact").classList.add("hidden");
  document.getElementById("empty-current").classList.remove("hidden");
}

function scheduleSave() {
  clearTimeout(saveTimer);
  const statusEl = document.getElementById("save-status");
  statusEl.textContent = "Saving…";
  const myToken = ++saveToken;
  saveTimer = setTimeout(async () => {
    if (!activeContact) return;
    const note = document.getElementById("note-input").value;
    const tags = document
      .getElementById("tags-input")
      .value.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const remindAt = document.getElementById("remind-input").value || null;
    try {
      await api("", {
        method: "POST",
        body: JSON.stringify({
          contact_email: activeContact.email,
          contact_name: activeContact.name,
          note,
          tags,
          remind_at: remindAt,
          observed_last_message_at: activeContact.lastMessageDate,
        }),
      });
      document.getElementById("reminder-badge").classList.toggle("hidden", !isDue(remindAt));
      if (myToken === saveToken) statusEl.textContent = "Saved";
      // Keep the list view's tags/reminders in sync, but only bother
      // re-fetching if it's actually visible right now.
      if (!document.getElementById("view-list").classList.contains("hidden")) loadContactsList();
    } catch (err) {
      if (err instanceof SubscriptionRequiredError) {
        showPaywall("none");
        return;
      }
      if (myToken === saveToken) statusEl.textContent = "Couldn't save — will retry on next edit";
    }
  }, 700);
}

function requestContactFromTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "REQUEST_CONTACT" }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(undefined); // content script not injected here (not a Gmail tab, or still loading)
        return;
      }
      resolve(response ?? null);
    });
  });
}

async function refreshActiveContact() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const direct = tab?.id != null ? await requestContactFromTab(tab.id) : undefined;

  // direct === undefined means we couldn't reach a content script (wrong tab,
  // or it hasn't loaded yet) — fall back to the background worker's last-known
  // state instead of assuming there's nothing to show.
  const contact = direct !== undefined ? direct : (await sendMessage({ type: "GET_ACTIVE_CONTACT" }))?.contact;

  if (contact) {
    await renderContact(contact);
  } else {
    showEmptyCurrent();
  }
}

// --- Contacts list / search / tag filter ---

function switchTab(name) {
  document.getElementById("tab-current").classList.toggle("active", name === "current");
  document.getElementById("tab-list").classList.toggle("active", name === "list");
  document.getElementById("view-current").classList.toggle("hidden", name !== "current");
  document.getElementById("view-list").classList.toggle("hidden", name !== "list");
  if (name === "list") loadContactsList();
}

async function loadContactsList() {
  try {
    const { contacts } = await api("/list", { method: "GET" });
    allContacts = contacts || [];
  } catch (err) {
    if (err instanceof SubscriptionRequiredError) {
      showPaywall("none");
      return;
    }
    allContacts = [];
  }
  renderTagChips();
  renderContactsList();
}

function renderTagChips() {
  const container = document.getElementById("list-tags");
  const tags = [...new Set(allContacts.flatMap((c) => c.tags || []))].sort();
  container.innerHTML = "";
  for (const tag of tags) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (activeTagFilters.has(tag) ? " active" : "");
    chip.textContent = tag;
    chip.addEventListener("click", () => {
      if (activeTagFilters.has(tag)) activeTagFilters.delete(tag);
      else activeTagFilters.add(tag);
      renderTagChips();
      renderContactsList();
    });
    container.appendChild(chip);
  }
}

function renderContactsList() {
  const query = document.getElementById("list-search").value.trim().toLowerCase();
  const container = document.getElementById("list-items");
  const emptyEl = document.getElementById("list-empty");

  const filtered = allContacts.filter((c) => {
    if (activeTagFilters.size > 0 && !(c.tags || []).some((t) => activeTagFilters.has(t))) return false;
    if (!query) return true;
    const haystack = [c.contact_name, c.contact_email, c.note, ...(c.tags || [])].join(" ").toLowerCase();
    return haystack.includes(query);
  });

  container.innerHTML = "";
  emptyEl.classList.toggle("hidden", filtered.length > 0);

  for (const c of filtered) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "list-row";
    row.innerHTML = `
      <div class="list-row-main">
        <div class="list-row-name">${escapeHtml(c.contact_name || c.contact_email)}</div>
        <div class="list-row-email">${escapeHtml(c.contact_email)}</div>
      </div>
      <div class="list-row-meta">
        ${isDue(c.remind_at) ? '<span class="badge" title="Follow-up due">●</span>' : ""}
        <span class="muted small">${formatDate(c.last_contacted)}</span>
      </div>
    `;
    row.addEventListener("click", () => {
      switchTab("current");
      renderContact({ email: c.contact_email, name: c.contact_name, lastMessageDate: c.last_contacted });
    });
    container.appendChild(row);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "CONTACT_UPDATED") {
    if (screens.app.classList.contains("hidden")) return; // not signed in / paywalled — ignore
    if (message.contact) {
      renderContact(message.contact);
    } else {
      showEmptyCurrent();
    }
  }
});

document.getElementById("sign-in-btn").addEventListener("click", handleSignIn);
document.getElementById("paywall-btn").addEventListener("click", startCheckout);
document.getElementById("paywall-signout-btn").addEventListener("click", signOut);
document.getElementById("sign-out-btn").addEventListener("click", signOut);
document.getElementById("manage-sub-btn").addEventListener("click", openBillingPortal);
document.getElementById("note-input").addEventListener("input", scheduleSave);
document.getElementById("tags-input").addEventListener("input", scheduleSave);
document.getElementById("remind-input").addEventListener("input", scheduleSave);
document.getElementById("tab-current").addEventListener("click", () => switchTab("current"));
document.getElementById("tab-list").addEventListener("click", () => switchTab("list"));
document.getElementById("list-search").addEventListener("input", renderContactsList);

(async function init() {
  showScreen("loading");
  const signedIn = await trySignInSilently();
  if (!signedIn) {
    showScreen("signedOut");
    return;
  }
  await afterSignedIn();
})();
