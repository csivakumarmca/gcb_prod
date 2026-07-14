<!--
  Author: Sivakumar Chandrahasu | Created: 2026-07-07 | Updated: 2026-07-07
  Purpose: Package notes for the current GCB build and deployment model.
           Documents direct page auth fallback, ChatMonitor replacement, and recommended URLs.
-->
# RAKBANK Genesys Context Bridge (GCB)

Updated package: v1.7.2.30-participant-status

## Main changes

- Removed SendMsg page and related files:
  - sendmsg.html
  - js/send-message.js
  - css/send-message.css
- Added Chat Monitor as package page:
  - chatmonitor.html
  - js/chatmonitor.js
  - css/chatmonitor.css
- index.html is now the common OAuth/MFA callback and router page.
- Router mode is now silent/compact for page=holdresume, page=holdtimer, page=prospects, and page=chatmonitor, so the full GCB dashboard is not shown before the target page opens.
- Shared OAuth uses index.html as the redirect URI, then restores the original target page.

- Improved ChatMonitor support/admin dashboard:
  - OAuth, WebSocket, subscription, loaded-from/router, last conversation, last sent, last skip reason, and last error summary cards.
  - Raw log filters for All / OK / WARN / ERROR / SENT / SKIPPED.
  - Log count summary to make support checks easier without browser developer tools.

## Recommended Genesys URLs

Use the same index.html URL for OAuth, Client App and Interaction Widget routing:

```text
index.html?page=chatmonitor&clientId=<OAuthClientId>&region=mypurecloud.ie&source=ClientApp
index.html?page=holdresume&clientId=<OAuthClientId>&region=mypurecloud.ie
index.html?page=holdtimer&clientId=<OAuthClientId>&region=mypurecloud.ie
index.html?page=prospects&clientId=<OAuthClientId>&region=mypurecloud.ie
```

## Pages

- index.html - OAuth/MFA and routing only
- chatmonitor.html - AFT GCB Conversation Monitor
- holdresume.html - Hold/Resume page
- holdtimer.html - Hold Timer page
- prospects.html - Prospects page



## v1.7.2.24 direct auth fallback update
- Client App should use `index.html?page=chatmonitor`.
- Agent Script visible pages should call `holdresume.html`, `holdtimer.html`, and `prospects.html` directly to avoid router flicker.
- If a direct page does not find a valid OAuth token, it shows a small status message and starts OAuth/MFA using `index.html` as the single callback.
- After OAuth/MFA, `index.html` restores the original direct page URL automatically.


## v1.7.2.25 file header update

- Added short author, created date, updated date, and purpose comments to HTML, JS, CSS, and README files.
- Date used in all file headers: 2026-07-07.
- No functional behavior changed from v1.7.2.24 direct auth fallback.


## v1.7.2.30 participant-config status update

GCB now reads configuration from participant data populated by CM/Architect from PROD_AFT_GCB_Config.

Applied participant attributes include:
- Hold/Resume message, limits, alert/sound/notification settings, and EN/AR labels.
- Prospects Data Table IDs, separators, multi-select flag, and wrap-up create flag.
- ChatMonitor support/admin role lists, supervisor keyword, and EN/AR joined/greeting messages.

GCB does not call the config Data Table directly; CM/Architect remains responsible for reading the table and setting participant data.


Banner layout switch (ChatMonitor)
- Query parameter: bannerLayout=light or bannerLayout=dark
- Alternate accepted query parameter: bannerTheme=dark or bannerTheme=light
- Participant attribute fallback: AFT_GCB_BannerLayout = dark or light
- Priority: query parameter first, then participant attribute, then default light.


ChatMonitor banner default update - v1.7.2.33
- Default banner layout is light.
- Use bannerLayout=dark only when dark preview is required.
- Header compact sizing: min-height 50px, logo 40x40px, logo padding 0.


Transfer leg resolver - v1.7.2.47-safe-ui-diagnostics
- Re-reads the full messaging conversation when a transfer notification arrives before the new agent communication ID.
- Selects only the logged-in user's latest agent participant and connected web messaging leg.
- Does not fall back to another agent participant.


