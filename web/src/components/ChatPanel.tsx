import { useCallback, useEffect, useRef, useState } from 'react'
import { Send, Wrench, Loader2, CircleOff } from 'lucide-react'
import { contentText, streamChat, type ChatMessage, type ToolEvent } from '../api'
import { MessageBubble } from './MessageBubble'

interface ChatPanelProps {
  readonly sessionId: string | undefined
  readonly initialMessages: readonly ChatMessage[]
  readonly loading: boolean
  readonly onFirstMessage: () => void
}

interface LocalMessage {
  readonly id: string
  readonly role: ChatMessage['role']
  readonly text: string
}

/** The main chat surface: streamed transcript + composer. */
export function ChatPanel({ sessionId, initialMessages, loading, onFirstMessage }: ChatPanelProps): JSX.Element {
  const [messages, setMessages] = useState<LocalMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [tools, setTools] = useState<ToolEvent[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const abortRef = useRef<AbortController | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement>(undefined as unknown as HTMLDivElement)

  // Sync the transcript when the active session changes.
  useEffect(() => {
    setMessages(initialMessages.map(message => ({ id: message.id, role: message.role, text: contentText(message.content) })))
    setTools([])
    setError(undefined)
  }, [initialMessages])

  // Keep the transcript scrolled to the newest message.
  useEffect(() => {
    if (scrollRef.current !== undefined) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, tools, streaming])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (text.length === 0 || streaming) return
    if (sessionId === undefined) return

    onFirstMessage()
    setInput('')
    setStreaming(true)
    setError(undefined)
    setTools([])
    setMessages(previous => [...previous, { id: `user-${Date.now()}`, role: 'user', text }])
    // Reserve a slot for the streaming assistant reply.
    const assistantId = `assistant-${Date.now()}`
    setMessages(previous => [...previous, { id: assistantId, role: 'assistant', text: '' }])

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await streamChat(
        sessionId,
        text,
        {
          onText: token => {
            setMessages(previous =>
              previous.map(message =>
                message.id === assistantId ? { ...message, text: message.text + token } : message,
              ),
            )
          },
          onTool: tool => {
            setTools(previous => [...previous, tool])
          },
          onError: message => setError(message),
          onDone: () => {
            // Finalize: drop the placeholder if it stayed empty.
            setMessages(previous => previous.filter(message => message.id !== assistantId || message.text.length > 0))
          },
        },
        controller.signal,
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setStreaming(false)
      abortRef.current = undefined
    }
  }, [input, streaming, sessionId, onFirstMessage])

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
        {messages.length === 0 && !loading ? (
          <EmptyState />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {messages.map(message => (
              <MessageBubble key={message.id} message={toChatMessage(message)} />
            ))}
            {tools.map((tool, index) => (
              <div key={`tool-${index}`} className="flex justify-start pl-4">
                <div className="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-1.5 text-xs text-slate-500">
                  <Wrench className="h-3.5 w-3.5 text-cyan-700" />
                  <span className="font-medium text-cyan-800">{tool.name}</span>
                  {tool.error !== undefined ? (
                    <CircleOff className="h-3.5 w-3.5 text-danger" />
                  ) : (
                    <span className="text-success">完成</span>
                  )}
                </div>
              </div>
            ))}
            {streaming && (
              <div className="flex justify-start pl-4">
                <Loader2 className="h-4 w-4 animate-spin text-cyan-700" />
              </div>
            )}
            {error !== undefined && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-600">
                {error}
              </div>
            )}
          </div>
        )}
      </div>

      <Composer
        value={input}
        disabled={sessionId === undefined || loading}
        streaming={streaming}
        onChange={setInput}
        onSend={() => void handleSend()}
        onStop={handleStop}
      />
    </div>
  )
}

function EmptyState(): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-slate-700">开始与 DeepSeek 智能体对话</h2>
        <p className="mt-2 text-sm text-slate-400">选择一个会话，或新建一个。支持 Bash、Python 与文件系统操作（经 E2B 沙箱）。</p>
      </div>
    </div>
  )
}

interface ComposerProps {
  readonly value: string
  readonly disabled: boolean
  readonly streaming: boolean
  readonly onChange: (value: string) => void
  readonly onSend: () => void
  readonly onStop: () => void
}

function Composer({ value, disabled, streaming, onChange, onSend, onStop }: ComposerProps): JSX.Element {
  return (
    <div className="border-t border-slate-200 bg-white px-6 py-4">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          value={value}
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              if (!disabled && !streaming && value.trim().length > 0) onSend()
            }
          }}
          rows={2}
          disabled={disabled || streaming}
          placeholder={disabled ? '请先选择或新建会话' : '输入消息，Shift+Enter 换行…'}
          className="flex-1 resize-none rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-cyan-600 focus:outline-none focus:ring-2 focus:ring-cyan-600/20 disabled:cursor-not-allowed"
        />
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            className="rounded-xl bg-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-300 transition-colors cursor-pointer"
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || value.trim().length === 0}
            className="flex items-center gap-2 rounded-xl bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-800 transition-colors disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
          >
            <Send className="h-4 w-4" />
            发送
          </button>
        )}
      </div>
    </div>
  )
}

/** Convert a local message back to a ChatMessage for rendering. */
function toChatMessage(message: LocalMessage): ChatMessage {
  return {
    id: message.id,
    sessionId: '',
    role: message.role,
    content: message.text,
    createdAt: '',
  }
}
