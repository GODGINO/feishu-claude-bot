import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, type SessionDetail as SessionDetailType } from '../lib/api'
import OverviewTab from '../components/OverviewTab'
import KnowledgeView from '../components/KnowledgeView'
import CronJobTable from '../components/CronJobTable'
import ChatHistory from '../components/ChatHistory'
import EmailView from '../components/EmailView'
import SkillsView from '../components/SkillsView'
import MemoryView from '../components/MemoryView'

const tabs = ['Overview', 'Skills', 'Knowledge', 'Cron Jobs', 'Chat', 'Email', 'Memory'] as const
type Tab = typeof tabs[number]

export default function SessionDetail() {
  const { key } = useParams<{ key: string }>()
  const [session, setSession] = useState<SessionDetailType | null>(null)
  const [tab, setTab] = useState<Tab>('Overview')
  const [muted, setMuted] = useState(false)
  const [mutedLoading, setMutedLoading] = useState(false)

  useEffect(() => {
    if (key) {
      api.session(key).then(setSession)
      api.getSessionConfig(key, 'muted').then(v => setMuted(v === 'true')).catch(() => setMuted(false))
    }
  }, [key])

  const toggleMuted = async () => {
    if (!key || mutedLoading) return
    setMutedLoading(true)
    const newVal = !muted
    try {
      await api.setSessionConfig(key, 'muted', newVal ? 'true' : '')
      setMuted(newVal)
    } catch { /* ignore */ }
    setMutedLoading(false)
  }

  if (!key) return null
  if (!session) return <p className="text-slate-400">Loading...</p>

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <span className={`w-3 h-3 rounded-full ${session.type === 'group' ? 'bg-blue-500' : 'bg-green-500'}`} />
        <h2 className="text-2xl font-bold">{session.name}</h2>
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
          session.type === 'group' ? 'bg-blue-50 text-blue-700' : 'bg-green-50 text-green-700'
        }`}>
          {session.type === 'group' ? 'Group' : 'DM'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-slate-500">{muted ? 'Muted' : 'Active'}</span>
          <button
            onClick={toggleMuted}
            disabled={mutedLoading}
            className={`relative w-10 h-5 rounded-full transition-colors ${muted ? 'bg-slate-300' : 'bg-green-500'}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${muted ? 'left-0.5' : 'left-[22px]'}`} />
          </button>
        </div>
      </div>

      <div className="flex gap-1 border-b border-slate-200 mb-6">
        {tabs.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              tab === t
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Overview' && <OverviewTab session={session} sessionKey={key} onRefresh={() => api.session(key).then(setSession)} />}
      {tab === 'Skills' && <SkillsView sessionKey={key} />}
      {tab === 'Knowledge' && <KnowledgeView sessionKey={key} />}
      {tab === 'Cron Jobs' && <CronJobTable sessionKey={key} />}
      {tab === 'Chat' && <ChatHistory sessionKey={key} />}
      {tab === 'Email' && <EmailView sessionKey={key} />}
      {tab === 'Memory' && <MemoryView sessionKey={key} />}
    </div>
  )
}