## Transfer agent greeting - v1.7.2.47-safe-ui-diagnostics
- For a non-supervisor Agent 2 transfer, sends Agent Joined followed by Greeting.
- Keeps transfer-leg resolver and communication-leg duplicate keys unchanged.
- Supervisor transfers continue to send Supervisor Joined only.


## v1.7.2.47 Safe Enhancements
- Preserves the confirmed v1.7.2.45 Agent 1/Agent 2 joined and greeting transfer logic.
- Renames Chat Monitor status label to SendMessage.
- Uses User Role label.
- Removes duplicate index card title.
- Adds copy/download diagnostics with concise, masked Agent View output.
- Adds index download fallback.
- Adds OAuth/MFA refresh-safe PKCE callback handling.


## v1.7.2.48 Index Support Health
- Removed the misleading SendMessage status row from index.html.
- Added Runtime Parameters availability, Last API, and Last Error rows.
- Added Environment, Source, page-load time, User Role, and shortened User ID metadata.
- Copy/Download details now produce a support-focused index diagnostic report without OAuth secrets or customer personal/banking data.
- ChatMonitor Agent 1 / Agent 2 joined and greeting send/transfer logic is unchanged from the confirmed v1.7.2.47 baseline.


## v1.7.2.49 Support Agent Participant
- Replaced the Support View Role column with Agent Participant.
- Shows shortened agent participant ID and current state for easier transfer troubleshooting.
- Full participant ID is available as hover text.
- No changes to Agent 1 / Agent 2 joined, greeting, transfer, duplicate-control, OAuth, Hold/Resume, or Prospects logic.


## v1.7.2.50 index layout cleanup
- Removed the misleading Runtime Parameters row from index.html because page-specific runtime IDs are passed directly to Prospects and Hold/Resume pages.
- Shortened Last API and Last Error values in the narrow status panel while retaining full values in copied/downloaded diagnostics.
- Improved text wrapping to prevent overlap in narrow Genesys interaction-widget layouts.
- ChatMonitor send, greeting, and transfer logic is unchanged.


## v1.7.2.52 post-MFA active interaction recovery
- Preserves the confirmed notification-driven Agent 1 / Agent 2 transfer and duplicate-control core.
- Interaction index pages publish recent conversation IDs to same-origin localStorage.
- After ChatMonitor OAuth/MFA completion and notification subscription, it performs a one-time fetch of recent active interaction conversations and passes valid connected snapshots into the existing processing function.
- Adds clipboard legacy fallback and stronger index diagnostic download fallback.


## v1.7.2.53 supervisor transfer greeting
- Transfer to a user with a Supervisor role now sends SUPERVISOR_JOINED first and GREETING second when configured.
- Initial Agent 1 and non-supervisor Agent 2 joined/greeting behavior is unchanged.
- Transfer detection, communication-leg resolution, duplicate-control, post-MFA recovery, Hold/Resume, Prospects, and diagnostics are unchanged.


## v1.7.2.54 configurable supervisor greeting

- Added optional participant attribute `AFT_GCB_SendGreetingForSupervisor`.
- `true`: supervisor transfer sends `SUPERVISOR_JOINED` followed by `GREETING` when the greeting text is configured.
- `false` or missing/invalid: supervisor transfer sends only `SUPERVISOR_JOINED`.
- Default is `false` to avoid an unexpected greeting when the Data Table/participant mapping has not yet been deployed.
- No changes were made to initial Agent 1, non-supervisor transfer, communication-leg resolution, duplicate-control, Hold/Resume, Prospects, OAuth/MFA, or diagnostic behavior.


## v1.7.2.55 configurable transfer greetings

- Added optional `AFT_GCB_AgentTransferGreetingText`.
- Added optional `AFT_GCB_SupervisorTransferGreetingText`.
- Initial chats continue to use `AFT_GCB_GreetingText` / language-specific greeting values.
- Agent transfers use `AFT_GCB_AgentTransferGreetingText`; when blank or missing, the existing initial Greeting is used.
- Supervisor transfers use `AFT_GCB_SupervisorTransferGreetingText` when `AFT_GCB_SendGreetingForSupervisor=true`; when blank or missing, the existing initial Greeting is used.
- `AGENT_JOINED` and `SUPERVISOR_JOINED` text and website-dependent behavior are unchanged.

