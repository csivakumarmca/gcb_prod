/*
 * Author: Sivakumar Chandrahasu | Created: 2026-07-07 | Updated: 2026-07-07
 * Purpose: Hold/Resume business logic shared by holdtimer and hold summary pages.
 *          Sends hold/resume messages, manages local hold records, and calculates hold status.
 */
/************************************************************
     * RAKBANK HOLD RESUME PAGE - v1.0.13
     * Uses existing Genesys client-side send-message approach.
     * v1.0.12 release note:
     * - Browser notification/taskbar attention kept as optional best-effort alert.
     * - If permission is granted, notification can appear.
     * - If permission is denied/blocked, Hold/Resume continues and falls back to alert blink, title blink, and sound.
     ************************************************************/
    const HR_VERSION = "v1.0.13";

    const ORIGINAL_DOCUMENT_TITLE = document.title;
    let attentionTitleInterval = null;
    let attentionBlinkTimeout = null;
    const PARAMS = new URLSearchParams(window.location.search);
    const REDIRECT_URI = window.location.origin + window.location.pathname;

    const DEFAULT_REGION = "mypurecloud.ie";
    const DEFAULT_CLIENT_ID = "";
    const STORAGE_CLIENT_ID = "rakbank_hr_clientId";
    const STORAGE_REGION = "rakbank_hr_region";
    const STORAGE_ORIGINAL_URL = "rakbank_hr_originalUrl";
    const STORAGE_TIMER_PREFIX = "rakbank_hr_timer_";
    const STORAGE_BUTTON_PREFIX = "rakbank_hr_button_";
    const STORAGE_SUMMARY_PREFIX = "rakbank_hr_summary_";
    const STORAGE_ATTEMPT_PREFIX = "rakbank_hr_attempt_";
    const STORAGE_AUTH_RECOVERY_PREFIX = "rakbank_hr_auth_recovery_";

    let isProcessing = false;
    let isInitialSummaryLoading = true;
    let isOnHold = false;
    let holdTimerInterval = null;
    let activeTimer = null;
    let latestSummary = null;
    let debugLines = [];
    let persistentLimitAlert = { message: "", type: "" };

    function safeString(value) {
      if (value === null || value === undefined) return "";
      return String(value).trim();
    }

    function getParam(name, fallback) {
      const value = safeString(PARAMS.get(name));
      if (!value || (value.includes("{{") && value.includes("}}"))) return fallback || "";
      return value;
    }

    function getBoolParam(name, defaultValue) {
      const text = safeString(getParam(name, "")).toLowerCase();
      if (!text) return defaultValue;
      if (["true", "1", "yes", "y"].includes(text)) return true;
      if (["false", "0", "no", "n"].includes(text)) return false;
      return defaultValue;
    }

    function getNumberParam(name, defaultValue) {
      const num = Number(getParam(name, ""));
      if (!Number.isFinite(num)) return defaultValue;
      return Math.max(0, Math.floor(num));
    }

    function sanitizeKey(value) {
      return safeString(value).replace(/[^a-zA-Z0-9_-]/g, "_");
    }

    function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    function addDebug(step, message) {
      const line = "[" + new Date().toLocaleString() + "] " + step + " ==> " + safeString(message);
      debugLines.push(line);
      if (debugLines.length > 400) debugLines.shift();
      if (CONFIG.debug) renderDebugPanel();
      console.log(line);
    }

    function getTokenStatusForDebug() {
      try {
        return getAccessToken() ? "AVAILABLE" : "MISSING";
      } catch (_) {
        return "MISSING";
      }
    }

    function getTimerStatusForDebug() {
      if (!activeTimer) return "NOT_ACTIVE";
      const remaining = Math.max(0, Math.ceil((Number(activeTimer.expiresAt || 0) - Date.now()) / 1000));
      return "ACTIVE | remainingSeconds=" + remaining + " | maxHoldTime=" + CONFIG.maxHoldTime;
    }

    function getDebugParametersText() {
      const lines = [];
      lines.push("Debug Parameters");
      lines.push("");
      lines.push("conversationId: " + (CONFIG.conversationId || "[missing]"));
      lines.push("communicationId: " + (CONFIG.communicationId || "[missing]"));
      lines.push("participantId: " + (CONFIG.participantId || "[missing]"));
      lines.push("agentParticipantId: " + (CONFIG.agentParticipantId || "[missing]"));
      lines.push("customerCommunicationId: " + (CONFIG.customerCommunicationId || "[missing]"));
      lines.push("agentCommunicationId: " + (CONFIG.agentCommunicationId || "[missing]"));
      lines.push("region: " + (CONFIG.region || "[missing]"));
      lines.push("clientId: " + (CONFIG.clientId || "[missing]"));
      lines.push("holdMessageText: " + (CONFIG.holdMessageText || "[missing]"));
      lines.push("resumeMessageText: " + (CONFIG.resumeMessageText || "[missing]"));
      lines.push("maxHoldAttempts: " + CONFIG.maxHoldAttempts);
      lines.push("maxHoldTime: " + CONFIG.maxHoldTime + " seconds");
      lines.push("holdDetailsApiUrl: " + (CONFIG.holdDetailsApiUrl || "[not configured]"));
      lines.push("currentAgentInteractionStartTime: " + (CONFIG.currentAgentInteractionStartTime || "[not passed]"));
      lines.push("isCustomerBasedHoldCalculation: " + CONFIG.isCustomerBasedHoldCalculation);
      lines.push("debug: " + CONFIG.debug);
      lines.push("alertBlinkEnabled: " + CONFIG.alertBlinkEnabled);
      lines.push("alertSoundEnabled: " + CONFIG.alertSoundEnabled);
      lines.push("browserNotificationEnabled: " + CONFIG.browserNotificationEnabled);
      lines.push("taskbarBlinkEnabled: " + CONFIG.taskbarBlinkEnabled);
      lines.push("notificationPermission: " + getNotificationPermissionStatus());
      lines.push("source: " + CONFIG.source);
      lines.push("");
      lines.push("Runtime Status");
      lines.push("buttonState: " + (isOnHold ? "RESUME" : "HOLD"));
      lines.push("isProcessing: " + isProcessing);
      lines.push("initialSummaryLoading: " + isInitialSummaryLoading);
      lines.push("timerStatus: " + getTimerStatusForDebug());
      lines.push("oauthToken: " + getTokenStatusForDebug());
      lines.push("apiBase: " + API_BASE);
      lines.push("redirectUri: " + REDIRECT_URI);
      lines.push("");
      lines.push("Current Summary");
      lines.push("currentHoldCount: " + (latestSummary ? latestSummary.currentHoldCount : "[not loaded]"));
      lines.push("currentHoldTime: " + (latestSummary ? latestSummary.currentHoldTime : "[not loaded]"));
      lines.push("totalHoldCount: " + (latestSummary ? latestSummary.totalHoldCount : "[not loaded]"));
      lines.push("totalHoldTime: " + (latestSummary ? latestSummary.totalHoldTime : "[not loaded]"));
      lines.push("averageHoldTime: " + (latestSummary ? latestSummary.averageHoldTime : "[not loaded]"));
      lines.push("longestHoldTime: " + (latestSummary ? latestSummary.longestHoldTime : "[not loaded]"));
      lines.push("holdHistory: " + (latestSummary && latestSummary.holdHistory ? latestSummary.holdHistory : "[none]"));
      lines.push("");
      lines.push("Debug Logs");
      lines.push(debugLines.length ? debugLines.join("\n") : "[no logs yet]");
      return lines.join("\n");
    }

    function renderDebugPanel() {
      const panel = document.getElementById("debugPanel");
      if (!panel || !CONFIG.debug) return;
      panel.style.display = "block";
      panel.textContent = getDebugParametersText();
    }


    function showPersistentAlert(message, type) {
      persistentLimitAlert = { message: safeString(message), type: type || "error" };
      const el = document.getElementById("limitAlert");
      if (!el) return;
      if (!persistentLimitAlert.message) {
        el.className = "limit-alert";
        el.textContent = "";
        return;
      }
      el.className = "limit-alert show " + (persistentLimitAlert.type || "error");
      el.textContent = persistentLimitAlert.message;
    }

    function clearPersistentAlert() {
      stopAttentionAlert();
      persistentLimitAlert = { message: "", type: "" };
      const el = document.getElementById("limitAlert");
      if (!el) return;
      el.className = "limit-alert";
      el.textContent = "";
    }


    function stopAttentionAlert() {
      if (attentionBlinkTimeout) {
        clearTimeout(attentionBlinkTimeout);
        attentionBlinkTimeout = null;
      }
      if (attentionTitleInterval) {
        clearInterval(attentionTitleInterval);
        attentionTitleInterval = null;
      }
      document.title = ORIGINAL_DOCUMENT_TITLE;
      const el = document.getElementById("limitAlert");
      if (el) el.classList.remove("attention-blink");
    }

    function playAttentionBeep() {
      if (!CONFIG.alertSoundEnabled) return;
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;

        const ctx = new AudioContextClass();
        const repeatCount = Math.max(1, Number(CONFIG.alertSoundRepeatCount || 3));
        const beepDurationMs = Math.max(250, Number(CONFIG.alertSoundDurationMs || 650));
        const gapMs = Math.max(80, Number(CONFIG.alertSoundGapMs || 250));
        const totalMs = (repeatCount * beepDurationMs) + ((repeatCount - 1) * gapMs) + 300;

        for (let i = 0; i < repeatCount; i++) {
          const startTime = ctx.currentTime + ((i * (beepDurationMs + gapMs)) / 1000);
          const endTime = startTime + (beepDurationMs / 1000);

          const oscillator = ctx.createOscillator();
          const gain = ctx.createGain();

          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(i % 2 === 0 ? 880 : 1040, startTime);

          gain.gain.setValueAtTime(0.001, startTime);
          gain.gain.exponentialRampToValueAtTime(0.32, startTime + 0.04);
          gain.gain.setValueAtTime(0.32, Math.max(startTime + 0.05, endTime - 0.15));
          gain.gain.exponentialRampToValueAtTime(0.001, endTime);

          oscillator.connect(gain);
          gain.connect(ctx.destination);
          oscillator.start(startTime);
          oscillator.stop(endTime);
        }

        setTimeout(function () { try { ctx.close(); } catch (_) {} }, totalMs);
        addDebug("ATTENTION_SOUND_PLAY", "repeatCount=" + repeatCount + " | beepDurationMs=" + beepDurationMs + " | gapMs=" + gapMs);
      } catch (err) {
        addDebug("ATTENTION_SOUND_BLOCKED", err.message || String(err));
      }
    }


    function getNotificationPermissionStatus() {
      try {
        if (!("Notification" in window)) return "UNSUPPORTED";
        return Notification.permission || "default";
      } catch (_) {
        return "UNKNOWN";
      }
    }

    function requestBrowserNotificationPermissionIfPossible(reason) {
      if (!CONFIG.browserNotificationEnabled) return;
      try {
        if (!("Notification" in window)) {
          addDebug("BROWSER_NOTIFICATION_UNSUPPORTED", "Notification API is not available in this browser/frame.");
          return;
        }

        if (Notification.permission === "granted") {
          addDebug("BROWSER_NOTIFICATION_PERMISSION", "Already granted. reason=" + safeString(reason));
          return;
        }

        if (Notification.permission === "denied") {
          addDebug("BROWSER_NOTIFICATION_PERMISSION", "Denied by browser/user. reason=" + safeString(reason));
          return;
        }

        if (!CONFIG.requestNotificationPermissionOnHold) {
          addDebug("BROWSER_NOTIFICATION_PERMISSION_SKIP", "requestNotificationPermissionOnHold=false");
          return;
        }

        const permissionResult = Notification.requestPermission();
        if (permissionResult && typeof permissionResult.then === "function") {
          permissionResult.then(function (permission) {
            addDebug("BROWSER_NOTIFICATION_PERMISSION", "permission=" + permission + " | reason=" + safeString(reason));
            renderDebugPanel();
          }).catch(function (err) {
            addDebug("BROWSER_NOTIFICATION_PERMISSION_FAILED", err.message || String(err));
            renderDebugPanel();
          });
        } else {
          addDebug("BROWSER_NOTIFICATION_PERMISSION", "Requested. current=" + getNotificationPermissionStatus() + " | reason=" + safeString(reason));
        }
      } catch (err) {
        addDebug("BROWSER_NOTIFICATION_PERMISSION_FAILED", err.message || String(err));
      }
    }

    function showBrowserNotification(title, body) {
      if (!CONFIG.browserNotificationEnabled) return;
      try {
        if (!("Notification" in window)) {
          addDebug("BROWSER_NOTIFICATION_SKIP", "Notification API unsupported.");
          return;
        }

        if (Notification.permission !== "granted") {
          addDebug("BROWSER_NOTIFICATION_SKIP", "permission=" + Notification.permission + " | title=" + safeString(title));
          return;
        }

        const notification = new Notification(title || "RAKBANK Hold Alert", {
          body: body || "Please return to Genesys Cloud and check the Hold Info page.",
          tag: "rakbank-hold-resume-alert-" + safeString(CONFIG.conversationId),
          renotify: true,
          requireInteraction: false,
          silent: false
        });

        notification.onclick = function () {
          try { window.focus(); } catch (_) {}
          try { notification.close(); } catch (_) {}
        };

        setTimeout(function () {
          try { notification.close(); } catch (_) {}
        }, CONFIG.notificationAutoCloseMs);

        addDebug("BROWSER_NOTIFICATION_SENT", "title=" + safeString(title) + " | autoCloseMs=" + CONFIG.notificationAutoCloseMs);
      } catch (err) {
        addDebug("BROWSER_NOTIFICATION_FAILED", err.message || String(err));
      }
    }

    function triggerTaskbarAttention(titleText, bodyText) {
      if (!CONFIG.taskbarBlinkEnabled) return;
      try {
        // A browser page cannot directly force Windows taskbar flashing from an embedded iframe.
        // Browser notification is the supported best-effort method. Title blinking remains the fallback.
        showBrowserNotification(titleText || CONFIG.holdAlertTitle, bodyText || "Hold action requires your attention.");
        if (navigator.vibrate) {
          try { navigator.vibrate([250, 120, 250]); } catch (_) {}
        }
        addDebug("TASKBAR_ATTENTION", "best-effort | notificationPermission=" + getNotificationPermissionStatus());
      } catch (err) {
        addDebug("TASKBAR_ATTENTION_FAILED", err.message || String(err));
      }
    }

    function startTitleBlink(titleText, durationMs) {
      if (!CONFIG.alertBlinkEnabled) return;
      if (attentionTitleInterval) clearInterval(attentionTitleInterval);
      const alertTitle = titleText || "⚠️ Auto Resume Sent";
      let showAlert = true;
      document.title = alertTitle;
      attentionTitleInterval = setInterval(function () {
        showAlert = !showAlert;
        document.title = showAlert ? alertTitle : ORIGINAL_DOCUMENT_TITLE;
      }, 900);
      setTimeout(function () {
        if (attentionTitleInterval) {
          clearInterval(attentionTitleInterval);
          attentionTitleInterval = null;
        }
        document.title = ORIGINAL_DOCUMENT_TITLE;
      }, durationMs || CONFIG.titleBlinkDurationMs);
    }

    function startAttentionAlert(message, type, titleText) {
      showPersistentAlert(message, type || "warning");
      const el = document.getElementById("limitAlert");
      if (CONFIG.alertBlinkEnabled && el) {
        el.classList.add("attention-blink");
        if (attentionBlinkTimeout) clearTimeout(attentionBlinkTimeout);
        attentionBlinkTimeout = setTimeout(function () {
          const alertEl = document.getElementById("limitAlert");
          if (alertEl) alertEl.classList.remove("attention-blink");
          attentionBlinkTimeout = null;
        }, CONFIG.alertBlinkDurationMs);
      }
      const finalTitleText = titleText || ("⚠️ " + CONFIG.holdAlertTitle);
      startTitleBlink(finalTitleText, CONFIG.titleBlinkDurationMs);
      triggerTaskbarAttention(finalTitleText, safeString(message));
      playAttentionBeep();
      addDebug("ATTENTION_ALERT", "blink=" + CONFIG.alertBlinkEnabled + " | sound=" + CONFIG.alertSoundEnabled + " | browserNotification=" + CONFIG.browserNotificationEnabled + " | taskbarBlink=" + CONFIG.taskbarBlinkEnabled + " | message=" + safeString(message));
    }

    function updateLimitVisualState() {
      const card = document.getElementById("currentHoldCountCard");
      if (!card) return;
      if (getEffectiveHoldCount() >= CONFIG.maxHoldAttempts) {
        card.classList.add("limit-reached");
      } else {
        card.classList.remove("limit-reached");
      }
    }

    function getMaxAttemptsAlertMessage() {
      const effectiveCount = getEffectiveHoldCount();
      return "⚠️  ⛔ " + CONFIG.holdMaxAttemptsAlertText + " (" + effectiveCount + " / " + CONFIG.maxHoldAttempts + ")";
    }

    function showMaxAttemptsAlert() {
      showPersistentAlert(getMaxAttemptsAlertMessage(), "error");
    }

    function refreshPersistentAlert() {
      updateLimitVisualState();
      const effectiveCount = getEffectiveHoldCount();

      // Count limit must always have priority over duration warning.
      // Example: auto-resume happened due to maxHoldTime, but the resume also completed the final allowed hold pair.
      // In that case the user should see maximum attempts reached, not only duration reached.
      if (effectiveCount >= CONFIG.maxHoldAttempts) {
        showMaxAttemptsAlert();
        return;
      }

      if (persistentLimitAlert && persistentLimitAlert.message && persistentLimitAlert.type === "warning") {
        showPersistentAlert(persistentLimitAlert.message, persistentLimitAlert.type);
        return;
      }
      clearPersistentAlert();
    }

    function setStatus(message, type) {
      const el = document.getElementById("statusLine");
      if (!el) return;
      el.className = "status-line " + (type || "info");
      el.textContent = safeString(message);
      if (!message) el.style.display = "none";
    }

    function hideStatusSoon() {
      setTimeout(function () {
        const el = document.getElementById("statusLine");
        if (el && (el.className.includes("success") || el.className.includes("info"))) {
          el.style.display = "none";
        }
      }, 3500);
    }

    const CONFIG = {
      clientId: getParam("clientId", sessionStorage.getItem(STORAGE_CLIENT_ID) || DEFAULT_CLIENT_ID),
      region: getParam("region", getParam("gcTargetEnv", sessionStorage.getItem(STORAGE_REGION) || DEFAULT_REGION)),
      conversationId: getParam("conversationId", "") || deriveConversationIdFromRequestId(getParam("requestId", "")),
      communicationId: getParam("communicationId", getParam("customerCommunicationId", "")),
      participantId: getParam("participantId", getParam("agentParticipantId", "")),
      agentParticipantId: getParam("agentParticipantId", getParam("participantId", "")),
      customerCommunicationId: getParam("customerCommunicationId", getParam("communicationId", "")),
      agentCommunicationId: getParam("agentCommunicationId", ""),
      currentAgentInteractionStartTime: getParam("currentAgentInteractionStartTime", getParam("agentInteractionStartTime", "")),
      isCustomerBasedHoldCalculation: getBoolParam("isCustomerBasedHoldCalculation", false),
      holdMessageText: decodeMessageText(getParam("holdMessageText", getParam("messageTextHold", "Gen-Hold-32"))),
      resumeMessageText: decodeMessageText(getParam("resumeMessageText", getParam("autoResumeMessageText", getParam("messageTextResume", "Gen-Resume-33")))),
      maxHoldAttempts: 3, // Script owns max-attempt enforcement; Hold Summary uses fixed display fallback 3.
      maxHoldTime: getNumberParam("maxHoldTime", getNumberParam("holdTimerSeconds", 0)),
      holdDetailsApiUrl: getParam("holdDetailsApiUrl", getParam("calculateHoldDetailsUrl", "")),
      debug: getBoolParam("debug", false),
      alertBlinkEnabled: getBoolParam("alertBlinkEnabled", true),
      alertSoundEnabled: getBoolParam("alertSoundEnabled", true),
      alertBlinkDurationMs: Math.max(3000, getNumberParam("alertBlinkDurationMs", 15000)),
      titleBlinkDurationMs: Math.max(3000, getNumberParam("titleBlinkDurationMs", 30000)),
      alertSoundRepeatCount: Math.max(1, getNumberParam("alertSoundRepeatCount", 3)),
      alertSoundDurationMs: Math.max(250, getNumberParam("alertSoundDurationMs", 650)),
      alertSoundGapMs: Math.max(80, getNumberParam("alertSoundGapMs", 250)),
      browserNotificationEnabled: getBoolParam("browserNotificationEnabled", true),
      taskbarBlinkEnabled: getBoolParam("taskbarBlinkEnabled", true),
      requestNotificationPermissionOnHold: getBoolParam("requestNotificationPermissionOnHold", true),
      notificationAutoCloseMs: Math.max(3000, getNumberParam("notificationAutoCloseMs", 12000)),
      autoRefreshDelayMs: Math.max(500, getNumberParam("autoRefreshDelayMs", 1200)),
      source: getParam("source", "HoldResumePage"),
      holdMaxTimeAlertText: "Maximum hold duration reached. Please resume the chat.",
      holdMaxAttemptsAlertText: "You have reached the maximum allowed hold attempts.",
      holdAlertTitle: "Hold Alert",
      autoResumeSentText: "Auto resume sent."
    };


    function attrText(attrs, name, fallback) {
      const value = attrs && Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : undefined;
      const text = safeString(value);
      return text ? text : (fallback || "");
    }
    function attrBool(attrs, name, fallback) {
      const text = attrText(attrs, name, "").toLowerCase();
      if (["true", "yes", "1", "y"].includes(text)) return true;
      if (["false", "no", "0", "n"].includes(text)) return false;
      return fallback;
    }
    function attrNumber(attrs, name, fallback, min) {
      const text = attrText(attrs, name, "");
      const num = Number(text);
      if (!Number.isFinite(num)) return fallback;
      return typeof min === "number" ? Math.max(min, num) : num;
    }
    function getGcbLanguage(attrs) {
      return attrText(attrs, "language", attrText(attrs, "Language", attrText(attrs, "AFT_Language", attrText(attrs, "Chat_Language", "en")))).toLowerCase();
    }
    function pickLocalizedAttr(attrs, enName, arName, fallbackEn) {
      const lang = getGcbLanguage(attrs);
      const isArabic = lang === "ar" || lang === "arabic" || lang.indexOf("arabic") >= 0;
      return isArabic
        ? attrText(attrs, arName, attrText(attrs, enName, fallbackEn))
        : attrText(attrs, enName, attrText(attrs, arName, fallbackEn));
    }
    function mergeParticipantAttributesFromConversation(conversation) {
      const output = {};
      const participants = Array.isArray(conversation && conversation.participants) ? conversation.participants : [];
      participants.forEach(function (p) { if (p && p.attributes) Object.assign(output, p.attributes); });
      participants.forEach(function (p) {
        const pid = safeString(p && p.id);
        if (pid && (pid === CONFIG.participantId || pid === CONFIG.agentParticipantId) && p.attributes) Object.assign(output, p.attributes);
      });
      return output;
    }
    function applyGcbParticipantConfig(attrs) {
      if (!attrs || !Object.keys(attrs).length) return;
      CONFIG.holdMessageText = decodeMessageText(attrText(attrs, "AFT_GCB_HoldMessageText", CONFIG.holdMessageText));
      CONFIG.resumeMessageText = decodeMessageText(attrText(attrs, "AFT_GCB_ResumeMessageText", CONFIG.resumeMessageText));
      CONFIG.maxHoldTime = attrNumber(attrs, "AFT_GCB_MaxHoldTimeSeconds", CONFIG.maxHoldTime, 0);
      CONFIG.isCustomerBasedHoldCalculation = attrBool(attrs, "AFT_GCB_CustomerBasedHoldCalculation", CONFIG.isCustomerBasedHoldCalculation);
      CONFIG.alertBlinkEnabled = attrBool(attrs, "AFT_GCB_AlertBlinkEnabled", CONFIG.alertBlinkEnabled);
      CONFIG.alertBlinkDurationMs = Math.max(3000, attrNumber(attrs, "AFT_GCB_AlertBlinkDurationMs", CONFIG.alertBlinkDurationMs, 3000));
      CONFIG.alertSoundEnabled = attrBool(attrs, "AFT_GCB_AlertSoundEnabled", CONFIG.alertSoundEnabled);
      CONFIG.alertSoundRepeatCount = Math.max(1, attrNumber(attrs, "AFT_GCB_AlertSoundRepeatCount", CONFIG.alertSoundRepeatCount, 1));
      CONFIG.alertSoundDurationMs = Math.max(250, attrNumber(attrs, "AFT_GCB_AlertSoundDurationMs", CONFIG.alertSoundDurationMs, 250));
      CONFIG.alertSoundGapMs = Math.max(80, attrNumber(attrs, "AFT_GCB_AlertSoundGapMs", CONFIG.alertSoundGapMs, 80));
      CONFIG.browserNotificationEnabled = attrBool(attrs, "AFT_GCB_BrowserNotificationEnabled", CONFIG.browserNotificationEnabled);
      CONFIG.taskbarBlinkEnabled = attrBool(attrs, "AFT_GCB_TaskbarBlinkEnabled", CONFIG.taskbarBlinkEnabled);
      CONFIG.titleBlinkDurationMs = Math.max(3000, attrNumber(attrs, "AFT_GCB_TitleBlinkDurationMs", CONFIG.titleBlinkDurationMs, 3000));
      CONFIG.notificationAutoCloseMs = Math.max(3000, attrNumber(attrs, "AFT_GCB_NotificationAutoCloseMs", CONFIG.notificationAutoCloseMs, 3000));
      CONFIG.holdMaxTimeAlertText = String(attrs.AFT_GCB_HoldMaxTimeAlertText || "").trim() || CONFIG.holdMaxTimeAlertText;
      CONFIG.holdMaxAttemptsAlertText = String(attrs.AFT_GCB_HoldMaxAttemptsAlertText || "").trim() || CONFIG.holdMaxAttemptsAlertText;
      CONFIG.holdAlertTitle = String(attrs.AFT_GCB_HoldAlertTitle || "").trim() || CONFIG.holdAlertTitle;
      CONFIG.autoResumeSentText = String(attrs.AFT_GCB_AutoResumeSentText || "").trim() || CONFIG.autoResumeSentText;
      addDebug("GCB_CONFIG_APPLIED", "participantData=true | maxHoldAttempts=" + CONFIG.maxHoldAttempts + " | maxHoldTime=" + CONFIG.maxHoldTime + " | holdMessageText=" + CONFIG.holdMessageText + " | resumeMessageText=" + CONFIG.resumeMessageText);
    }
    async function loadGcbConfigFromParticipantData(token) {
      if (!token || !CONFIG.conversationId) return;
      try {
        const conversation = await getMessageConversationDirect(token, CONFIG.conversationId);
        applyGcbParticipantConfig(mergeParticipantAttributesFromConversation(conversation));
      } catch (err) {
        addDebug("GCB_CONFIG_LOAD_WARN", err.message || String(err));
      }
    }

    if (CONFIG.clientId) sessionStorage.setItem(STORAGE_CLIENT_ID, CONFIG.clientId);
    if (CONFIG.region) sessionStorage.setItem(STORAGE_REGION, CONFIG.region);

    const LOGIN_BASE = "https://login." + CONFIG.region;
    const API_BASE = "https://api." + CONFIG.region;

    function deriveConversationIdFromRequestId(requestId) {
      const match = safeString(requestId).match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
      return match ? match[0] : "";
    }

    function decodeMessageText(value) {
      return safeString(value)
        .replaceAll("@@COMMA@@", ",")
        .replaceAll("@@AMP@@", "&")
        .replaceAll("@@PIPE@@", "|");
    }

    function getContextKey() {
      return sanitizeKey((CONFIG.conversationId || "NO_CONV") + "_" + (CONFIG.communicationId || CONFIG.customerCommunicationId || "NO_COMM"));
    }

    function getButtonStateKey() {
      return STORAGE_BUTTON_PREFIX + getContextKey();
    }

    function getTimerStateKey() {
      return STORAGE_TIMER_PREFIX + getContextKey();
    }

    function getSummaryStateKey() {
      return STORAGE_SUMMARY_PREFIX + getContextKey();
    }

    function getAttemptStateKey() {
      return STORAGE_ATTEMPT_PREFIX + getContextKey();
    }

    function getAuthRecoveryStateKey() {
      return STORAGE_AUTH_RECOVERY_PREFIX + getContextKey();
    }

    function clearOAuthToken() {
      try {
        sessionStorage.removeItem("gc_access_token");
        sessionStorage.removeItem("gc_token_expires_at");
      } catch (_) {}
    }

    function isAuthOrConversationAccessError(error) {
      const text = safeString(error && (error.message || error)).toLowerCase();
      return (
        text.includes("http 401") ||
        text.includes("http 403") ||
        text.includes("unauthorized") ||
        text.includes("forbidden") ||
        text.includes("access to conversation") ||
        text.includes("not.authorized")
      );
    }

    async function recoverAuthAndReload(reason) {
      if (!CONFIG.clientId) return false;

      const key = getAuthRecoveryStateKey();
      const alreadyAttempted = sessionStorage.getItem(key) === "YES";
      if (alreadyAttempted) {
        addDebug("AUTH_RECOVERY_SKIP", "Already attempted OAuth recovery for this conversation. reason=" + safeString(reason));
        return false;
      }

      sessionStorage.setItem(key, "YES");
      clearOAuthToken();
      setStatus("Genesys login/MFA is required before validating hold count. Redirecting to login...", "info");
      showPersistentAlert("Genesys login/MFA is required. The page will reload automatically after authentication.", "warning");
      addDebug("AUTH_RECOVERY_START", safeString(reason));
      await startPKCELogin();
      return true;
    }

    function loadAttemptState() {
      try {
        const raw = localStorage.getItem(getAttemptStateKey());
        if (!raw) return { startedCount: 0 };
        const parsed = JSON.parse(raw);
        return { startedCount: parseCount(parsed && parsed.startedCount) };
      } catch (_) {
        return { startedCount: 0 };
      }
    }

    function saveAttemptState(state) {
      try {
        localStorage.setItem(getAttemptStateKey(), JSON.stringify({
          startedCount: parseCount(state && state.startedCount),
          savedAt: Date.now()
        }));
      } catch (_) {}
    }

    function getAttemptStartedCount() {
      return parseCount(loadAttemptState().startedCount);
    }

    function getEffectiveHoldCount() {
      return Math.max(getCurrentSessionCount(), getAttemptStartedCount());
    }

    function markHoldAttemptStarted() {
      const current = getCurrentSessionCount();
      const state = loadAttemptState();
      state.startedCount = Math.max(parseCount(state.startedCount), current) + 1;
      saveAttemptState(state);
      addDebug("LOCAL_ATTEMPT_COUNT", "startedCount=" + state.startedCount + " | apiCurrentCount=" + current);
      return state.startedCount;
    }

    function syncAttemptStateFromSummary(data) {
      const completedCount = parseCount(data && data.currentHoldCount);
      const state = loadAttemptState();
      if (completedCount > parseCount(state.startedCount)) {
        state.startedCount = completedCount;
        saveAttemptState(state);
      }
      data.currentHoldCount = Math.max(completedCount, parseCount(state.startedCount));
      return data;
    }

    function hhmmss(totalSeconds) {
      const safe = Math.max(0, Math.floor(Number(totalSeconds || 0)));
      const h = String(Math.floor(safe / 3600)).padStart(2, "0");
      const m = String(Math.floor((safe % 3600) / 60)).padStart(2, "0");
      const s = String(safe % 60).padStart(2, "0");
      return h + ":" + m + ":" + s;
    }

    function mmss(totalSeconds) {
      const safe = Math.max(0, Math.floor(Number(totalSeconds || 0)));
      const m = String(Math.floor(safe / 60)).padStart(2, "0");
      const s = String(safe % 60).padStart(2, "0");
      return m + ":" + s;
    }

    function parseCount(value) {
      const num = Number(safeString(value));
      if (!Number.isFinite(num)) return 0;
      return Math.max(0, Math.floor(num));
    }

    function getCurrentSessionCount() {
      return parseCount(document.getElementById("currentHoldCount").textContent);
    }

    function setText(id, value) {
      const el = document.getElementById(id);
      if (el) el.textContent = safeString(value);
    }

    function applySummary(summary) {
      const data = syncAttemptStateFromSummary(normalizeSummary(summary || {}));
      latestSummary = data;
      try { localStorage.setItem(getSummaryStateKey(), JSON.stringify(data)); } catch (_) {}

      setText("currentHoldCount", data.currentHoldCount);
      setText("maxHoldAttempts", CONFIG.maxHoldAttempts);
      setText("maxHoldAttemptsSub", CONFIG.maxHoldAttempts);
      resetTimerIndicator("Timer not active");
      setText("currentHoldTime", data.currentHoldTime);
      setText("currentSegments", data.currentSegments || "Current session");
      setText("totalHoldCount", data.totalHoldCount);
      setText("totalHoldTime", data.totalHoldTime);
      setText("averageHoldTime", data.averageHoldTime);
      setText("longestHoldTime", data.longestHoldTime);
      setText("holdHistory", data.holdHistory || "");

      updateLimitVisualState();
      updateButtonState();
    }

    function normalizeSummary(raw) {
      return {
        currentHoldCount: parseCount(raw.CurrentSession_Hold_TotalCount || raw.currentHoldCount || raw.CurrentSession_Hold_Count || 0),
        currentHoldTime: safeString(raw.CurrentSession_Hold_TotalHHMMSS || raw.currentHoldTime || "00:00:00") || "00:00:00",
        currentSegments: safeString(raw.CurrentSession_Hold_Total_Hours_Segment_List || raw.currentHoldSegments || raw.currentSegments || ""),
        totalHoldCount: parseCount(raw.Hold_TotalCount || raw.totalHoldCount || 0),
        totalHoldTime: safeString(raw.Hold_TotalHHMMSS || raw.totalHoldTime || "00:00:00") || "00:00:00",
        averageHoldTime: safeString(raw.averageHoldTime || raw.AverageHoldTime || "00:00:00") || "00:00:00",
        longestHoldTime: safeString(raw.longestHoldTime || raw.LongestHoldTime || "00:00:00") || "00:00:00",
        holdHistory: safeString(raw.Hold_Total_Hours_Segment_List || raw.holdHistory || "")
      };
    }

    function buildInitialSummaryFromParams() {
      return normalizeSummary({
        currentHoldCount: getParam("currentHoldCount", "0"),
        currentHoldTime: getParam("currentHoldTime", "00:00:00"),
        currentSegments: getParam("currentHoldSegments", getParam("currentSegments", "")),
        totalHoldCount: getParam("totalHoldCount", "0"),
        totalHoldTime: getParam("totalHoldTime", "00:00:00"),
        averageHoldTime: getParam("averageHoldTime", "00:00:00"),
        longestHoldTime: getParam("longestHoldTime", "00:00:00"),
        holdHistory: getParam("holdHistory", "")
      });
    }

    function loadCachedSummary() {
      try {
        const raw = localStorage.getItem(getSummaryStateKey());
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (_) {
        return null;
      }
    }

    function updateButtonState() {
      const btn = document.getElementById("holdResumeBtn");
      if (!btn) return;

      btn.disabled = isProcessing || isInitialSummaryLoading;
      btn.className = "hold-action-btn" + (isOnHold ? " resume" : "");
      btn.textContent = isOnHold ? "Resume" : "Hold";

      if (isInitialSummaryLoading) {
        btn.disabled = true;
        btn.title = "Checking existing hold count. Please wait.";
      } else if (!isOnHold && getEffectiveHoldCount() >= CONFIG.maxHoldAttempts) {
        btn.disabled = true;
        btn.title = "Maximum hold attempts reached.";
      } else {
        btn.title = "";
      }

      refreshPersistentAlert();
    }

    function persistButtonState() {
      try {
        localStorage.setItem(getButtonStateKey(), JSON.stringify({ isOnHold, savedAt: Date.now() }));
      } catch (_) {}
    }

    function restoreButtonState() {
      try {
        const raw = localStorage.getItem(getButtonStateKey());
        if (!raw) return;
        const state = JSON.parse(raw);
        isOnHold = state && state.isOnHold === true;
      } catch (_) {}
    }

    /************************************************************
     * OAuth PKCE
     ************************************************************/
    function getAccessToken() {
      const token = sessionStorage.getItem("gc_access_token");
      const expiresAt = Number(sessionStorage.getItem("gc_token_expires_at") || 0);
      if (!token) return "";
      if (!expiresAt || Date.now() > expiresAt - 60000) {
        sessionStorage.removeItem("gc_access_token");
        sessionStorage.removeItem("gc_token_expires_at");
        return "";
      }
      return token;
    }

    function base64UrlEncode(arrayBuffer) {
      let str = "";
      const bytes = new Uint8Array(arrayBuffer);
      for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
      return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    }

    function generateCodeVerifier() {
      const array = new Uint8Array(64);
      window.crypto.getRandomValues(array);
      return base64UrlEncode(array);
    }

    async function generateCodeChallenge(codeVerifier) {
      const data = new TextEncoder().encode(codeVerifier);
      const digest = await window.crypto.subtle.digest("SHA-256", data);
      return base64UrlEncode(new Uint8Array(digest));
    }

    async function startPKCELogin() {
      if (!CONFIG.clientId) throw new Error("clientId is required for Genesys OAuth login.");
      const verifier = generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);
      sessionStorage.setItem("pkce_code_verifier", verifier);
      sessionStorage.setItem(STORAGE_ORIGINAL_URL, window.location.href);
      const url = LOGIN_BASE + "/oauth/authorize" +
        "?response_type=code" +
        "&client_id=" + encodeURIComponent(CONFIG.clientId) +
        "&redirect_uri=" + encodeURIComponent(REDIRECT_URI) +
        "&code_challenge=" + encodeURIComponent(challenge) +
        "&code_challenge_method=S256";
      window.location.href = url;
    }

    async function handleOAuthCallback(code) {
      const verifier = sessionStorage.getItem("pkce_code_verifier");
      if (!verifier) throw new Error("Missing PKCE verifier. Please reload the page and login again.");
      const body = new URLSearchParams();
      body.append("grant_type", "authorization_code");
      body.append("client_id", CONFIG.clientId);
      body.append("code", code);
      body.append("redirect_uri", REDIRECT_URI);
      body.append("code_verifier", verifier);

      const response = await fetch(LOGIN_BASE + "/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      const text = await response.text();
      const result = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error("Token request failed: " + text);
      sessionStorage.setItem("gc_access_token", result.access_token);
      sessionStorage.setItem("gc_token_expires_at", String(Date.now() + ((result.expires_in || 3600) * 1000)));
    }

    /************************************************************
     * Genesys message send
     ************************************************************/
    async function resolveCommunicationId(token) {
      if (CONFIG.communicationId) return CONFIG.communicationId;
      const endpoint = API_BASE + "/api/v2/conversations/messages/" + encodeURIComponent(CONFIG.conversationId);
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }
      });
      const text = await response.text();
      if (!response.ok) throw new Error("Communication lookup failed. HTTP " + response.status + " - " + text);
      const conversation = text ? JSON.parse(text) : {};
      const communicationId = extractBestCommunicationId(conversation);
      if (!communicationId) throw new Error("communicationId could not be resolved from conversation.");
      CONFIG.communicationId = communicationId;
      return communicationId;
    }

    function extractBestCommunicationId(conversation) {
      if (!conversation || !Array.isArray(conversation.participants)) return "";
      const preferredPurposes = ["customer", "external", "agent"];
      for (const purpose of preferredPurposes) {
        for (const participant of conversation.participants) {
          if (safeString(participant.purpose).toLowerCase() !== purpose) continue;
          const id = extractCommunicationIdFromParticipant(participant);
          if (id) return id;
        }
      }
      for (const participant of conversation.participants) {
        const id = extractCommunicationIdFromParticipant(participant);
        if (id) return id;
      }
      return "";
    }

    function extractCommunicationIdFromParticipant(participant) {
      const arrays = [participant.messages, participant.message, participant.communications, participant.chats];
      for (const arr of arrays) {
        if (!Array.isArray(arr)) continue;
        const connected = arr.find(x => x && x.id && ["connected", "alerting", "dialing"].includes(safeString(x.state).toLowerCase()));
        if (connected && connected.id) return connected.id;
        const firstWithId = arr.find(x => x && x.id);
        if (firstWithId && firstWithId.id) return firstWithId.id;
      }
      return "";
    }

    function buildRequestId(action) {
      return sanitizeKey((CONFIG.conversationId || "NO_CONV") + "-" + action + "-" + (CONFIG.agentCommunicationId || CONFIG.communicationId || "NO_COMM") + "-" + Date.now());
    }

    async function sendMessageToConversation(action, messageText) {
      let token = getAccessToken();
      if (!token) {
        await startPKCELogin();
        return { redirected: true };
      }

      if (!CONFIG.conversationId) throw new Error("conversationId is required.");
      if (!messageText) throw new Error(action + " message text is required.");

      const communicationId = await resolveCommunicationId(token);
      const requestId = buildRequestId(action);
      const endpoint = API_BASE + "/api/v2/conversations/messages/" + encodeURIComponent(CONFIG.conversationId) +
        "/communications/" + encodeURIComponent(communicationId) + "/messages";

      addDebug("SEND_REQUEST", action + " | " + endpoint.replace(API_BASE, "") + " | requestId=" + requestId);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ textBody: messageText })
      });
      const text = await response.text();
      if (!response.ok) {
        if (response.status === 401) {
          sessionStorage.removeItem("gc_access_token");
          sessionStorage.removeItem("gc_token_expires_at");
        }
        throw new Error("Send " + action + " failed. HTTP " + response.status + " - " + text);
      }

      addDebug("SEND_OK", action + " | requestId=" + requestId);
      return { ok: true, requestId, responseText: text };
    }

    /************************************************************
     * Hold details refresh
     * Priority:
     * 1) If holdDetailsApiUrl is configured, call that API.
     * 2) If not configured, calculate directly from Genesys conversation messages using the current OAuth token.
     ************************************************************/
    async function refreshHoldSummary(showStatus) {
      if (CONFIG.holdDetailsApiUrl) {
        await refreshHoldSummaryFromApi(showStatus);
        return;
      }

      await refreshHoldSummaryFromGenesys(showStatus);
    }

    async function refreshHoldSummaryFromApi(showStatus) {
      const body = buildHoldDetailsRequestBody();

      addDebug("SUMMARY_API_REQUEST", JSON.stringify(body));

      const response = await fetch(CONFIG.holdDetailsApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
      if (!response.ok || data.status === "ERROR" || data.success === false) {
        throw new Error("Hold summary fetch failed. HTTP " + response.status + " - " + (data.message || text));
      }

      applySummary(data);
      addDebug("SUMMARY_API_OK", "Current=" + data.CurrentSession_Hold_TotalCount + " | Total=" + data.Hold_TotalCount);
      if (showStatus) {
        setStatus("Hold summary refreshed successfully.", "success");
        hideStatusSoon();
      }
    }

    function buildHoldDetailsRequestBody() {
      return {
        conversationId: CONFIG.conversationId,
        participantId: CONFIG.participantId,
        agentParticipantId: CONFIG.agentParticipantId,
        customerCommunicationId: CONFIG.customerCommunicationId || CONFIG.communicationId,
        agentCommunicationId: CONFIG.agentCommunicationId,
        communicationId: CONFIG.communicationId,
        currentAgentInteractionStartTime: CONFIG.currentAgentInteractionStartTime,
        isCustomerBasedHoldCalculation: CONFIG.isCustomerBasedHoldCalculation,
        setDebugAttribute: CONFIG.debug,
        source: CONFIG.source,
        version: HR_VERSION
      };
    }

    async function refreshHoldSummaryFromGenesys(showStatus) {
      const token = getAccessToken();

      if (!token) {
        const cached = loadCachedSummary();
        applySummary(cached || buildInitialSummaryFromParams());
        if (showStatus) {
          setStatus("OAuth token is missing. Click Hold or login first, then refresh again.", "warning");
        }
        addDebug("SUMMARY_DIRECT_SKIP", "OAuth token missing. Cached/query values used.");
        return;
      }

      if (!CONFIG.conversationId) {
        throw new Error("conversationId is required to refresh hold summary.");
      }

      addDebug("SUMMARY_DIRECT_START", "Fetching message conversation directly from Genesys. holdDetailsApiUrl is not configured.");

      const messageConversation = await getMessageConversationDirect(token, CONFIG.conversationId);

      const fullRefs = collectMessageRefsFromConversation(messageConversation, "FULL_INTERACTION");
      const currentRefs = collectMessageRefsFromConversation(messageConversation, "CURRENT_SESSION");

      addDebug("SUMMARY_REFS", "fullRefs=" + fullRefs.length + " | currentRefs=" + currentRefs.length);

      const fullItems = await readTranscriptItemsDirect(token, CONFIG.conversationId, fullRefs, "FULL");
      const currentItems = await readTranscriptItemsDirect(token, CONFIG.conversationId, currentRefs, "CURRENT_SESSION");

      const fullHold = calculateHoldDetailsFromTranscript(fullItems);
      const currentHold = calculateHoldDetailsFromTranscript(currentItems);

      const data = {
        CurrentSession_Hold_TotalCount: currentHold.Hold_TotalCount,
        CurrentSession_Hold_TotalHHMMSS: currentHold.Hold_TotalHHMMSS,
        CurrentSession_Hold_Total_Hours_Segment_List: currentHold.Hold_Total_Hours_Segment_List,
        Hold_TotalCount: fullHold.Hold_TotalCount,
        Hold_TotalHHMMSS: fullHold.Hold_TotalHHMMSS,
        Hold_Total_Hours_Segment_List: fullHold.Hold_Total_Hours_Segment_List,
        averageHoldTime: fullHold.averageHoldTime,
        longestHoldTime: fullHold.longestHoldTime
      };

      applySummary(data);
      addDebug(
        "SUMMARY_DIRECT_OK",
        "Current=" + data.CurrentSession_Hold_TotalCount +
        " | CurrentTime=" + data.CurrentSession_Hold_TotalHHMMSS +
        " | Total=" + data.Hold_TotalCount +
        " | TotalTime=" + data.Hold_TotalHHMMSS +
        " | Segments=" + (data.Hold_Total_Hours_Segment_List || "none")
      );

      try { sessionStorage.removeItem(getAuthRecoveryStateKey()); } catch (_) {}

      if (showStatus) {
        setStatus("Hold summary refreshed successfully from Genesys conversation messages.", "success");
        hideStatusSoon();
      }
    }

    async function getMessageConversationDirect(token, conversationId) {
      const endpoint = API_BASE + "/api/v2/conversations/messages/" + encodeURIComponent(conversationId);
      addDebug("SUMMARY_CONVERSATION_GET", endpoint.replace(API_BASE, ""));
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }
      });
      const text = await response.text();
      if (!response.ok) {
        if (response.status === 401) {
          sessionStorage.removeItem("gc_access_token");
          sessionStorage.removeItem("gc_token_expires_at");
        }
        throw new Error("Message conversation fetch failed. HTTP " + response.status + " - " + text);
      }
      try { return text ? JSON.parse(text) : {}; } catch (_) { return {}; }
    }

    function collectMessageRefsFromConversation(messageConversation, mode) {
      const participants = Array.isArray(messageConversation && messageConversation.participants)
        ? messageConversation.participants
        : [];
      const refs = [];
      const targetAgentParticipantId = safeString(CONFIG.agentParticipantId || CONFIG.participantId);
      const targetCustomerCommunicationId = safeString(CONFIG.customerCommunicationId || CONFIG.communicationId);

      participants.forEach(function (participant) {
        if (!participant || safeString(participant.purpose).toLowerCase() !== "agent") return;

        const participantId = safeString(participant.id);
        const peer = safeString(participant.peer);

        if (mode === "CURRENT_SESSION") {
          if (targetCustomerCommunicationId && peer !== targetCustomerCommunicationId) return;

          if (CONFIG.isCustomerBasedHoldCalculation === false) {
            if (!targetAgentParticipantId || participantId !== targetAgentParticipantId) return;
          }
        }

        const messages = Array.isArray(participant.messages) ? participant.messages : [];
        messages.forEach(function (message) {
          const messageId = safeString(message.messageId || message.id);
          if (!messageId || messageId === CONFIG.conversationId) return;
          refs.push({
            messageId: messageId,
            participantId: participantId,
            participantName: safeString(participant.name),
            participantPurpose: safeString(participant.purpose),
            participantPeer: peer,
            messageTime: safeString(message.messageTime),
            messageStatus: safeString(message.messageStatus)
          });
        });
      });

      return dedupeMessageRefs(refs);
    }

    function dedupeMessageRefs(refs) {
      const seen = new Set();
      const output = [];
      (refs || []).forEach(function (ref) {
        if (!ref || !ref.messageId || seen.has(ref.messageId)) return;
        seen.add(ref.messageId);
        output.push(ref);
      });
      return output;
    }

    async function readTranscriptItemsDirect(token, conversationId, refs, label) {
      const items = [];
      let failed = 0;

      for (const ref of refs || []) {
        try {
          const detail = await getConversationMessageDirect(token, conversationId, ref.messageId);
          const item = buildTranscriptItemFromMessage(detail, ref);
          if (item.messageText) items.push(item);
        } catch (err) {
          failed += 1;
          addDebug("SUMMARY_MESSAGE_READ_FAILED", label + " | messageId=" + ref.messageId + " | " + (err.message || String(err)));
        }
      }

      addDebug("SUMMARY_MESSAGE_READ", label + " | refs=" + (refs || []).length + " | items=" + items.length + " | failed=" + failed);
      return items;
    }

    async function getConversationMessageDirect(token, conversationId, messageId) {
      const endpoint = API_BASE + "/api/v2/conversations/messages/" + encodeURIComponent(conversationId) +
        "/messages/" + encodeURIComponent(messageId) + "?useNormalizedMessage=true";
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }
      });
      const text = await response.text();
      if (!response.ok) {
        if (response.status === 401) {
          sessionStorage.removeItem("gc_access_token");
          sessionStorage.removeItem("gc_token_expires_at");
        }
        throw new Error("Message detail fetch failed. HTTP " + response.status + " - " + text);
      }
      try { return text ? JSON.parse(text) : {}; } catch (_) { return {}; }
    }

    function buildTranscriptItemFromMessage(messageDetail, messageRef) {
      const messageText = extractBestMessageText(messageDetail);
      const timestamp =
        safeString(messageDetail && messageDetail.timestamp) ||
        safeString(messageDetail && messageDetail.normalizedMessage && messageDetail.normalizedMessage.channel && messageDetail.normalizedMessage.channel.time) ||
        safeString(messageRef && messageRef.messageTime) ||
        extractFirstValueByKeys(messageDetail, ["timestamp", "time", "createdDate", "createdDateTime", "messageTime"]);

      return {
        messageText: messageText,
        timestamp: timestamp,
        messageId: safeString(messageRef && messageRef.messageId),
        participantId: safeString(messageRef && messageRef.participantId),
        participantPeer: safeString(messageRef && messageRef.participantPeer)
      };
    }

    function extractBestMessageText(messageDetail) {
      return safeString(messageDetail && messageDetail.textBody) ||
        safeString(messageDetail && messageDetail.normalizedMessage && messageDetail.normalizedMessage.text) ||
        extractMessageTextFallback(messageDetail);
    }

    function extractMessageTextFallback(messageDetail) {
      const textParts = [];

      function walk(node, keyName) {
        if (node === null || node === undefined) return;
        if (typeof node === "string") {
          const lowerKey = safeString(keyName).toLowerCase();
          if (
            lowerKey.includes("text") ||
            lowerKey.includes("body") ||
            lowerKey.includes("message") ||
            lowerKey.includes("content")
          ) {
            const clean = safeString(node);
            if (clean) textParts.push(clean);
          }
          return;
        }
        if (Array.isArray(node)) {
          node.forEach(function (item) { walk(item, keyName); });
          return;
        }
        if (typeof node === "object") {
          Object.keys(node).forEach(function (key) { walk(node[key], key); });
        }
      }

      walk(messageDetail, "");
      return Array.from(new Set(textParts)).join(" | ");
    }

    function extractFirstValueByKeys(obj, keysToFind) {
      const lowerKeys = (keysToFind || []).map(function (key) { return safeString(key).toLowerCase(); });
      let found = "";

      function walk(node) {
        if (found || node === null || node === undefined) return;
        if (Array.isArray(node)) {
          node.forEach(function (item) { if (!found) walk(item); });
          return;
        }
        if (typeof node === "object") {
          Object.keys(node).forEach(function (key) {
            if (found) return;
            const val = node[key];
            if (lowerKeys.includes(key.toLowerCase())) {
              if (["string", "number", "boolean"].includes(typeof val)) {
                found = safeString(val);
                return;
              }
            }
            walk(val);
          });
        }
      }

      walk(obj);
      return found;
    }

    function calculateHoldDetailsFromTranscript(transcriptItems) {
      let openHoldStart = null;
      let totalHoldSeconds = 0;
      let totalHoldCount = 0;
      let longestHoldSeconds = 0;
      const segmentList = [];

      const holdTag = safeString(CONFIG.holdMessageText).toLowerCase();
      const resumeTag = safeString(CONFIG.resumeMessageText).toLowerCase();

      const sortedItems = (transcriptItems || []).slice().sort(function (a, b) {
        const da = parseFlexibleDate(a.timestamp);
        const db = parseFlexibleDate(b.timestamp);
        return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
      });

      sortedItems.forEach(function (item) {
        const msg = safeString(item.messageText).toLowerCase();
        const msgTime = parseFlexibleDate(item.timestamp);
        if (!msgTime) return;

        const isHold = holdTag && msg.includes(holdTag);
        const isResume = resumeTag && msg.includes(resumeTag);

        if (isHold) {
          openHoldStart = msgTime;
          return;
        }

        if (isResume) {
          if (!openHoldStart) return;
          const seconds = Math.max(0, Math.floor((msgTime.getTime() - openHoldStart.getTime()) / 1000));
          totalHoldCount += 1;
          totalHoldSeconds += seconds;
          if (seconds > longestHoldSeconds) longestHoldSeconds = seconds;
          segmentList.push(hhmmss(seconds));
          openHoldStart = null;
        }
      });

      const averageHoldSeconds = totalHoldCount > 0 ? Math.floor(totalHoldSeconds / totalHoldCount) : 0;

      return {
        Hold_TotalHHMMSS: hhmmss(totalHoldSeconds),
        Hold_TotalSeconds: totalHoldSeconds,
        Hold_TotalCount: totalHoldCount,
        Hold_Total_Hours_Segment_List: segmentList.join(", "),
        averageHoldTime: hhmmss(averageHoldSeconds),
        longestHoldTime: hhmmss(longestHoldSeconds)
      };
    }

    function parseFlexibleDate(value) {
      const text = safeString(value);
      if (!text) return null;
      let normalized = text.replace(/\s+at\s+/i, " ");
      normalized = normalized.replace(/GMT([+-])(\d{1,2})(?!:)/i, function (_, sign, hour) {
        return "GMT" + sign + String(hour).padStart(2, "0") + ":00";
      });
      let d = new Date(normalized);
      if (!Number.isNaN(d.getTime())) return d;
      d = new Date(text);
      if (!Number.isNaN(d.getTime())) return d;
      return null;
    }

    /************************************************************
     * Timer control
     ************************************************************/
    function startMaxHoldTimer() {
      if (!CONFIG.maxHoldTime) return;
      stopMaxHoldTimer(false);

      activeTimer = {
        startedAt: Date.now(),
        expiresAt: Date.now() + (CONFIG.maxHoldTime * 1000),
        totalSeconds: CONFIG.maxHoldTime,
        autoResumeSent: false
      };
      try { localStorage.setItem(getTimerStateKey(), JSON.stringify(activeTimer)); } catch (_) {}
      tickTimer();
      holdTimerInterval = setInterval(tickTimer, 1000);
    }

    function restoreMaxHoldTimer() {
      try {
        const raw = localStorage.getItem(getTimerStateKey());
        if (!raw) return;
        const timer = JSON.parse(raw);
        if (!timer || !timer.expiresAt || Date.now() >= Number(timer.expiresAt)) {
          localStorage.removeItem(getTimerStateKey());
          return;
        }
        activeTimer = timer;
        isOnHold = true;
        tickTimer();
        holdTimerInterval = setInterval(tickTimer, 1000);
      } catch (_) {}
    }

    function resetTimerIndicator(statusText) {
      const card = document.getElementById("timerIndicatorCard");
      const fill = document.getElementById("timerProgressFill");
      if (card) card.className = "metric-card timer-indicator-card";
      if (fill) fill.style.width = "0%";
      setText("timerRemainingValue", "00:00");
      setText("timerIndicatorStatus", statusText || "Timer not active");
      setText("timerElapsedText", "00:00");
      setText("timerMaxText", CONFIG.maxHoldTime ? mmss(CONFIG.maxHoldTime) : "00:00");
    }

    function stopMaxHoldTimer(clearStorage) {
      if (holdTimerInterval) {
        clearInterval(holdTimerInterval);
        holdTimerInterval = null;
      }
      activeTimer = null;
      document.getElementById("holdTimeCard").classList.remove("timer-active");
      setText("timerSubText", "Current session total");
      resetTimerIndicator("Timer not active");
      if (clearStorage !== false) {
        try { localStorage.removeItem(getTimerStateKey()); } catch (_) {}
      }
    }

    function tickTimer() {
      if (!activeTimer) return;
      const remaining = Math.max(0, Math.ceil((Number(activeTimer.expiresAt) - Date.now()) / 1000));
      const elapsed = Math.max(0, Number(activeTimer.totalSeconds || 0) - remaining);
      const totalSeconds = Math.max(1, Number(activeTimer.totalSeconds || 0));
      const usedPercent = Math.max(0, Math.min(100, (elapsed / totalSeconds) * 100));

      document.getElementById("holdTimeCard").classList.add("timer-active");
      setText("currentHoldTime", hhmmss(elapsed));
      setText("timerSubText", "Current active hold elapsed time");

      const card = document.getElementById("timerIndicatorCard");
      const fill = document.getElementById("timerProgressFill");
      if (card) {
        let timerClass = "metric-card timer-indicator-card active";
        if (remaining <= 15) timerClass += " danger";
        else if (remaining <= 60) timerClass += " warning";
        card.className = timerClass;
      }
      if (fill) fill.style.width = usedPercent + "%";

      setText("timerRemainingValue", mmss(remaining));
      setText("timerElapsedText", mmss(elapsed));
      setText("timerMaxText", mmss(totalSeconds));

      if (remaining <= 0) {
        setText("timerIndicatorStatus", "Time reached. Auto resume is sending...");
        if (holdTimerInterval) {
          clearInterval(holdTimerInterval);
          holdTimerInterval = null;
        }
        autoResumeOnTimeout();
        return;
      }

      if (remaining <= 15) {
        setText("timerIndicatorStatus", "Critical: auto resume soon");
      } else if (remaining <= 60) {
        setText("timerIndicatorStatus", "Warning: less than 1 minute");
      } else {
        setText("timerIndicatorStatus", "Hold active - auto resume at 00:00");
      }
    }

    async function autoResumeOnTimeout() {
      if (!isOnHold || (activeTimer && activeTimer.autoResumeSent)) return;
      if (activeTimer) activeTimer.autoResumeSent = true;
      showPersistentAlert(CONFIG.holdMaxTimeAlertText + " Auto resume is being sent...", "warning");
      setStatus(CONFIG.holdMaxTimeAlertText + " Auto resume is being sent...", "warning");
      addDebug("AUTO_RESUME_START", "maxHoldTime=" + CONFIG.maxHoldTime);

      try {
        await sendMessageToConversation("RESUME", CONFIG.resumeMessageText);
        isOnHold = false;
        persistButtonState();
        stopMaxHoldTimer(true);
        updateButtonState();
        await sleep(CONFIG.autoRefreshDelayMs);
        await refreshHoldSummary(false);

        // After auto-resume, if the resume completed the final allowed hold pair,
        // show the maximum-attempts alert as the final state instead of the duration warning.
        if (getEffectiveHoldCount() >= CONFIG.maxHoldAttempts) {
          const maxMessage = getMaxAttemptsAlertMessage();
          startAttentionAlert(maxMessage, "error", "⛔ Max Hold Reached");
          setStatus(CONFIG.holdMaxAttemptsAlertText, "error");
        } else {
          const durationMessage = CONFIG.holdMaxTimeAlertText + " " + CONFIG.autoResumeSentText;
          startAttentionAlert(durationMessage, "warning", "⚠️ Auto Resume Sent");
          setStatus(CONFIG.autoResumeSentText, "success");
        }
        hideStatusSoon();
      } catch (err) {
        setStatus("Auto resume failed: " + err.message, "error");
        addDebug("AUTO_RESUME_FAILED", err.message);
        updateButtonState();
      }
    }

    async function refreshHoldSummaryAfterAction(action) {
      const expectedCount = getAttemptStartedCount();
      const maxTries = action === "RESUME" ? 4 : 2;

      for (let attempt = 1; attempt <= maxTries; attempt++) {
        await sleep(attempt === 1 ? CONFIG.autoRefreshDelayMs : 1200);
        try {
          await refreshHoldSummary(false);
        } catch (err) {
          addDebug("SUMMARY_RETRY_FAILED", "attempt=" + attempt + " | " + (err.message || String(err)));
          if (attempt === maxTries) throw err;
        }

        const visibleCount = getCurrentSessionCount();
        addDebug("SUMMARY_RETRY_CHECK", "action=" + action + " | attempt=" + attempt + " | visibleCount=" + visibleCount + " | expectedCount=" + expectedCount);

        if (action !== "RESUME" || visibleCount >= expectedCount) {
          return;
        }
      }
    }

    /************************************************************
     * Button click loop
     ************************************************************/
    async function handleHoldResumeClick() {
      if (isProcessing) return;

      const action = isOnHold ? "RESUME" : "HOLD";
      const messageText = action === "HOLD" ? CONFIG.holdMessageText : CONFIG.resumeMessageText;

      if (action === "HOLD") {
        requestBrowserNotificationPermissionIfPossible("HOLD_CLICK");
      }

      if (action === "HOLD" && getEffectiveHoldCount() >= CONFIG.maxHoldAttempts) {
        const validationMessage = "⚠️  ⛔ " + CONFIG.holdMaxAttemptsAlertText + " (" + getEffectiveHoldCount() + " / " + CONFIG.maxHoldAttempts + ")";
        startAttentionAlert(validationMessage, "error", "⛔ Max Hold Reached");
        setStatus(validationMessage, "error");
        addDebug("VALIDATION_BLOCK", "Max hold attempts reached. effectiveCount=" + getEffectiveHoldCount() + " | max=" + CONFIG.maxHoldAttempts);
        updateButtonState();
        return;
      }

      isProcessing = true;
      updateButtonState();
      setStatus(action === "HOLD" ? "Sending Hold message..." : "Sending Resume message...", "info");

      try {
        const result = await sendMessageToConversation(action, messageText);
        if (result && result.redirected) return;

        if (action === "HOLD") {
          markHoldAttemptStarted();
          applySummary(latestSummary || buildInitialSummaryFromParams());
          isOnHold = true;
          persistButtonState();
          startMaxHoldTimer();
          setStatus("Hold message sent. Timer started.", "success");
        } else {
          isOnHold = false;
          persistButtonState();
          stopMaxHoldTimer(true);
          setStatus("Resume message sent. Timer stopped.", "success");
        }

        updateButtonState();
        await refreshHoldSummaryAfterAction(action);
        hideStatusSoon();
      } catch (err) {
        setStatus(err.message || String(err), "error");
        addDebug("CLICK_FAILED", err.message || String(err));
      } finally {
        isProcessing = false;
        updateButtonState();
      }
    }

    async function initPage() {
      document.getElementById("holdResumeBtn").addEventListener("click", handleHoldResumeClick);
      document.getElementById("refreshBtn").addEventListener("click", async function () {
        try {
          setStatus("Refreshing hold summary...", "info");
          await refreshHoldSummary(true);
        } catch (err) {
          setStatus(err.message || String(err), "error");
        }
      });
      document.getElementById("debugBtn").addEventListener("click", function () {
        const panel = document.getElementById("debugPanel");
        if (!panel) return;
        if (panel.style.display === "block") {
          panel.style.display = "none";
        } else {
          panel.style.display = "block";
          panel.textContent = getDebugParametersText();
        }
      });
      if (CONFIG.debug) {
        document.getElementById("debugBtn").style.display = "inline-block";
        renderDebugPanel();
      }

      setText("maxHoldAttempts", CONFIG.maxHoldAttempts);
      setText("maxHoldAttemptsSub", CONFIG.maxHoldAttempts);
      resetTimerIndicator("Timer not active");
      isInitialSummaryLoading = true;
      updateButtonState();

      const code = getParam("code", "");
      if (code) {
        setStatus("OAuth callback received. Completing login...", "info");
        await handleOAuthCallback(code);
        addDebug("OAUTH_CALLBACK_OK", "Token received after login/MFA. Reloading original HoldResume page.");
        const original = sessionStorage.getItem(STORAGE_ORIGINAL_URL) || (window.location.origin + window.location.pathname);
        window.location.replace(original.replace(/[?&]code=[^&]+/, ""));
        return;
      }

      restoreButtonState();
      if (getAccessToken()) await loadGcbConfigFromParticipantData(getAccessToken());
      restoreMaxHoldTimer();
      applySummary(loadCachedSummary() || buildInitialSummaryFromParams());

      if (!CONFIG.conversationId) {
        isInitialSummaryLoading = false;
        setStatus("conversationId is missing. Hold/Resume cannot be sent until the Agent Screen passes conversationId.", "error");
        updateButtonState();
        return;
      }

      if (!getAccessToken() && CONFIG.clientId) {
        isInitialSummaryLoading = false;
        setStatus("Ready. Click Hold to login and send the first hold message.", "info");
      } else if (!CONFIG.clientId) {
        isInitialSummaryLoading = false;
        setStatus("clientId is missing. The page can show summary, but cannot send Hold/Resume without OAuth clientId.", "warning");
      } else {
        try {
          setStatus("Checking existing hold count before enabling Hold...", "info");
          addDebug("INITIAL_GUARD_START", "Hold button disabled until latest summary is loaded.");
          await refreshHoldSummary(false);
          isInitialSummaryLoading = false;
          setStatus("Ready.", "success");
          hideStatusSoon();
          addDebug("INITIAL_GUARD_OK", "Hold button enabled/blocked based on latest count. effectiveCount=" + getEffectiveHoldCount());
        } catch (err) {
          const errText = err.message || String(err);
          addDebug("INITIAL_GUARD_FAILED", errText);

          if (isAuthOrConversationAccessError(err)) {
            const recoveryStarted = await recoverAuthAndReload("Initial hold summary validation failed: " + errText);
            if (recoveryStarted) return;
          }

          isInitialSummaryLoading = true;
          setStatus("Hold is disabled because existing hold count could not be validated: " + errText, "error");
          showPersistentAlert("Unable to validate existing hold count. Hold is disabled to avoid exceeding the maximum limit.", "error");
        }
      }

      updateButtonState();
      addDebug("INIT", "version=" + HR_VERSION + " | conversationId=" + CONFIG.conversationId + " | region=" + CONFIG.region + " | maxHoldAttempts=" + CONFIG.maxHoldAttempts + " | maxHoldTime=" + CONFIG.maxHoldTime);
      renderDebugPanel();
    }

    window.addEventListener("load", function () {
      initPage().catch(function (err) {
        setStatus("Initialization failed: " + (err.message || String(err)), "error");
      });
    });
