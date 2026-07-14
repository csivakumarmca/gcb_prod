/*
 * Author: Sivakumar Chandrahasu | Created: 2026-07-07 | Updated: 2026-07-07
 * Purpose: RAKBANK-specific common helper functions for legacy GCB page behavior.
 *          Provides compatibility utilities used by existing Hold/Prospects logic.
 */
/* RAKBANK GCB Common Utilities v1.0.0 */
(function (global) {
  "use strict";

  function safeString(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
  }

  function cleanRuntimeValue(value) {
    const text = safeString(value);
    if (!text) return "";
    if (/^\{\{.*\}\}$/.test(text)) return "";
    return text;
  }

  function getParams() {
    return new URLSearchParams(global.location.search || "");
  }

  function getParam(name, fallback) {
    const params = getParams();
    const value = cleanRuntimeValue(params.get(name) || "");
    return value || fallback || "";
  }

  function getBoolParam(name, defaultValue) {
    const value = safeString(getParam(name, "")).toLowerCase();
    if (!value) return defaultValue;
    if (["true", "1", "yes", "y"].includes(value)) return true;
    if (["false", "0", "no", "n"].includes(value)) return false;
    return defaultValue;
  }

  function sanitizeKey(value) {
    return safeString(value).replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function parseJson(text) {
    try {
      return text ? JSON.parse(text) : {};
    } catch (_) {
      return { raw: text };
    }
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>\"']/g, function (char) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
    });
  }

  function truncate(value, maxLength) {
    const text = safeString(value);
    if (!maxLength || text.length <= maxLength) return text;
    return text.substring(0, Math.max(0, maxLength - 3)) + "...";
  }

  function deriveUuid(value) {
    const match = safeString(value).match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    return match ? match[0] : "";
  }

  function extractUuids(value) {
    return safeString(value).match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g) || [];
  }

  function applyMessageTemplate(value, replacements) {
    let text = safeString(value)
      .replaceAll("@@COMMA@@", ",")
      .replaceAll("@@AMP@@", "&")
      .replaceAll("@@PIPE@@", "|");

    Object.keys(replacements || {}).forEach(function (key) {
      text = text.replaceAll("{{" + key + "}}", safeString(replacements[key]));
    });

    return text;
  }

  global.RakCommon = {
    safeString,
    cleanRuntimeValue,
    getParams,
    getParam,
    getBoolParam,
    sanitizeKey,
    sleep,
    parseJson,
    escapeHtml,
    truncate,
    deriveUuid,
    extractUuids,
    applyMessageTemplate
  };
})(window);