## v1.7.2.56 language-specific customer messages

- Customer-facing joined and greeting messages use only `_EN` / `_AR` attributes.
- Initial greeting: `AFT_GCB_GreetingText_EN` / `_AR`.
- Agent and supervisor transfers: `AFT_GCB_TransferGreetingText_EN` / `_AR`.
- Architect selects with-subject versus without-subject templates and writes the final formatted values.
- Agent-screen hold alert text uses one common attribute per message.

## v1.7.2.57 participant-config status fix

- GCB Participant Config Status now shows exactly the 42 participant attributes populated from `PROD_AFT_GCB_Config`.
- Removed unrelated optional/runtime-only attributes from the status table.
- Summary now displays `Data Table Participant Config: x/42 OK`.
- Added a cache-buster to `chatmonitor.js`.
- No greeting, joined-message, transfer, duplicate-control, or send logic was changed.

## v1.7.2.58 hold-attempt default fix

- Hold Summary no longer reads `maxHoldAttempts` from the URL.
- Hold Summary uses fixed fallback `3` for display/local protection.
- Agent Script remains the source of truth for maximum hold-attempt enforcement.
- No ChatMonitor greeting, transfer, duplicate-control, or send logic changed.

## v1.7.2.59 participant configuration alignment

The active HTML pages now read business configuration directly from participant attributes populated by Architect.

### Hold Summary / Hold Timer
- Read Hold/Resume message text, maximum hold time, auto-resume, hold-calculation mode, alert settings, and agent alert labels from `AFT_GCB_*` participant attributes.
- URL business settings no longer override Data Table configuration.
- Hold Summary maximum-attempt display remains fixed at `3`, as requested; the Agent Script owns the actual max-attempt validation.
- Hold Timer compact layout now defaults to enabled.
- Browser notification title/body and repeated alert sound now use Data Table values.

### Prospects
- Read Data Table IDs, multi-select mode, separators, and create-wrap-up behavior from participant attributes.
- `AFT_GCB_CreateWrapupIfMissing=false` is now honored by the active page.

## v1.7.2.60 hold rate-limit and resume fix

- Prevents overlapping Hold Summary refreshes.
- Caches message details during the page session.
- Fetches full/current-session transcript details only once per unique message.
- Stops the remaining message-detail loop immediately after HTTP 429 and honors a cooldown.
- Storage/Broadcast timer events update local timer state only; they no longer trigger a full transcript reload.
- After-action summary refresh retries reduced to two.
- Resume immediately clears widget blinking and browser-title blinking.
- No ChatMonitor greeting, transfer, or duplicate-control logic changed.

## v1.7.2.61 hold-count synchronization fix

- Fixes Hold Summary remaining at `1 / 3` after a second Hold/Resume cycle.
- Runs one debounced summary refresh after HOLD/RESUME storage/broadcast activity becomes quiet.
- Reuses the v1.7.2.60 single-flight and message-detail cache, so previously loaded messages are not fetched again.
- Preserves the higher local attempt count, hold duration, and segment history while Genesys transcript messages are still propagating.
- No ChatMonitor joined/greeting/transfer/duplicate-control logic changed.

## v1.7.2.62 Prospects canonical runtime ID fix

- Prospects now reads `agentParticipantId` and `agentCommunicationId` from the Agent Script URL.
- Legacy `participantId` and `communicationId` are retained only as backward-compatible fallbacks.
- Submit validation now reports the canonical parameter names.
- Prospects page version updated to `Prospects_v3.14`.
- No Hold/Resume, ChatMonitor greeting, transfer, or duplicate-control logic changed.

## v1.7.2.63 Prospects optional disconnect

- New participant attribute: `AFT_GCB_DisconnectAfterProspectsSubmit`.
- `false`: find/create the wrap-up as configured, apply wrap-up, and save Prospects participant data; keep the chat connected.
- `true`: complete all of the above successfully, then PATCH the current agent messaging communication with `{ "state": "disconnected" }`.
- Disconnect is never attempted when wrap-up assignment or participant-data save fails.
- ChatMonitor/Index Participant Config Status now expects `43/43` required GCB attributes.
- Prospects page version: `Prospects_v3.15`; ChatMonitor UI: `v1.2.22`.
- No ChatMonitor joined/greeting/transfer/duplicate-control logic changed.


