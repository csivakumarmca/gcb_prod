# RAKBANK Genesys Context Bridge (GCB) — Production

## Release Information

- Package: `GCB_PROD_v1.0.0.zip`
- Environment: `PRODUCTION`
- Release track: `PROD`
- GCB version: `v1.0.0-prod`
- ChatMonitor UI version: `v1.0.0-prod`
- Cache version: `100000`
- Source DEV baseline: `v1.7.2.71-faster-page-load-fallback`
- Release status: Initial production package
- Business logic changes from confirmed DEV baseline: None

## Production Scope

This production package contains:

- `index.html` — OAuth/MFA callback, runtime configuration publisher, status page, and page router
- `monitorwake.html` — Agent Script wake/bootstrap page for hidden ChatMonitor startup
- `chatmonitor.html` — notification monitor, Joined/Greeting sender, support view, and diagnostics
- `holdresume.html` — Hold/Resume summary page
- `holdtimer.html` — Hold timer and alert page
- `prospects.html` — Prospect selection, wrap-up assignment, and optional disconnect page

## Confirmed Behavior Inherited from DEV

- Hidden ChatMonitor startup from the Agent Script
- OAuth/MFA validation and recovery
- Notification subscription for the logged-in Genesys user
- Initial `AGENT_JOINED` followed by `GREETING`
- Agent transfer and supervisor message rules
- Language-specific EN/AR customer messages
- Agent Script communication-ID fallback when the conversation snapshot does not provide it
- Two-second page-load fallback for stopped-monitor recovery
- Duplicate protection through local, runtime, and participant-data sent keys
- Standard Genesys REST requests limited to three total attempts
- Notification reconnect handled separately in three-attempt cycles with cooldown
- Hold/Resume, Hold Timer, and Prospects functionality unchanged

## Production Agent Script URL

```text
{{AFT_URL_GCB_Root_URL}}
+ "/monitorwake.html?v=100000"
+ {{AFT_URL_GCB_Common_Params}}
+ "&forceStart=true"
```

## Required Common Parameters

`AFT_URL_GCB_Common_Params` must provide:

```text
&conversationId=<Genesys Interaction ID>
&agentCommunicationId=<Agent Communication ID>
&agentParticipantId=<Agent Participant ID>
&customerCommunicationId=<Customer Communication ID>
&customerParticipantId=<Customer Participant ID>
&agentName=<Agent Name>
&source=AgentScript
```

## Production Release Rules

- PROD versions are maintained independently from DEV versions.
- Do not overwrite a released PROD package after production deployment.
- Every PROD release must identify its exact confirmed DEV source baseline.
- Increment the PROD package, GCB version, ChatMonitor version, and cache version together for later releases.
- Run syntax checks, protected-logic checks, version checks, and ZIP integrity validation before delivery.
