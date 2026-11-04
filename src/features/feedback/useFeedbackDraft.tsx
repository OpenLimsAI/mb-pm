import { useEffect, useRef, useState } from 'react'
import { deleteDraft, loadDraft, saveDraft } from './drafts'

type SavedDraft<T> = { value: T; files: File[]; savedAt: string }
export function useFeedbackDraft<T>(namespace: string | undefined, key: string, serialized: string, files: File[], dirty: boolean, onRestore: (saved: SavedDraft<T>) => void) {
  const [recoverable, setRecoverable] = useState<SavedDraft<T> | null>(null)
  const [ready, setReady] = useState(false)
  const [warning, setWarning] = useState('')
  const writes = useRef<Promise<unknown>>(Promise.resolve())
  const stopped = useRef<string | null>(null)
  useEffect(() => {
    if (!namespace) return
    let active = true
    loadDraft<T>(namespace, key).then(saved => { if (active) { setRecoverable(saved); setReady(true) } })
      .catch(() => { if (active) setWarning('暂时无法读取草稿，请保留当前页面后重试。') })
    return () => { active = false }
  }, [namespace, key])
  useEffect(() => {
    if (!namespace || !ready || recoverable || !dirty || stopped.current === serialized) return
    let active = true
    const timer = window.setTimeout(() => {
      writes.current = writes.current.catch(() => {}).then(() => saveDraft(namespace, key, JSON.parse(serialized) as T, files)).then(ok => {
        if (active) setWarning(ok ? '' : '草稿图片暂未保存，请保留原图；文字将尽可能保留。')
      }).catch(() => { if (active) setWarning('草稿暂未保存，请保留当前页面。') })
    }, 500)
    return () => { active = false; window.clearTimeout(timer) }
  }, [namespace, key, serialized, files, ready, recoverable, dirty])
  const discard = async () => {
    stopped.current = serialized
    await writes.current.catch(() => {})
    await deleteDraft(namespace, key).catch(() => {})
  }
  const keep = async () => {
    if (!namespace) { setWarning('当前登录身份尚未确认，暂时无法保存草稿。'); return false }
    await writes.current.catch(() => {})
    try {
      const ok = await saveDraft(namespace, key, JSON.parse(serialized) as T, files)
      if (!ok) setWarning('草稿图片暂未保存，请保留原图或继续编辑。')
      return ok
    } catch { setWarning('草稿暂未保存，请保留当前页面。'); return false }
  }
  const banner = <>
    {recoverable && <div className="feedback-draft-banner" role="status"><span>发现未发送的草稿（{new Date(recoverable.savedAt).toLocaleString('zh-CN')}）</span><button type="button" onClick={() => { onRestore(recoverable); setRecoverable(null) }}>恢复草稿</button><button type="button" onClick={() => { void deleteDraft(namespace, key).catch(() => {}); setRecoverable(null) }}>忽略草稿</button></div>}
    {warning && <p className="feedback-draft-warning" role="status">{warning}</p>}
  </>
  return { discard, keep, banner }
}
