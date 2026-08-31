---
applyTo: "src/ui/**,src/components/**,src/pages/**,src/styles/**,public/**,tests/e2e/**"
---

# Mini App UI instructions

- Optimize first for Telegram Mini App on iPhone at 360/390/430 CSS px.
- Normal MEMBER/SIMPLE flows must not require free-text input.
- Primary actions >=52x52 px; secondary controls >=44x44 px.
- One primary task per screen and at most four preferred actions before secondary choices.
- Show financial confirmations in plain language with the actual action/amount when relevant.
- Support Telegram theme variables, light/dark mode, safe-area insets, BackButton and interrupted network states.
- Prefer fast server/API interactions and minimal JavaScript bundle size; do not add UI libraries for cosmetic convenience.
- Owner celebrations are subtle, optional, respect reduced-motion and must never delay data.
- Accessibility and touch usability take priority over visual novelty.
