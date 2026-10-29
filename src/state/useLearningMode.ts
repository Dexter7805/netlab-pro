// Small persisted UI preference (learning mode). Kept separate from lab data.

import { useCallback, useSyncExternalStore } from 'react'

const KEY = 'netlab-pro.learning.v1'

type Listener = () => void

function storageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

function read(): boolean {
  if (!storageAvailable()) return false
  try {
    return localStorage.getItem(KEY) === 'on'
  } catch {
    return false
  }
}

let cached = read()
const listeners = new Set<Listener>()

function write(value: boolean): void {
  cached = value
  if (storageAvailable()) {
    try {
      localStorage.setItem(KEY, value ? 'on' : 'off')
    } catch {
      // ignore quota errors
    }
  }
  for (const listener of listeners) listener()
}

export function useLearningMode(): { enabled: boolean; setEnabled: (value: boolean) => void } {
  const enabled = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => cached,
  )
  const setEnabled = useCallback((value: boolean) => write(value), [])
  return { enabled, setEnabled }
}
