# BankManage Project Status

> Last verified: 2026-08-31 UTC.  
> Live work is tracked by GitHub Issues, pull requests, checks and GitHub Projects. This file is the owner-facing visual snapshot; it does not replace `SPEC.md`, ADRs or acceptance evidence.

## Current snapshot

| Item | Verified status |
| --- | --- |
| Authoritative branch | `main` |
| Current milestone | **M0 — GitHub/Cloudflare foundation** |
| Active task | [Issue #1 — M0 scaffold](https://github.com/jhackuy/bankmanage/issues/1) |
| Active delivery | [PR #2 — Copilot M0 implementation](https://github.com/jhackuy/bankmanage/pull/2), Draft, 4 commits / 44 changed files at verification time |
| CI | **Attention required** — latest `CI` run concluded `action_required` |
| Review | **Changes recommended** by Copilot; corrections and re-review required |
| Accepted milestones | **0 / 6** — M0 is active; M1–M5 remain pending |
| Merge state | **Forbidden until CI, Copilot review and ChatGPT acceptance pass** |

## Development workflow

```mermaid
flowchart TD
    S["SPEC / ADR / AGENTS"] --> I["GitHub Issue"]
    I --> C["Copilot cloud agent"]
    C --> P["Draft pull request"]
    P --> CI["GitHub Actions CI"]
    CI --> R["Copilot code review"]
    R --> A["ChatGPT acceptance"]
    A -->|PASS| M["Merge"]
    A -->|RETURN| C
    M --> D["Cloudflare pilot deploy"]
    D --> H["Health and smoke checks"]
```

## Project progress

```mermaid
flowchart TD
    A["✅ Product specification and governance"] --> B["🔵 M0 foundation implementation — Issue 1 / PR 2"]
    B --> C["🟡 M0 CI and review corrections"]
    C --> D["⚪ M0 acceptance and merge"]
    D --> E["⚪ M1 term deposits and reminders"]
    E --> F["⚪ M2 household ledger and quick expenses"]
    F --> G["⚪ M3 documents and OCR"]
    G --> H["⚪ M4 Telegram integration"]
    H --> I["⚪ M5 pilot deployment and acceptance"]

    classDef done fill:#1f883d,stroke:#116329,color:#fff
    classDef active fill:#0969da,stroke:#0550ae,color:#fff
    classDef attention fill:#bf8700,stroke:#9a6700,color:#fff
    classDef pending fill:#d0d7de,stroke:#8c959f,color:#24292f

    class A done
    class B active
    class C attention
    class D,E,F,G,H,I pending
```

## Status meaning

- **Done** requires merged code plus accepted evidence; an open Issue, a commit count or an Agent message is not completion.
- **Active** means implementation is currently advancing.
- **Attention required** means the work can continue but cannot merge.
- **Pending** means the milestone has not entered accepted implementation.
- Update this snapshot only when Issue, PR, CI, review, acceptance or deployment state materially changes.