## v1.7.2.64 ChatMonitor OAuth/MFA and monitor recovery

Technical-only changes:

- OAuth token is validated during ChatMonitor startup.
- Missing/expired authentication starts the shared PKCE/MFA recovery and restores the original ChatMonitor URL.
- Browser tabs coordinate OAuth recovery using a temporary localStorage lock and BroadcastChannel/storage events.
- Access tokens remain in each tab's sessionStorage; no access token is written to localStorage.
- After another tab completes MFA, a waiting tab automatically performs its own PKCE round-trip using the existing Genesys SSO session.
- Unexpected WebSocket closure automatically creates a new notification channel, resubscribes, and reconnects.
- Recovery runs after visibility, focus, online, pageshow, and a 45-second local watchdog check.
- Manual `stopMonitor()` remains stopped and does not auto-reconnect. `startMonitor()` restarts it.
- Status values now include Starting, Checking OAuth, Waiting for OAuth / MFA, Reconnecting, Running, and Stopped manually.
- ChatMonitor UI version: `v1.2.23`.
- ChatMonitor script cache: `v=172264`.

Protected business logic not changed:

- Initial Agent Joined + Greeting
- Transfer Agent Joined + Transfer Greeting
- Supervisor greeting rules
- Language-specific message selection
- Duplicate-control and participant-data send keys
- Hold/Resume
- Prospects


## v1.7.2.65-agent-script-monitor-wake

- Added `monitorwake.html` for a hidden Agent Script Web Page.
- Publishes canonical runtime IDs and a monitor wake request.
- Does not send customer messages and does not handle OAuth tokens.
- ChatMonitor remains the only sender.
- Uses BroadcastChannel with localStorage-event fallback.
- Retains the latest wake briefly for Client App resume timing.
- `forceStart=true` restarts a stale or manually stopped monitor on interaction page load.
- Added visible `Restart Monitor` fallback.
- Added `simulateUnexpectedMonitorStop()` for technical testing.
- Index diagnostic display now prefers canonical Agent Script IDs.
- ChatMonitor UI: `v1.2.24`
- Cache version: `172265`

Recommended hidden URL:

`<GCB_ROOT>/monitorwake.html?v=172265&conversationId=<value>&agentCommunicationId=<value>&agentParticipantId=<value>&customerCommunicationId=<value>&customerParticipantId=<value>&agentName=<value>&langTag=<value>&source=AgentScript&forceStart=true`


## v1.7.2.66-hidden-monitor-autostart

The hidden Agent Script `monitorwake.html` page now starts ChatMonitor automatically when the visible GCB Client App is not loaded.

- Waits 4.5 seconds for an existing monitor heartbeat.
- Routes the hidden page to `index.html?page=chatmonitor` when no monitor exists.
- Uses the browser's existing Genesys SSO session for OAuth validation.
- Uses a cross-tab leader lease so only one monitor owns the notification WebSocket.
- A visible GCB Client App opened later stays in standby while the hidden monitor is active.
- Filters placeholder values such as `[Interaction ID]`.

Versions:
- GCB: `v1.7.2.66-hidden-monitor-autostart`
- ChatMonitor UI: `v1.2.25`
- Cache: `172266`

Recommended hidden URL:

`<GCB_ROOT>/monitorwake.html?v=172266&conversationId=<value>&agentCommunicationId=<value>&agentParticipantId=<value>&customerCommunicationId=<value>&customerParticipantId=<value>&agentName=<value>&langTag=<value>&clientId=<OAuth client ID>&region=mypurecloud.ie&gcTargetEnv=prod-euw1&gcHostOrigin=https%3A%2F%2Fapps.mypurecloud.ie&usePopupAuth=false&source=AgentScript&forceStart=true`


## v1.7.2.67-shared-runtime-config

This patch removes duplicate OAuth/environment maintenance from the Agent Script `monitorwake.html` URL.

