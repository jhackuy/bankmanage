# ADR-001 — Cloudflare-first pilot

Status: Accepted  
Date: 2026-08-31

## Context

The first product specification targeted a Synology NAS Docker runtime with SQLite, local OCR, Telegram long polling and Cloudflare Tunnel. The current project goal changes the development experiment: use GitHub products end-to-end for development and minimize deployment/operations while the product is still a non-production pilot with synthetic data.

## Decision

For v1 pilot development and acceptance, use Cloudflare as the runtime platform:

- Cloudflare Workers for API/runtime;
- Hono as the preferred Worker web framework;
- Worker Static Assets / Vite-built Mini App UI;
- D1 for relational application data;
- private R2 for document objects;
- Cron Triggers for reminder scans;
- Telegram webhook to the Worker instead of NAS long polling;
- GitHub Actions + Wrangler for pilot deployment.

The old NAS-only deployment, local SQLite, cloudflared Named Tunnel and Bot long-polling requirements are superseded **only** for this pilot.

## What does not change

The architecture change does not weaken product/business rules:

- two allowlisted Telegram users only;
- Telegram initData verification;
- deterministic money/interest calculation;
- deposit lifecycle and evidence closure gates;
- human confirmation before OCR-derived financial writes;
- idempotency;
- zero-keyboard SIMPLE UX;
- reminders and statistics as primary product value;
- private evidence access;
- no bank credential/API integration.

## Data policy during pilot

- Use only synthetic or fully anonymized data until security and OCR gates pass.
- R2 buckets must not be public.
- D1/R2 are Cloudflare-managed data stores; therefore the old claim that financial data never leaves the NAS is no longer true for this pilot and must not appear in current documentation.
- No real secrets or family financial artifacts may be committed to the public GitHub repository.

## Why this option

- Removes NAS deployment and Tunnel maintenance during product discovery.
- Keeps the runtime small: Worker + D1 + R2 + Cron, without extra queues/databases/servers.
- Integrates cleanly with GitHub Actions and Wrangler.
- Makes the Telegram Mini App HTTPS endpoint stable without home-network dependency.
- Preserves a migration path: domain/service boundaries must avoid Cloudflare-specific business logic so a future NAS/GX10 runtime can replace adapters without rewriting financial rules.

## OCR decision

No OCR provider is pre-approved as accurate enough for finance. Implement an adapter and benchmark Cloudflare-native vision/extraction first on synthetic/anonymized samples. If it misses the acceptance thresholds in `SPEC.md`, use an approved fallback rather than lowering the gate.

## Consequences

Positive:

- faster pilot iteration;
- low operational burden;
- no home-network uptime dependency;
- GitHub-to-Cloudflare deployment is straightforward.

Negative/risks:

- Cloudflare becomes a data processor for pilot data;
- D1/R2 differ from the original SQLite/filesystem implementation;
- OCR may require a second runtime path;
- Cloudflare limits/pricing must be checked before any future real-data deployment.

## Future exit

If the pilot is useful and a later decision requires local-only storage, create a new ADR for NAS/GX10. Business services and tests must remain portable; only persistence, document storage, scheduler and Telegram delivery adapters should need replacement.
