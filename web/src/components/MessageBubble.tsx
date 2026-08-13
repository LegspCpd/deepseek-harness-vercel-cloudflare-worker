import { contentText, type ChatMessage } from '../api'

interface MessageBubbleProps {
  readonly message: ChatMessage
}

/** Render a single transcript message by role. */
export function MessageBubble({ message }: MessageBubbleProps): JSX.Element {
  const text = contentText(message.content)
  switch (message.role) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[78%] rounded-2xl bg-cyan-700 px-4 py-2.5 text-sm text-white">
            {text}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className="flex justify-start">
          <div className="max-w-[85%] rounded-2xl bg-white border border-slate-200 px-4 py-2.5 text-sm text-slate-800 whitespace-pre-wrap">
            {text}
          </div>
        </div>
      )
    case 'tool':
      return (
        <div className="flex justify-start pl-4">
          <div className="max-w-[85%] rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-500 font-mono whitespace-pre-wrap border-l-2 border-cyan-600">
            <span className="font-semibold text-cyan-800">工具</span>
            <pre className="mt-1 max-h-48 overflow-auto">{text}</pre>
          </div>
        </div>
      )
    case 'system':
    default:
      return (
        <div className="flex justify-center">
          <span className="text-xs text-slate-400">{text}</span>
        </div>
      )
  }
}
