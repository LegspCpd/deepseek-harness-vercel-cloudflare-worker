import { useState } from 'react'
import { Sparkles, KeyRound, ShieldCheck, Copy } from 'lucide-react'
import { createUserWithKey } from '../api'

interface OnboardingProps {
  readonly workerUrl: string
  readonly onProvisioned: (apiKey: string, name: string) => void
}

/** First-run screen: bootstrap a user and capture the one-time API key. */
export function Onboarding({ workerUrl, onProvisioned }: OnboardingProps): JSX.Element {
  const [name, setName] = useState('')
  const [adminToken, setAdminToken] = useState('')
  const [issuedKey, setIssuedKey] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleCreate = async (): Promise<void> => {
    if (name.trim().length === 0 || adminToken.trim().length === 0) return
    setBusy(true)
    setError(undefined)
    try {
      const { apiKey } = await createUserWithKey(name.trim(), adminToken.trim())
      setIssuedKey(apiKey)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const handleCopy = async (): Promise<void> => {
    if (issuedKey === undefined) return
    await navigator.clipboard.writeText(issuedKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (issuedKey !== undefined) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
          <div className="flex items-center gap-2 text-cyan-800">
            <Sparkles className="h-5 w-5" />
            <h1 className="text-lg font-semibold">你的 API Key 已生成</h1>
          </div>
          <p className="mt-2 text-sm text-slate-600">
            请立即复制并妥善保存。此密钥仅显示一次，之后无法再次查看。把它交给下一步的「开始使用」页面。
          </p>
          <div className="mt-4 flex items-center gap-2 rounded-lg bg-slate-100 p-3">
            <code className="flex-1 break-all text-xs text-slate-800">{issuedKey}</code>
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="flex shrink-0 items-center gap-1 rounded-lg bg-cyan-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-800 cursor-pointer"
            >
              <Copy className="h-3.5 w-3.5" />
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => onProvisioned(issuedKey, name)}
            className="mt-5 w-full rounded-xl bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-800 cursor-pointer"
          >
            开始使用
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
        <div className="flex items-center gap-2 text-cyan-800">
          <Sparkles className="h-5 w-5" />
          <h1 className="text-lg font-semibold">加入 DeepSeek Harness</h1>
        </div>
        <p className="mt-1 text-xs text-slate-400 truncate" title={workerUrl}>
          {workerUrl}
        </p>

        <label className="mt-5 block">
          <span className="text-sm font-medium text-slate-700">你的名字</span>
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="例如：Alice"
            className="mt-1 w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm focus:border-cyan-600 focus:outline-none focus:ring-2 focus:ring-cyan-600/20"
          />
        </label>

        <label className="mt-4 block">
          <span className="flex items-center gap-1 text-sm font-medium text-slate-700">
            <ShieldCheck className="h-4 w-4 text-cyan-700" />
            管理员令牌（Admin Token）
          </span>
          <input
            type="password"
            value={adminToken}
            onChange={event => setAdminToken(event.target.value)}
            placeholder="部署时配置的 ADMIN_TOKEN"
            className="mt-1 w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm focus:border-cyan-600 focus:outline-none focus:ring-2 focus:ring-cyan-600/20"
          />
        </label>

        {error !== undefined && (
          <div className="mt-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-600">{error}</div>
        )}

        <button
          type="button"
          disabled={busy || name.trim().length === 0 || adminToken.trim().length === 0}
          onClick={() => void handleCreate()}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-800 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
        >
          <KeyRound className="h-4 w-4" />
          {busy ? '创建中…' : '生成 API Key'}
        </button>
      </div>
    </div>
  )
}
