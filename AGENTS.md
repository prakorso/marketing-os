<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Database migrations — never reset a database that may hold real data

`supabase db reset` and `npm run db:reset` are destructive. They drop and recreate the entire local database, replay migrations, and load `supabase/seed.sql`. This can destroy manually-created application data, including workspaces created through the application.

For normal migration application against an existing local database, use:

`supabase migration up --local`

or:

`supabase db push --local`

Only use `db reset` when the local database is explicitly known to be disposable, or when the user has explicitly confirmed that its data may be discarded.

If `supabase migration up --local` or `supabase db push --local` fails, STOP and report the exact error and migration involved. Do not fall back to `db reset` as a workaround.

`supabase/seed.sql` is intentionally empty and must not be treated as a backup or recovery mechanism for application data.


## Claude ↔ Codex coordination (filesystem handoff protocol)

**Authority:** Panji > canonical `docs/` > this `AGENTS.md` > task file > approved UI principles (`.marqos/ui-principles.md`) > UI/UX reviewer findings. Panji owns product decisions, scope changes, architecture overrides, and final approval. Claude owns concept, architecture, data model, database, backend, business logic, API/service contracts, and validation. Codex owns UI/UX, frontend visual implementation, components, and frontend changes the contract explicitly allows. If a contract conflicts with a canonical doc, set `needs_panji`. Ruflo is **not** used for coordination (no Ruflo memory, swarm, daemon, or autopilot).

**Directory:** `.marqos/coordination/<TASK-ID>.json`, one file per task, gitignored. `TASK-ID` matches `^[A-Z][A-Z0-9]*(-[A-Za-z0-9.]+)+$` (e.g. `MVP-6.1-analytics-dashboard`). Always use the main checkout's directory, by absolute path if working in another git worktree.

**Who writes which section:** Claude writes `brief` (recording Panji), `authority`, `contract`, every `validation`, and `final`. Codex writes every `receipt`. The agent whose turn it is writes `status`, `revision`, `updated_*`, and `history`; `history` is append-only. Codex copies UI/UX reviewer output verbatim into `rounds[n].ui_review` and adds only `builder_response` entries. A new round `{n, contract_version, receipt: null, ui_review: null, validation: null}` is appended by Claude on every move to `contract_ready` or `changes_requested`.

**State machine.** The current `status` decides whose turn it is. Only that agent may write the file.

| From | To | By | Guard |
|---|---|---|---|
| (new) | `draft` | Claude | brief recorded |
| `draft` | `contract_ready` | Claude | `api`, `ui`, `allowed_files`, `acceptance` complete; baseline captured |
| any | `needs_panji` | Claude | open product/scope/architecture question |
| `needs_panji` | previous state | Claude | Panji's answer in `brief.decisions` |
| `contract_ready` / `changes_requested` | `in_frontend` | Codex | contract (and latest validation) read |
| `in_frontend` | `receipt_ready` | Codex | UI/UX review gate met (or `ui_review.skipped` with reason); current round's receipt written; checks run |
| `receipt_ready` | `validating` | Claude | none |
| `validating` | `changes_requested` | Claude | findings listed; new round appended |
| `validating` | `contract_ready` | Claude | change request accepted: `contract.version` bumped, baseline recaptured, new round appended |
| `validating` | `verified` | Claude | `result = pass`; nothing outside `allowed_files` or inside `forbidden_files` |
| `verified` | `reported` | Claude | report sent to Panji; `final` written |
| any | `cancelled` | Claude | on Panji's instruction |

**Every write:** (1) re-read the file; (2) if `revision` differs from what you last read, stop and re-read; (3) set `revision + 1`, `updated_by`, `updated_at`, append `history`; (4) write `<ID>.json.tmp`, then `mv` it over `<ID>.json`.

**Claude:**
- Contract: data refs, exact API/service/action signatures and types (backend prerequisites done before handoff), UI routes/states/requirements, `allowed_files`, `forbidden_files`, numbered acceptance checks (`AC-n`).
- Baseline, captured right before `contract_ready`: `head` = `git rev-parse HEAD`; `snapshot` = every path from `git status --porcelain=v1 --untracked-files=all` (excluding `.marqos/`) mapped to its `git hash-object`, or `deleted`.
- Validation uses the **actual diff**, never the receipt alone. `actual_files_changed` = paths whose hash differs from the snapshot, plus new dirty paths, plus `git diff --name-only <head> HEAD`. Check it against `allowed_files`/`forbidden_files` and against the receipt (`unreported`, `reported_but_unchanged`). Read the changes. Run the acceptance commands plus lint and typecheck. Decide each change request (`accepted` / `rejected` / `escalated_to_panji`).
- Check the UI/UX review gate and any `skipped` reason, declined MAJORs, and escalations. Do not redo the visual review.
- In the final report, list `principle_candidates` for Panji. Change `.marqos/ui-principles.md` only by transcribing an explicit Panji decision (see UI principles).

