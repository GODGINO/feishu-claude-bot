import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Users, MessageSquare, Clock, Mail, Zap, Brain, MessagesSquare } from 'lucide-react'
import { api, type Stats, type SessionSummary } from '../lib/api'
import { formatTime } from '../lib/utils'

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: typeof Users; label: string; value: number | string; sub?: string; color: string
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 flex items-center gap-4">
      <div className={`w-11 h-11 rounded-lg flex items-center justify-center ${color}`}>
        <Icon size={20} className="text-white" />
      </div>
      <div>
        <p className="text-2xl font-bold">{value}</p>
        <p className="text-sm text-slate-500">{label}</p>
        {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])

  useEffect(() => {
    api.stats().then(setStats)
    api.sessions().then(setSessions)
  }, [])

  const recentSessions = sessions.slice(0, 8)

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Dashboard</h2>

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard
            icon={Users}
            label="Sessions"
            value={stats.totalSessions}
            sub={`${stats.groupSessions} groups, ${stats.dmSessions} DMs`}
            color="bg-blue-500"
          />
          <StatCard
            icon={MessageSquare}
            label="Total Messages"
            value={stats.totalMessages}
            sub={`${stats.todayMessages} today`}
            color="bg-indigo-500"
          />
          <StatCard
            icon={Zap}
            label="Skills"
            value={stats.totalSkills}
            color="bg-green-500"
          />
          <StatCard
            icon={Brain}
            label="Memories"
            value={stats.totalObservations}
            color="bg-violet-500"
          />
          <StatCard
            icon={Clock}
            label="Cron Jobs"
            value={stats.totalCronJobs}
            color="bg-amber-500"
          />
          <StatCard
            icon={Mail}
            label="Email Accounts"
            value={stats.totalEmailAccounts}
            color="bg-purple-500"
          />
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-semibold">Recent Sessions</h3>
          <span className="text-xs text-slate-400">{sessions.length} total</span>
        </div>
        <div className="divide-y divide-slate-100">
          {recentSessions.map(s => (
            <Link
              key={s.key}
              to={`/session/${s.key}`}
              className="flex items-center justify-between px-5 py-3.5 hover:bg-slate-50 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                  s.type === 'group' ? 'bg-blue-500' : 'bg-green-500'
                }`} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm truncate">{s.name}</p>
                  <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5">
                    <span>{s.type === 'group' ? 'Group' : 'DM'}</span>
                    <span>&middot;</span>
                    <span className="flex items-center gap-1">
                      <MessagesSquare size={11} /> {s.messageCount}
                    </span>
                    {s.skillCount > 0 && (
                      <>
                        <span>&middot;</span>
                        <span className="flex items-center gap-1">
                          <Zap size={11} /> {s.skillCount}
                        </span>
                      </>
                    )}
                    {s.cronJobCount > 0 && (
                      <>
                        <span>&middot;</span>
                        <span className="flex items-center gap-1">
                          <Clock size={11} /> {s.cronJobCount}
                        </span>
                      </>
                    )}
                    {s.hasEmail && (
                      <>
                        <span>&middot;</span>
                        <Mail size={11} />
                      </>
                    )}
                  </div>
                </div>
              </div>
              <span className="text-xs text-slate-400 shrink-0 ml-3">
                {s.lastActiveAt ? formatTime(s.lastActiveAt) : 'No activity'}
              </span>
            </Link>
          ))}
          {recentSessions.length === 0 && (
            <p className="px-5 py-8 text-center text-slate-400">No sessions found</p>
          )}
        </div>
      </div>
    </div>
  )
}
