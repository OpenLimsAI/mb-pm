import { useEffect, useRef, useState } from 'react'
import { noteSourceNames } from './client'
import type { NoteCounts, NotesClient, NoteSource } from './client'

const sources = Object.keys(noteSourceNames) as NoteSource[]

/** Sidebar totals describe the account, independently of list search and pagination. */
export function useNoteCounts(client: NotesClient, refreshVersion: number, accessLost: boolean) {
  const [result, setResult] = useState<{ client: NotesClient; counts: NoteCounts | null }>({ client, counts: null })
  const request = useRef(0)
  useEffect(() => {
    const token = ++request.current
    let active = true
    if (accessLost) return
    const load = async (): Promise<NoteCounts> => {
      if (client.counts) return client.counts()
      // Support custom embedded clients which still only expose list totals.
      const rows = await Promise.all([
        ...sources.map(sourceApp => client.list({ sourceApp })),
        client.list({ trashed: true }),
      ])
      const counts = Object.fromEntries(sources.map((source, index) => [source, rows[index].total])) as NoteCounts
      counts.all = sources.reduce((sum, source) => sum + counts[source], 0)
      counts.trash = rows[sources.length].total
      return counts
    }
    void load().then(counts => {
      if (!active || request.current !== token) return
      if (['all', 'trash', ...sources].some(key => !Number.isSafeInteger(counts[key as keyof NoteCounts]) || counts[key as keyof NoteCounts] < 0)) { setResult({ client, counts: null }); return }
      setResult({ client, counts })
    }).catch(() => {
      if (active && request.current === token) setResult({ client, counts: null })
    })
    return () => { active = false }
  }, [client, refreshVersion, accessLost])
  return !accessLost && result.client === client ? result.counts : null
}