### Configuration ownership

Interaction Widget URL supplies and publishes:

- `langTag`
- `gcTargetEnv`
- `gcHostOrigin`
- `usePopupAuth`
- `clientId`
- `region`

Agent Script `monitorwake.html` supplies:

- `conversationId`
- `agentCommunicationId`
- `agentParticipantId`
- `customerCommunicationId`
- `customerParticipantId`
- `agentName`
- `source`
- `forceStart`

Shared runtime storage key:

`AFT_GCB_RUNTIME_CONFIG_V1`

### Agent Script expression

```text
{{AFT_URL_GCB_Root_URL}}
+ "/monitorwake.html?v=172267"
+ {{AFT_URL_GCB_Common_Params}}
+ "&forceStart=true"
```

Do not duplicate the Interaction Widget OAuth/environment parameters in the Agent Script expression.

Versions:

- GCB: `v1.7.2.67-shared-runtime-config`
- ChatMonitor UI: `v1.2.26`
- Cache: `172267`


## v1.7.2.68-production-safety

Production safety changes:

- Maximum five recent interaction contexts for the logged-in browser/user.
- Maximum five ChatMonitor conversation-leg records.
- Recovery scans only the newest five records and only within 15 minutes.
- Standard Genesys REST calls: maximum three total attempts.
- Retry only for network failures and HTTP 408, 429, 500, 502, 503, and 504.
- `Retry-After` is respected for HTTP 429.
- Agent communication-leg resolution: maximum three snapshot attempts.
- Notification reconnect: maximum three attempts, then five-minute cooldown.
- Agent Script wake, online/focus/page visibility, or manual restart may end the cooldown early.
- Production debug history: latest 50 concise events.
- Detailed payload logging is available only while Admin Verbose is enabled.
- `monitorwake.html` waits for shared runtime configuration at most five times.
- Page-load fallback runs once after four seconds when the primary monitor is not yet open.
- Fallback uses the existing Joined decision and sends:
  - Initial agent: `AGENT_JOINED` then `GREETING`
  - Transferred agent: `AGENT_JOINED` then transfer `GREETING`
  - Supervisor: `SUPERVISOR_JOINED` and the configured supervisor greeting rule
- Primary and fallback paths use the same communication-leg duplicate keys, fast local lock, and participant-data sent keys.

Versions:

- GCB: `v1.7.2.68-production-safety`
- ChatMonitor UI: `v1.2.27`
- Cache: `172268`

Agent Script expression:

```text
{{AFT_URL_GCB_Root_URL}}
+ "/monitorwake.html?v=172268"
+ {{AFT_URL_GCB_Common_Params}}
+ "&forceStart=true"
```


## v1.7.2.69-monitorwake-fallback-fix

MonitorWake fallback correction:

- Uses the valid Agent Script `agentCommunicationId` when the conversation snapshot does not return a communication ID.
- Prefers a snapshot-resolved communication ID when available.
- Confirms the logged-in agent participant is connected before sending.
- Runs the existing Joined/Greeting sender directly for the effective communication leg.
- Keeps existing duplicate, participant-data, transfer, supervisor, and language logic unchanged.
- Shows fallback failures in Agent, Support, and Admin tables.
- Example visible reason: `Joined/Greeting not sent: connected agent communication could not be confirmed.`
- Cache version: `172269`
- ChatMonitor UI: `v1.2.28`

Agent Script expression:

```text
{{AFT_URL_GCB_Root_URL}}
+ "/monitorwake.html?v=172269"
+ {{AFT_URL_GCB_Common_Params}}
+ "&forceStart=true"
```


## v1.7.2.70-notification-retry-cycle

Notification reconnect policy:

- Standard Genesys REST request: maximum 3 total attempts.
- Notification WebSocket recovery is independent:
  - Attempt 1 after 2 seconds
  - Attempt 2 after 5 seconds
  - Attempt 3 after 10 seconds
  - Five-minute cooldown
  - Start a new three-attempt cycle after cooldown
