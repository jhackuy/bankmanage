# BankManage — Product & Acceptance Specification

Version: v1.3-claude-minimax-runtime  
Status: AUTHORITATIVE  
Date: 2026-09-01

## 0. Authority and change rule

This specification is based on the first Term Deposit & Daily Finance v1.1 design. It preserves the confirmed financial workflows, simple-family UX, Telegram identity model, evidence-chain rules and acceptance discipline. `ADR/001-cloudflare-first-pilot.md` explicitly replaces only the old NAS-only runtime/deployment sections for this pilot.

If code, an Issue, a PR comment or an Agent suggestion conflicts with this file, this file wins unless the Owner explicitly changes the specification. Agents must not silently invent business rules.

## 1. Product definition

BankManage is a private-use family financial manager for exactly two configured Telegram users. It is not a public fintech product and does not connect to bank APIs.

The v1 pilot must answer quickly:

1. What term deposits mature in the next 30/60/90 days?
2. What principal, estimated gross/net interest and maturity amount are expected?
3. Where is family money held, grouped by bank/account/currency?
4. How much was spent this month and on what?
5. What needs attention today?

The main interface is a Telegram Mini App optimized for iPhone. The Bot provides reminders and fast entry points.

## 2. Users and authorization

Exactly two Telegram identities are configured for the pilot:

- OWNER: full access, financial confirmation, settlement, settings and corrections.
- MEMBER: SIMPLE UI, photo entry, quick expenses, reminders and permitted views.

Rules:

- No public registration, invitation flow, OAuth or organization/multi-tenant model.
- Every Mini App API request validates original Telegram `initData`, signature freshness and allowlisted identity server-side.
- Never trust `initDataUnsafe`, username, display name or a client-submitted role for authorization.
- Every Bot command/callback and webhook update is checked against the allowlist.
- Unauthorized requests return 403 with zero financial mutation.

## 3. Asset and bank management

The system tracks family funds using accounts and term-deposit asset accounts.

Seed bank choices must include:

- BDO
- BPI
- Metrobank
- PNB
- HSBC
- Other / custom bank

Bank names are configuration data, not an enum that requires a code deployment to extend.

Account types:

- BANK
- CASH
- E_WALLET
- CREDIT_CARD
- TERM_DEPOSIT
- INTERNAL

Every account has currency, owner/member association, opening balance, active/archive state and reconciliation metadata. Different currencies must never be silently summed as if 1:1.

## 4. Term-deposit workflow

### 4.1 Facts and calculations

A deposit records at minimum:

- bank/product/nickname;
- holder;
- currency;
- certificate number last four only;
- principal in integer minor units;
- start date;
- official maturity date;
- annual rate;
- SIMPLE/COMPOUND interest method;
- ACT/365, ACT/360 or ACT/ACT day-count basis;
- tax rate and fees;
- optional bank-quoted gross interest/net interest/maturity amount;
- maturity instruction;
- predecessor/successor relationship;
- source evidence.

Money must never use binary floating point. Store money as integer minor units and rates as fixed integer scale; use deterministic decimal/fixed-point calculations.

System calculations are estimates. Bank-confirmed contractual facts and final settlement evidence always take precedence.

Required regression vectors:

- PHP 100,000, 5% annual, 90 days, ACT/365, 20% tax -> gross 1,232.88; tax 246.58; net 986.30; maturity 100,986.30.
- Same inputs ACT/360 -> gross 1,250.00; tax 250.00; net 1,000.00; maturity 101,000.00.

### 4.2 State machine

`DRAFT -> REVIEW_REQUIRED -> ACTIVE -> MATURED_ACTION_REQUIRED`

Terminal business outcomes:

- SETTLED_TO_ACCOUNT
- RENEWED
- PRETERMINATED
- CANCELLED (draft only)

Terminal records are never physically deleted.

### 4.3 Maturity closure gates

A matured deposit cannot be closed with a generic "void" button.

If RENEWED:

- upload/capture the new certificate, Renewal Advice or equivalent bank evidence;
- confirm new principal, rate, start date and maturity date;
- create a successor deposit linked to the predecessor;
- record where interest went;
- only then may the old deposit become RENEWED.

If SETTLED_TO_ACCOUNT or PRETERMINATED:

- select the settlement account;
- capture settlement/credit evidence;
- confirm actual settlement date, actual received total, interest, tax, penalty/fees as applicable;
- create balanced ledger entries;
- only then may the old deposit enter a terminal state.

Failure anywhere in a financial closure must cause zero partial financial state.

## 5. Reminders

Default term-deposit reminders: D-30, D-7, D-1 and D0.

Reminder actions are button-first:

- View deposit
- Remind tomorrow
- Remind in 7 days
- Process maturity
- Mute future messages

Muting Telegram messages never changes the deposit business state. A matured unresolved deposit remains visible as an action item until the evidence/ledger closure is complete.

The reminder scheduler must be idempotent and recover missed reminders after temporary outages without duplicate logical reminders.

## 6. Daily household finance

The normal MEMBER path is zero-keyboard or near-zero-keyboard.

