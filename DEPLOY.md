# 部署指南（零基础手把手）v3 — 无卡免费架构

本指南将把一个 **Serverless 版的 DeepSeek Harness** 从零部署上线，**100% 免费、零银行卡门槛**。整套架构由四个部分构成：

| 部分 | 作用 | 托管平台 |
| --- | --- | --- |
| 前端 UI | 聊天界面 + 用户引导 | Vercel |
| 引擎 Engine | Agent 核心、路由、SSE 流式响应 | Cloudflare Workers |
| 数据库 DB | 用户 / 会话 / 消息 / 插件配置 | Neon PostgreSQL |
| 沙箱 Sandbox | Bash / Python / 文件系统执行 | **Hugging Face 免费 Gradio/Python Space** |

```
浏览器 → Vercel 前端 ──SSE──▶ Cloudflare Worker（Hono 引擎，持全部密钥）
                                  │
                                  ├──▶ Neon PostgreSQL（Drizzle ORM，user_id 隔离）
                                  ├──▶ Hugging Face 免费 Gradio 沙箱（命令/代码执行，HTTP）
                                  └──▶ DeepSeek API（大模型）
```

> **为什么不用 E2B / Docker**：E2B 和 HF 的 Docker 模式都需要绑定信用卡/Billing。本项目把代码沙箱外包给 **Hugging Face Spaces（Gradio/Python 免费模式）** 自建的 API，完全免费、零绑卡、零银行卡门槛。

> **安全原则（5 条护栏贯穿全程）**：
> 1. **数据隔离**：所有数据按 `user_id` 归属，数据库层强制 `WHERE ... AND user_id = ?`，杜绝越权访问（BOLA/IDOR）。
> 2. **防注入**：数据库全参数化（Drizzle ORM），沙箱指令做参数转义。
> 3. **真实依赖**：仅使用 npm / PyPI 真实存在的包（Hono、Drizzle、zod、FastAPI）。
> 4. **SSE 兜底**：流式异常必发 `event: error` 并关闭连接，绝不挂起。
> 5. **凭证安全**：所有密钥只放 Workers Secret，代码零明文。

---

## 前置准备

你需要这些账号（均有免费额度）：**GitHub、Hugging Face、Neon、Cloudflare、Vercel、DeepSeek**。

本机需安装：**Node.js 22+**、**pnpm**、**git**。

```sh
node -v   # 应输出 v22 或更高
git --version
```

---

## 第 1 步：部署 Hugging Face 免费沙箱（Gradio/Python 模式）

> 这是替代 E2B 的核心。我们在 Hugging Face 上部署一个 **Gradio / Python 模式**（免费、零绑卡）的沙箱服务，它通过 HTTP 接收并执行 Bash / Python / 文件系统操作。
>
> ⚠️ **避开绑卡**：HF 的 **Docker** 模式需要绑定 Billing 账户；**Gradio / Python** 模式完全免费、无需绑卡。我们使用后者。

### 1.1 新建 Space

1. 打开 <https://huggingface.co/new-space>（需先注册 Hugging Face，免费）。
2. 填写：
   - **Owner**：你的账号
   - **Space name**：例如 `dsh-sandbox`
   - **License**：MIT
   - **SDK**：选 **Gradio**
3. 点击 **Create Space**。

### 1.2 上传沙箱代码

创建成功后，Space 会生成一个 Git 仓库。把 `apps/serverless-worker/sandbox-hf/` 目录下的 **2 个文件**推送到这个 Space 仓库：

- `app.py`
- `requirements.txt`

推送方式（在沙箱代码目录内）：
```sh
cd apps/serverless-worker/sandbox-hf
git init
git add app.py requirements.txt
git commit -m "sandbox"
# 关联你的 Space 仓库（替换为你的实际地址）
git remote add origin https://huggingface.co/spaces/<你的用户名>/dsh-sandbox
git push -u origin main
```

### 1.3 配置密钥并等待启动

1. 回到 Space 页面，进入 **Settings → Variables and secrets**。
2. 添加一个 **Secret**：
   - Key：`SANDBOX_SECRET`
   - Value：一串随机的长字符串（例如 `openssl rand -hex 32` 的输出）