- A new Agent Script wake, browser online/focus/visibility/pageshow event, or manual restart may restart immediately.
- Added `cycle`, `attempt`, `attemptsPerCycle`, and policy details to reconnect diagnostics.
- No Joined/Greeting, MonitorWake fallback, transfer, supervisor, language, duplicate, OAuth/MFA, Hold/Resume, or Prospects logic changed.

Versions:

- GCB: `v1.7.2.70-notification-retry-cycle`
- ChatMonitor UI: `v1.2.29`
- Cache: `172270`

Agent Script expression:

```text
{{AFT_URL_GCB_Root_URL}}
+ "/monitorwake.html?v=172270"
+ {{AFT_URL_GCB_Common_Params}}
+ "&forceStart=true"
```


## v1.7.2.71-faster-page-load-fallback

Page-load fallback timing update:

- Previous one-time fallback delay: 4 seconds
- New one-time fallback delay: 2 seconds
- Notification-driven send remains the primary path.
- The fallback still runs only once for the current page load.
- Existing duplicate locks and participant-data confirmation remain unchanged.
- No change to REST retry, notification reconnect cycles, OAuth/MFA, transfer, supervisor, language, Hold/Resume, or Prospects logic.

Versions:

- GCB: `v1.7.2.71-faster-page-load-fallback`
- ChatMonitor UI: `v1.2.30`
- Cache: `172271`

Agent Script expression:

```text
{{AFT_URL_GCB_Root_URL}}
+ "/monitorwake.html?v=172271"
+ {{AFT_URL_GCB_Common_Params}}
+ "&forceStart=true"
```


## v1.7.2.72-customer-details-html — DEV Customer Details Migration

This DEV-only change moves the entire approved Customer Details section into `prospects.html`.

Displayed fields:

- Customer Name — read-only
- Customer Type — read-only
- Mobile Number — read-only
- Card No / Account — selectable dropdown

Supported URL parameters:

```text
&customerName=<SI_Customer_Name>
&customerType=<SI_Customer_Type>
&mobileNumber=<SI_Customer_MobileNumber>
&cardAccountList=<SI_Product_CardAccountNoList or prepared string list>
```

The page also supports participant-attribute fallbacks using the original `SI_*` names.

Accepted Card/Account list formats:

- JSON array of strings
- JSON array of objects with `value`, `label`, and optional `type`
- Pipe-separated values
- Semicolon-separated values
- Newline-separated values
- Comma-separated values

On Prospects Submit, the selected value is stored in:

```text
pia_ddl_Selected_AccountNumber
Agent_Selected_CardAccount
Agent_Selected_CardAccount_Display
Agent_Selected_CardAccount_Type
Prospects_Selected_CardAccount
Prospects_Selected_CardAccount_Display
Prospects_Selected_CardAccount_Type
```

Versions:

- GCB: `v1.7.2.72-customer-details-html`
- ChatMonitor UI: `v1.2.31`
- Prospects: `Prospects_v3.16`
- Cache: `172272`

DEV Agent Script expression:

```text
{{AFT_URL_GCB_Root_URL}}
+ "/prospects.html?v=172272"
+ {{AFT_URL_GCB_Common_Params}}
+ "&customerName=" + {{SI_Customer_Name}}
+ "&customerType=" + {{SI_Customer_Type}}
+ "&mobileNumber=" + {{SI_Customer_MobileNumber}}
+ "&cardAccountList=" + {{SI_Product_CardAccountNoList}}
```

The PROD package remains unchanged.


## v1.7.2.73-customer-details-layout-fix

- Customer Details is now a separate top-level section.
- Service Classification starts below Customer Details.
- Customer labels: Arial 12px bold.
- Customer values: Arial 11px.
- Customer field height: 29px.
- Approved two-column spacing, borders, header height, and padding restored.
- No participant-data, Card/Account, wrap-up, or submit logic changed.

Versions: GCB `v1.7.2.73-customer-details-layout-fix`, ChatMonitor `v1.2.32`, Prospects `Prospects_v3.17`, cache `172273`.

Important: HTML cannot render outside its Genesys Web Page component. The Prospects web component must cover the combined Customer Details + Service Classification area. Remove or hide the old Agent Script Customer Details fields and the old Service Classification header to avoid duplication.


## v1.7.2.74-prospects-external-css

