import { useCallback, useRef, useState, type SetStateAction } from 'react'
import type { AnswerMode } from '../answerModes/types'
import { normalizeDataSources, type ApplicationDataSource } from './dataSources'

interface Configuration { model: string; answerMode: AnswerMode; dataSources: ApplicationDataSource[] }

// A check belongs to a particular settings revision. Updating the ref together
// with state also covers actions that change a setting and submit in one click.
export default function useAssistantConfiguration(initial: () => Configuration) {
  const [snapshot, setSnapshot] = useState(() => {
    const value = initial()
    if (value.answerMode === 'knowledge') value.answerMode = 'auto'
    return { revision: 0, value }
  })
  const current = useRef(snapshot)
  const update = useCallback((change: (previous: Configuration) => Configuration) => {
    const previous = current.current, value = change(previous.value)
    if (JSON.stringify(value) === JSON.stringify(previous.value)) return
    current.current = { revision: previous.revision + 1, value }
    setSnapshot(current.current)
  }, [])
  const setModel = useCallback((value: SetStateAction<string>) => update(previous => ({ ...previous, model: typeof value === 'function' ? value(previous.model) : value })), [update])
  const setAnswerMode = useCallback((answerMode: AnswerMode) => update(previous => ({ ...previous, answerMode: answerMode === 'knowledge' ? 'auto' : answerMode })), [update])
  const setDataSources = useCallback((sources: ApplicationDataSource[]) => update(previous => ({ ...previous, dataSources: normalizeDataSources(sources) })), [update])
  const getSnapshot = useCallback(() => current.current, [])
  const invalidate = useCallback(() => {
    current.current = { ...current.current, revision: current.current.revision + 1 }
    setSnapshot(current.current)
  }, [])
  return { ...snapshot.value, revision: snapshot.revision, setModel, setAnswerMode, setDataSources, getSnapshot, invalidate }
}
