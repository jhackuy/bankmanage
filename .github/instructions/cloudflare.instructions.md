---
applyTo: "wrangler.jsonc,wrangler.toml,src/adapters/**,src/worker/**,src/routes/**,migrations/**,.github/workflows/**"
---

# Cloudflare runtime instructions

- Follow `ADR/001-cloudflare-first-pilot.md`.
- Keep platform bindings behind typed adapters; do not leak D1/R2 details into financial domain logic.
- D1 schema changes require versioned migrations and a fresh-database migration test.
- R2 evidence buckets/objects are private; serve documents only through authenticated/authorized application routes.
- Cron work must be idempotent. A repeated scheduler invocation cannot create duplicate logical reminders.
- Telegram webhook requests must verify the configured webhook secret before processing payloads.
- Health endpoints expose only minimal liveness/readiness information and no secrets, IDs, SQL errors or environment details.
- Do not add another cloud service or persistence system without an accepted ADR.
- GitHub Actions deployments receive secrets only in deployment jobs. Copilot development tasks should work with fakes/local bindings without real credentials.
