---
name: miniapp-ux-check
description: Validate BankManage Telegram Mini App usability for non-technical family users, responsive layouts, touch targets, SIMPLE zero-keyboard flows, and Telegram-specific interaction requirements. Use for UI implementation, review, accessibility, and acceptance testing.
---

# BankManage Mini App UX Check

Use `SPEC.md` and `.github/instructions/ui.instructions.md` as the authority.

For each UI change:

1. Check 360 px, 390 px, and 430 px wide viewports with no horizontal overflow.
2. Primary touch targets should be at least 52x52 px; secondary touch targets at least 44x44 px.
3. SIMPLE mode must not require typing for ordinary receipt capture, deposit lookup, maturity handling, quick expense recording, or common queries.
4. Keep the primary flow short: photo/tap -> candidate/result -> one clear confirmation or action.
5. Present business language, not accounting/database jargon.
6. Home must prioritize actionable reminders and useful household summaries, not decorative dashboards.
7. Keep animations/sound restrained, optional, fast, and non-blocking. Celebration effects must never delay a financial action or obscure status.
8. Every tap that may take time must give immediate visible feedback; Telegram callback interactions should acknowledge promptly.
9. Error states must state what happened and offer a clear recovery action without exposing stack traces or internal identifiers.
10. Verify Telegram Mini App auth assumptions are server-validated; never trust a client-supplied role or username.
11. Check keyboard, safe-area, viewport, and long-text behavior on iPhone-like screens.
12. Add targeted automated UI/component/browser checks where reliable; otherwise document the exact manual acceptance evidence required.

Reject UI changes that technically work but force routine typing, hide the next action, or make financial state ambiguous.
