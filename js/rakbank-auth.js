/*
 * Author: Sivakumar Chandrahasu | Created: 2026-07-07 | Updated: 2026-07-07
 * Purpose: RAKBANK-specific auth compatibility helper used by legacy GCB pages.
 *          Keeps older page-level auth calls aligned with the shared OAuth flow.
 */
/* RAKBANK GCB Shared OAuth / MFA Recovery v1.0.0 */
(function (global) {
  "use strict";

  const C = global.RakCommon;
  const STORAGE_CLIENT_ID = "rakbank_clientId";
  const STORAGE_REGION = "rakbank_region";
  const STORAGE_ORIGINAL_URL = "rakbank_gcb_auth_original_url";
  const DEFAULT_CLIENT_ID = "cc8cd8bf-0e14-4b14-9e4f-4849bc23ed00";
  const DEFAULT_REGION = "mypurecloud.ie";

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
    return global.location.origin + global.location.pathname;
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
      sessionStorage.removeItem("pkce_code_verifier");
    } catch (_) {}
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

    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    sessionStorage.setItem("pkce_code_verifier", verifier);
    sessionStorage.setItem(STORAGE_CLIENT_ID, clientId);
    sessionStorage.setItem(STORAGE_REGION, getRegion());
    sessionStorage.setItem(STORAGE_ORIGINAL_URL, options.restoreUrl || global.location.href);

    const authUrl = getLoginBase() + "/oauth/authorize" +
      "?response_type=code" +
      "&client_id=" + encodeURIComponent(clientId) +
      "&redirect_uri=" + encodeURIComponent(getRedirectUri()) +
      "&code_challenge=" + encodeURIComponent(challenge) +
      "&code_challenge_method=S256";

    global.location.href = authUrl;
  }

  async function handleOAuthCallback(code) {
    const verifier = sessionStorage.getItem("pkce_code_verifier");
    if (!verifier) throw new Error("Missing PKCE code verifier. Clear session and try again.");

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
    if (!response.ok) throw new Error("Token request failed: " + JSON.stringify(result));

    sessionStorage.setItem("gc_access_token", result.access_token || "");
    sessionStorage.setItem("gc_token_expires_at", String(Date.now() + ((result.expires_in || 3600) * 1000)));
    sessionStorage.removeItem("pkce_code_verifier");

    return result.access_token || "";
  }

  async function handleOAuthRedirectIfPresent() {
    const code = C.getParam("code");
    if (!code) return false;
    await handleOAuthCallback(code);
    const restoreUrl = sessionStorage.getItem(STORAGE_ORIGINAL_URL) || (global.location.origin + global.location.pathname);
    sessionStorage.removeItem(STORAGE_ORIGINAL_URL);
    global.location.replace(restoreUrl.replace(/[?&]code=[^&]+/, ""));
    return true;
  }

  async function ensureToken() {
    const token = getAccessToken();
    if (token) return token;
    await startPKCELogin({ restoreUrl: global.location.href });
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
    isAuthError
  };
})(window);
