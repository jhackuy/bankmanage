# bankmanage

[📊 查看开发流程和项目进度](PROJECT_STATUS.md)

家庭银行存单、资产与日常财务管理工具。

当前阶段：**Cloudflare-first pilot**。GitHub Copilot cloud agent 是主要开发 Agent，所有实现必须以仓库内 `SPEC.md` 为业务事实源。

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
