---
name: finance-gate
description: Verify BankManage financial correctness, state transitions, ledger integrity, evidence requirements, and exact money/rate calculations. Use for implementation, code review, bug fixes, migrations, and acceptance work touching deposits, transactions, balances, reconciliation, interest, tax, penalties, or settlement.
---

# BankManage Finance Gate

Use `SPEC.md` as the authority. Do not simplify financial rules for convenience.

When reviewing or implementing finance-related changes:

1. Verify money is stored as integer minor units. Never use floating-point values for money.
2. Verify interest, tax, penalty, and rate calculations use exact decimal/integer-safe arithmetic and include the specification test vectors where applicable.
3. Verify term-deposit state transitions follow the specified state machine. Reject undocumented shortcuts.
4. Verify maturity does not create an automatic settlement transaction. A human-selected action and required evidence must exist before closure.
5. Verify renewal creates a successor deposit with predecessor linkage, new evidence, new deposit facts, and an ACTIVE successor before closing the predecessor as RENEWED.
6. Verify redemption/pretermination records settlement account, actual amounts, proof/evidence, certificate disposition, and balanced ledger effects.
7. Verify financial mutations that span state, ledger, reminders, evidence, or successor records are atomic. Failure paths must cause zero partial mutation.
8. Verify corrections to settled financial events are reverse-and-repost rather than destructive edits.
9. Verify transfers are not classified as income or expense and cross-currency transfer is not introduced unless the specification is explicitly changed.
10. Verify reconciliation never silently adjusts balances.
11. Verify settled ledger records are not hard-deleted.
12. Add or update tests for every changed business rule and boundary case.

For a review, report concrete violations with file/line evidence. Do not approve based only on passing tests when the implementation violates `SPEC.md`.
