---
name: cloudflare-release
description: Prepare and validate safe BankManage Cloudflare pilot releases using Workers, D1, R2, GitHub Actions, and Telegram runtime configuration. Use for deployment, migration, release, rollback, health checks, and Cloudflare-specific review.
---

# BankManage Cloudflare Release

Follow `ADR/001-cloudflare-first-pilot.md` and `.github/instructions/cloudflare.instructions.md`.

Release sequence:

1. Confirm the target is the `pilot` GitHub Environment and deployment originates from an accepted `main` commit.
2. Run repository-defined install, lint/format, strict typecheck, tests, fresh migration validation, and production build before deployment.
3. Apply D1 migrations before deploying code that requires the new schema. Migrations must be versioned and forward-safe for this pilot.
4. Deploy the Worker using Wrangler/GitHub Actions. Never print, echo, upload, or persist secret values.
5. Run a minimal `/health` check that proves the Worker responds without revealing bindings, environment dumps, account IDs, tokens, or internal stack details.
6. Run D1 smoke checks that prove expected schema/version and basic read/write behavior using synthetic data only.
7. Run R2 smoke checks using a synthetic object. The bucket must remain private; never create unrestricted public document URLs.
8. When Telegram webhook functionality exists, validate webhook-secret handling and a synthetic/controlled Bot API smoke without exposing tokens.
9. Record exact commit SHA, migration version, deployment result, health result, and known limitations.
10. If any required gate fails, stop and report `BLOCKED`; do not bypass the gate or deploy a partially validated release.

Do not add unrelated Cloudflare services. D1, R2, Worker, Cron, and later measured OCR/Container fallback are the allowed pilot primitives unless an ADR explicitly changes this.
