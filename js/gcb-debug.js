/*
 * Author: Sivakumar Chandrahasu | Created: 2026-07-07 | Updated: 2026-07-07
 * Purpose: Shared debug/status bridge for GCB modules.
 *          Writes module status and diagnostic messages for support troubleshooting.
 */
/* GCB Central Debug Bridge v1.1.0 */
(function (global) {
  "use strict";

  const STORAGE_KEY = "GCB_CENTRAL_DEBUG_EVENTS";
  const STATUS_KEY = "GCB_CENTRAL_STATUS";
  const MAX_EVENTS = 500;
  const SENSITIVE_PARAMS = new Set([
    "access_token", "id_token", "refresh_token", "token", "code", "state", "oauth_token", "authorization"
  ]);

  function now() { return new Date().toISOString(); }
  function safeString(value) {
    if (value === null || value === undefined) return "";
    try { return String(value); } catch (_) { return "[unprintable]"; }
  }
  function truncate(value, max) {
    const text = safeString(value);
    return text.length > max ? text.substring(0, max - 3) + "..." : text;
  }
  function getModuleName() {
    try {
      const params = new URLSearchParams(global.location.search || "");
      return params.get("module") || (global.location.pathname || "").split("/").pop() || "index";
    } catch (_) {
      return "unknown";
    }
  }
  function maskValue(key, value) {
    const text = safeString(value);
    if (!text) return "";
    const lower = safeString(key).toLowerCase();
    if (SENSITIVE_PARAMS.has(lower)) return "***masked***";
    if (lower === "clientid" && text.length > 10) return text.substring(0, 4) + "..." + text.substring(text.length - 4);
    if (lower.includes("token")) return "***masked***";
    return text;
  }
  function maskUrl(url) {
    const input = safeString(url);
    if (!input) return "";
    try {
      const u = new URL(input, global.location.origin);
      u.searchParams.forEach(function (value, key) { u.searchParams.set(key, maskValue(key, value)); });
      return u.toString();
    } catch (_) {
      return truncate(input.replace(/(access_token|id_token|refresh_token|token|code)=([^&\s]+)/ig, "$1=***masked***"), 1200);
    }
  }
  function readJson(key, fallback) {
    try {
      const raw = global.localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : fallback;
      return parsed || fallback;
    } catch (_) { return fallback; }
  }
  function writeJson(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }
  function readEvents() {
    const parsed = readJson(STORAGE_KEY, []);
    return Array.isArray(parsed) ? parsed : [];
  }
  function writeEvents(events) { writeJson(STORAGE_KEY, events.slice(-MAX_EVENTS)); }
  function readStatuses() { return readJson(STATUS_KEY, {}); }
  function writeStatuses(statuses) { writeJson(STATUS_KEY, statuses || {}); }
  function setStatus(key, state, reason) {
    const k = safeString(key);
    if (!k) return null;
    const statuses = readStatuses();
    statuses[k] = {
      state: safeString(state || "pending"),
      reason: truncate(reason || "", 500),
      time: now()
    };
    writeStatuses(statuses);
    try { global.dispatchEvent(new CustomEvent("gcb-status-event", { detail: { key: k, status: statuses[k] } })); } catch (_) {}
    return statuses[k];
  }
  function clearStatuses() { writeStatuses({}); }

  function inferStatus(event) {
    const moduleName = safeString(event.module).toLowerCase();
    const step = safeString(event.step).toUpperCase();
    const msg = safeString(event.message);
    const level = safeString(event.level).toUpperCase();

    if (moduleName === "index.html" || moduleName === "index" || moduleName === "") {
      if (step === "LANDING_READY" || (step === "FETCH_DONE" && /\/api\/v2\/users\/me/i.test(msg) && /HTTP 200/.test(msg))) {
        setStatus("oauth", "success", "OAuth completed and Genesys access validated.");
      }
      if (step === "INDEX_INIT_FAILED" || (level === "ERROR" && /oauth|login|mfa|token|authorization/i.test(msg))) {
        setStatus("oauth", "failed", msg || "OAuth validation failed.");
      }
    }

    if (moduleName === "chatmonitor" || moduleName === "chatmonitor.html" || /chatmonitor\.html/i.test(safeString(event.page)) || moduleName === "sendmsg" || moduleName === "sendmsg.html" || /sendmsg\.html/i.test(safeString(event.page))) {
      if (step === "SEND_JOINED_OK" || step === "SEND_GREETING_OK") {
        setStatus("sendGreeting", "success", step === "SEND_GREETING_OK" ? "Joined/Greeting message sent by ChatMonitor." : "Mandatory joined message sent by ChatMonitor.");
      }
      if (/SKIPPED/.test(step)) setStatus("sendGreeting", "success", "Skipped duplicate / not required: " + msg);
      if (step === "PROCESS_FAILED" || step === "VALIDATION_FAILED" || level === "ERROR") setStatus("sendGreeting", "failed", msg);
    }

    if (moduleName === "holdresume" || moduleName === "holdresume.html" || /holdresume\.html/i.test(safeString(event.page))) {
      if (step === "SEND_OK") setStatus("holdResume", "success", msg || "Hold/Resume message sent.");
      if (step === "SUMMARY_API_OK" || step === "SUMMARY_DIRECT_OK") setStatus("holdResume", "success", "Hold summary loaded.");
      if (level === "ERROR" || step.includes("FAILED") || step.includes("ERROR")) setStatus("holdResume", "failed", msg);
    }

    if (moduleName === "prospects" || moduleName === "prospects.html" || /prospects\.html/i.test(safeString(event.page))) {
      if (/Prospects values loaded/i.test(msg) || /VALUES_LOADED/i.test(msg)) setStatus("prospects", "success", "Prospects values loaded.");
      if (/Wrap-up assigned and Prospects submitted successfully/i.test(msg) || /PARTICIPANT_DATA_SAVED|WRAPUP_ASSIGNED/i.test(msg)) setStatus("prospects", "success", "Wrap-up assigned and Prospects submitted successfully.");
      if (level === "ERROR" || /Submit failed|LOAD_ERROR|ERROR::/i.test(msg) || step.includes("FAILED") || step.includes("ERROR")) setStatus("prospects", "failed", msg);
    }
  }

  function log(level, step, message, data) {
    const event = {
      time: now(),
      level: safeString(level || "INFO").toUpperCase(),
      module: getModuleName(),
      page: (global.location.pathname || "").split("/").pop() || "index.html",
      step: truncate(step || "GENERAL", 80),
      message: truncate(message, 1800),
      url: maskUrl(global.location.href)
    };
    if (data !== undefined) {
      try { event.data = truncate(typeof data === "string" ? data : JSON.stringify(data), 1800); }
      catch (_) { event.data = "[unserializable]"; }
    }
    const events = readEvents();
    events.push(event);
    writeEvents(events);
    inferStatus(event);
    try { global.dispatchEvent(new CustomEvent("gcb-debug-event", { detail: event })); } catch (_) {}
    return event;
  }
  function clear() { writeEvents([]); clearStatuses(); }
  function exportText() {
    return readEvents().map(function (e) {
      return [e.time, e.level, e.module, e.page, e.step, e.message, e.data || ""].join(" | ");
    }).join("\n");
  }

  if (!global.GcbDebug) {
    global.GcbDebug = { log, getEvents: readEvents, clear, exportText, maskUrl, storageKey: STORAGE_KEY, setStatus, getStatuses: readStatuses, clearStatuses };
  }

  if (!global.__GCB_DEBUG_CONSOLE_WRAPPED__) {
    global.__GCB_DEBUG_CONSOLE_WRAPPED__ = true;
    const original = {
      log: global.console && global.console.log ? global.console.log.bind(global.console) : function () {},
      warn: global.console && global.console.warn ? global.console.warn.bind(global.console) : function () {},
      error: global.console && global.console.error ? global.console.error.bind(global.console) : function () {},
      debug: global.console && global.console.debug ? global.console.debug.bind(global.console) : function () {}
    };
    function wrap(name, level) {
      if (!global.console || !global.console[name]) return;
      global.console[name] = function () {
        try {
          const args = Array.prototype.slice.call(arguments).map(function (x) {
            if (x instanceof Error) return x.stack || x.message;
            if (typeof x === "object") { try { return JSON.stringify(x); } catch (_) { return "[object]"; } }
            return safeString(x);
          });
          log(level, "CONSOLE_" + name.toUpperCase(), args.join(" "));
        } catch (_) {}
        return original[name].apply(null, arguments);
      };
    }
    wrap("log", "INFO");
    wrap("debug", "DEBUG");
    wrap("warn", "WARN");
    wrap("error", "ERROR");
  }

  if (!global.__GCB_DEBUG_ERROR_WRAPPED__) {
    global.__GCB_DEBUG_ERROR_WRAPPED__ = true;
    global.addEventListener("error", function (event) {
      log("ERROR", "WINDOW_ERROR", (event.message || "Script error") + " at " + (event.filename || "") + ":" + (event.lineno || ""));
    });
    global.addEventListener("unhandledrejection", function (event) {
      const reason = event.reason;
      log("ERROR", "UNHANDLED_REJECTION", reason && (reason.stack || reason.message) ? (reason.stack || reason.message) : safeString(reason));
    });
  }

  if (!global.__GCB_DEBUG_FETCH_WRAPPED__ && typeof global.fetch === "function") {
    global.__GCB_DEBUG_FETCH_WRAPPED__ = true;
    const originalFetch = global.fetch.bind(global);
    global.fetch = function (input, init) {
      const start = Date.now();
      const method = (init && init.method) || (input && input.method) || "GET";
      const url = typeof input === "string" ? input : (input && input.url) || "";
      log("DEBUG", "FETCH_START", method + " " + maskUrl(url));
      return originalFetch(input, init).then(function (response) {
        log(response.ok ? "DEBUG" : "WARN", "FETCH_DONE", method + " " + maskUrl(url) + " -> HTTP " + response.status + " (" + (Date.now() - start) + "ms)");
        return response;
      }).catch(function (error) {
        log("ERROR", "FETCH_FAILED", method + " " + maskUrl(url) + " -> " + (error && error.message ? error.message : safeString(error)));
        throw error;
      });
    };
  }

  log("INFO", "PAGE_LOAD", "Loaded " + ((global.location.pathname || "").split("/").pop() || "index.html"));
})(window);