**Codex:**
- Pick up only `contract_ready` or `changes_requested` tasks. Read the cited canonical refs, the contract, and on `changes_requested` the latest findings.
- Before building, read `.marqos/ui-principles.md` (active principles and Declined proposals). Apply the relevant ones. If the contract or canonical docs conflict with one, follow the contract and record it in `principles_waived`.
- Edit only `allowed_files`. Consume the signatures as given. If the frontend needs something different, add a `change_requests` entry; never edit services, actions, types, or schema.
- Receipt: complete `files_changed`, `covered` AC IDs, `deviations`, `principles_applied`, `principles_waived`, `checks_run` (at least lint and typecheck).
- Never run `supabase`/database commands, change `package.json` or the lockfile, commit, or push.

**Ownership.** Anything not listed is Claude's.
- Claude: `supabase/**`, `src/server/**`, `src/lib/**`, `src/types/**`, `**/actions.ts`, `**/route.ts`, `src/app/auth/**` logic, `tests/**`, `docs/**`, `package.json`, `package-lock.json`, config files, `AGENTS.md`, `CLAUDE.md`, `.marqos/ui-principles.md`, `.marqos/roles/**` (Codex reads these only).
- Codex: `src/components/**`, `src/app/**/{page,layout,loading,error}.tsx`, `src/app/globals.css`, `public/**` visual assets.
- A contract may grant Codex a Claude-owned path via `allowed_files`. `forbidden_files` always wins. Neither side modifies the other's files without that authorization.

**UI/UX review.** Every meaningful visual implementation passes a UI/UX review before `receipt_ready`. "Meaningful" means a new route or page, a new component, a layout or composition change, a visual-system change (tokens, typography, `globals.css`), or new UI states. It may be skipped only for pure data or wiring fixes, copy typos, or test-only changes, recorded as `ui_review.skipped = "<reason>"`. `changes_requested` rounds need a review only if the fixes are visual, and one final pass is then enough.
- The reviewer is a fresh, read-only Codex session defined by `.marqos/roles/uiux-reviewer.md`. It is not a product authority: it adds no requirements and never overrides the contract or canonical docs.
- Run it from the repo root: `codex exec --sandbox read-only "$(cat .marqos/roles/uiux-reviewer.md) TASK=<TASK-ID> PASS=<initial|final>"`. It prints one JSON review pass.
- Lifecycle: build → `initial` pass → Codex records a `builder_response` per finding (`fixed`; `declined` with reason, allowed for MINOR/SUGGESTION or a disputed MAJOR; or `escalated`, also added to `receipt.change_requests` with `source: "ui_review"`) → `final` pass.
- Gate for `receipt_ready`: the last `final` pass has no open BLOCKER; every MAJOR is fixed, declined with reason, or escalated; `verdict` is not `fail`. After 3 failing final passes, stop and escalate via the receipt.
- Findings with `contract_conflict: true` are escalated, never implemented.

**UI principles.** `.marqos/ui-principles.md` is versioned, persistent MARQOS visual learning. Only Panji approves, changes, or retires principles. Reviewers may only propose `principle_candidates` (a recurring issue in at least 2 tasks, flagged by Panji, or a clear MARQOS-specific convention). Claude lists candidates in the final report and transcribes Panji's decision exactly: approved → new `UIP-###` with source and approval date; declined → one line under Declined proposals; retire → `Status: retired`. No approval, no change. A violation of an active principle is at least MAJOR, unless covered by `principles_waived`.

**Concurrency:** While a task is `in_frontend`, Claude makes no edits in this checkout (parallel backend work goes in a separate `git worktree`). One active frontend task per checkout; concurrent tasks must have non-overlapping `allowed_files`. Neither agent commits or pushes unless Panji says so.

