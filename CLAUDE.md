# BankManage — Claude Code instructions

Claude Code is the primary implementation harness for BankManage. `SPEC.md` is the product/business authority and accepted ADRs are the architecture authority.

## One run, one task

- One Claude run implements exactly one assigned GitHub Issue.
- If `.agent-task/issue.md` exists, read it first. It is the task contract for this run.
- Do not expand scope to nearby cleanup, redesign, dependency upgrades, deployment, or unrelated defects.
- Do not change `SPEC.md` or accepted ADRs unless the assigned Issue explicitly authorizes that governance/product change.
- If a requirement affecting money, tax, maturity, settlement, balances, authorization, or evidence closure is ambiguous, stop and report the blocker instead of guessing.

## Context discipline

- Start with the Issue, then read only the relevant sections of `SPEC.md`, relevant ADRs, `AGENTS.md`, and files directly involved in the task.
- Use `Grep`/`Glob` to locate code before opening large files. Do not perform a repository-wide audit by default.
- Prefer the smallest set of files that completes the vertical slice. Avoid rereading unchanged large files.
- Do not create subagents or parallel investigations. The automation intentionally exposes only bounded repository file tools.
- Do not rely on cross-session memory. Each task starts from a fresh context and project source-of-truth files.

## Architecture and correctness

- TypeScript remains strict; avoid `any` except at narrow validated external boundaries.
- Financial money values use integer minor units. Rates and calculations use deterministic fixed-point/decimal logic; never JavaScript binary floating point for financial outcomes.
- Business/state-machine logic belongs in domain/services, not UI components, HTTP handlers, migrations tests, or fake adapters.
- Keep D1, R2, Cron, Telegram, OCR, and other platform integrations behind adapters/services.
- Migrations are forward-only, deterministic, and must work from a fresh database. Never rewrite an accepted migration.
- Preserve the SIMPLE zero/near-zero-keyboard iPhone/Telegram UX and the two-user authorization model.

## Security

- This repository is public. Use synthetic fixtures only.
- Never read, create, print, or commit real tokens, Telegram IDs, account/certificate numbers, receipts, screenshots, or family financial data.
- Do not access `.env*`, `.dev.vars`, `.wrangler/`, uploads, documents, receipts, or screenshots containing runtime/private material.
- The implementation model must not deploy and must not receive GitHub write, Cloudflare, Telegram, or production credentials.

## Tool boundary

The automated implementation run normally provides only `Read`, `Glob`, `Grep`, `Edit`, and `Write`.

- Do not expect Bash, WebFetch/WebSearch, MCP, browser, GitHub write APIs, or deployment tools.
- Do not weaken code because a tool is unavailable. Make the code change; deterministic workflow steps run formatting, tests, migrations, and builds afterward.

## Completion

Before ending the run:

- make one coherent implementation for the assigned Issue;
- update/add the lowest useful tests when behavior changes;
- avoid placeholder PASS claims or skipped-test claims;
- summarize changed areas and any genuine blocker concisely.

The surrounding GitHub workflow, not Claude, owns formatting, validation, commit/push, PR creation, and final acceptance.
