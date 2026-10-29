// React bindings for the storage layers (useSyncExternalStore based).

import { useCallback, useSyncExternalStore } from 'react'
import { labStore } from '../storage/labStore'
import { progressStore } from '../storage/progressStore'
import type { Lab } from '../engine/types'

export function useLabs(): { labs: Lab[]; getLab: (id: string | null) => Lab | null } {
  const labs = useSyncExternalStore(labStore.subscribe.bind(labStore), labStore.list.bind(labStore))
  const getLab = useCallback(
    (id: string | null) => (id ? labs.find((l) => l.id === id) ?? null : null),
    [labs],
  )
  return { labs, getLab }
}

export function useProgress() {
  return useSyncExternalStore(
    progressStore.subscribe.bind(progressStore),
    progressStore.all.bind(progressStore),
  )
}

/** Apply a pure mutation to a lab and persist it. */
export function mutateLab(lab: Lab, mutate: (draft: Lab) => void): Lab {
  const draft = structuredClone(lab)
  mutate(draft)
  return labStore.save(draft)
}
