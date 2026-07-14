/*
 * Author: Sivakumar Chandrahasu | Created: 2026-07-07 | Updated: 2026-07-07
 * Purpose: Prospects page business logic for Data Table loading, filtering, and submission.
 *          Builds selected contact reason/outcome values and updates Genesys participant data.
 */
const DEFAULT_OAUTH_CLIENT_ID = "cc8cd8bf-0e14-4b14-9e4f-4849bc23ed00";
      const DEFAULT_GENESYS_REGION = "mypurecloud.ie";
      const DEFAULT_APP_VERSION = "RakProspects_v3.12";
      const STORAGE_CLIENT_ID = "rakbank_clientId";
      const STORAGE_REGION = "rakbank_region";
      const STORAGE_PROSPECTS_ORIGINAL_QUERY = "rakbank_prospects_original_query";
      const REDIRECT_URI = window.location.origin + window.location.pathname;

      const params = new URLSearchParams(window.location.search);
      const APP_VERSION = getParam("version") || getParam("prospectsVersion") || DEFAULT_APP_VERSION;
      const DEBUG_PANEL_ENABLED = getBooleanParam("debugPanel", false) || getBooleanParam("showDebug", false) || getBooleanParam("debug", false);
      const AUTO_REFRESH_TOKEN_ENABLED = getBooleanParam("autoRefreshToken", true) || getBooleanParam("autoLogin", false);
      const STORAGE_PROSPECTS_AUTO_REFRESH_BLOCKED = "rakbank_prospects_auto_refresh_blocked";
      const STORAGE_PROSPECTS_LOAD_RECOVERY_ATTEMPTED = "rakbank_prospects_load_recovery_attempted";
      const context = {
        conversationId: getParam("conversationId"),
        communicationId: getParam("communicationId"),
        participantId: getParam("participantId"),
      };

      const OAUTH_CLIENT_ID = getParam("clientId") || sessionStorage.getItem(STORAGE_CLIENT_ID) || DEFAULT_OAUTH_CLIENT_ID;
      const GENESYS_REGION = getParam("region") || getParam("gcTargetEnv") || sessionStorage.getItem(STORAGE_REGION) || DEFAULT_GENESYS_REGION;
      const LOGIN_BASE = `https://login.${GENESYS_REGION}`;
      const API_BASE = `https://api.${GENESYS_REGION}`;
      const SEARCH_DEBUG_ATTRIBUTE_NAME = "AFT_GCB_Logs_Prospects";
      const ASSIGN_DEBUG_ATTRIBUTE_NAME = "AFT_GCB_Logs_Prospects";
      const DEBUG_ATTRIBUTE_MAX_LENGTH = 20000;
      const draftKey = `RAK_PROSPECTS_DRAFT_${context.conversationId}_${context.communicationId}`;
      const submitKey = `RAK_PROSPECTS_SUBMITTED_${context.conversationId}_${context.communicationId}`;

      const actionConfig = {
        all: getParam("prospectsDataActionId"),
        type: getParam("typeActionId") || getParam("typeOfInteractionActionId"),
        contact: getParam("contactReasonActionId"),
        outcome: getParam("interactionOutcomeActionId") || getParam("outcomeActionId"),
      };

      const dataTableConfig = {
        types: getParam("typeDataTableId") || "bc945049-40ea-4714-bd3f-4e552659a0e8",
        prospects: getParam("prospectsDataTableId") || "85f5ecc1-0f16-423c-b91b-cea46bac40d7",
      };

      const wrapupConfig = {
        createIfMissing: getBooleanParam("createWrapupIfMissing", true),
        nameSeparator: getParam("wrapupNameSeparator") || " ⟹ ",
        pageSize: Number(getParam("wrapupPageSize") || 200),
      };

      let CONTACT_REASON_SEPARATOR = getParam("contactReasonSeparator") || " ⇢ ";
      let INTERACTION_OUTCOME_SEPARATOR = getParam("interactionOutcomeSeparator") || CONTACT_REASON_SEPARATOR;
      let INTERACTION_OUTCOME_MULTI_SELECT = getBooleanParam("interactionOutcomeMultiSelect", false) || getBooleanParam("allowMultipleInteractionOutcome", false) || getBooleanParam("multiSelectOutcome", false);

      const dataTableColumnConfig = {
        typeOfInteraction: buildColumnAliases(
          getParam("typeColumnName"),
          ["Interaction Type", "Interaction_Type", "TypeOfInteraction", "typeOfInteraction", "InteractionType", "interactionType", "Type", "type", "Name", "name", "label", "value"]
        ),
        contactReason: buildColumnAliases(
          getParam("contactReasonColumnName"),
          ["Contact Reason", "ContactReason", "contactReason", "Contact_Reason", "Reason", "reason", "contact_reason", "Name", "name"]
        ),
        interactionOutcome: buildColumnAliases(
          getParam("interactionOutcomeColumnName") || getParam("outcomeColumnName"),
          ["Interaction Outcome", "InteractionOutcome", "interactionOutcome", "Interaction_Outcome", "Outcome", "outcome", "Result", "result", "interaction_outcome", "Name", "name"]
        ),
        active: buildColumnAliases(
          getParam("activeColumnName"),
          ["Active", "active", "IsActive", "isActive", "Status", "status"]
        ),
      };

      const state = {
        types: [],
        contactReasons: [],
        outcomes: [],
        prospectRows: [],
        debugInfo: {
          typeRows: 0,
          mappingRows: 0,
          activeMappingRows: 0,
          typeOptions: 0,
          contactOptions: 0,
          outcomeOptions: 0,
          typeColumns: "",
          mappingColumns: "",
          wrapupCodeName: "",
          wrapupCodeId: "",
          wrapupCreated: "",
          searchLog: "",
          submitLog: "",
        },
      };

      const typeSelect = document.getElementById("interactionType");
      const contactPanel = document.getElementById("contactPanel");
      const outcomePanel = document.getElementById("outcomePanel");
      const contactSearch = contactPanel.querySelector(".search-input");
      const resetContactReasonButton = document.getElementById("resetContactReasonButton");
      const outcomeSearch = outcomePanel.querySelector(".search-input");
      const remarks = document.getElementById("remarks");
      const validationMessage = document.getElementById("validationMessage");
      const runtimeStatus = document.getElementById("runtimeStatus");
      const runtimeStatusRow = document.getElementById("runtimeStatusRow");
      const debugParams = document.getElementById("debugParams");
      const debugBox = document.getElementById("debugBox");
      const authRow = document.getElementById("authRow");
      const loginButton = document.getElementById("loginButton");
      const submitButton = document.querySelector(".submit-button");

      init();

      function buildColumnAliases(primaryColumnName, fallbackColumnNames) {
        const aliases = [];
        const addAlias = (value) => {
          String(value || "")
            .split(/[|,]/)
            .map((item) => item.trim())
            .filter(Boolean)
            .forEach((item) => {
              if (!aliases.some((existing) => normalizeFieldName(existing) === normalizeFieldName(item))) {
                aliases.push(item);
              }
            });
        };
        addAlias(primaryColumnName);
        addAlias((fallbackColumnNames || []).join("|"));
        return aliases;
      }


      function attrText(attrs, name, fallback) {
        const value = attrs && Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : undefined;
        const text = String(value ?? "").trim();
        return text ? text : (fallback || "");
      }
      function attrBool(attrs, name, fallback) {
        const text = attrText(attrs, name, "").toLowerCase();
        if (["true", "yes", "1", "y"].includes(text)) return true;
        if (["false", "no", "0", "n"].includes(text)) return false;
        return fallback;
      }
      function mergeParticipantAttributesFromConversation(conversation) {
        const output = {};
        const participants = Array.isArray(conversation && conversation.participants) ? conversation.participants : [];
        participants.forEach((p) => { if (p && p.attributes) Object.assign(output, p.attributes); });
        participants.forEach((p) => {
          const pid = String((p && p.id) || "").trim();
          if (pid && pid === context.participantId && p.attributes) Object.assign(output, p.attributes);
        });
        return output;
      }
      async function getMessageConversation(token) {
        const response = await fetch(`${API_BASE}/api/v2/conversations/messages/${encodeURIComponent(context.conversationId)}`, {
          method: "GET",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        });
        const text = await response.text();
        const payload = parseJson(text);
        if (!response.ok) throw new Error(payload.message || payload.error || `Conversation fetch failed: ${response.status}`);
        return payload;
      }
      async function applyGcbConfigFromParticipantData(token) {
        if (!token || !context.conversationId) return;
        try {
          const conversation = await getMessageConversation(token);
          const attrs = mergeParticipantAttributesFromConversation(conversation);
          dataTableConfig.types = attrText(attrs, "AFT_GCB_ProspectsTypeDataTableId", dataTableConfig.types);
          dataTableConfig.prospects = attrText(attrs, "AFT_GCB_ProspectsMappingDataTableId", dataTableConfig.prospects);
          wrapupConfig.createIfMissing = attrBool(attrs, "AFT_GCB_CreateWrapupIfMissing", wrapupConfig.createIfMissing);
          wrapupConfig.nameSeparator = attrText(attrs, "AFT_GCB_WrapupNameSeparator", wrapupConfig.nameSeparator);
          CONTACT_REASON_SEPARATOR = attrText(attrs, "AFT_GCB_ContactReasonSeparator", CONTACT_REASON_SEPARATOR);
          INTERACTION_OUTCOME_SEPARATOR = attrText(attrs, "AFT_GCB_InteractionOutcomeSeparator", INTERACTION_OUTCOME_SEPARATOR || CONTACT_REASON_SEPARATOR);
          if (!INTERACTION_OUTCOME_SEPARATOR) INTERACTION_OUTCOME_SEPARATOR = CONTACT_REASON_SEPARATOR;
          INTERACTION_OUTCOME_MULTI_SELECT = attrBool(attrs, "AFT_GCB_InteractionOutcomeMultiSelect", INTERACTION_OUTCOME_MULTI_SELECT);
          state.debugInfo.gcbConfigSource = "participantData";
        } catch (error) {
          state.debugInfo.gcbConfigSource = "default/url";
          state.debugInfo.gcbConfigWarning = getErrorMessage(error);
        }
      }

      async function init() {
        if (getParam("clientId")) sessionStorage.setItem(STORAGE_CLIENT_ID, getParam("clientId"));
        if (getParam("region") || getParam("gcTargetEnv")) sessionStorage.setItem(STORAGE_REGION, getParam("region") || getParam("gcTargetEnv"));
        applyPageRuntimeSettings();
        renderDebugParameters();

        const code = params.get("code");
        if (code) {
          try {
            setRuntimeStatus("Completing Genesys login...");
            await handleOAuthCallback(code);
            sessionStorage.removeItem(STORAGE_PROSPECTS_AUTO_REFRESH_BLOCKED);
            const originalQuery = sessionStorage.getItem(STORAGE_PROSPECTS_ORIGINAL_QUERY) || "";
            sessionStorage.removeItem(STORAGE_PROSPECTS_ORIGINAL_QUERY);
            window.location.replace(REDIRECT_URI + (originalQuery || ""));
            return;
          } catch (error) {
            sessionStorage.setItem(STORAGE_PROSPECTS_AUTO_REFRESH_BLOCKED, "true");
            setRuntimeStatus("Login failed: " + getErrorMessage(error), true);
          }
        }

        loginButton.addEventListener("click", loginOrRefreshOAuthToken);
        typeSelect.addEventListener("change", onTypeChange);
        contactSearch.addEventListener("input", applyContactReasonSearch);
        resetContactReasonButton.addEventListener("click", resetContactReasonSelections);
        outcomeSearch.addEventListener("input", applyInteractionOutcomeSearch);
        remarks.addEventListener("input", saveDraft);
        submitButton.addEventListener("click", submitProspects);

        restoreDraft();
        updateSubmitState();

        const token = getAccessToken();
        authRow.hidden = true;
        if (!token) {
          if (AUTO_REFRESH_TOKEN_ENABLED && sessionStorage.getItem(STORAGE_PROSPECTS_AUTO_REFRESH_BLOCKED) !== "true") {
            authRow.hidden = true;
            setRuntimeStatus("OAuth token missing. Auto refreshing token...");
            await autoRefreshOAuthToken();
            return;
          }
          authRow.hidden = true;
          setRuntimeStatus("OAuth token missing. Token refresh is required.");
          clearDynamicLists();
          return;
        }

        await applyGcbConfigFromParticipantData(token);
        await loadLiveData(token);
      }

      function applyPageRuntimeSettings() {
        document.title = `${APP_VERSION} - RAKBANK Prospects`;
        document.body.setAttribute("data-prospects-version", APP_VERSION);
        if (debugBox) debugBox.hidden = !DEBUG_PANEL_ENABLED;
        if (runtimeStatusRow) runtimeStatusRow.hidden = !DEBUG_PANEL_ENABLED;
      }

      function getParam(name) {
        return cleanRuntimeValue(params.get(name) || "");
      }

      function getBooleanParam(name, defaultValue) {
        const value = getParam(name);
        if (!value) return defaultValue;
        return ["true", "1", "yes", "y"].includes(value.toLowerCase());
      }

      function cleanRuntimeValue(value) {
        const text = String(value || "").trim();
        if (!text || text === "{{" + text.slice(2)) return "";
        if (/^\{\{.*\}\}$/.test(text)) return "";
        return text;
      }

      function setRuntimeStatus(message, isError = false) {
        runtimeStatus.textContent = message || "";
        runtimeStatus.style.color = isError ? "#d71920" : "#006d8f";
        if (runtimeStatusRow) runtimeStatusRow.hidden = !(DEBUG_PANEL_ENABLED || isError);
      }

      function renderDebugParameters() {
        debugParams.textContent = [
          `version: ${APP_VERSION || "[missing]"}`,
          `debugPanel: ${String(DEBUG_PANEL_ENABLED)}`,
          `autoRefreshToken: ${String(AUTO_REFRESH_TOKEN_ENABLED)}`,
          `interactionOutcomeMultiSelect: ${String(INTERACTION_OUTCOME_MULTI_SELECT)}`,
          `loadRecoveryAttempted: ${sessionStorage.getItem(STORAGE_PROSPECTS_LOAD_RECOVERY_ATTEMPTED) || "false"}`,
          `conversationId: ${context.conversationId || "[missing]"}`,
          `communicationId: ${context.communicationId || "[missing]"}`,
          `participantId: ${context.participantId || "[missing]"}`,
          `region: ${GENESYS_REGION || "[missing]"}`,
          `clientId: ${OAUTH_CLIENT_ID || "[missing]"}`,
          `typeDataTableId: ${dataTableConfig.types || "[missing]"}`,
          `prospectsDataTableId: ${dataTableConfig.prospects || "[missing]"}`,
          `type column aliases: ${dataTableColumnConfig.typeOfInteraction.join(" | ")}`,
          `contact column aliases: ${dataTableColumnConfig.contactReason.join(" | ")}`,
          `outcome column aliases: ${dataTableColumnConfig.interactionOutcome.join(" | ")}`,
          "",
          `typeRows loaded: ${state.debugInfo.typeRows}`,
          `mappingRows loaded: ${state.debugInfo.mappingRows}`,
          `activeMappingRows: ${state.debugInfo.activeMappingRows}`,
          `typeOptions rendered: ${state.debugInfo.typeOptions}`,
          `contactOptions rendered: ${state.debugInfo.contactOptions}`,
          `outcomeOptions rendered: ${state.debugInfo.outcomeOptions}`,
          `type sample columns: ${state.debugInfo.typeColumns || "[none]"}`,
          `mapping sample columns: ${state.debugInfo.mappingColumns || "[none]"}`,
          `searchLog: ${state.debugInfo.searchLog || "[none]"}`,
          "",
          `wrapupCodeName: ${state.debugInfo.wrapupCodeName || "[none]"}`,
          `wrapupCodeId: ${state.debugInfo.wrapupCodeId || "[none]"}`,
          `wrapupCreated: ${state.debugInfo.wrapupCreated || "[none]"}`,
          `submitLog: ${state.debugInfo.submitLog || "[none]"}`,
        ].join("\n");
      }

      function clearDynamicLists() {
        typeSelect.innerHTML = '<option value="">---Select---</option>';
        renderOptions("contactReason", []);
        renderOptions("outcome", []);
      }

      async function loadLiveData(token) {
        try {
          setRuntimeStatus("Loading Prospects values...");

          if (actionConfig.all) {
            const result = await executeDataAction(token, actionConfig.all, buildActionInput());
            state.types = normalizeOptions(result.typeOfInteraction || result.types || result.interactionTypes || result);
            state.contactReasons = normalizeOptions(result.contactReason || result.contactReasons || result.reasons || result);
            state.outcomes = normalizeOptions(result.interactionOutcome || result.outcomes || result.results || result);
            state.prospectRows = [];
          } else if (actionConfig.type || actionConfig.contact || actionConfig.outcome) {
            const [typesResult, contactResult, outcomeResult] = await Promise.all([
              actionConfig.type ? executeDataAction(token, actionConfig.type, buildActionInput()) : Promise.resolve([]),
              actionConfig.contact ? executeDataAction(token, actionConfig.contact, buildActionInput()) : Promise.resolve([]),
              actionConfig.outcome ? executeDataAction(token, actionConfig.outcome, buildActionInput()) : Promise.resolve([]),
            ]);
            state.types = normalizeOptions(typesResult);
            state.contactReasons = normalizeOptions(contactResult);
            state.outcomes = normalizeOptions(outcomeResult);
            state.prospectRows = [];
          } else {
            const [typeRows, prospectRows] = await Promise.all([
              fetchDataTableRows(token, dataTableConfig.types),
              fetchDataTableRows(token, dataTableConfig.prospects),
            ]);

            state.debugInfo.typeRows = typeRows.length;
            state.debugInfo.mappingRows = prospectRows.length;
            state.debugInfo.typeColumns = getSampleColumns(typeRows[0]);
            state.debugInfo.mappingColumns = getSampleColumns(prospectRows[0]);
            state.prospectRows = prospectRows.map(normalizeTableRow).filter((row) => row.active);
            state.types = normalizeTypeRows(typeRows);
            if (!state.types.length) {
              state.types = uniqueSortedOptions(state.prospectRows.map((row) => ({
                label: row.typeOfInteraction,
                value: row.typeOfInteraction,
              })));
            }
            state.debugInfo.activeMappingRows = state.prospectRows.length;
            rebuildDependentOptionsFromRows();
          }

          renderTypeOptions();
          restoreDraft();
          if (state.prospectRows.length) rebuildDependentOptionsFromRows();
          refreshDependentLists();
          appendSearchLog("VALUES_LOADED");
          sessionStorage.removeItem(STORAGE_PROSPECTS_LOAD_RECOVERY_ATTEMPTED);
          await updateSearchDebugAttribute(token);
          renderDebugParameters();
          setRuntimeStatus("Prospects values loaded.");
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          appendSearchLog("LOAD_ERROR::" + errorMessage);

          if (shouldRecoverGenesysLogin(error) && AUTO_REFRESH_TOKEN_ENABLED && sessionStorage.getItem(STORAGE_PROSPECTS_LOAD_RECOVERY_ATTEMPTED) !== "true") {
            sessionStorage.setItem(STORAGE_PROSPECTS_LOAD_RECOVERY_ATTEMPTED, "true");
            sessionStorage.removeItem(STORAGE_PROSPECTS_AUTO_REFRESH_BLOCKED);
            clearDynamicLists();
            renderDebugParameters();
            setRuntimeStatus("Genesys authentication requires refresh. Redirecting to login/MFA...");
            await clearTokenAndStartPKCELogin();
            return;
          }

          clearDynamicLists();
          await updateSearchDebugAttribute(token);
          renderDebugParameters();
          setRuntimeStatus("Unable to load values: " + errorMessage, true);
        }
      }

      function createHttpError(message, status, payload) {
        const error = new Error(message || `HTTP error: ${status}`);
        error.status = Number(status || 0);
        error.payload = payload || null;
        return error;
      }

      function shouldRecoverGenesysLogin(error) {
        const status = Number(error && error.status ? error.status : 0);
        const message = getErrorMessage(error).toLowerCase();
        if ([401, 403].includes(status)) return true;
        if (status === 404 && (message.includes("not found") || message.includes("not_found") || message.includes("unable to find"))) return true;
        return (
          message.includes("unauthorized") ||
          message.includes("forbidden") ||
          message.includes("mfa") ||
          message.includes("authentication") ||
          message.includes("not authenticated") ||
          message.includes("invalid token") ||
          message.includes("expired token") ||
          message.includes("not found")
        );
      }

      async function fetchDataTableRows(token, dataTableId) {
        const rows = [];
        let pageNumber = 1;
        let pageCount = 1;

        do {
          const url = `${API_BASE}/api/v2/flows/datatables/${encodeURIComponent(dataTableId)}/rows?pageSize=500&pageNumber=${pageNumber}&showbrief=false`;
          const response = await fetch(url, {
            method: "GET",
            headers: { Authorization: "Bearer " + token },
          });
          const text = await response.text();
          const payload = parseJson(text);
          if (!response.ok) throw createHttpError(payload.message || payload.error || `Data Table read failed: ${response.status}`, response.status, payload);

          rows.push(...findFirstArray(payload));
          pageCount = Number(payload.pageCount || payload.page_count || 1);
          pageNumber += 1;
        } while (pageNumber <= pageCount);

        return rows;
      }

      function buildActionInput(extra = {}) {
        return {
          conversationId: context.conversationId,
          communicationId: context.communicationId,
          participantId: context.participantId,
          typeOfInteraction: typeSelect.value,
          ...extra,
        };
      }

      async function executeDataAction(token, actionId, input) {
        const response = await fetch(`${API_BASE}/api/v2/integrations/actions/${encodeURIComponent(actionId)}/execute`, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input || {}),
        });

        const text = await response.text();
        const payload = parseJson(text);
        if (!response.ok) throw createHttpError(payload.message || payload.error || `Data Action failed: ${response.status}`, response.status, payload);
        return payload;
      }

      function normalizeOptions(payload) {
        const source = findFirstArray(payload);
        return uniqueSortedOptions(source.map((item) => {
          const row = unwrapDataRow(item);
          if (!isActiveRow(row)) return { label: "", value: "" };
          const label =
            getFirstField(row, ["label", "name", "displayName", "value", "key"]) ||
            getFirstField(row, ["Interaction Type", "TypeOfInteraction", "typeOfInteraction", "InteractionType", "interactionType"]) ||
            getFirstField(row, ["Contact Reason", "ContactReason", "contactReason", "Contact_Reason"]) ||
            getFirstField(row, ["Interaction Outcome", "InteractionOutcome", "interactionOutcome", "Outcome", "outcome"]) ||
            "";
          const value = getFirstField(row, ["value", "key", "id"]) || label;
          const typeOfInteraction = getTypeValue(row);
          return {
            label: cleanOptionValue(label),
            value: cleanOptionValue(value || label),
            typeOfInteraction: cleanOptionValue(typeOfInteraction),
          };
        }));
      }

      function normalizeTypeRows(rows) {
        return uniqueSortedOptions(rows.map((item) => {
          const row = unwrapDataRow(item);
          if (!isActiveRow(row)) return { label: "", value: "" };
          const label = cleanOptionValue(getFirstField(row, dataTableColumnConfig.typeOfInteraction) || getMeaningfulFallbackField(row));
          return { label, value: label };
        }));
      }

      function normalizeTableRow(item) {
        const row = unwrapDataRow(item);
        return {
          typeOfInteraction: cleanOptionValue(getTypeValue(row)),
          contactReason: cleanOptionValue(getFirstField(row, dataTableColumnConfig.contactReason)),
          interactionOutcome: cleanOptionValue(getFirstField(row, dataTableColumnConfig.interactionOutcome)),
          active: isActiveRow(row),
        };
      }

      function unwrapDataRow(item) {
        if (!item || typeof item !== "object") return {};

        // Genesys Data Table rows normally return values inside row.values when showbrief=false.
        // Keep top-level properties also, so key/id/debug fields are still available.
        const mergedRow = { ...item };

        if (item.values && typeof item.values === "object") {
          Object.assign(mergedRow, item.values);
        }
        if (item.fields && typeof item.fields === "object") {
          Object.assign(mergedRow, item.fields);
        }
        if (item.properties && typeof item.properties === "object") {
          Object.assign(mergedRow, item.properties);
        }
        if (item.data && typeof item.data === "object") {
          Object.assign(mergedRow, item.data);
        }

        return mergedRow;
      }

      function rebuildDependentOptionsFromRows() {
        const selectedType = typeSelect.value;
        const matchingRows = state.prospectRows.filter((row) => !selectedType || !row.typeOfInteraction || valuesEqual(row.typeOfInteraction, selectedType));
        state.contactReasons = uniqueSortedOptions(matchingRows.map((row) => ({
          label: row.contactReason,
          value: row.contactReason,
          typeOfInteraction: row.typeOfInteraction,
        })));
        state.outcomes = uniqueSortedOptions(matchingRows.map((row) => ({
          label: row.interactionOutcome,
          value: row.interactionOutcome,
          typeOfInteraction: row.typeOfInteraction,
          contactReason: row.contactReason,
        })));
        state.debugInfo.contactOptions = state.contactReasons.length;
        state.debugInfo.outcomeOptions = getVisibleOutcomeOptions().length;
      }

      function uniqueSortedOptions(options) {
        const seen = new Map();
        options.forEach((item) => {
          const label = cleanOptionValue(item.label);
          const value = cleanOptionValue(item.value || label);
          const typeOfInteraction = cleanOptionValue(item.typeOfInteraction);
          const contactReason = cleanOptionValue(item.contactReason);
          if (!label) return;
          const key = [label, typeOfInteraction, contactReason].map(normalizeOptionKey).join("||");
          if (!seen.has(key)) {
            seen.set(key, {
              label,
              value,
              typeOfInteraction,
              contactReason,
            });
          }
        });
        return Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label));
      }

      function uniqueSortedDisplayOptions(options) {
        const seen = new Map();
        options.forEach((item) => {
          const label = cleanOptionValue(item.label);
          const value = cleanOptionValue(item.value || label);
          const typeOfInteraction = cleanOptionValue(item.typeOfInteraction);
          if (!label) return;
          const key = [label, value, typeOfInteraction].map(normalizeOptionKey).join("||");
          if (!seen.has(key)) {
            seen.set(key, {
              label,
              value,
              typeOfInteraction,
              contactReason: cleanOptionValue(item.contactReason),
            });
          }
        });
        return Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label));
      }

      function getFirstField(row, names) {
        for (const name of names) {
          const value = row && row[name];
          if (value !== undefined && value !== null && cleanOptionValue(value)) return cleanOptionValue(value);
        }
        const normalizedLookup = {};
        Object.keys(row || {}).forEach((key) => {
          normalizedLookup[normalizeFieldName(key)] = row[key];
        });
        for (const name of names) {
          const value = normalizedLookup[normalizeFieldName(name)];
          if (value !== undefined && value !== null && cleanOptionValue(value)) return cleanOptionValue(value);
        }
        return "";
      }

      function getTypeValue(row) {
        return getFirstField(row, dataTableColumnConfig.typeOfInteraction);
      }

      function getMeaningfulFallbackField(row) {
        const ignored = new Set(["key", "id", "active", "isactive", "status"]);
        for (const [key, value] of Object.entries(row || {})) {
          if (ignored.has(normalizeFieldName(key))) continue;
          if (value !== undefined && value !== null && cleanOptionValue(value)) return cleanOptionValue(value);
        }
        return "";
      }

      function getSampleColumns(item) {
        const row = unwrapDataRow(item);
        return Object.keys(row || {}).slice(0, 12).join(", ");
      }

      function normalizeFieldName(name) {
        return String(name || "").toLowerCase().replace(/[\s_-]+/g, "");
      }

      function isActiveRow(row) {
        const value = getFirstField(row, dataTableColumnConfig.active);
        if (!value) return true;
        return ["true", "yes", "y", "1", "active"].includes(value.toLowerCase());
      }

      function findFirstArray(payload) {
        if (Array.isArray(payload)) return payload;
        if (!payload || typeof payload !== "object") return [];
        const keys = ["entities", "items", "rows", "data", "results", "values", "options", "typeOfInteraction", "types", "interactionTypes", "contactReason", "contactReasons", "interactionOutcome", "outcomes"];
        for (const key of keys) {
          if (Array.isArray(payload[key])) return payload[key];
        }
        for (const value of Object.values(payload)) {
          if (Array.isArray(value)) return value;
          if (value && typeof value === "object") {
            const nested = findFirstArray(value);
            if (nested.length) return nested;
          }
        }
        return [];
      }

      function renderTypeOptions() {
        const previous = typeSelect.value;
        typeSelect.innerHTML = '<option value="">---Select---</option>' +
          state.types.map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join("");
        if (previous) typeSelect.value = previous;
        state.debugInfo.typeOptions = state.types.length;
      }

      async function onTypeChange() {
        // Type of Interaction is stored/validated only.
        // It does not filter or re-fetch Contact Reason / Interaction Outcome values.
        saveDraft();
        renderDebugParameters();
      }

      function applyContactReasonSearch() {
        const selectedValues = getSelectedOptions("contactReason").map((item) => item.value);
        const filteredOptions = filterBySearch(state.contactReasons, contactSearch.value);
        renderOptions("contactReason", filteredOptions, selectedValues);
        state.debugInfo.contactOptions = filteredOptions.length;
        renderDebugParameters();
      }

      function applyInteractionOutcomeSearch() {
        const selectedValue = INTERACTION_OUTCOME_MULTI_SELECT
          ? getSelectedOptions("outcome").map((item) => item.value)
          : getSelectedOption("outcome").value;
        const filteredOptions = getVisibleOutcomeOptions();
        renderOptions("outcome", filteredOptions, selectedValue);
        state.debugInfo.outcomeOptions = filteredOptions.length;
        renderDebugParameters();
      }

      function refreshDependentLists() {
        contactSearch.value = "";
        outcomeSearch.value = "";
        renderOptions("contactReason", filterByType(state.contactReasons));
        renderOptions("outcome", getVisibleOutcomeOptions());
        state.debugInfo.contactOptions = filterByType(state.contactReasons).length;
        state.debugInfo.outcomeOptions = getVisibleOutcomeOptions().length;
        restoreDraftSelections();
        renderOptions("outcome", getVisibleOutcomeOptions(), INTERACTION_OUTCOME_MULTI_SELECT ? getSelectedOptions("outcome").map((item) => item.value) : getSelectedOption("outcome").value);
        state.debugInfo.outcomeOptions = getVisibleOutcomeOptions().length;
      }

      function resetContactReasonSelections() {
        Array.from(document.querySelectorAll('input[name="contactReason"]')).forEach((box) => {
          box.checked = false;
        });
        contactSearch.value = "";
        outcomeSearch.value = "";
        renderOptions("contactReason", filterByType(state.contactReasons));
        refreshInteractionOutcomesForContact();
        saveDraft();
      }

      function refreshInteractionOutcomesForContact() {
        outcomeSearch.value = "";
        const filteredOptions = getVisibleOutcomeOptions();
        renderOptions("outcome", filteredOptions);
        state.debugInfo.outcomeOptions = filteredOptions.length;
        renderDebugParameters();
      }

      function getVisibleOutcomeOptions() {
        return filterBySearchAndContact(state.outcomes, outcomeSearch.value);
      }

      function filterByType(options) {
        // No dependency between Type of Interaction and Contact Reason/Interaction Outcome.
        // Keep this function for backward compatibility with existing calls, but return all values.
        return Array.isArray(options) ? options : [];
      }

      function valuesEqual(left, right) {
        return normalizeOptionKey(left) === normalizeOptionKey(right);
      }

      function filterBySearch(options, searchText) {
        const term = normalizeSearchText(searchText);
        const sourceOptions = Array.isArray(options) ? options : [];
        if (!term) return sourceOptions;
        return sourceOptions.filter((item) => normalizeSearchText(item.label).includes(term) || normalizeSearchText(item.value).includes(term));
      }

      function filterBySearchAndContact(options, searchText) {
        const selectedContacts = getSelectedOptions("contactReason").map((item) => item.value);
        let filteredOptions = Array.isArray(options) ? options : [];

        if (selectedContacts.length) {
          filteredOptions = filteredOptions.filter((item) => {
            if (!item.contactReason) return false;
            return selectedContacts.some((selectedContact) => valuesEqual(item.contactReason, selectedContact));
          });
        }

        filteredOptions = uniqueSortedDisplayOptions(filteredOptions);

        const term = normalizeSearchText(searchText);
        if (!term) return filteredOptions;
        return filteredOptions.filter((item) => normalizeSearchText(item.label).includes(term) || normalizeSearchText(item.value).includes(term));
      }

      function splitContactReasonText(value) {
        const text = String(value || "");
        if (!text) return [];
        return text
          .split(/\s*(?:⇢|\|\|)\s*/g)
          .map(cleanOptionValue)
          .filter(Boolean);
      }

      function splitInteractionOutcomeText(value) {
        const text = String(value || "");
        if (!text) return [];
        return text
          .split(/\s*(?:⇢|\|\|)\s*/g)
          .map(cleanOptionValue)
          .filter(Boolean);
      }

      function cleanOptionValue(value) {
        return String(value || "")
          .replace(/\s+/g, " ")
          .trim();
      }

      function normalizeOptionKey(value) {
        return cleanOptionValue(value).toLowerCase();
      }

      function normalizeSearchText(value) {
        return cleanOptionValue(value).toLowerCase();
      }

      function renderOptions(name, options, selectedValue = "") {
        const container = document.getElementById(name === "contactReason" ? "contactOptions" : "outcomeOptions");
        if (!container) return;

        if (!options.length) {
          container.innerHTML = '<div class="option">No matching values found</div>';
          return;
        }

        const selectedValues = Array.isArray(selectedValue)
          ? selectedValue.map(cleanOptionValue).filter(Boolean)
          : (name === "outcome" ? splitInteractionOutcomeText(selectedValue) : splitContactReasonText(selectedValue));

        container.innerHTML = options.map((item) => {
          const isChecked = selectedValues.some((value) => valuesEqual(value, item.value)) ? " checked" : "";
          const inputType = "checkbox";
          return `<label class="option"><input name="${name}" type="${inputType}" value="${escapeHtml(item.value)}" data-label="${escapeHtml(item.label)}"${isChecked} /> ${escapeHtml(item.label)}</label>`;
        }).join("");
        wireOptionSelect(container, name);
      }

      function wireOptionSelect(container, name) {
        Array.from(container.querySelectorAll(`input[name="${name}"]`)).forEach((box) => {
          box.addEventListener("change", () => {
            if (name === "outcome" && !INTERACTION_OUTCOME_MULTI_SELECT && box.checked) {
              Array.from(container.querySelectorAll(`input[name="${name}"]`)).forEach((otherBox) => {
                if (otherBox !== box) otherBox.checked = false;
              });
            }

            if (name === "contactReason") {
              refreshInteractionOutcomesForContact();
            }
            saveDraft();
          });
        });
      }

      function getSelectedOption(name) {
        const selected = document.querySelector(`input[name="${name}"]:checked`);
        return selected ? { value: selected.value, label: selected.dataset.label || selected.value } : { value: "", label: "" };
      }

      function getSelectedOptions(name) {
        return Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map((selected) => ({
          value: selected.value,
          label: selected.dataset.label || selected.value,
        }));
      }

      function getSelectedContactReasonText() {
        return getSelectedOptions("contactReason")
          .map((item) => item.label)
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
          .join(CONTACT_REASON_SEPARATOR);
      }

      function getSelectedInteractionOutcomeText() {
        const selectedOutcomes = getSelectedOptions("outcome")
          .map((item) => item.label)
          .filter(Boolean);

        if (!INTERACTION_OUTCOME_MULTI_SELECT) {
          return selectedOutcomes[0] || "";
        }

        return selectedOutcomes
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
          .join(INTERACTION_OUTCOME_SEPARATOR);
      }

      function saveDraft() {
        if (!context.conversationId || !context.communicationId) return;
        const contacts = getSelectedOptions("contactReason");
        const outcomes = getSelectedOptions("outcome");
        const draft = {
          typeOfInteraction: typeSelect.value,
          contactReasons: contacts.map((item) => item.value),
          contactReason: contacts.map((item) => item.value).join(CONTACT_REASON_SEPARATOR),
          interactionOutcomes: outcomes.map((item) => item.value),
          interactionOutcome: outcomes.map((item) => item.value).join(INTERACTION_OUTCOME_SEPARATOR),
          remarks: remarks.value,
        };
        sessionStorage.setItem(draftKey, JSON.stringify(draft));
      }

      function restoreDraft() {
        const draft = getDraft();
        if (!draft) return;
        if (draft.typeOfInteraction) typeSelect.value = draft.typeOfInteraction;
        if (draft.remarks) remarks.value = draft.remarks;
      }

      function restoreDraftSelections() {
        const draft = getDraft();
        if (!draft) return;
        const contactValues = Array.isArray(draft.contactReasons)
          ? draft.contactReasons
          : splitContactReasonText(draft.contactReason || "");
        setCheckedValues("contactReason", contactValues);
        const outcomeValues = Array.isArray(draft.interactionOutcomes)
          ? draft.interactionOutcomes
          : splitInteractionOutcomeText(draft.interactionOutcome || "");
        setCheckedValues("outcome", INTERACTION_OUTCOME_MULTI_SELECT ? outcomeValues : outcomeValues.slice(0, 1));
      }

      function getDraft() {
        try {
          return JSON.parse(sessionStorage.getItem(draftKey) || "null");
        } catch (_) {
          return null;
        }
      }

      function setCheckedValue(name, value) {
        if (!value) return;
        const box = Array.from(document.querySelectorAll(`input[name="${name}"]`)).find((item) => valuesEqual(item.value, value));
        if (box) box.checked = true;
      }

      function setCheckedValues(name, values) {
        const valueSet = new Set((values || []).map(normalizeOptionKey));
        Array.from(document.querySelectorAll(`input[name="${name}"]`)).forEach((item) => {
          item.checked = valueSet.has(normalizeOptionKey(item.value));
        });
      }
      function appendSearchLog(message) {
        const safeMessage = String(message || "").trim();
        if (!safeMessage) return;
        state.debugInfo.searchLog = state.debugInfo.searchLog
          ? `${state.debugInfo.searchLog} ==> ${safeMessage}`
          : safeMessage;
        renderDebugParameters();
      }

      async function updateSearchDebugAttribute(token) {
        await updateDebugAttributeSafe(token, SEARCH_DEBUG_ATTRIBUTE_NAME, buildSearchDebugLog());
      }

      function buildSearchDebugLog() {
        const contact = { label: getSelectedContactReasonText() };
        const outcome = { label: getSelectedInteractionOutcomeText() };
        return [
          "START",
          "SEARCH_PROSPECT_DROPDOWN",
          `version::${APP_VERSION || "(blank)"}`,
          `conversationId::${context.conversationId || "(blank)"}`,
          `participantId::${context.participantId || "(blank)"}`,
          `typeRows::${state.debugInfo.typeRows}`,
          `mappingRows::${state.debugInfo.mappingRows}`,
          `activeMappingRows::${state.debugInfo.activeMappingRows}`,
          `typeOptions::${state.debugInfo.typeOptions}`,
          `contactOptions::${state.debugInfo.contactOptions}`,
          `outcomeOptions::${state.debugInfo.outcomeOptions}`,
          `selectedType::${getSelectedTypeLabel() || "(blank)"}`,
          `selectedContactReason::${contact.label || "(blank)"}`,
          `selectedInteractionOutcome::${outcome.label || "(blank)"}`,
          `contactSearch::${contactSearch.value || "(blank)"}`,
          `outcomeSearch::${outcomeSearch.value || "(blank)"}`,
          state.debugInfo.searchLog || "NO_SEARCH_LOG"
        ].join(" ==> ");
      }


      function showValidationError(message, focusElement) {
        validationMessage.textContent = message || "";
        if (focusElement && typeof focusElement.focus === "function") {
          setTimeout(() => focusElement.focus(), 0);
        }
      }

      async function submitProspects() {
        validationMessage.textContent = "";
        resetSubmitDebugInfo();

        const token = getAccessToken();
        if (!token) {
          if (AUTO_REFRESH_TOKEN_ENABLED && sessionStorage.getItem(STORAGE_PROSPECTS_AUTO_REFRESH_BLOCKED) !== "true") {
            authRow.hidden = true;
            showValidationError("OAuth token missing. Auto refreshing token...", submitButton);
            await autoRefreshOAuthToken();
            return;
          }
          authRow.hidden = true;
          showValidationError("OAuth token missing. Token refresh is required.", submitButton);
          return;
        }

        const interactionType = typeSelect.value;
        const interactionTypeLabel = getSelectedTypeLabel();
        const selectedContacts = getSelectedOptions("contactReason");
        const contactReasonText = getSelectedContactReasonText();
        const selectedOutcomes = getSelectedOptions("outcome");
        const interactionOutcomeText = getSelectedInteractionOutcomeText();
        const wrapupCodeName = buildWrapupCodeName(contactReasonText, interactionOutcomeText);

        if (!interactionType) {
          showValidationError("Please select Type of Interaction", typeSelect);
          return;
        }
        if (!selectedContacts.length) {
          showValidationError("Please select Contact Reason", contactSearch);
          return;
        }
        if (!selectedOutcomes.length) {
          showValidationError("Please select Interaction Outcome", outcomeSearch);
          return;
        }
        if (!wrapupCodeName) {
          showValidationError("Unable to build wrap-up code name", outcomeSearch);
          return;
        }
        if (sessionStorage.getItem(submitKey) === "true") {
          showValidationError("Already submitted for this conversation", submitButton);
          return;
        }
        if (!context.conversationId || !context.participantId || !context.communicationId) {
          showValidationError("Missing conversationId, participantId or communicationId", submitButton);
          return;
        }

        try {
          submitButton.disabled = true;
          state.debugInfo.wrapupCodeName = wrapupCodeName;
          appendSubmitLog("SUBMIT_START");
          appendSubmitLog(`type::${interactionTypeLabel}`);
          appendSubmitLog(`contactReason::${contactReasonText}`);
          appendSubmitLog(`interactionOutcome::${interactionOutcomeText}`);
          appendSubmitLog(`wrapupName::${wrapupCodeName}`);
          await updateAssignDebugAttribute(token);
          setRuntimeStatus("Finding wrap-up code...");

          const selectedWrapup = await findOrCreateWrapupCode(token, wrapupCodeName);
          state.debugInfo.wrapupCodeId = selectedWrapup.id || "";
          state.debugInfo.wrapupCreated = selectedWrapup.created ? "Y" : "N";
          appendSubmitLog(selectedWrapup.created ? "WRAPUP_CREATED" : "WRAPUP_FOUND");
          appendSubmitLog(`wrapupId::${selectedWrapup.id}`);
          await updateAssignDebugAttribute(token);

          setRuntimeStatus("Assigning wrap-up code...");
          await setMessageConversationWrapup(token, selectedWrapup.id, remarks.value);
          appendSubmitLog("WRAPUP_ASSIGNED");
          await updateAssignDebugAttribute(token);

          setRuntimeStatus("Saving Prospects details...");
          await setParticipantAttributes(token, {
            // Existing Agent Selected participant-data names retained for compatibility.
            Agent_Selected_ContactReason: contactReasonText,
            Agent_Selected_InteractionOutcome: interactionOutcomeText,
            Agent_Selected_CombinedWrapupCodeName: wrapupCodeName,
            Agent_Selected_CallOrChatType: "Chat",
            Agent_Selected_Remarks: remarks.value,

            // Prospects-specific participant-data names retained separately.
            Prospects_TypeOfInteraction: interactionTypeLabel,
            Prospects_ContactReason: contactReasonText,
            Prospects_InteractionOutcome: interactionOutcomeText,
            Prospects_CombinedWrapupCodeName: wrapupCodeName,
            Prospects_WrapupCodeId: selectedWrapup.id || "",
            Prospects_WrapupCreated: selectedWrapup.created ? "Y" : "N",
            Prospects_Remarks: remarks.value,
            Prospects_SubmittedDateTime: new Date().toISOString(),
          });
          appendSubmitLog("PARTICIPANT_DATA_SAVED");
          await updateAssignDebugAttribute(token);

          sessionStorage.setItem(submitKey, "true");
          saveDraft();
          renderDebugParameters();
          setRuntimeStatus("Wrap-up assigned and Prospects submitted successfully.");
        } catch (error) {
          submitButton.disabled = false;
          appendSubmitLog(`ERROR::${getErrorMessage(error)}`);
          if (token) await updateAssignDebugAttribute(token);
          renderDebugParameters();
          setRuntimeStatus("Submit failed: " + getErrorMessage(error), true);
        }
      }

      function resetSubmitDebugInfo() {
        state.debugInfo.wrapupCodeName = "";
        state.debugInfo.wrapupCodeId = "";
        state.debugInfo.wrapupCreated = "";
        state.debugInfo.submitLog = "";
        renderDebugParameters();
      }

      function appendSubmitLog(message) {
        const safeMessage = String(message || "").trim();
        if (!safeMessage) return;
        state.debugInfo.submitLog = state.debugInfo.submitLog
          ? `${state.debugInfo.submitLog} ==> ${safeMessage}`
          : safeMessage;
        renderDebugParameters();
      }

      async function updateAssignDebugAttribute(token) {
        await updateDebugAttributeSafe(token, ASSIGN_DEBUG_ATTRIBUTE_NAME, buildAssignDebugLog());
      }

      function buildAssignDebugLog() {
        const contact = { label: getSelectedContactReasonText() };
        const outcome = { label: getSelectedInteractionOutcomeText() };
        return [
          "START",
          "ASSIGN_WRAPUP_CODE_TO_INTERACTION",
          `version::${APP_VERSION || "(blank)"}`,
          `conversationId::${context.conversationId || "(blank)"}`,
          `participantId::${context.participantId || "(blank)"}`,
          `communicationId::${context.communicationId || "(blank)"}`,
          `inquiry::${contact.label || "(blank)"}`,
          `wrapupName::${outcome.label || "(blank)"}`,
          `combinedWrapupCodeName::${state.debugInfo.wrapupCodeName || "(blank)"}`,
          `wrapupCodeId::${state.debugInfo.wrapupCodeId || "(blank)"}`,
          `wrapupCreated::${state.debugInfo.wrapupCreated || "(blank)"}`,
          state.debugInfo.submitLog || "NO_SUBMIT_LOG"
        ].join(" ==> ");
      }

      function buildWrapupCodeName(contactReason, interactionOutcome) {
        const left = String(contactReason || "").trim();
        const right = String(interactionOutcome || "").trim();
        if (!left || !right) return "";
        return `${left}${wrapupConfig.nameSeparator}${right}`;
      }

      async function findOrCreateWrapupCode(token, wrapupCodeName) {
        const wrapupCodes = await getAllWrapupCodes(token);
        appendSubmitLog(`wrapupCount::${wrapupCodes.length}`);

        const existing = findWrapupByName(wrapupCodes, wrapupCodeName);
        if (existing) {
          return { ...existing, created: false };
        }

        appendSubmitLog("WRAPUP_NOT_FOUND");
        if (!wrapupConfig.createIfMissing) {
          throw new Error("Wrap-up code not found: " + wrapupCodeName);
        }

        const created = await createWrapupCode(token, wrapupCodeName);
        if (!created || !created.id) {
          throw new Error("Wrap-up code created response did not return an id");
        }
        return { ...created, created: true };
      }

      async function getAllWrapupCodes(token) {
        const rows = [];
        let pageNumber = 1;
        let pageCount = 1;
        const pageSize = Math.max(1, wrapupConfig.pageSize || 200);

        do {
          const url = `${API_BASE}/api/v2/routing/wrapupcodes?pageSize=${encodeURIComponent(pageSize)}&pageNumber=${encodeURIComponent(pageNumber)}`;
          const response = await fetch(url, {
            method: "GET",
            headers: { Authorization: "Bearer " + token },
          });
          const text = await response.text();
          const payload = parseJson(text);
          if (!response.ok) throw new Error(payload.message || payload.error || `Wrap-up code read failed: ${response.status}`);

          rows.push(...findFirstArray(payload));
          pageCount = Number(payload.pageCount || payload.page_count || 1);
          pageNumber += 1;
        } while (pageNumber <= pageCount);

        return rows;
      }

      function findWrapupByName(wrapupCodes, wrapupCodeName) {
        const target = normalizeSearchText(wrapupCodeName);
        return (wrapupCodes || []).find((item) => normalizeSearchText(item && item.name) === target) || null;
      }

      async function createWrapupCode(token, wrapupCodeName) {
        const response = await fetch(`${API_BASE}/api/v2/routing/wrapupcodes`, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: wrapupCodeName }),
        });
        const text = await response.text();
        const payload = parseJson(text);
        if (!response.ok) throw new Error(payload.message || payload.error || `Wrap-up code create failed: ${response.status}`);
        return payload;
      }

      async function setMessageConversationWrapup(token, wrapupCodeId, notes) {
        const url = `${API_BASE}/api/v2/conversations/messages/${encodeURIComponent(context.conversationId)}/participants/${encodeURIComponent(context.participantId)}/communications/${encodeURIComponent(context.communicationId)}/wrapup`;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            code: wrapupCodeId,
            notes: String(notes || "").trim(),
          }),
        });
        const text = await response.text();
        const payload = parseJson(text);
        if (!response.ok) throw new Error(payload.message || payload.error || `Wrap-up assignment failed: ${response.status}`);
        return payload;
      }

      function getSelectedTypeLabel() {
        const selected = typeSelect.options[typeSelect.selectedIndex];
        return selected && selected.value ? selected.textContent : typeSelect.value;
      }

      async function updateDebugAttributeSafe(token, attributeName, logText) {
        try {
          if (!token || !attributeName || !context.conversationId || !context.participantId) return;
          await setParticipantAttributes(token, {
            [attributeName]: truncateForAttribute(logText, DEBUG_ATTRIBUTE_MAX_LENGTH),
          });
        } catch (_) {
          // Debug attribute update should not stop the main Prospects flow.
        }
      }

      function truncateForAttribute(value, maxLength) {
        const text = String(value || "").trim();
        if (!maxLength || text.length <= maxLength) return text;
        return text.substring(0, maxLength);
      }

      async function setParticipantAttributes(token, attributes) {
        const response = await fetch(`${API_BASE}/api/v2/conversations/messages/${encodeURIComponent(context.conversationId)}/participants/${encodeURIComponent(context.participantId)}/attributes`, {
          method: "PATCH",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ attributes }),
        });
        const text = await response.text();
        const payload = parseJson(text);
        if (!response.ok) throw new Error(payload.message || payload.error || `Attribute update failed: ${response.status}`);
        return payload;
      }

      function updateSubmitState() {
        if (sessionStorage.getItem(submitKey) === "true") {
          submitButton.disabled = true;
          setRuntimeStatus("Prospects already submitted for this conversation.");
        }
      }

      async function loginOrRefreshOAuthToken() {
        sessionStorage.removeItem(STORAGE_PROSPECTS_AUTO_REFRESH_BLOCKED);
        sessionStorage.removeItem(STORAGE_PROSPECTS_LOAD_RECOVERY_ATTEMPTED);
        await clearTokenAndStartPKCELogin();
      }

      async function autoRefreshOAuthToken() {
        await clearTokenAndStartPKCELogin();
      }

      async function clearTokenAndStartPKCELogin() {
        sessionStorage.removeItem("gc_access_token");
        sessionStorage.removeItem("gc_token_expires_at");
        sessionStorage.removeItem("pkce_code_verifier");
        await startPKCELogin();
      }

      async function startPKCELogin() {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = await generateCodeChallenge(codeVerifier);
        sessionStorage.setItem("pkce_code_verifier", codeVerifier);
        sessionStorage.setItem(STORAGE_CLIENT_ID, OAUTH_CLIENT_ID);
        sessionStorage.setItem(STORAGE_REGION, GENESYS_REGION);
        sessionStorage.setItem(STORAGE_PROSPECTS_ORIGINAL_QUERY, buildQueryWithoutOAuthCode());
        window.location.href =
          `${LOGIN_BASE}/oauth/authorize?response_type=code` +
          `&client_id=${encodeURIComponent(OAUTH_CLIENT_ID)}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
          `&code_challenge=${encodeURIComponent(codeChallenge)}` +
          `&code_challenge_method=S256`;
      }

      async function handleOAuthCallback(code) {
        const codeVerifier = sessionStorage.getItem("pkce_code_verifier");
        if (!codeVerifier) throw new Error("Missing PKCE code verifier.");
        const body = new URLSearchParams();
        body.append("grant_type", "authorization_code");
        body.append("client_id", OAUTH_CLIENT_ID);
        body.append("code", code);
        body.append("redirect_uri", REDIRECT_URI);
        body.append("code_verifier", codeVerifier);
        const response = await fetch(`${LOGIN_BASE}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        const result = parseJson(await response.text());
        if (!response.ok) throw new Error("Token request failed: " + JSON.stringify(result));
        sessionStorage.setItem("gc_access_token", result.access_token);
        sessionStorage.setItem("gc_token_expires_at", String(Date.now() + ((result.expires_in || 3600) * 1000)));
      }

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

      function base64UrlEncode(arrayBuffer) {
        let str = "";
        const bytes = new Uint8Array(arrayBuffer);
        for (let i = 0; i < bytes.byteLength; i += 1) str += String.fromCharCode(bytes[i]);
        return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
      }

      function buildQueryWithoutOAuthCode() {
        const next = new URLSearchParams(window.location.search);
        next.delete("code");
        return next.toString() ? "?" + next.toString() : "";
      }

      function parseJson(text) {
        try {
          return text ? JSON.parse(text) : {};
        } catch (_) {
          return { raw: text };
        }
      }

      function escapeHtml(value) {
        return String(value || "").replace(/[&<>"']/g, (char) => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char]);
      }

      function getErrorMessage(error) {
        return error && error.message ? error.message : String(error || "Unknown error");
      }
