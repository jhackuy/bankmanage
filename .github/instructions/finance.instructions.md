---
applyTo: "src/domain/**,src/services/**,src/db/**,migrations/**,tests/**/*finance*,tests/**/*deposit*,tests/**/*ledger*"
---

# Financial-domain instructions

- Treat `SPEC.md` financial invariants as executable requirements.
- Money is integer minor units. Rates use an explicit integer scale. Never calculate financial outcomes with JavaScript floating point.
- Keep deterministic calculation helpers pure and heavily unit tested.
- Enforce legal term-deposit state transitions in one domain/service path.
- Settlement/renewal/pretermination must be atomic and idempotent.
- A terminal deposit state must not exist without the required evidence and balanced ledger effects.
- Transfers and principal movements are not income/expense; interest is income; taxes/penalties/fees are expense.
- Never hard-delete posted financial history.
- Any corrective operation leaves traceable reversal/audit information.
- A test must prove both successful transitions and rejected transitions with zero partial mutation.
