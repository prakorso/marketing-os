# MARQOS UI principles

Persistent, Panji-approved visual lessons for MARQOS frontend work. Codex reads this file before building. The UI/UX reviewer checks the implementation against it.

- **Authority:** Panji > canonical `docs/` > task contract > these principles > reviewer findings. If the contract conflicts with a principle, follow the contract and record it in the receipt's `principles_waived`.
- **Changes:** only Panji approves, changes, or retires a principle. Claude transcribes Panji's decision exactly. Reviewers may only propose candidates in the task file. Codex never edits this file.
- **Size:** keep about 25 active principles or fewer. Prefer merging or rewording to adding. Retire instead of deleting; IDs are never reused.

Entry format:

```
## UIP-### <short title>
Rule: <one imperative rule>
Why: <user or product consequence>
Applies to: <surfaces, e.g. dashboards, forms, settings>
Do / Don't: <concrete example> / <concrete counter-example>
Source: <TASK-ID> (<PC-n>) · Approved by Panji <YYYY-MM-DD>
Status: active | retired
```

## Principles

_None yet._

## Declined proposals

_None yet._ Format: `<PC-id> (<TASK-ID>) "<statement>": declined <YYYY-MM-DD>, <Panji's reason>`
