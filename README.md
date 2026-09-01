# bankmanage

家庭银行存单、资产与日常财务管理工具。当前阶段：**Cloudflare-first pilot，M0 已完成，M1 开发中**。

所有产品实现必须以 `SPEC.md` 为业务事实源；Accepted ADR 是架构事实源。

## 核心目标

- 银行存单：拍照/识别、利息估算、到期提醒、续存/赎回证据链。
- 家庭资产：按银行、账户、币种汇总；预置 BDO、BPI、Metrobank、PNB、HSBC，并允许自定义银行。
- 日常开支：收据拍照 + 快捷点按；保姆、司机、房屋维修、游泳池维护、买菜等家庭支出优先。
- Telegram：仅配置的两位家庭成员使用；Bot 负责提醒，Mini App 负责查看、拍照、确认和处理。
- 统计与提醒优先，普通使用流程尽量零键盘。

## 开发方式

主流程：

`SPEC -> GitHub Issue -> Claude Code + MiniMax M2.7 -> deterministic validation -> PR -> GitHub CI -> independent acceptance -> merge`

角色：

- `SPEC.md`：产品、金融规则和验收规范。
- `ADR/`：架构决策。
- `AGENTS.md`：所有 AI Agent 的硬规则与安全边界。
- `CLAUDE.md`：Claude Code 的精简项目上下文；不复制整份 SPEC，按需读取。
- `.claude/settings.json`：关闭自动记忆并限制敏感工具/路径。
- `.github/workflows/claude-implement.yml`：Owner 在 Issue 评论 `/claude-build` 后启动实现。
- `.github/workflows/ci.yml`：独立确定性 CI。
- `.github/copilot-instructions.md` / `.github/agents/`：Copilot fallback 兼容文件，不是主开发链路。

### Claude Code + MiniMax

GitHub repository secret 只需要配置推理凭据：

- `MINIMAX_API_KEY`：MiniMax Token Plan 的 `sk-cp` key。

Claude Code 当前走 MiniMax 官方 Anthropic-compatible endpoint，并使用官方文档支持的 `MiniMax-M2.7`。MiniMax M3 虽然属于 Token Plan 可用模型，但当前 Anthropic-compatible interface 的官方 supported-model list 不包含 M3，因此本项目不通过 Claude Code 强行路由 M3。

自动实现流程把该 secret 只暴露给 Claude 模型调用步骤。Claude 不获得 GitHub 写 Token、Cloudflare、Telegram 或生产/部署凭据；commit/push/PR 由模型运行结束后的确定性步骤完成。

Context/token 控制：

- 一个 Issue 一个新会话，不跨任务续长上下文；
- 默认无 subagent、Web/MCP、Bash；
- search-first，只读取相关 SPEC/ADR/代码；
- 自动记忆关闭；
- Claude Code 固定版本，自动更新关闭；
- 约 140k token 主运行自动压缩阈值；
- deterministic validation 失败时最多允许一次新的、较小 repair pass；
- usage 只有 CLI/provider 确实返回时才记录，否则为 `UNKNOWN`。

## 公开仓库安全规则

本仓库是 Public，但禁止提交真实家庭财务数据或凭据：

- Telegram Bot Token、Webhook Secret、真实 User ID / Chat ID；
- Cloudflare API Token 和其他敏感凭据；
- 真实存单、收据、银行 App 截图、账户/证书号码；
- 密码、PIN、OTP、Cookie、Session、访问令牌；
- 可识别个人的家庭财务数据。

仓库测试 fixture 必须人工构造或完全脱敏。

## Local development

Requirements: Node.js 由 `.node-version` 固定，npm 使用 lockfile。

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run format:check
npm run lint
npm run typecheck
npm test
npm run migrate:check
npm run build
```

开发服务器：

```bash
npm run dev
```

`.dev.vars` 只用于本地真实集成且永远不得提交；M0-M3 的正常单元/集成测试默认不需要真实服务凭据。

## Cloudflare pilot

当前技术栈：Cloudflare Workers + Hono + Vite/Preact + D1 + private R2 + Cron Triggers + Telegram Mini App/Bot。

真实部署只允许在已接受代码进入 `main` 后的 deployment job 中使用 GitHub/Cloudflare secrets。PR/Agent 实现阶段必须使用 fake/local bindings，不得连接生产/pilot 凭据。

基础命令：

```bash
npx wrangler d1 create bankmanage-pilot
npx wrangler r2 bucket create bankmanage-pilot-docs
npm run build
npx wrangler deploy --env pilot
```

真实 secret 使用 `wrangler secret put ... --env pilot` 设置，不写入仓库。

## Milestones

- M0 — Done: scaffold, CI, D1 schema, adapters, Mini App shell.
- M1 — In progress: term deposits, interest calculations, state machine, reminders.
- M2 — Pending: household ledger, quick expenses, reconciliation.
- M3 — Pending: private R2 document upload, OCR adapter/benchmark.
- M4 — Pending: Telegram webhook, initData auth, Bot reminders.
- M5 — Pending: pilot deployment, smoke tests, security review.
