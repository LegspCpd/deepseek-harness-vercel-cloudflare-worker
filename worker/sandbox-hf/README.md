# Hugging Face Space — 免费代码沙箱 API（Gradio / Python 模式）

这是 `deepseek-harness` 的 **100% 免费、零银行卡、零 Docker 绑卡** 命令/代码沙箱服务。它部署在 Hugging Face Spaces 的 **Gradio / Python 模式** 上（免费、无需 Billing），并通过 HTTP/REST 向 Cloudflare Worker 提供 Bash / Python / 文件系统执行能力。

## 为什么用 Gradio 模式而不是 Docker
Hugging Face Spaces 的 **Docker** 模式要求绑定 Billing 账户；而 **Gradio / Python** 模式完全免费、无需绑卡。本服务用 Gradio 加载约定，并在此之上挂载纯 REST API 供 Worker 调用。

## 部署到 Hugging Face（免费，零绑卡）

1. 打开 <https://huggingface.co/new-space> 新建 Space：
   - **Owner**：你的账号
   - **Space name**：例如 `dsh-sandbox`
   - **License**：MIT
   - **SDK**：选 **Gradio**
2. 创建后，把本目录下 **`app.py`、`requirements.txt`** 两个文件推送到该 Space 的 Git 仓库。
3. 在 Space 的 **Settings → Variables and secrets** 添加一个 secret：
   - Key：`SANDBOX_SECRET`
   - Value：一串随机的长字符串（与 Worker 侧配置的 `HF_SANDBOX_SECRET` 一致）
4. Space 会自动安装依赖并启动。等它显示 **Running** 后，得到一个公网地址：
   ```
   https://<你的用户名>-dsh-sandbox.hf.space
   ```
   访问该地址应看到 Gradio 测试界面。

## 本地运行（开发）

```sh
pip install -r requirements.txt
SANDBOX_SECRET=dev-secret python app.py
```

## REST API 一览（供 Worker 调用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 存活检查（无需密钥） |
| `POST` | `/run` | 执行 bash 或 python，body：`{lang, command, cwd?, timeout_s?}` |
| `GET` | `/fs/list?path=/workspace` | 列出目录 |
| `GET` | `/fs/read?path=...` | 读取文本文件 |

所有受保护接口需携带请求头 `X-Sandbox-Secret: <你的SANDBOX_SECRET>`。

### 示例：执行 Bash

```bash
curl -X POST https://<你的用户名>-dsh-sandbox.hf.space/run \
  -H "Content-Type: application/json" \
  -H "X-Sandbox-Secret: <SECRET>" \
  -d '{"lang":"bash","command":"echo hello && ls /workspace"}'
```

返回：`{"stdout":"hello\n","stderr":"","exit_code":0,"timed_out":false}`
