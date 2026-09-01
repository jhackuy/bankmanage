# BankManage Agent Rules

These rules apply to every AI coding agent working in this repository.

## 1. Source of truth

Read only what the assigned task needs, in this authority order:

1. `SPEC.md`
2. relevant accepted `ADR/*`
3. `CLAUDE.md` when Claude Code is the assigned implementation harness
4. matching path-specific `.github/instructions/*.instructions.md`
5. the assigned GitHub Issue and its acceptance criteria

`.github/copilot-instructions.md` and `.github/agents/*` are fallback compatibility files for a task explicitly assigned to Copilot; they are not the primary BankManage implementation contract.

If sources conflict, `SPEC.md` wins for product/business behavior and the newest accepted ADR wins for architecture. Do not silently reinterpret requirements.

## 2. Work style and context budget

- One implementation Agent owns one Issue/branch/PR at a time.
- Inspect current code before editing, but do not perform an unbounded repository-wide audit.
- Use search first, then open the smallest relevant file set. Do not repeatedly reread unchanged large specifications/files.
- Implement only the assigned Issue; record adjacent improvements instead of expanding scope.
- Prefer the smallest architecture that satisfies the specification.
- Do not add new infrastructure/services without an ADR.
- Do not create parallel duplicate implementations.
- No subagents by default. A task must not fan out merely to explore or review the same code repeatedly.
- Start a fresh bounded Agent session for a new Issue instead of carrying a large previous conversation forward.
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

Any ambiguity that could alter money, tax, maturity, settlement or balances is a blocker: document it instead of guessing.

## 4. Security and public-repository discipline

Never commit real secrets, Telegram IDs, account numbers, certificates, receipts, screenshots or family financial data.

Use only synthetic fixtures. Any secret-shaped string in examples must be obviously fake.

- Validate Telegram webhook secret.
- Validate Mini App initData server-side.
- R2 financial documents stay private.
- Do not expose document object keys as unauthenticated public URLs.
- Unauthorized requests must cause zero mutation.
- Logs must not contain tokens, complete initData, raw financial documents or sensitive document text.
- The implementation model gets only the inference credential needed for that model call. It must not receive GitHub write, Cloudflare deployment, Telegram, or production credentials.
- Git commit/push, PR creation, CI and deployment are deterministic workflow responsibilities, not implementation-model responsibilities.

## 5. Testing

Every behavior change must add/update tests at the lowest useful level.

Minimum before claiming completion:

- format/lint/typecheck for changed code;
- relevant unit tests;
- relevant integration tests;
- fresh migration verification when schema changes;
- build;
- targeted browser/API smoke when UI or routes changed.

Tests must exercise production code paths. Do not create a separate simplified implementation just to make tests pass.

Do not mark PASS if required checks are failing, skipped without justification or not run. In automated Agent work, deterministic workflow steps run the commands and are the authority for pass/fail.

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

An implementation PR must include:

- what changed;
- files/areas changed;
- exact validation commands and results;
- acceptance criteria mapping;
- risks/known limitations;
- any item not completed;
- model/provider route and usage metrics only when the tool/provider actually reports them; unknown values remain `UNKNOWN` rather than estimated.

Keep a single Issue/PR coherent. Do not split work into ceremonial micro-PRs unless isolation is needed for safety, context control or reviewability.