Primary entry choices:

- Take receipt photo
- Quick expense
- Income
- Transfer

### 6.1 Quick household expenses

Provide one-tap/few-tap favorites suitable for real household use. Seed at least:

- Nanny / house helper salary
- Driver salary
- House repair
- Home maintenance
- Pool cleaning / maintenance
- Groceries / wet market
- Household supplies
- Electricity
- Water
- Internet / mobile
- Fuel
- Parking / tolls
- Dining
- Children / school
- Medical
- Pet
- Entertainment
- Travel
- Tips / small cash expense
- Other

OWNER can edit favorites and categories. Frequently used categories/accounts should rise to the front without creating an opaque automatic accounting rule.

A quick-expense normal path should require at most: amount candidate/keypad -> category -> payment account -> confirm. Receipt OCR paths should require even less typing where recognition succeeds.

### 6.2 Receipt flow

`capture -> store original privately -> extract candidates -> review -> category/account -> human confirmation -> ledger`

Extract candidate fields:

- total amount;
- date;
- merchant/payee;
- currency;
- payment method candidate;
- optional tax / receipt last4.

OCR/vision is an assistant, never the financial source of truth. A low-confidence amount/date cannot auto-post. Failure provides actionable buttons: retake, choose another photo, send to OWNER review.

Detect exact duplicate images by hash and warn on near duplicates such as same merchant/date/amount.

## 7. Ledger and reconciliation

User-facing transaction types:

- INCOME
- EXPENSE
- TRANSFER

The implementation may use balanced double-entry internally, but SIMPLE UI must not expose accounting jargon.

Rules:

- transfers do not count as income or expense;
- opening/settling term-deposit principal is an asset transfer, not income;
- interest is income;
- tax/penalties/bank fees are expense;
- posted transactions are not hard-deleted; corrections use void/reversal semantics with traceability;
- every transaction currency must balance.

Reconciliation compares bank-confirmed balance with cleared ledger balance. A non-zero difference is displayed and never silently repaired by inserting an adjustment.

## 8. Dashboard and statistics

Statistics and reminders are the product priority.

OWNER home must show:

- this-month income, expense and net by currency;
- asset/account totals by bank and currency;
- bank distribution including term-deposit principal;
- deposits maturing in 30/60/90 days;
- expected gross interest, tax/fees and net interest;
- overdue/unresolved maturity actions;
- unreconciled accounts;
- recent transactions;
- household expense category breakdown.

SIMPLE home must show only the most useful actions:

- large `Take receipt` action;
- Today;
- This month;
- Deposits due soon;
- Money by bank/account;
- at most three personal action cards.

Reports v1:

1. monthly income/expense/net;
2. expense-category breakdown and drilldown;
3. assets/accounts by bank and currency plus reconciliation status;
4. term-deposit maturity calendar/timeline for 30/60/90 days.

No stock/fund/crypto prices, investment advice, portfolio risk score or live FX aggregation in v1.

## 9. Telegram UX

Bot responsibilities:

- private reminders;
- open the Mini App at the relevant object/action;
- receipt-photo shortcut;
- lightweight status summaries.

Mini App responsibilities:

- dashboard;
- capture/review receipts;
- deposits list/detail/maturity processing;
- transactions;
- statistics/reports;
- settings permitted by role.

The Bot must acknowledge callbacks promptly before slow work. Duplicate button taps must not duplicate financial writes.

## 10. Mobile UX rules

Target widths: 360, 390 and 430 CSS px.

- Primary touch targets >= 52x52 CSS px; secondary >= 44x44.
- SIMPLE mode body text >= 17 px; key amounts clearly larger.
- One primary task per screen; do not create dashboard walls.
- Use icon + short human-language label, never icon-only critical actions.
- Support Telegram light/dark theme, safe area, BackButton and network interruption.
- No required free-text input in the normal SIMPLE workflow.
- Financial confirmation buttons state the action and amount, not generic `OK`.

### 10.1 Owner emotional-value microinteractions

The OWNER experience may provide restrained positive feedback:

- subtle entry animation when opening the dashboard;
- optional short sound/haptic for meaningful milestones such as successful reconciliation, completed maturity handling or a clean "nothing urgent" state;
- small celebratory effect for important completed tasks.

Rules:

- sound must be opt-in or easy to mute;
- never autoplay loud audio on every open;
- animation must not delay financial information or degrade responsiveness;
- reduced-motion preference must be respected;
- no gambling-like or manipulative reward loops.

## 11. Cloudflare pilot runtime

Authoritative runtime decision is detailed in `ADR/001-cloudflare-first-pilot.md`.

Preferred pilot stack:

- TypeScript;
- Cloudflare Workers;
- Hono API/runtime;
- Vite + Preact (or an equally small approved UI layer) for the Mini App;
- D1 for relational application data;
- private R2 for receipt/deposit/settlement documents;
- Cron Triggers for reminder scans;
- Telegram webhook to Worker;
- GitHub Actions + Wrangler for deployment.

Do not add Redis, Kafka, Celery, Kubernetes, Supabase, Firebase, Neon or a second application backend without a new ADR.