**Task file schema (v2):**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "marqos/coordination-task/v2",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version","task_id","revision","status","updated_by","updated_at",
               "authority","brief","contract","rounds","final","history"],
  "properties": {
    "schema_version": { "const": 2 },
    "task_id":   { "type": "string", "pattern": "^[A-Z][A-Z0-9]*(-[A-Za-z0-9.]+)+$" },
    "revision":  { "type": "integer", "minimum": 1 },
    "status":    { "enum": ["draft","contract_ready","in_frontend","receipt_ready","validating",
                            "changes_requested","verified","reported","needs_panji","cancelled"] },
    "updated_by": { "enum": ["claude","codex","panji"] },
    "updated_at": { "type": "string", "format": "date-time" },

    "authority": {
      "type": "object", "additionalProperties": false, "required": ["canonical_refs"],
      "properties": { "canonical_refs": { "type": "array", "items": { "type": "string" } } }
    },

    "brief": {
      "type": "object", "additionalProperties": false, "required": ["text","decisions"],
      "properties": {
        "text": { "type": "string" },
        "decisions": { "type": "array", "items": {
          "type": "object", "additionalProperties": false, "required": ["question","answer","at"],
          "properties": { "question": {"type":"string"}, "answer": {"type":"string"},
                          "at": {"type":"string","format":"date-time"} } } }
      }
    },

    "contract": {
      "type": "object", "additionalProperties": false,
      "required": ["version","summary","data_refs","api","ui","allowed_files","forbidden_files",
                   "acceptance","baseline","handoff_notes"],
      "properties": {
        "version": { "type": "integer", "minimum": 0 },
        "summary": { "type": "string" },
        "data_refs": { "type": "array", "items": {
          "type": "object", "additionalProperties": false, "required": ["path","what"],
          "properties": { "path": {"type":"string"}, "symbol": {"type":"string"}, "what": {"type":"string"} } } },
        "api": { "type": "array", "items": {
          "type": "object", "additionalProperties": false,
          "required": ["kind","path","symbol","signature","auth","errors"],
          "properties": {
            "kind": { "enum": ["server_action","service","route_handler","type"] },
            "path": {"type":"string"}, "symbol": {"type":"string"},
            "signature": {"type":"string"}, "auth": {"type":"string"},
            "errors": { "type": "array", "items": {"type":"string"} } } } },
        "ui": {
          "type": "object", "additionalProperties": false, "required": ["routes","states","requirements"],
          "properties": {
            "routes": { "type": "array", "items": {
              "type": "object", "additionalProperties": false, "required": ["route","file","purpose"],
              "properties": { "route": {"type":"string"}, "file": {"type":"string"}, "purpose": {"type":"string"} } } },
            "states": { "type": "array", "items": {"type":"string"} },
            "requirements": { "type": "array", "items": {"type":"string"} } } },
        "allowed_files":   { "type": "array", "items": {"type":"string"} },
        "forbidden_files": { "type": "array", "items": {"type":"string"} },
        "acceptance": { "type": "array", "items": {
          "type": "object", "additionalProperties": false, "required": ["id","check"],
          "properties": { "id": {"type":"string","pattern":"^AC-[0-9]+$"}, "check": {"type":"string"},
                          "command": {"type":"string"} } } },
        "baseline": {
          "type": ["object","null"], "additionalProperties": false,
          "required": ["head","captured_at","snapshot"],
          "properties": {
            "head": {"type":"string","pattern":"^[0-9a-f]{40}$"},
            "captured_at": {"type":"string","format":"date-time"},
            "snapshot": { "type": "object",
              "additionalProperties": { "type": "string", "pattern": "^([0-9a-f]{40}|deleted)$" } } } },
        "handoff_notes": { "type": "string" }
      }
    },

    "rounds": { "type": "array", "items": {
      "type": "object", "additionalProperties": false,
      "required": ["n","contract_version","receipt","ui_review","validation"],
      "properties": {
        "n": {"type":"integer","minimum":1},
        "contract_version": {"type":"integer","minimum":1},
        "receipt": { "type": ["object","null"], "additionalProperties": false,
          "required": ["files_changed","covered","deviations","change_requests","principles_applied",
                       "principles_waived","checks_run","submitted_at"],
          "properties": {
            "files_changed": { "type": "array", "items": {"type":"string"} },
            "covered": { "type": "array", "items": {"type":"string","pattern":"^AC-[0-9]+$"} },
            "deviations": { "type": "array", "items": {"type":"string"} },
            "change_requests": { "type": "array", "items": {
              "type": "object", "additionalProperties": false, "required": ["target","request","reason"],
              "properties": { "target": {"type":"string"}, "request": {"type":"string"}, "reason": {"type":"string"},
                              "source": { "enum": ["frontend","ui_review"] } } } },
            "principles_applied": { "type": "array", "items": {"type":"string","pattern":"^UIP-[0-9]{3}$"} },
            "principles_waived": { "type": "array", "items": {
              "type": "object", "additionalProperties": false, "required": ["id","reason"],
              "properties": { "id": {"type":"string","pattern":"^UIP-[0-9]{3}$"}, "reason": {"type":"string"} } } },
            "checks_run": { "$ref": "#/$defs/checks" },
            "notes": {"type":"string"},
            "submitted_at": {"type":"string","format":"date-time"} } },
        "ui_review": { "$ref": "#/$defs/ui_review" },
        "validation": { "type": ["object","null"], "additionalProperties": false,
          "required": ["result","actual_files_changed","outside_allowed","forbidden_touched",
                       "unreported","reported_but_unchanged","findings","checks_run","validated_at"],
          "properties": {
            "result": { "enum": ["pass","changes_requested","needs_panji"] },
            "actual_files_changed":   { "type": "array", "items": {"type":"string"} },
            "outside_allowed":        { "type": "array", "items": {"type":"string"} },
            "forbidden_touched":      { "type": "array", "items": {"type":"string"} },
            "unreported":             { "type": "array", "items": {"type":"string"} },
            "reported_but_unchanged": { "type": "array", "items": {"type":"string"} },
            "findings": { "type": "array", "items": {
              "type": "object", "additionalProperties": false, "required": ["id","severity","issue","expected"],
              "properties": { "id": {"type":"string","pattern":"^F-[0-9]+$"},
                "severity": { "enum": ["blocker","major","minor"] },
                "file": {"type":"string"}, "line": {"type":"integer"},
                "issue": {"type":"string"}, "expected": {"type":"string"} } } },
            "change_request_decisions": { "type": "array", "items": {
              "type": "object", "additionalProperties": false, "required": ["target","decision","reason"],
              "properties": { "target": {"type":"string"},
                "decision": { "enum": ["accepted","rejected","escalated_to_panji"] },
                "reason": {"type":"string"} } } },
            "checks_run": { "$ref": "#/$defs/checks" },
            "validated_at": {"type":"string","format":"date-time"} } }
      } } },

    "final": { "type": ["object","null"], "additionalProperties": false,
      "required": ["result","report","at"],
      "properties": { "result": { "enum": ["verified","cancelled"] },
                      "report": {"type":"string"}, "at": {"type":"string","format":"date-time"} } },

    "history": { "type": "array", "items": {
      "type": "object", "additionalProperties": false, "required": ["revision","from","to","by","at"],
      "properties": { "revision": {"type":"integer"}, "from": {"type":["string","null"]}, "to": {"type":"string"},
                      "by": { "enum": ["claude","codex","panji"] },
                      "at": {"type":"string","format":"date-time"}, "note": {"type":"string"} } } }
  },
  "$defs": {
    "ui_review": { "type": ["object","null"], "additionalProperties": false, "required": ["skipped","passes"],
      "properties": {
        "skipped": { "type": ["string","null"] },
        "passes": { "type": "array", "items": {
          "type": "object", "additionalProperties": false,
          "required": ["pass","reviewer","at","evidence","viewports","principles_checked","verdict",
                       "findings","builder_response","principle_candidates"],
          "properties": {
            "pass": { "enum": ["initial","final"] },
            "reviewer": { "const": "codex-uiux" },
            "at": {"type":"string","format":"date-time"},
            "evidence": { "enum": ["rendered","code_only"] },
            "viewports": { "type": "array", "items": {"type":"string"} },
            "principles_checked": { "type": "array", "items": {"type":"string","pattern":"^UIP-[0-9]{3}$"} },
            "verdict": { "enum": ["pass","pass_with_minor","fail"] },
            "findings": { "type": "array", "items": {
              "type": "object", "additionalProperties": false,
              "required": ["id","severity","area","location","problem","why","principle_ref","recommendation","contract_conflict"],
              "properties": {
                "id": {"type":"string","pattern":"^UX-[0-9]+$"},
                "severity": { "enum": ["BLOCKER","MAJOR","MINOR","SUGGESTION"] },
                "area": { "enum": ["hierarchy","typography","spacing","density","layout","consistency","responsive",
                                   "interaction","states","accessibility","dashboard_usability","generic_pattern"] },
                "location": { "type": "object", "additionalProperties": false,
                  "properties": { "route": {"type":"string"}, "file": {"type":"string"},
                                  "line": {"type":"integer"}, "viewport": {"type":"string"} } },
                "problem": {"type":"string","minLength":1},
                "why": {"type":"string","minLength":1},
                "principle_ref": { "type": ["string","null"], "pattern": "^UIP-[0-9]{3}$" },
                "recommendation": {"type":"string"},
                "contract_conflict": {"type":"boolean"} } } },
            "builder_response": { "type": "array", "items": {
              "type": "object", "additionalProperties": false, "required": ["finding","action","note"],
              "properties": { "finding": {"type":"string","pattern":"^UX-[0-9]+$"},
                "action": { "enum": ["fixed","declined","escalated"] }, "note": {"type":"string"} } } },
            "principle_candidates": { "type": "array", "items": {
              "type": "object", "additionalProperties": false, "required": ["id","statement","rationale","evidence"],
              "properties": { "id": {"type":"string","pattern":"^PC-[0-9]+$"}, "statement": {"type":"string"},
                "rationale": {"type":"string"}, "evidence": { "type": "array", "items": {"type":"string"} } } } }
          } } }
      } },
    "checks": { "type": "array", "items": {
      "type": "object", "additionalProperties": false, "required": ["command","result"],
      "properties": { "command": {"type":"string"}, "result": { "enum": ["pass","fail","skipped"] },
                      "note": {"type":"string"} } } }
  }
}
```