3. Space 会自动安装 `requirements.txt` 依赖并启动。等状态变为 **Running**。

### 1.4 获取沙箱公网地址

Space 运行后，公网地址形如：
```
https://<你的用户名>-dsh-sandbox.hf.space
```
访问该地址应看到一个 Gradio 测试界面；访问 `/health` 看到 `{"ok":true,...}` 即沙箱就绪。**记下这个地址**，第 2 步会用。

---

## 第 2 步：配置 Neon 数据库

### 2.1 创建数据库

1. 打开 <https://neon.tech> 注册登录，点击 **Create a project**，命名 `dsh`，选择离你最近的 Region。
2. 在 **Connection string** 面板复制连接串：
   ```
   postgresql://neondb_owner:xxxxx@ep-xxxx.region.aws.neon.tech/dsh?sslmode=require
   ```
   > 此连接串含密码，**务必保密**。

### 2.2 建表（两种方式任选）

**方式 A（推荐，Drizzle 迁移）** —— 在 Worker 目录用 Drizzle 自动生成并应用迁移：

```sh
cd apps/serverless-worker
pnpm install
# 用文本编辑器创建 .env，写入：
# DATABASE_URL=postgresql://...
export DATABASE_URL=postgresql://你的连接串
pnpm db:generate   # 根据 src/db/schema.ts 生成迁移
pnpm db:migrate    # 应用到 Neon
```

**方式 B（手动，Neon 控制台）** —— 打开 Neon **SQL Editor**，复制 `apps/serverless-worker/sql/schema.sql` 全量粘贴并 **Run**。

两种方式都会创建 4 张表：`users`、`sessions`、`messages`、`plugin_configs`，以及必要的索引。

---

## 第 3 步：部署 Cloudflare Worker（引擎）

### 3.1 安装依赖与本地预览

```sh
cd apps/serverless-worker
pnpm install
cp .env.example .dev.vars   # 填入真实值
pnpm wrangler dev
```

打开 <http://localhost:8787/health>，看到 `{"ok":true,...}` 即本地引擎运行成功。

### 3.2 登录 Cloudflare 并配置 Secret

```sh
npx wrangler login
```

然后配置 **Secret**（加密存储，绝不进版本库）：

```sh
npx wrangler secret put DATABASE_URL          # 第 2.1 步的连接串
npx wrangler secret put DEEPSEEK_API_KEY      # 见第 6 步
npx wrangler secret put ADMIN_TOKEN           # 引导用户用，任意长随机串
npx wrangler secret put HF_SANDBOX_SECRET     # 第 1.3 步设的 SANDBOX_SECRET（与 HF 侧一致）
```

生成 `ADMIN_TOKEN` 的命令：
```sh
openssl rand -hex 32        # macOS / Linux
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # Windows
```

### 3.3 配置 CORS 白名单与沙箱地址

编辑 `apps/serverless-worker/wrangler.json` 的 `vars`：

```json
{
  "vars": {
    "ALLOWED_ORIGIN": "https://你的前端域名.vercel.app",
    "HF_SANDBOX_URL": "https://你的用户名-dsh-sandbox.hf.space"
  }
}
```

> `HF_SANDBOX_URL` 是第 1.4 步得到的沙箱地址（普通变量，非 Secret）。`ALLOWED_ORIGIN` 多个域名用英文逗号分隔。

### 3.4 部署

```sh
npx wrangler deploy
```

终端会输出 `https://dsh-serverless-engine.<你的子域>.workers.dev`，记下它。

---

## 第 4 步：部署 Vercel 前端

前端代码在 `apps/web/vercel/`（独立 Vite + React 应用）。

1. 把代码推送到 GitHub。
2. 打开 <https://vercel.com> → **Add New → Project** → 选仓库 → **Import**。
3. 配置：
   - **Root Directory**：`apps/web/vercel`
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
2. 输入部署时配置的 **ADMIN_TOKEN**（就是第 3.2 步那个）。
3. 点击「生成 API Key」——系统会创建一个用户并返回**仅显示一次**的 API Key。
4. 复制并保存该 Key，点击「开始使用」即进入主界面。

