# 部署指南（零基础手把手）v2

本指南将把一个 **Serverless 版的 DeepSeek Harness** 从零部署上线。整套架构由四个部分构成：

| 部分 | 作用 | 托管平台 |
| --- | --- | --- |
| 前端 UI | 聊天界面 + 用户引导 | Vercel |
| 引擎 Engine | Agent 核心、路由、SSE 流式响应 | Cloudflare Workers |
| 数据库 DB | 用户 / 会话 / 消息 / 插件配置 | Neon PostgreSQL |
| 沙箱 Sandbox | Bash / Python / 文件系统执行 | E2B |

```
浏览器 → Vercel 前端 ──SSE──▶ Cloudflare Worker（Hono 引擎，持全部密钥）
                                  │
                                  ├──▶ Neon PostgreSQL（Drizzle ORM，user_id 隔离）
                                  ├──▶ E2B 沙箱（命令/代码执行，双层适配器）
                                  └──▶ DeepSeek API（大模型）
```

> **安全原则（5 条护栏贯穿全程）**：
> 1. **数据隔离**：所有数据按 `user_id` 归属，数据库层强制 `WHERE ... AND user_id = ?`，杜绝越权访问（BOLA/IDOR）。
> 2. **防注入**：数据库全参数化（Drizzle ORM），Shell 指令用 `quoteE2BShellArg` 转义。
> 3. **真实依赖**：仅使用 npm 真实存在的包（Hono、Drizzle、zod、e2b）。
> 4. **SSE 兜底**：流式异常必发 `event: error` 并关闭连接，绝不挂起。
> 5. **凭证安全**：所有密钥只放 Workers Secret，代码零明文。

---

## 前置准备

你需要这些账号（均有免费额度）：**GitHub、Neon、Cloudflare、E2B、Vercel、DeepSeek**。

本机需安装：**Node.js 22+**、**pnpm**、**git**。

```sh
node -v   # 应输出 v22 或更高
git --version
```

---

## 第 1 步：配置 Neon 数据库

### 1.1 创建数据库

1. 打开 <https://neon.tech> 注册登录，点击 **Create a project**，命名 `dsh`，选择离你最近的 Region。
2. 在 **Connection string** 面板复制连接串：
   ```
   postgresql://neondb_owner:xxxxx@ep-xxxx.region.aws.neon.tech/dsh?sslmode=require
   ```
   > 此连接串含密码，**务必保密**。

### 1.2 建表（两种方式任选）

**方式 A（推荐，Drizzle 迁移）** —— 在 Worker 目录用 Drizzle 自动生成并应用迁移：

```sh
cd worker
pnpm install
# 用文本编辑器创建 .env，写入：
# DATABASE_URL=postgresql://...
export DATABASE_URL=postgresql://你的连接串
pnpm db:generate   # 根据 src/db/schema.ts 生成迁移
pnpm db:migrate    # 应用到 Neon
```

**方式 B（手动，Neon 控制台）** —— 打开 Neon **SQL Editor**，复制 `worker/sql/schema.sql` 全量粘贴并 **Run**。

两种方式都会创建 4 张表：`users`、`sessions`、`messages`、`plugin_configs`，以及必要的索引。

---

## 第 2 步：部署 Cloudflare Worker（引擎）

### 2.1 安装依赖与本地预览

```sh
cd worker
pnpm install
cp .env.example .dev.vars   # 填入真实值
pnpm wrangler dev
```

打开 <http://localhost:8787/health>，看到 `{"ok":true,...}` 即本地引擎运行成功。

### 2.2 登录 Cloudflare 并配置 Secret

```sh
npx wrangler login
```

然后配置 4 个 **Secret**（加密存储，绝不进版本库）：

```sh
npx wrangler secret put DATABASE_URL          # 第 1.1 步的连接串
npx wrangler secret put E2B_API_KEY           # 见第 3 步
npx wrangler secret put DEEPSEEK_API_KEY      # 见第 5 步
npx wrangler secret put ADMIN_TOKEN           # 引导用户用，任意长随机串
```

生成 `ADMIN_TOKEN` 的命令：
```sh
openssl rand -hex 32        # macOS / Linux
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # Windows
```

### 2.3 配置 CORS 白名单

编辑 `worker/wrangler.json` 的 `vars.ALLOWED_ORIGIN`：

```json
{
  "vars": {
    "ALLOWED_ORIGIN": "https://你的前端域名.vercel.app"
  }
}
```

多个域名用英文逗号分隔。改后部署生效。

### 2.4 部署

```sh
npx wrangler deploy
```

终端会输出 `https://dsh-serverless-engine.<你的子域>.workers.dev`，记下它。

---

## 第 3 步：获取 E2B 沙箱密钥

1. 打开 <https://e2b.dev> 注册。
2. **Dashboard → API Keys → Create**，复制 Key。
3. 已在第 2.2 步通过 `wrangler secret put E2B_API_KEY` 配置。

> 引擎用此 Key 创建安全云沙箱执行 Bash/Python/文件操作，**绝不会把 Key 注入沙箱内部**（密钥隔离）。