Prospects CSS organization update:

- Approved Prospects styling moved from inline `<style>` to `css/prospects.css`.
- `prospects.html` now loads `./css/prospects.css?v=172274`.
- Customer Details and Service Classification appearance is unchanged.
- No functional or business-logic changes.

Versions:

- GCB: `v1.7.2.74-prospects-external-css`
- ChatMonitor UI: `v1.2.33`
- Prospects: `Prospects_v3.20`
- Cache: `172274`


## v1.7.2.75-account-list-source-fix

Card No / Account dropdown correction:

- Dropdown source: `SI_Account_AccountIdList` only
- Removed dropdown parsing from:
  - `SI_Product_CardAccountNoList`
  - `CardAccountList`
- Selected value remains stored in:
  - `pia_ddl_Selected_AccountNumber`

Expected example:

```text
SI_Account_AccountIdList = 0342540096001
```

Dropdown result:

```text
Select Card/Account
0342540096001
```

Versions:

- GCB: `v1.7.2.75-account-list-source-fix`
- ChatMonitor UI: `v1.2.34`
- Prospects: `Prospects_v3.21`
- Cache: `172275`


## v1.7.2.76-prospect-account-card-parameter

Prospects Card No / Account participant-data mapping:

```text
Dropdown source:
SI_Prospect_AccountOrCard_NumberList

Selected value:
SI_Prospect_Selected_AccountOrCard_Number

Legacy compatibility selected value:
pia_ddl_Selected_AccountNumber
```

Example Architect participant data:

```text
SI_Prospect_AccountOrCard_NumberList =
0342540096001|1234********5678|9876********4321
```

Versions:

- GCB: `v1.7.2.76-prospect-account-card-parameter`
- ChatMonitor UI: `v1.2.35`
- Prospects: `Prospects_v3.22`
- Cache: `172276`


## v1.7.2.77-uniform-prospect-participant-names

Prospects participant-data naming standard:

### Agent-selected values

```text
Agent_Prospect_Selected_AccountOrCard_Number
Agent_Prospect_Selected_AccountOrCard_Display
Agent_Prospect_Selected_AccountOrCard_Type
Agent_Prospect_Selected_TypeOfInteraction
Agent_Prospect_Selected_ContactReason
Agent_Prospect_Selected_InteractionOutcome
Agent_Prospect_Selected_CombinedWrapupCodeName
Agent_Prospect_Selected_ChannelType
Agent_Prospect_Selected_Remarks
```

### Prospects submission metadata

```text
Agent_Prospect_WrapupCodeId
Agent_Prospect_WrapupCreated
Agent_Prospect_SubmittedDateTime
```

Removed output variable families:

```text
Agent_Selected_*
Prospects_Selected_*
Prospects_*
SI_Prospect_Selected_*
pia_ddl_Selected_*
```

Input dropdown source remains:

```text
SI_Prospect_AccountOrCard_NumberList
```

Versions:

- GCB: `v1.7.2.77-uniform-prospect-participant-names`
- ChatMonitor UI: `v1.2.36`
- Prospects: `Prospects_v3.23`
- Cache: `172277`


## v1.7.2.78-account-card-id-display-lists

Card No / Account dropdown input:

```text
SI_Prospect_AccountOrCard_IdList
SI_Prospect_AccountOrCard_DisplayList
```

Example:

```text
SI_Prospect_AccountOrCard_IdList =
CARD_987654|ACC_0342540096001

SI_Prospect_AccountOrCard_DisplayList =
Card - 1234********5678|Account - ********96001
```

The two lists must contain the same number of items in the same order.

Dropdown behavior:

```text
Displayed value: matching DisplayList item
Stored value: matching IdList item
```

Selected participant-data outputs:

```text
Agent_Prospect_Selected_AccountOrCard_Id
Agent_Prospect_Selected_AccountOrCard_Display
Agent_Prospect_Selected_AccountOrCard_Type
```

Versions:

- GCB: `v1.7.2.78-account-card-id-display-lists`
- ChatMonitor UI: `v1.2.37`
- Prospects: `Prospects_v3.24`
- Cache: `172278`


## v1.7.2.79-participant-logging-standard