> 之后同一浏览器会自动带上这个 Key（存于 localStorage）。**多用户**：每位用户各自在引导页用同一 ADMIN_TOKEN 注册自己的 Key，彼此数据完全隔离。

---

## 第 5 步：测试沙箱连通

部署完成后，可用 curl 验证沙箱是否被引擎正常调用：

```sh
# 直接测沙箱
curl -X POST https://你的用户名-dsh-sandbox.hf.space/run \
  -H "Content-Type: application/json" \
  -H "X-Sandbox-Secret: <你的SANDBOX_SECRET>" \
  -d '{"lang":"bash","command":"echo hello"}'
# 期望返回 {"stdout":"hello\n","stderr":"","exit_code":0,"timed_out":false}
```

在聊天界面发一句「帮我运行 `echo hello`」即可端到端验证。

---

## 第 6 步：获取 DeepSeek 大模型密钥

1. 打开 <https://platform.deepseek.com> 注册，进入 **API Keys** 创建 Key。
2. 若第 3.2 步已配置 `DEEPSEEK_API_KEY` 则跳过。

> 默认请求 `deepseek-chat`。需自定义地址可加 `DEEPSEEK_BASE_URL` 变量。

---

## 环境变量总表

### Hugging Face Space（沙箱）

| 变量 | 类型 | 作用 | 配置位置 |
| --- | --- | --- | --- |
| `SANDBOX_SECRET` | **Secret** | 沙箱鉴权共享密钥 | Space Settings → Secrets |

### Cloudflare Worker（引擎）

| 变量 | 类型 | 作用 | 配置位置 |
| --- | --- | --- | --- |
| `DATABASE_URL` | **Secret** | Neon 连接串 | `wrangler secret put` |
| `DEEPSEEK_API_KEY` | **Secret** | DeepSeek 大模型鉴权 | `wrangler secret put` |
| `ADMIN_TOKEN` | **Secret** | 引导创建用户的令牌 | `wrangler secret put` |
| `HF_SANDBOX_SECRET` | **Secret** | 沙箱共享密钥（与 HF 侧一致） | `wrangler secret put` |
| `ALLOWED_ORIGIN` | 普通变量 | CORS 白名单域名 | `wrangler.json` 的 `vars` |
| `HF_SANDBOX_URL` | 普通变量 | 沙箱公网地址 | `wrangler.json` 的 `vars` |
| `DEEPSEEK_BASE_URL`（可选） | 普通变量 | 自定义 DeepSeek 地址 | `wrangler.json` 的 `vars` |
| `HF_SANDBOX_TIMEOUT_MS`（可选） | 普通变量 | 沙箱请求超时毫秒数 | `wrangler.json` 的 `vars` |

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

**Q：命令执行返回「sandbox error」？**
- 确认 `HF_SANDBOX_URL` 正确且 Space 处于 **Running**。
- 确认 Worker 的 `HF_SANDBOX_SECRET` 与 Space 的 `SANDBOX_SECRET` 一致。

**Q：我能看到别人的会话吗？**
不能。所有查询强制 `AND user_id = <你的ID>`，访问他人资源返回「not found」而非数据。

**Q：如何更新代码？**
```sh
cd apps/serverless-worker && npx wrangler deploy   # Worker
```
前端提交到 GitHub 后 Vercel 自动重建；沙箱代码改动推送到 Space 仓库后 HF 自动重建。

---

## 本地全栈联调（开发者）

1. **沙箱**：`cd apps/serverless-worker/sandbox-hf && pip install -r requirements.txt && SANDBOX_SECRET=dev python app.py`（Gradio 默认监听 `$PORT` 或 7860）
2. **引擎**：`cd apps/serverless-worker && pnpm wrangler dev`
3. **前端**：`cd apps/web/vercel && pnpm dev`（本地地址 `http://localhost:5173`）

本地 `.dev.vars` 的 `ALLOWED_ORIGIN` 需含 `http://localhost:5173`；`NEXT_PUBLIC_WORKER_URL` 本地默认回退到 `http://localhost:8787`。