R2 objects are private. Financial documents are never served through an unrestricted public bucket URL.

## 12. OCR technical gate

The OCR/extraction provider must be behind an adapter interface.

Cloudflare-native image/vision extraction may be evaluated first for the pilot, but it is not considered accepted simply because it returns text.

Acceptance on at least 20 synthetic or fully anonymized representative receipts/deposit documents:

- amount correctness >= 95%;
- date correctness >= 90%;
- every incorrect critical result is intercepted by review and causes zero incorrect automatic posting;
- record latency and cost;
- record failure modes for blur, glare, crop, rotation and multi-language documents.

If the Cloudflare-native approach misses the gate, use a documented fallback (for example PaddleOCR in an approved container/runtime) rather than lowering the acceptance threshold.

No real family document is used until the pilot security and OCR gates pass.

## 13. Public repository security

This repository is intentionally Public during development.

Never commit:

- real Telegram IDs/chat IDs/tokens;
- Cloudflare API tokens;
- real financial documents;
- real account/certificate numbers;
- passwords, PINs, OTPs, cookies or sessions;
- identifiable family financial datasets.

Only synthetic/anonymized test fixtures are allowed.

Production/pilot secrets must come from GitHub Actions Secrets and/or Cloudflare Worker secrets. Tests must use fake adapters and deterministic fixtures by default.

## 14. Development governance

Development is GitHub-native and Claude-Code/MiniMax-first:

`SPEC -> Issue -> Claude Code + MiniMax -> validated branch -> PR -> GitHub CI -> independent acceptance -> merge`

Rules:

- GitHub Issues/PRs and repository source files are the durable source of truth; Agent chat history is not.
- one implementation Agent owns one Issue/branch/PR at a time;
- no parallel Agents modifying overlapping product code;
- each new Issue starts a fresh bounded Agent session rather than resuming a large prior context;
- Agent discovery is targeted: search first, then read only relevant specification sections and files; no default whole-repository audit;
- subagents, Web/MCP exploration and shell access are disabled in the default implementation run;
- auto memory is disabled for automated implementation runs;
- Claude Code receives only the MiniMax inference credential during model invocation. It must not receive GitHub write, Cloudflare deployment, Telegram, or production credentials;
- deterministic workflow steps, not the model, run formatting/tests/migrations/build, commit/push and PR creation;
- at most one bounded fresh repair pass is allowed after deterministic validation fails; repeated failures stop as a blocker instead of looping and burning tokens;
- CI stays useful and small: lint/typecheck, unit/integration tests, migration/schema verification, build, targeted browser smoke;
- implementation tests call production code paths; no duplicated "test implementation";
- financial rules and state machines live in services/domain code, not UI templates/components;
- a PR cannot claim PASS when tests are skipped/failing or acceptance evidence is absent;
- model/provider usage values are recorded only when reported by the provider/CLI; unknown usage stays `UNKNOWN` and is never estimated;
- do not create ceremonial gates or dozens of micro Issues. Split only when a slice is genuinely too broad for safe implementation/review/context control.

Primary automation is the owner-only `/claude-build` Issue command. Copilot remains an optional fallback tool but Copilot quota/review is not a BankManage merge gate.

## 15. First development milestones

### M0 — GitHub/Cloudflare foundation

- project scaffold;
- Worker + Hono + UI shell;
- D1 schema/migrations;
- R2 private document adapter;
- configuration and fake Telegram adapter;
- GitHub Actions CI;
- Wrangler configuration for a `pilot` environment;
- synthetic seed data;
- health endpoint;
- responsive Telegram Mini App shell.

M0 must not require any real secret to run tests.

### M1 — Term deposits and reminders

- deposit CRUD through service/domain layer;
- deterministic interest calculations;
- state machine and closure gates;
- D-30/D-7/D-1/D0 reminder records;
- dashboard maturity statistics.

### M2 — Household ledger and quick expenses

- accounts/categories;
- income/expense/transfer;
- quick household categories/favorites;
- reconciliation;
- reports/statistics.

### M3 — Documents and OCR

- private R2 upload/preview path;
- duplicate detection;
- OCR adapter and benchmark gate;
- receipt/deposit/settlement review flows.

### M4 — Telegram integration

- webhook secret verification;
- two-user allowlist;
- Mini App initData authentication;
- Bot reminders/buttons;
- idempotent writes and callback UX.

### M5 — Pilot deployment and acceptance

- GitHub Actions deployment to Cloudflare pilot;
- synthetic-data browser/mobile smoke at 360/390/430;
- reminder test;
- security leakage check;
- OCR benchmark report;
- final limitations report.

## 16. Definition of done

Final status is one of:

- PASS
- PASS_WITH_KNOWN_LIMITATIONS
- BLOCKED

Never replace these with vague wording such as "mostly done".

Core blockers include incorrect financial math, broken evidence closure gates, duplicate writes, authorization bypass, private-document exposure, OCR auto-posting errors, reminder loss/duplication, unusable SIMPLE mobile flow, or failed CI/build.
