import { Plus, MessageSquare, Sparkles, LogOut, User } from 'lucide-react'
import type { SessionRecord } from '../api'

interface SidebarProps {
  readonly sessions: readonly SessionRecord[]
  readonly activeSessionId: string | undefined
  readonly userName: string
  readonly workerUrl: string
  readonly onSelect: (id: string) => void
  readonly onNew: () => void
  readonly onLogout: () => void
}

/** Left rail: session list, identity, and controls. */
export function Sidebar({
  sessions,
  activeSessionId,
  userName,
  workerUrl,
  onSelect,
  onNew,
  onLogout,
}: SidebarProps): JSX.Element {
  return (
    <aside className="w-72 shrink-0 border-r border-slate-200 bg-white flex flex-col">
      <div className="px-4 py-4 border-b border-slate-100">
        <div className="flex items-center gap-2 text-cyan-800">
          <Sparkles className="h-5 w-5" />
          <h1 className="text-base font-semibold">DeepSeek Harness</h1>
        </div>
        <p className="mt-1 text-xs text-slate-400 truncate" title={workerUrl}>
          {workerUrl}
        </p>
      </div>

      <div className="px-3 py-3">
        <button
          type="button"
          onClick={onNew}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-700 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-800 transition-colors cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          新建会话
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {sessions.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-slate-400">暂无会话，点击上方按钮开始</p>
        ) : (
          sessions.map(session => {
            const active = session.id === activeSessionId
            return (
              <button
                key={session.id}
                type="button"
                onClick={() => onSelect(session.id)}
                className={`mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors cursor-pointer ${
                  active ? 'bg-cyan-50 text-cyan-900' : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                <MessageSquare className="h-4 w-4 shrink-0 text-slate-400" />
                <span className="truncate">{session.title}</span>
              </button>
            )
          })
        )}
      </nav>

      <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <User className="h-4 w-4 text-slate-400" />
          <span className="truncate">{userName || '用户'}</span>
        </div>
        <button
          type="button"
          onClick={onLogout}
          title="退出（清除本地 API Key）"
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer"
        >
          <LogOut className="h-4 w-4" />
          退出
        </button>
      </div>
    </aside>
  )
}
