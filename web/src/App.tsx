import { useCallback, useEffect, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { ChatPanel } from './components/ChatPanel'
import { Onboarding } from './components/Onboarding'
import type { ChatMessage, SessionRecord } from './api'
import { createSession, listSessions, loadMessages, fetchMe } from './api'
import { clearApiKey, loadApiKey, loadUserName, runtimeConfig, saveApiKey, saveUserName } from './config'

/** The top-level console: gate on auth, then sessions + streaming chat. */
export default function App(): JSX.Element {
  const [hasKey, setHasKey] = useState<boolean>(() => loadApiKey().length > 0)
  const [userName, setUserName] = useState<string>(() => loadUserName())
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)

  const refreshSessions = useCallback(async () => {
    try {
      const list = await listSessions()
      setSessions(list)
    } catch (error) {
      console.error('failed to list sessions', error)
    }
  }, [])

  // After a key is present, validate it and load sessions.
  useEffect(() => {
    if (!hasKey) return
    setLoading(true)
    void fetchMe()
      .then(me => {
        if (userName.length === 0) setUserName(me.name)
      })
      .catch(() => {
        // Invalid/expired key; drop it and show onboarding.
        clearApiKey()
        setHasKey(false)
      })
      .finally(() => setLoading(false))
    void refreshSessions()
  }, [hasKey, refreshSessions, userName])

  const handleProvisioned = useCallback(
    (key: string, name: string) => {
      saveApiKey(key)
      saveUserName(name)
      setUserName(name)
      setHasKey(true)
    },
    [],
  )

  const handleSelectSession = useCallback(async (id: string) => {
    setActiveSessionId(id)
    setLoading(true)
    try {
      const transcript = await loadMessages(id)
      setMessages(transcript)
    } catch (error) {
      console.error('failed to load messages', error)
      setMessages([])
    } finally {
      setLoading(false)
    }
  }, [])

  const handleNewSession = useCallback(async () => {
    setLoading(true)
    try {
      const session = await createSession()
      await refreshSessions()
      setActiveSessionId(session.id)
      setMessages([])
    } catch (error) {
      console.error('failed to create session', error)
    } finally {
      setLoading(false)
    }
  }, [refreshSessions])

  const handleLogout = useCallback(() => {
    clearApiKey()
    setHasKey(false)
    setSessions([])
    setActiveSessionId(undefined)
    setMessages([])
  }, [])

  if (!hasKey) {
    return <Onboarding workerUrl={runtimeConfig.workerUrl} onProvisioned={handleProvisioned} />
  }

  return (
    <div className="flex h-full">
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        userName={userName}
        workerUrl={runtimeConfig.workerUrl}
        onSelect={handleSelectSession}
        onNew={handleNewSession}
        onLogout={handleLogout}
      />
      <main className="flex-1">
        <ChatPanel
          sessionId={activeSessionId}
          initialMessages={messages}
          loading={loading}
          onFirstMessage={() => {
            void refreshSessions()
          }}
        />
      </main>
    </div>
  )
}
