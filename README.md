# bankmanage

家庭银行存单、资产与日常财务管理工具。

当前阶段：**Cloudflare-first pilot (M0)**。GitHub Copilot cloud agent 是主要开发 Agent，所有实现必须以仓库内 `SPEC.md` 为业务事实源。

## 核心目标

- 银行存单：拍照/识别、利息估算、到期提醒、续存/赎回证据链。
- 家庭资产：按银行、账户、币种汇总；银行配置包含 BDO、BPI、Metrobank、PNB、HSBC，并允许后续新增。
- 日常开支：收据拍照 + 快捷点按；保姆、司机、房屋维修、游泳池维护、买菜等高频家庭支出优先。
- Telegram：仅配置的两位家庭成员使用；Bot 负责提醒，Mini App 负责查看、拍照、确认和处理。
- 统计与提醒优先，操作尽量零键盘。

## 开发方式

`SPEC -> GitHub Issue -> Copilot cloud agent -> Draft PR -> GitHub Actions -> Copilot code review -> merge`

项目规则：

- `SPEC.md`：当前产品与验收规范。
- `ADR/`：架构决策以及对旧规范的显式覆盖。
- `AGENTS.md`：所有 AI Agent 的硬规则。
- `.github/copilot-instructions.md`：Copilot 仓库级规则。
- `.github/instructions/`：按路径加载的开发规则。
- `.github/agents/bankmanage-builder.agent.md`：本项目 Copilot custom agent。

## 公开仓库安全规则

本仓库保持 Public，但**禁止提交真实家庭财务数据或凭据**。以下内容永远只能存在于 GitHub Secrets / Cloudflare Secrets / 测试部署环境：

- Telegram Bot Token、Webhook Secret、真实 Telegram User ID / Chat ID；
- Cloudflare API Token、Account ID 以外的敏感凭据；
- 真实存单、收据、银行 App 截图、账户号码、证书号码；
- 任何密码、PIN、OTP、Cookie、Session、访问令牌；
- 真实家庭财务金额明细或可识别个人的数据。

仓库测试 fixture 必须是人工构造或完全脱敏数据。

---

## Local development

### Requirements

- Node.js ≥ 20, npm ≥ 10
- (Optional for Cloudflare deployment) Wrangler CLI — included as a dev dependency

### Setup

```bash
# 1. Install dependencies
npm ci

# 2. Copy the environment template (no real secrets needed for tests/CI)
cp .dev.vars.example .dev.vars
# Edit .dev.vars only if you need real Telegram/Cloudflare integration locally.
```

### Run all checks

```bash
# Format check
npm run format:check

# Lint
npm run lint

# Strict typecheck (Worker code + test code)
npm run typecheck

# Unit + integration tests (60 tests, no secrets required)
npm test

# Migration check — applies all SQL migrations to a fresh in-memory SQLite DB
npm run migrate:check

# Full production build (Vite UI + Wrangler dry-run)
npm run build
```

### Local development server

```bash
# Start Worker + UI concurrently (requires a .dev.vars file)
npm run dev
```

On a clean checkout the Worker dev process bootstraps `dist/ui` once so Wrangler's
local `ASSETS` binding has a concrete directory, while the Vite server continues to
provide live UI development feedback.

### Run tests in watch mode

```bash
npm run test:watch
```

---

## Project structure

```
bankmanage/
├── data/
│   └── config/
│       └── banks.ts          # System bank seed data (BDO, BPI, Metrobank, PNB, HSBC, Other)
├── migrations/
│   └── 0001_foundation.sql   # D1 schema: households, banks, accounts, categories, currencies
├── scripts/
│   └── migrate-check.mjs     # CI migration verification script
├── src/
│   ├── adapters/
│   │   ├── ocr/              # OCR adapter interface (M3)
│   │   ├── storage/          # R2 document storage interface + fake adapter
│   │   └── telegram/         # Telegram adapter interface + fake adapter
│   ├── worker/
│   │   ├── routes/
│   │   │   └── health.ts     # GET /health — minimal liveness endpoint
│   │   ├── env.ts            # Worker environment bindings type
│   │   └── index.ts          # Hono Worker entry point
│   └── ui/
│       ├── components/       # TabBar, tab definitions
│       ├── pages/            # Home, Receipt, Deposits, Transactions, More
│       ├── styles/           # CSS (360/390/430px responsive, Telegram theme vars)
│       ├── App.tsx           # Root Preact component
│       └── main.tsx          # UI entry point
├── tests/
│   ├── integration/
│   │   └── migration.test.ts # Fresh-DB migration tests (20 assertions)
│   └── unit/
│       ├── auth-boundary.test.ts      # Telegram auth boundary (9 tests)
│       ├── bank-seed.test.ts          # Bank config data (10 tests)
│       ├── fixture-discipline.test.ts # Synthetic fixture checks (6 tests)
│       ├── health-endpoint.test.ts    # /health endpoint (5 tests)
│       └── r2-fake-adapter.test.ts    # R2 fake adapter (10 tests)
├── index.html                # Mini App HTML entry point
├── vite.config.ts            # Vite build config
├── vitest.config.ts          # Vitest test config
├── wrangler.jsonc            # Cloudflare Workers config (pilot env, placeholder IDs)
├── tsconfig.json             # TypeScript config (Worker code)
├── tsconfig.test.json        # TypeScript config (test code, Node types)
└── .dev.vars.example         # Secret variable names template (no values)
```

---

## Cloudflare pilot setup

> These steps require a Cloudflare account and a Telegram Bot. They are not needed for local tests or CI.

### 1. Create D1 database

```bash
npx wrangler d1 create bankmanage-pilot
# Copy the database_id into wrangler.jsonc env.pilot.d1_databases[0].database_id
```

### 2. Apply D1 migrations

```bash
npx wrangler d1 execute bankmanage-pilot --env pilot --file migrations/0001_foundation.sql --remote
```

### 3. Create R2 bucket

```bash
npx wrangler r2 bucket create bankmanage-pilot-docs
```

### 4. Set Cloudflare secrets

```bash
# Never commit real values — set them here only
npx wrangler secret put TELEGRAM_BOT_TOKEN --env pilot
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --env pilot
npx wrangler secret put TELEGRAM_ALLOWED_USER_IDS --env pilot
```

### 5. Deploy

```bash
npm run build
npx wrangler deploy --env pilot
```

---

## Milestones

| Milestone | Status  | Description                                         |
| --------- | ------- | --------------------------------------------------- |
| **M0**    | ✅ Done | Scaffold, CI, D1 schema, adapters, Mini App shell   |
| M1        | Pending | Term deposits, interest calculations, state machine |
| M2        | Pending | Household ledger, quick expenses, reconciliation    |
| M3        | Pending | Private R2 document upload, OCR adapter             |
| M4        | Pending | Telegram webhook, initData auth, Bot reminders      |
| M5        | Pending | Pilot deployment, smoke tests, security review      |
