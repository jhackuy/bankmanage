---
applyTo: "tests/**,.github/workflows/**"
---

# Test and CI instructions

- Tests must call the same production services/domain code used by routes and UI.
- Use synthetic deterministic fixtures only; never real financial/Telegram data.
- Unit tests cover financial math and state invariants exhaustively where practical.
- Integration tests cover D1/adapters, transactions, idempotency and authorization failure with zero mutation.
- UI changes require targeted browser smoke at 360/390/430 widths and both light/dark states when relevant.
- A migration test must create a fresh database and apply every migration in order.
- CI should remain small and actionable: install/lock verification, lint, typecheck, tests, migration verification, build, targeted smoke.
- Do not hide failures using `continue-on-error`, blanket ignores or tests that only assert mocks were called.
- Report exact skipped tests and why. Required skipped tests mean the PR is not PASS.
