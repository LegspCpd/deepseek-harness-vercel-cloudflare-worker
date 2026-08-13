# Hugging Face Space — 免费代码沙箱 API

这是 `deepseek-harness` 的 **免费、零银行卡** 命令/代码沙箱服务。把它部署为一个 **Docker 模式** 的 Hugging Face Space，然后让 Cloudflare Worker 通过 HTTP 调用它执行 Bash / Python / 文件系统操作。

## 为什么用它代替 E2B
E2B 需要绑定信用卡验证；本服务部署在 Hugging Face 的免费 Docker Space 上，**100% 免费、无需银行卡**。

## 部署到 Hugging Face

1. 打开 <https://huggingface.co/new-space> 新建 Space：
   - **Owner**：你的账号
   - **Space name**：例如 `dsh-sandbox`
   - **License**：MIT
   - **SDK**：选 **Docker**
2. 创建后，把本目录下 `app.py`、`requirements.txt`、`Dockerfile` 三个文件推送到该 Space 的 Git 仓库。
3. 在 Space 的 **Settings → Variables and secrets** 添加一个 secret：
   - Key：`SANDBOX_SECRET`
   - Value：一串随机的长字符串（与 Worker 侧配置的 `HF_SANDBOX_SECRET` 一致）
4. Space 会自动构建镜像并启动。等它显示 **Running** 后，得到一个公网地址，形如：
   ```
   https://LegspCpd-dsh-sandbox.hf.space
   ```

## 本地运行（开发）

```sh
pip install -r requirements.txt
SANDBOX_SECRET=dev-secret uvicorn app:app --port 7860
```

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 存活检查（无需密钥） |
| `POST` | `/run` | 执行 bash 或 python，body：`{lang, command, cwd?, timeout_s?}` |
| `GET` | `/fs/list?path=/workspace` | 列出目录 |
| `GET` | `/fs/read?path=...` | 读取文本文件 |

所有受保护接口需携带请求头 `X-Sandbox-Secret: <你的SANDBOX_SECRET>`。

### 示例：执行 Bash

```bash
curl -X POST https://LegspCpd-dsh-sandbox.hf.space/run \
  -H "Content-Type: application/json" \
  -H "X-Sandbox-Secret: <SECRET>" \
  -d '{"lang":"bash","command":"echo hello && ls /workspace"}'
```

返回：`{"stdout":"hello\n","stderr":"","exit_code":0,"timed_out":false}`
