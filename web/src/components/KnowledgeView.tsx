import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import { api } from '../lib/api'

export default function KnowledgeView({ sessionKey }: { sessionKey: string }) {
  const [content, setContent] = useState<string | null>(null)

  useEffect(() => {
    api.knowledge(sessionKey).then(r => setContent(r.content))
  }, [sessionKey])

  if (content === null) return <p className="text-slate-400">Loading...</p>
  if (!content) return <p className="text-slate-400">No knowledge base (CLAUDE.md) found</p>

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6">
      <div className="prose prose-sm prose-slate max-w-none
        prose-headings:font-semibold
        prose-h1:text-xl prose-h2:text-lg prose-h3:text-base
        prose-code:bg-slate-100 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-sm
        prose-pre:bg-slate-900 prose-pre:text-slate-100
        prose-a:text-blue-600
        prose-table:text-sm
        prose-th:bg-slate-50 prose-th:px-3 prose-th:py-2
        prose-td:px-3 prose-td:py-2
      ">
        <Markdown>{content}</Markdown>
      </div>
    </div>
  )
}