---

## 第 4 步：部署 Vercel 前端

前端代码在 `web/`（独立 Vite + React 应用）。

1. 把代码推送到 GitHub。
2. 打开 <https://vercel.com> → **Add New → Project** → 选仓库 → **Import**。
3. 配置：
   - **Root Directory**：`web`
   - **Build Command**：`npm run build`
   - **Output Directory**：`dist`
4. 添加环境变量：

   | Key | Value |
   | --- | --- |
   | `NEXT_PUBLIC_WORKER_URL` | Worker 地址，如 `https://dsh-serverless-engine.xxx.workers.dev` |

5. 点击 **Deploy**。

### 首次使用：引导用户

打开 Vercel 地址，会看到「加入 DeepSeek Harness」页：
1. 输入你的名字。
2. 输入部署时配置的 **ADMIN_TOKEN**（就是第 2.2 步那个）。
3. 点击「生成 API Key」——系统会创建一个用户并返回**仅显示一次**的 API Key。
4. 复制并保存该 Key，点击「开始使用」即进入主界面。

> 之后同一浏览器会自动带上这个 Key（存于 localStorage）。**多用户**：每位用户各自在引导页用同一 ADMIN_TOKEN 注册自己的 Key，彼此数据完全隔离。

---

## 第 5 步：获取 DeepSeek 大模型密钥

1. 打开 <https://platform.deepseek.com> 注册，进入 **API Keys** 创建 Key。
2. 若第 2.2 步已配置 `DEEPSEEK_API_KEY` 则跳过。

> 默认请求 `deepseek-chat`。需自定义地址可加 `DEEPSEEK_BASE_URL` 变量。

---

## 环境变量总表

### Cloudflare Worker（引擎）

| 变量 | 类型 | 作用 | 配置位置 |
| --- | --- | --- | --- |
| `DATABASE_URL` | **Secret** | Neon 连接串 | `wrangler secret put` |
| `E2B_API_KEY` | **Secret** | E2B 沙箱鉴权 | `wrangler secret put` |
| `DEEPSEEK_API_KEY` | **Secret** | DeepSeek 大模型鉴权 | `wrangler secret put` |
| `ADMIN_TOKEN` | **Secret** | 引导创建用户的令牌 | `wrangler secret put` |
| `ALLOWED_ORIGIN` | 普通变量 | CORS 白名单域名 | `wrangler.json` 的 `vars` |
| `DEEPSEEK_BASE_URL`（可选） | 普通变量 | 自定义 DeepSeek 地址 | `wrangler.json` 的 `vars` |
| `E2B_SANDBOX_TIMEOUT_MS`（可选） | 普通变量 | 沙箱存活毫秒数 | `wrangler.json` 的 `vars` |

### Vercel 前端

| 变量 | 类型 | 作用 |
| --- | --- | --- |
| `NEXT_PUBLIC_WORKER_URL` | 公开 | 指向 Worker 公网地址 |

---

## 用户自助 API

注册后，每个用户可通过带自己 API Key 的请求管理自己的数据：

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/users` | POST | 引导创建用户（需 `x-admin-token` 头） |
| `/api/users/me` | GET | 查看自己的资料 |
| `/api/users/me/rotate-key` | POST | 轮换自己的 API Key（旧 Key 立即失效） |
| `/api/users/me` | DELETE | 删除自己的账号及全部数据 |
| `/api/chat` | POST | SSE 流式对话（授权后） |
| `/api/sessions` | GET/POST | 列/建会话（仅自己的） |
| `/api/sessions/:id` | GET/PATCH/DELETE | 会话详情/改名/删除（仅自己的） |
| `/api/plugin-configs` | GET/POST | 插件配置（仅自己的） |

---

## 常见问题排查

**Q：首次打开引导页，生成 Key 报 401？**
`ADMIN_TOKEN` 未正确配置。用 `npx wrangler secret put ADMIN_TOKEN` 重新配置后重新部署。

**Q：前端发消息报 403？**
CORS 白名单未包含前端域名。检查 `ALLOWED_ORIGIN`。

**Q：前端报 401？**
API Key 失效或未配置。到引导页重新注册，或在 Worker 里轮换 Key。

**Q：我能看到别人的会话吗？**
不能。所有查询强制 `AND user_id = <你的ID>`，访问他人资源返回「not found」而非数据。

**Q：命令执行慢？**
首次 E2B 冷启动需几秒，之后复用同一沙箱。可调 `E2B_SANDBOX_TIMEOUT_MS`（默认 300000ms）。

**Q：如何更新代码？**
```sh
cd worker && npx wrangler deploy   # Worker
```
前端提交到 GitHub 后 Vercel 自动重建。

---

## 本地全栈联调（开发者）

1. **引擎**：`cd worker && pnpm wrangler dev`
2. **前端**：`cd web && pnpm dev`（本地地址 `http://localhost:5173`）

本地 `.dev.vars` 的 `ALLOWED_ORIGIN` 需含 `http://localhost:5173`；`NEXT_PUBLIC_WORKER_URL` 本地默认回退到 `http://localhost:8787`。
