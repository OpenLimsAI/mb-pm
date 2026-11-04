import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
export function useKnowledgePreference<T>(key: string, fallback: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => { try {const raw=localStorage.getItem(key);if(!raw)return fallback;const parsed=JSON.parse(raw);return (Array.isArray(fallback) ? Array.isArray(parsed)&&parsed.every(v=>typeof v==='string') : typeof parsed===typeof fallback) ? parsed as T : fallback} catch {return fallback} })
  const update: Dispatch<SetStateAction<T>> = useCallback(next => setValue(previous => {const result=typeof next === 'function' ? (next as (v:T)=>T)(previous) : next;try{localStorage.setItem(key,JSON.stringify(result))}catch{/* Browsing remains available without storage. */}return result}), [key])
  return [value,update]
}
