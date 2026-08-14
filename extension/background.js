// Service worker: tracks which Gmail thread is open in which tab, keeps the
// side panel's "active contact" in sync, and brokers Google auth tokens.
//
// Auth uses chrome.identity.launchWebAuthFlow (a hosted Google OAuth popup)
// rather than chrome.identity.getAuthToken. getAuthToken depends on Chrome's
// browser-level "Allow Chrome sign-in" being on, which many users disable
// for privacy — launchWebAuthFlow works the same way a website's "Sign in
// with Google" button does, independent of that setting.
import { GOOGLE_CLIENT_ID, SUPABASE_FUNCTION_URL } from "./config.js";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const AUTH_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

// --- Access token cache (memory-only, cleared when the browser closes) ---
async function getCachedToken() {
  const { authToken } = await chrome.storage.session.get("authToken");
  if (authToken && authToken.expiresAt > Date.now() + 60_000) return authToken.token;
  return null;
}

async function setCachedToken(token, expiresInSeconds) {
  await chrome.storage.session.set({
    authToken: { token, expiresAt: Date.now() + expiresInSeconds * 1000 },
  });
}

// --- Refresh token (chrome.storage.local — persists across browser
// restarts, cleared only on explicit sign-out or extension uninstall). This
// is what actually fixes repeated sign-in prompts: launchWebAuthFlow's
// non-interactive mode runs in an isolated cookie partition that can't see
// the user's Google session, so silent re-auth through it basically never
// works. A stored refresh token sidesteps that entirely — refreshing an
// access token is a plain server-to-server token exchange, no popup, no
// cookies involved. ---
async function getRefreshToken() {
  const { refreshToken } = await chrome.storage.local.get("refreshToken");
  return refreshToken ?? null;
}

async function setRefreshToken(token) {
  if (token) await chrome.storage.local.set({ refreshToken: token });
}

async function clearRefreshToken() {
  await chrome.storage.local.remove("refreshToken");
}

async function exchangeCodeForTokens(code, redirectUri) {
  const res = await fetch(`${SUPABASE_FUNCTION_URL}/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, redirect_uri: redirectUri }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Token exchange failed");
  return data;
}

async function refreshAccessToken() {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return null;

  const res = await fetch(`${SUPABASE_FUNCTION_URL}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const data = await res.json();
  if (!res.ok) {
    // Refresh token was revoked/expired — clear it so we fall back to a
    // normal interactive sign-in instead of retrying a dead token forever.
    await clearRefreshToken();
    return null;
  }
  await setCachedToken(data.access_token, data.expires_in);
  return data.access_token;
}

function launchAuthFlow() {
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", AUTH_SCOPES);
  // access_type=offline + prompt=consent guarantees Google issues a refresh
  // token on this sign-in (it otherwise only does so the very first time an
  // app is ever authorized) — that refresh token is what lets every future
  // access happen silently, including after a full browser restart.
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true }, async (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        reject(new Error(chrome.runtime.lastError?.message ?? "Auth flow failed"));
        return;
      }
      const code = new URL(redirectUrl).searchParams.get("code");
      if (!code) {
        reject(new Error("No authorization code in response"));
        return;
      }
      try {
        const tokens = await exchangeCodeForTokens(code, redirectUri);
        await setCachedToken(tokens.access_token, tokens.expires_in);
        await setRefreshToken(tokens.refresh_token);
        resolve(tokens.access_token);
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function getAuthTokenCachedFirst(interactive) {
  const cached = await getCachedToken();
  if (cached) return cached;

  const refreshed = await refreshAccessToken();
  if (refreshed) return refreshed;

  if (!interactive) throw new Error("Sign-in required");
  return launchAuthFlow();
}

/** @type {Map<number, {email: string, name: string, lastMessageDate: string|null}>} */
const contactsByTab = new Map();
let activeTabId = null;

async function refreshActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  activeTabId = tab ? tab.id : null;
}
refreshActiveTabId();

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  activeTabId = tabId;
  broadcastActiveContact();
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  await refreshActiveTabId();
  broadcastActiveContact();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  contactsByTab.delete(tabId);
});

function broadcastActiveContact() {
  const contact = activeTabId != null ? contactsByTab.get(activeTabId) ?? null : null;
  chrome.runtime.sendMessage({ type: "CONTACT_UPDATED", contact }).catch(() => {
    // No side panel listening right now — fine, it will pull on open.
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ACTIVE_CONTACT" && sender.tab?.id != null) {
    contactsByTab.set(sender.tab.id, message.contact);
    if (sender.tab.id === activeTabId) broadcastActiveContact();
    return false;
  }

  if (message?.type === "GET_ACTIVE_CONTACT") {
    const contact = activeTabId != null ? contactsByTab.get(activeTabId) ?? null : null;
    sendResponse({ contact });
    return false;
  }

  if (message?.type === "GET_AUTH_TOKEN") {
    getAuthTokenCachedFirst(message.interactive !== false)
      .then((token) => sendResponse({ token }))
      .catch((err) => sendResponse({ error: err.message }));
    return true; // async response
  }

  if (message?.type === "SIGN_OUT") {
    (async () => {
      const refreshToken = await getRefreshToken();
      await chrome.storage.session.remove("authToken");
      await clearRefreshToken();
      if (refreshToken) {
        // Best-effort — revoke so the user shows up as "signed out" in
        // their Google account's connected-apps list too. Don't block
        // sign-out on this succeeding.
        fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, {
          method: "POST",
        }).catch(() => {});
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});
