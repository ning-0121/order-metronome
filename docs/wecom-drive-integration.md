# 企业微盘文件归档（P3 — 待你提供凭据后接入）

## 业务目标

订单创建时自动在企业微盘建一个文件夹（命名规则 `{order_no}_{customer_name}`，
例 `QM-20260518-001_Ross Sourcing`），所有该订单上传到系统的附件自动镜像到
这个微盘文件夹。员工可以在 PC 端/手机端的企业微信微盘直接查看，不依赖系统访问。

## 现状

代码已有 WeChat Work App 推送通道（`lib/utils/wechat-push.ts`），用的是
`WECOM_CORP_ID` / `WECOM_CORP_SECRET` / `WECOM_AGENT_ID` 三个 env。
**微盘 API 是另外一个权限**，需要单独开通 + 凭据。

## 准备工作（你这边操作）

### 1. 企业微信管理后台 — 创建微盘应用

打开 https://work.weixin.qq.com → 管理后台 → 应用管理 → 创建应用：
- 应用类型：自建应用
- 名称建议：「订单文件镜像」
- 给应用授予以下权限：
  - **微盘读写**（创建文件夹、上传文件、列文件）
  - **企业通讯录读取**（用于解析员工 userid）

### 2. 准备配置参数

从应用详情页拿到：
- `WECOM_DRIVE_CORP_ID` — 企业 ID（顶部）
- `WECOM_DRIVE_AGENT_ID` — 应用 AgentId
- `WECOM_DRIVE_SECRET` — 应用 Secret（注意：与现有 `WECOM_CORP_SECRET` 不同，要单独配）

进微盘 → 选一个空间作为存放订单文件的根目录：
- `WECOM_DRIVE_SPACE_ID` — 空间 ID（从 URL 或 API 调用获取）
- 或 `WECOM_DRIVE_ROOT_FOLDER_ID` — 根目录 ID（建议建个「订单归档」根文件夹）

### 3. 服务器 IP 白名单

微盘 API 要求服务器 IP 在企业微信信任 IP 列表。
Vercel 是动态 IP — 需要去 Vercel 拿 outbound IP 列表（或用 Fixie / QuotaGuard 等出口代理 → 固定 IP），加进微信管理后台的"企业可信 IP"。

或：用客户端代理（在你的内网服务器上代发），系统调代理服务。

## 把这些值给我后我开始集成

```env
WECOM_DRIVE_CORP_ID=ww_xxxxxxxx
WECOM_DRIVE_AGENT_ID=1000003
WECOM_DRIVE_SECRET=ABC_xxxxxxxx
WECOM_DRIVE_SPACE_ID=or WECOM_DRIVE_ROOT_FOLDER_ID
```

并确认 IP 白名单方式（Vercel 出口 / 反向代理 / 其他）。

## 集成范围（确认凭据后）

| 模块 | 触发点 | 行为 |
|------|--------|------|
| 创建订单 | `orders.ts createOrder` 成功后 | 调微盘 API 在根目录建 `{order_no}_{customer_name}` 文件夹，保存 folder_id 到 `orders.wecom_drive_folder_id` 字段 |
| 文件上传 | 任何附件上传完成后 | 调微盘 API 把文件副本上传到对应订单文件夹 |
| 订单详情页 | 顶部显示「📁 在微盘查看」按钮 | 链接到企业微信微盘 URL |
| 失败容错 | 微盘 API 失败 | 不阻塞主流程，记 `order_logs(action='wecom_drive_sync_failed')` 让 admin 排查 |

## 待办（凭据齐备后）

- [ ] 添加 env vars 到 Vercel
- [ ] 新建 `lib/integration/wecom-drive.ts`（token 缓存、folder API、upload API）
- [ ] migration: `ALTER TABLE orders ADD COLUMN wecom_drive_folder_id text`
- [ ] hook 进 `createOrder` 末尾
- [ ] hook 进 `order_attachments` insert 后（或文件上传 action）
- [ ] UI: 订单详情页加「📁 在微盘查看」按钮
- [ ] 错误处理 + 失败重试机制（cron 每小时扫一次 sync 失败的订单尝试补传）

---

*文档创建：2026-05-18。等凭据 → 开 sprint。*
