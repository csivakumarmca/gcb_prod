# AFT Genesys Context Bridge (AFT GCB)

- PROD package: `v1.0.1`
- ChatMonitor UI: `v1.0.1`
- Prospects: `Prospects_v3.42`
- Production cache: `100001`
- Environment: `PRODUCTION`
- Release track: `PROD`
- Source baseline: `AFT_GCB_PROD_v1.0.0_contact_search_selection_fix_v2`
- Customer: `RAKBANK`

## Prospect Value Source

Prospect values continue to be supplied through these Architect-prepared participant attributes:

- `SI_Prospect_InteractionTypeListJson`
- `SI_Prospect_ContactReasonListJson`
- `SI_Prospect_InteractionOutcomeListJson`

The browser does not read the Prospect source Data Tables directly.

## Prospect Wrap-up Processing

The Prospects page no longer searches, creates, or applies Genesys wrap-up codes directly.

On Submit, the page:

1. Builds and stores the selected Prospect business attributes.
2. Generates a unique `AFT_GCB_ProspectRequestId`.
3. Stores the workflow runtime participant attributes.
4. Writes `AFT_GCB_ProspectWrapupStatus=PENDING` separately and last.
5. The Process Automation Trigger workflow performs Search, Create when required, and Apply.

Multiple submissions are supported for the same interaction.

## Contact Reason Maximum Selection

Required participant configuration:

- Attribute: `AFT_GCB_ProspectMaxContactReasonSelections`
- Current PROD value: `5`
- Positive whole number: maximum allowed selections
- `0`, blank, missing, invalid, or negative: unlimited

When the limit is reached, existing selections remain selected and only the additional selection is blocked.

## Protected Logic

The following confirmed PROD logic was not redesigned:

- Message sending
- Joined and greeting handling
- Agent and supervisor transfer handling
- Duplicate-message control
- Hold/Resume counting and timers
- OAuth/MFA recovery
- Stop-monitor and monitor-wake recovery