### Removed selected field

```text
Agent_Prospect_Selected_AccountOrCard_Type
```

The selected Card No / Account outputs are now only:

```text
Agent_Prospect_Selected_AccountOrCard_Id
Agent_Prospect_Selected_AccountOrCard_Display
```

### Participant logging standard

All participant log attributes introduced or renamed in this release follow:

```text
AFT_GCB_<PageOrFunctionality>_Logs_<Meaning>
```

Prospects:

```text
AFT_GCB_Prospects_Logs_SearchDropdown
AFT_GCB_Prospects_Logs_AssignWrapup
AFT_GCB_Prospects_Logs_LastStep
AFT_GCB_Prospects_Logs_LastStatus
AFT_GCB_Prospects_Logs_LastTime
AFT_GCB_Prospects_Logs_LastTrace
```

ChatMonitor:

```text
AFT_GCB_ChatMonitor_Logs_LastStep
AFT_GCB_ChatMonitor_Logs_LastStatus
AFT_GCB_ChatMonitor_Logs_LastTime
AFT_GCB_ChatMonitor_Logs_LastTrace
```

HoldResume:

```text
AFT_GCB_HoldResume_Logs_LastStep
AFT_GCB_HoldResume_Logs_LastStatus
AFT_GCB_HoldResume_Logs_LastTime
AFT_GCB_HoldResume_Logs_LastTrace
AFT_GCB_HoldResume_Logs_LastError
```

HoldTimer:

```text
AFT_GCB_HoldTimer_Logs_LastStep
AFT_GCB_HoldTimer_Logs_LastStatus
AFT_GCB_HoldTimer_Logs_LastTime
AFT_GCB_HoldTimer_Logs_LastTrace
AFT_GCB_HoldTimer_Logs_LastError
```

Index and MonitorWake retain browser diagnostic logging. They do not write business execution logs to participant data because they are runtime/helper pages rather than agent business actions.

Versions:

- GCB: `v1.7.2.79-participant-logging-standard`
- ChatMonitor UI: `v1.2.38`
- Prospects: `Prospects_v3.25`
- Cache: `172279`


## v1.7.2.80-single-participant-log-per-page

Participant logging is consolidated to one attribute per page/functionality:

```text
AFT_GCB_Prospects_Logs
AFT_GCB_ChatMonitor_Logs
AFT_GCB_HoldResume_Logs
AFT_GCB_HoldTimer_Logs
```

Each value contains the timestamp, step, status, trace, and error details in one string.

Removed separate log attributes:

```text
*_Logs_LastStep
*_Logs_LastStatus
*_Logs_LastTime
*_Logs_LastTrace
*_Logs_LastError
```

Versions:

- GCB: `v1.7.2.80-single-participant-log-per-page`
- ChatMonitor UI: `v1.2.39`
- Prospects: `Prospects_v3.26`
- Cache: `172280`


## v1.7.2.81-meaningful-participant-logs

One participant log attribute remains per operational page:

```text
AFT_GCB_Prospects_Logs
AFT_GCB_ChatMonitor_Logs
AFT_GCB_HoldResume_Logs
AFT_GCB_HoldTimer_Logs
```

Only useful post-disposal evidence is stored:

```text
selected business values
wrap-up found/created/assigned result
participant-data save result
message API success/failure
retry status and retry delay
validation block
final success/failure
```

Basic page-load and UI-only events are intentionally excluded.

Versions:

- GCB: `v1.7.2.81-meaningful-participant-logs`
- ChatMonitor UI: `v1.2.40`
- Prospects: `Prospects_v3.27`
- Cache: `172281`


## v1.7.2.82-optional-card-account

The Prospects `Card No / Account` field is now optional.

Behavior:

```text
No selection:
Submit continues normally.
Agent_Prospect_Selected_AccountOrCard_Id = ""
Agent_Prospect_Selected_AccountOrCard_Display = ""
```

When selected, the existing ID/display mapping remains unchanged.

Versions:

- GCB: `v1.7.2.82-optional-card-account`
- ChatMonitor UI: `v1.2.41`
- Prospects: `Prospects_v3.28`
- Cache: `172282`
