/*
 * Author: Sivakumar Chandrahasu | Created: 2026-07-07 | Updated: 2026-07-07
 * Purpose: Shared OAuth/PKCE helper for GCB pages.
 *          Stores and refreshes browser-side auth state used by direct pages and router fallback.
 */
/* GCB Shared OAuth / MFA Recovery v1.1.0-coordinated */
(function (global) {
  "use strict";

  const C = global.RakCommon;
  const STORAGE_CLIENT_ID = "gcb_clientId";
  const STORAGE_REGION = "gcb_region";
  const STORAGE_ORIGINAL_URL = "gcb_gcb_auth_original_url";
  const DEFAULT_CLIENT_ID = "cc8cd8bf-0e14-4b14-9e4f-4849bc23ed00";
  const DEFAULT_REGION = "mypurecloud.ie";
  const STORAGE_PKCE_VERIFIER = "pkce_code_verifier";
  const STORAGE_PKCE_STATE = "pkce_oauth_state";
  const AUTH_LOCK_KEY = "AFT_GCB_AUTH_RECOVERY_LOCK_V1";
  const AUTH_EVENT_KEY = "AFT_GCB_AUTH_RECOVERY_EVENT_V1";
  const AUTH_CHANNEL_NAME = "AFT_GCB_AUTH_RECOVERY_V1";
  const AUTH_LOCK_TTL_MS = 120000;
  const AUTH_WAIT_TIMEOUT_MS = 45000;
  const TAB_ID_KEY = "AFT_GCB_AUTH_TAB_ID";

  function getClientId() {
    const value = C.getParam("clientId") || sessionStorage.getItem(STORAGE_CLIENT_ID) || DEFAULT_CLIENT_ID;
    if (value) sessionStorage.setItem(STORAGE_CLIENT_ID, value);
    return value;
  }

  function getRegion() {
    const value = C.getParam("region") || C.getParam("gcTargetEnv") || sessionStorage.getItem(STORAGE_REGION) || DEFAULT_REGION;
    if (value) sessionStorage.setItem(STORAGE_REGION, value);
    return value;
  }

  function getLoginBase() {
    return "https://login." + getRegion();
  }

  function getApiBase() {
    return "https://api." + getRegion();
  }

  function getRedirectUri() {
    // Always use index.html as the single Genesys OAuth redirect/callback page.
    // Business pages can still request login; after MFA/OAuth the user is restored to the original page URL.
    try {
      const indexPath = global.location.pathname.replace(/\/[^\/]*$/, "/index.html");
      return global.location.origin + indexPath;
    } catch (_) {
      return global.location.origin + "/index.html";
    }
  }

  function getAccessToken() {
    const token = sessionStorage.getItem("gc_access_token");
    const expiresAt = Number(sessionStorage.getItem("gc_token_expires_at") || 0);
    if (!token) return "";
    if (!expiresAt || Date.now() > expiresAt - 60000) {
      clearToken();
      return "";
    }
    return token;
  }

  function clearToken() {
    try {
      sessionStorage.removeItem("gc_access_token");
      sessionStorage.removeItem("gc_token_expires_at");
      sessionStorage.removeItem(STORAGE_PKCE_VERIFIER);
      sessionStorage.removeItem(STORAGE_PKCE_STATE);
    } catch (_) {}
  }

  function getTabId() {
    let value = "";
    try {
      value = sessionStorage.getItem(TAB_ID_KEY) || "";
      if (!value) {
        value = "tab-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem(TAB_ID_KEY, value);
      }
    } catch (_) {
      value = "tab-" + Math.random().toString(36).slice(2, 10);
    }
    return value;
  }

  function readAuthLock() {
    try {
      const parsed = JSON.parse(localStorage.getItem(AUTH_LOCK_KEY) || "null");
      if (!parsed || !parsed.owner || !parsed.createdAt) return null;
      if (Date.now() - Number(parsed.createdAt) > AUTH_LOCK_TTL_MS) {
        localStorage.removeItem(AUTH_LOCK_KEY);
        return null;
      }
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function acquireAuthLock() {
    const tabId = getTabId();
    const existing = readAuthLock();
    if (existing && existing.owner !== tabId) return false;
    try {
      localStorage.setItem(AUTH_LOCK_KEY, JSON.stringify({
        owner: tabId,
        createdAt: Date.now()
      }));
      const confirmed = readAuthLock();
      return !!confirmed && confirmed.owner === tabId;
    } catch (_) {
      return true;
    }
  }

  function releaseAuthLock() {
    try {
      const existing = readAuthLock();
      if (!existing || existing.owner === getTabId()) localStorage.removeItem(AUTH_LOCK_KEY);
    } catch (_) {}
  }

  function publishAuthEvent(type, detail) {
    const event = {
      type: String(type || ""),
      owner: getTabId(),
      at: Date.now(),
      detail: detail || {}
    };
    try {
      if ("BroadcastChannel" in global) {
        const channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
        channel.postMessage(event);
        channel.close();
      }
    } catch (_) {}
    try {
      localStorage.setItem(AUTH_EVENT_KEY, JSON.stringify(event));
      localStorage.removeItem(AUTH_EVENT_KEY);
    } catch (_) {}
  }

  function waitForAuthCompletion(timeoutMs) {
    const waitMs = Number(timeoutMs || AUTH_WAIT_TIMEOUT_MS);
    return new Promise(function (resolve) {
      let finished = false;
      let channel = null;
      let timer = null;

      function finish(value) {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        if (channel) {
          try { channel.close(); } catch (_) {}
        }
        global.removeEventListener("storage", onStorage);
        resolve(!!value);
      }

      function inspect(eventValue) {
        const event = eventValue && typeof eventValue === "object" ? eventValue : {};
        if (event.owner === getTabId()) return;
        if (event.type === "AUTH_COMPLETED") finish(true);
        if (event.type === "AUTH_FAILED") finish(false);
      }

      function onStorage(event) {
        if (event.key !== AUTH_EVENT_KEY || !event.newValue) return;
        try { inspect(JSON.parse(event.newValue)); } catch (_) {}
      }

      try {
        if ("BroadcastChannel" in global) {
          channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
          channel.onmessage = function (event) { inspect(event.data); };
        }
      } catch (_) {}

      global.addEventListener("storage", onStorage);
      timer = setTimeout(function () { finish(false); }, waitMs);
    });
  }

  function base64UrlEncode(arrayBuffer) {
    let str = "";
    const bytes = new Uint8Array(arrayBuffer);
    for (let i = 0; i < bytes.byteLength; i += 1) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }

  function generateCodeVerifier() {
    const array = new Uint8Array(64);
    global.crypto.getRandomValues(array);
    return base64UrlEncode(array);
  }

  async function generateCodeChallenge(codeVerifier) {
    const data = new TextEncoder().encode(codeVerifier);
    const digest = await global.crypto.subtle.digest("SHA-256", data);
    return base64UrlEncode(new Uint8Array(digest));
  }

  async function startPKCELogin(options) {
    options = options || {};
    const clientId = getClientId();
    if (!clientId) throw new Error("clientId is required for Genesys OAuth login.");

    if (!options.skipCoordination) {
      const existingLock = readAuthLock();
      if (existingLock && existingLock.owner !== getTabId()) {
        publishAuthEvent("AUTH_WAITING", { waitingTab: getTabId() });
        await waitForAuthCompletion(options.waitTimeoutMs || AUTH_WAIT_TIMEOUT_MS);
        const tokenAfterWait = getAccessToken();
        if (tokenAfterWait) return tokenAfterWait;
      }
    }

    if (!acquireAuthLock()) {
      await waitForAuthCompletion(options.waitTimeoutMs || AUTH_WAIT_TIMEOUT_MS);
      const tokenAfterLockWait = getAccessToken();
      if (tokenAfterLockWait) return tokenAfterLockWait;
      if (!acquireAuthLock()) throw new Error("OAuth recovery is already running in another GCB tab.");
    }

    publishAuthEvent("AUTH_STARTED", { restoreUrl: options.restoreUrl || global.location.href });

    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const state = generateCodeVerifier().slice(0, 48);
    sessionStorage.setItem(STORAGE_PKCE_VERIFIER, verifier);
    sessionStorage.setItem(STORAGE_PKCE_STATE, state);
    sessionStorage.setItem(STORAGE_PKCE_VERIFIER + ":" + state, verifier);
    sessionStorage.setItem(STORAGE_CLIENT_ID, clientId);
    sessionStorage.setItem(STORAGE_REGION, getRegion());
    sessionStorage.setItem(STORAGE_ORIGINAL_URL, options.restoreUrl || global.location.href);

    const authUrl = getLoginBase() + "/oauth/authorize" +
      "?response_type=code" +
      "&client_id=" + encodeURIComponent(clientId) +
      "&redirect_uri=" + encodeURIComponent(getRedirectUri()) +
      "&code_challenge=" + encodeURIComponent(challenge) +
      "&code_challenge_method=S256" +
      "&state=" + encodeURIComponent(state);

    global.location.href = authUrl;
  }

  function cleanOAuthParameters(urlValue) {
    try {
      const cleanUrl = new URL(urlValue || global.location.href, global.location.href);
      ["code", "state", "error", "error_description"].forEach((name) => cleanUrl.searchParams.delete(name));
      return cleanUrl.toString();
    } catch (_) {
      return String(urlValue || global.location.href)
        .replace(/([?&])(code|state|error|error_description)=[^&]*/g, "$1")
        .replace(/[?&]$/, "");
    }
  }

  async function handleOAuthCallback(code, callbackState) {
    const currentToken = getAccessToken();
    const state = C.safeString(callbackState || C.getParam("state"));
    const verifier = (state && sessionStorage.getItem(STORAGE_PKCE_VERIFIER + ":" + state)) ||
      sessionStorage.getItem(STORAGE_PKCE_VERIFIER);

    // Refreshing an already-authenticated callback URL must not fail after the verifier was consumed.
    if (!verifier && currentToken) return currentToken;
    if (!verifier) throw new Error("Missing PKCE code verifier. Authentication may already be complete; reload the original GCB page.");

    const expectedState = sessionStorage.getItem(STORAGE_PKCE_STATE);
    if (state && expectedState && state !== expectedState && !sessionStorage.getItem(STORAGE_PKCE_VERIFIER + ":" + state)) {
      if (currentToken) return currentToken;
      throw new Error("OAuth state validation failed. Please start authentication again.");
    }

    const body = new URLSearchParams();
    body.append("grant_type", "authorization_code");
    body.append("client_id", getClientId());
    body.append("code", code);
    body.append("redirect_uri", getRedirectUri());
    body.append("code_verifier", verifier);

    const response = await fetch(getLoginBase() + "/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });

    const result = C.parseJson(await response.text());
    if (!response.ok) {
      // A refreshed/stale authorization code can be ignored when another GCB frame already obtained a token.
      const recoveredToken = getAccessToken();
      if (recoveredToken) return recoveredToken;
      releaseAuthLock();
      publishAuthEvent("AUTH_FAILED", { reason: "token_request_failed", status: response.status });
      throw new Error("Token request failed: " + JSON.stringify(result));
    }

    sessionStorage.setItem("gc_access_token", result.access_token || "");
    sessionStorage.setItem("gc_token_expires_at", String(Date.now() + ((result.expires_in || 3600) * 1000)));
    releaseAuthLock();
    publishAuthEvent("AUTH_COMPLETED", { region: getRegion() });
    sessionStorage.removeItem(STORAGE_PKCE_VERIFIER);
    sessionStorage.removeItem(STORAGE_PKCE_STATE);
    if (state) sessionStorage.removeItem(STORAGE_PKCE_VERIFIER + ":" + state);

    return result.access_token || "";
  }

  async function handleOAuthRedirectIfPresent() {
    const code = C.getParam("code");
    if (!code) return false;

    const restoreUrl = sessionStorage.getItem(STORAGE_ORIGINAL_URL) || (global.location.origin + global.location.pathname);
    const validToken = getAccessToken();

    // MFA may have completed in another Genesys frame. On refresh, reuse that token and only clean the stale callback URL.
    if (!validToken) await handleOAuthCallback(code, C.getParam("state"));

    sessionStorage.removeItem(STORAGE_ORIGINAL_URL);
    global.location.replace(cleanOAuthParameters(restoreUrl));
    return true;
  }

  async function ensureToken(options) {
    options = options || {};
    const token = getAccessToken();
    if (token) return token;

    const existingLock = readAuthLock();
    if (existingLock && existingLock.owner !== getTabId()) {
      publishAuthEvent("AUTH_WAITING", { waitingTab: getTabId() });
      await waitForAuthCompletion(options.waitTimeoutMs || AUTH_WAIT_TIMEOUT_MS);
      const tokenAfterWait = getAccessToken();
      if (tokenAfterWait) return tokenAfterWait;
      // Each browser tab keeps its own session token. After another tab completes MFA,
      // this tab performs its own PKCE round-trip; the existing Genesys SSO session
      // normally completes without another MFA prompt.
      await startPKCELogin({
        restoreUrl: options.restoreUrl || global.location.href,
        skipCoordination: true
      });
      return "";
    }

    await startPKCELogin({ restoreUrl: options.restoreUrl || global.location.href });
    return "";
  }

  function isAuthError(error) {
    const text = C.safeString(error && (error.message || error)).toLowerCase();
    const status = Number(error && error.status || 0);
    return status === 401 || status === 403 ||
      text.includes("401") || text.includes("403") ||
      text.includes("unauthorized") || text.includes("forbidden") ||
      text.includes("mfa") || text.includes("expired token") || text.includes("invalid token");
  }

  global.RakAuth = {
    getClientId,
    getRegion,
    getLoginBase,
    getApiBase,
    getRedirectUri,
    getAccessToken,
    clearToken,
    startPKCELogin,
    handleOAuthCallback,
    handleOAuthRedirectIfPresent,
    ensureToken,
    waitForAuthCompletion,
    readAuthLock,
    releaseAuthLock,
    publishAuthEvent,
    isAuthError
  };
})(window);
