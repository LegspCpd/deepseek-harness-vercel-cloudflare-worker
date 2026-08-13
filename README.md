# DeepSeek Harness — Serverless (Vercel + Cloudflare Worker + Neon + E2B)

把 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 重构为一套 **Serverless 架构**，保持「功能与体验几乎完整，仅替换底座」：

- **前端 UI** → Vercel（`web/`，Vite + React 18）
- **服务端 Engine** → Cloudflare Workers（`worker/`，Hono）
- **数据库** → Neon PostgreSQL（Drizzle ORM，`user_id` 数据隔离）
- **命令/代码沙箱** → E2B API（Shell / Python / 文件系统，绝不使用本地子进程）

## 架构

```
浏览器 → Vercel 前端 ──SSE──▶ Cloudflare Worker（Hono 引擎，持全部密钥）
                                  │
                                  ├──▶ Neon PostgreSQL（Drizzle ORM，user_id 隔离）
                                  ├──▶ E2B 沙箱（命令/代码执行，双层适配器）
                                  └──▶ DeepSeek API（大模型）
```

## 目录结构

```
worker/     Cloudflare Worker 引擎（Hono 路由 + SSE + Drizzle + E2B 双层适配器）
web/        Vercel 前端（Vite + React，API Key 引导 + 聊天控制台）
DEPLOY.md   零基础部署教程
```

## 5 条安全护栏

1. **数据隔离**：所有数据按 `user_id` 归属，数据库层强制 `WHERE ... AND user_id = ?`，杜绝 BOLA/IDOR 越权。
2. **防注入**：Drizzle 全参数化；Shell 指令用 `quoteE2BShellArg` 转义。
3. **真实依赖**：仅使用 npm 真实存在的包（Hono、Drizzle、zod、e2b）。
4. **SSE 兜底**：流式异常必发 `event: error` 并关闭连接，绝不挂起。
5. **凭证安全**：所有密钥只放 Workers Secret，代码零明文。

## 快速开始

完整部署步骤见 [DEPLOY.md](./DEPLOY.md)。本地开发：

```sh
# 引擎（Cloudflare Worker）
cd worker
pnpm install
cp .env.example .dev.vars   # 填入真实值
npx wrangler dev

# 前端（Vercel）
cd ../web
pnpm install
pnpm dev
```
