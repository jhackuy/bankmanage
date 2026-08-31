---
name: pr-closeout
description: Produce evidence-based BankManage pull-request closeout and acceptance reports. Use before marking a PR ready, requesting merge, or declaring a milestone PASS, PASS_WITH_KNOWN_LIMITATIONS, or BLOCKED.
---

# BankManage PR Closeout

Before a PR is considered ready for acceptance:

1. Summarize changed files/areas and the user-visible or architectural effect.
2. Map every Issue/acceptance criterion to concrete implementation evidence.
3. List exact validation commands run and their results.
4. Report GitHub Actions/CI status for the final PR head SHA.
5. Check relevant `SPEC.md`, ADR, `AGENTS.md`, custom instructions, and applicable Agent Skills.
6. For finance changes, apply `finance-gate`.
7. For Mini App/UI changes, apply `miniapp-ux-check`.
8. For release/deploy changes, apply `cloudflare-release`.
9. Identify risks, security/privacy implications, migrations, and known limitations.
10. Do not call a PR PASS merely because it builds. Required behavior and acceptance criteria must be demonstrated.
11. Do not hide skipped tests or unverified assumptions. Mark them explicitly.
12. End with exactly one conclusion: `PASS`, `PASS_WITH_KNOWN_LIMITATIONS`, or `BLOCKED`.

A `PASS` requires all required acceptance criteria and CI checks for the final head to be satisfied with no unresolved correctness/security blockers.
