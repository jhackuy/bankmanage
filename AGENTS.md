# BankManage Agent Rules

These rules apply to every AI coding agent working in this repository.

## 1. Source of truth

Read these before implementation:

1. `SPEC.md`
2. relevant `ADR/*`
3. `.github/copilot-instructions.md`
4. path-specific `.github/instructions/*.instructions.md`
5. the assigned Issue and its acceptance criteria

If they conflict, `SPEC.md` wins for product/business behavior and the newest accepted ADR wins for architecture. Do not silently reinterpret requirements.

## 2. Work style

- Inspect the current repository state before editing.
- Implement only the assigned Issue; record adjacent improvements instead of expanding scope.
- Prefer the smallest architecture that satisfies the specification.
- Do not add new infrastructure/services without an ADR.
- Do not create parallel duplicate implementations.
- Keep business logic out of UI components, route handlers and tests.
- Use adapters around Cloudflare-specific persistence/storage/scheduler/Telegram integrations.
- Do not rewrite accepted product UX based on subjective taste.

## 3. Financial correctness

- Never use JavaScript floating-point arithmetic for stored/calculated money or rates.
- Use integer minor units and deterministic fixed-point/decimal logic.
- Transfers and term-deposit principal movement are not income/expense.
- Terminal term-deposit states require the evidence/ledger closure gates in `SPEC.md`.
- OCR/vision output never directly posts a financial transaction or finalizes a deposit.
- Financial writes must be atomic and idempotent.
- Posted records are not hard-deleted.

Any ambiguity that could alter money, tax, maturity, settlement or balances is a blocker: document it in the PR instead of guessing.

## 4. Security and public-repository discipline

Never commit real secrets, Telegram IDs, account numbers, certificates, receipts, screenshots or family financial data.

Use only synthetic fixtures. Any secret-shaped string in examples must be obviously fake.

- Validate Telegram webhook secret.
- Validate Mini App initData server-side.
- R2 financial documents stay private.
- Do not expose document object keys as unauthenticated public URLs.
- Unauthorized requests must cause zero mutation.
- Logs must not contain tokens, complete initData, raw financial documents or sensitive document text.

## 5. Testing

Every change must add/update tests at the lowest useful level.

Minimum before claiming completion:

- lint/typecheck for changed code;
- relevant unit tests;
- relevant integration tests;
- build;
- targeted browser/API smoke when UI or routes changed.

Tests must exercise production code paths. Do not create a separate simplified implementation just to make tests pass.

Do not mark PASS if required checks are failing, skipped without justification or not run.

## 6. UX

- iPhone/Telegram Mini App first.
- Verify 360/390/430 CSS px layouts for relevant UI changes.
- Primary touch targets >=52 px, secondary >=44 px.
- SIMPLE flows avoid required free-text entry.
- One primary task per screen.
- Financial confirmations use human-readable action text including the amount when relevant.
- Owner celebratory effects are restrained, optional and never block data display.

## 7. Dependencies

Before adding a dependency:

- confirm it is maintained and compatible with Cloudflare Workers;
- prefer platform/native or small libraries;
- avoid dependency duplication;
- pin/lock through the repository package manager.

Do not add Redis, external databases, Supabase, Firebase, Neon, Kubernetes, queues or a second backend without an accepted ADR.

## 8. PR delivery

A Copilot PR must include:

- what changed;
- files/areas changed;
- exact validation commands and results;
- acceptance criteria mapping;
- risks/known limitations;
- any item not completed.

Keep a single Issue/PR coherent. Do not split work into ceremonial micro-PRs unless isolation is needed for safety or reviewability.
