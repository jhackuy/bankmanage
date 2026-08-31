# GitHub Copilot instructions — BankManage

You are the primary implementation agent for BankManage. Follow `SPEC.md` and `AGENTS.md` exactly.

## Repository workflow

- Work from one assigned GitHub Issue at a time.
- Start by reading `SPEC.md`, relevant ADRs and the Issue acceptance criteria.
- Inspect existing code/tests before changing files.
- Implement a complete vertical slice for the Issue, not unrelated cleanup.
- Raise/update one coherent PR and keep it reviewable.
- Never silently change product requirements to fit an implementation.

## Technical direction

Current pilot target:

- TypeScript on Cloudflare Workers;
- Hono for HTTP/API routing;
- Vite with a small UI layer (prefer Preact unless repository reality already chose an equivalent approved approach);
- D1 for relational data;
- private R2 for documents;
- Cron Triggers for reminder scans;
- Telegram webhook + Mini App;
- Vitest or an equivalent Worker-compatible test runner; Playwright for targeted browser smoke;
- GitHub Actions for CI/deploy and Wrangler for Cloudflare configuration.

Keep domain/business logic platform-neutral where practical. Isolate D1, R2, Cron and Telegram behind adapters/services so a future NAS/GX10 runtime can replace them without rewriting financial rules.

## Code quality

- Strict TypeScript; avoid `any` except at narrow external boundaries with validation.
- Validate external input at boundaries.
- Prefer explicit domain types and small functions.
- Financial calculations: integer minor units/fixed-point only; never JS float arithmetic for financial outcomes.
- Service/domain layer owns financial state transitions and invariants.
- Routes translate requests/responses; UI renders state and sends intents; neither owns financial formulas.
- Migrations are forward, deterministic and tested against a fresh database.
- Avoid speculative abstractions and excessive folders.

## Security

This repository is public. Never commit real secrets or real financial/identity data.

Tests and seeds use synthetic values only.

Never print or persist secrets in logs. Do not include complete Telegram initData, raw OCR text from real documents, tokens or document contents in error messages.

No task should require Agent Secrets by default. Deployment credentials belong to GitHub Actions Secrets / Cloudflare Secrets and downstream deployment jobs, not the Copilot agent runtime.

## UI

The ordinary MEMBER must be able to operate with taps and camera input rather than typing. Optimize for iPhone Telegram WebView, including 360/390/430 px widths, safe areas and dark/light themes.

Do not add decorative complexity that slows the app. Owner micro-celebrations must be subtle, optional, accessible and non-blocking.

## Verification and PR report

Before claiming the task is complete, run all checks relevant to the final state. The PR description must list exact commands and pass/fail counts/results. Explicitly disclose skipped checks, limitations or blockers.

A failing or unrun required check is not PASS.
