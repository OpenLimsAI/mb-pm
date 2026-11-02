import { useEffect, useState } from 'react'
import type { AnswerCapabilities } from './types'

interface CapabilityClient { capabilities?(modelProfileId?: string): Promise<AnswerCapabilities> }
interface CapabilityState {
  client: CapabilityClient; profileId: string | undefined; revision: number; refresh: number; value: AnswerCapabilities | null
}
const changedEvent = 'assistant:model-settings-changed'
const changedStorageKey = 'mberp:model-settings-change:v1'

/** Publish only an opaque change nonce, never configuration or credentials. */
export function notifySearchConfigurationChanged() {
  window.dispatchEvent(new Event(changedEvent))
  try { localStorage.setItem(changedStorageKey, crypto.randomUUID()) } catch { /* Focus remains a fallback for other tabs. */ }
}

export function listenForSearchConfigurationChanges(reload: () => void) {
  const storageChanged = (event: StorageEvent) => { if (event.key === changedStorageKey) reload() }
  window.addEventListener('focus', reload)
  window.addEventListener(changedEvent, reload)
  window.addEventListener('storage', storageChanged)
  return () => { window.removeEventListener('focus', reload); window.removeEventListener(changedEvent, reload); window.removeEventListener('storage', storageChanged) }
}

export function useSearchCapabilities(client: CapabilityClient, profileId: string | undefined, revision = 0) {
  const [refresh, setRefresh] = useState(0), [state, setState] = useState<CapabilityState | null>(null)
  useEffect(() => listenForSearchConfigurationChanges(() => setRefresh(value => value + 1)), [])
  useEffect(() => {
    if (!client.capabilities) return
    let current = true
    const save = (value: AnswerCapabilities | null) => { if (current) setState({ client, profileId, revision, refresh, value }) }
    void Promise.resolve().then(() => client.capabilities!(profileId)).then(save).catch(() => save(null))
    return () => { current = false }
  }, [client, profileId, revision, refresh])
  // Hide stale readiness in the render that changes a model, before its effect runs.
  return state?.client === client && state.profileId === profileId && state.revision === revision && state.refresh === refresh ? state.value : null
}
