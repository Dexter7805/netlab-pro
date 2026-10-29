// localStorage-backed lab persistence (save / load / rename / delete).
// Falls back to an in-memory store when localStorage is unavailable
// (e.g. during unit tests), so the engine stays testable.

import type { Lab } from '../engine/types'
import { createSampleLabs } from '../data/sampleLabs'
import { uid } from '../engine/ids'

const STORAGE_KEY = 'netlab-pro.labs.v1'

type Listener = () => void

function storageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

function loadRaw(): Lab[] | null {
  if (!storageAvailable()) return null
  try {
    const text = localStorage.getItem(STORAGE_KEY)
    if (!text) return null
    const parsed = JSON.parse(text) as Lab[]
    if (!Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

function persist(labs: Lab[]) {
  if (!storageAvailable()) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(labs))
  } catch {
    // Storage full or blocked: keep working in memory.
  }
}

class LabStore {
  private labs: Lab[] = []
  private listCache: Lab[] | null = null
  private listeners = new Set<Listener>()
  private loaded = false

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    const raw = loadRaw()
    if (raw) {
      // Existing storage wins — even an empty list means the user deleted
      // their labs on purpose. Never silently re-seed.
      this.labs = raw
    } else {
      this.labs = createSampleLabs()
      persist(this.labs)
    }
  }

  private notify(): void {
    this.listCache = null
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Cached snapshot — stable between mutations (required by useSyncExternalStore). */
  list(): Lab[] {
    this.ensureLoaded()
    if (!this.listCache) {
      this.listCache = [...this.labs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    }
    return this.listCache
  }

  get(id: string): Lab | undefined {
    this.ensureLoaded()
    return this.labs.find((l) => l.id === id)
  }

  /** Upsert a lab (id preserved). */
  save(lab: Lab): Lab {
    this.ensureLoaded()
    const stamped: Lab = { ...lab, updatedAt: new Date().toISOString() }
    const index = this.labs.findIndex((l) => l.id === stamped.id)
    if (index >= 0) this.labs[index] = stamped
    else this.labs.push(stamped)
    persist(this.labs)
    this.notify()
    return stamped
  }

  create(name: string, origin: Lab['origin'] = 'user'): Lab {
    const now = new Date().toISOString()
    const lab: Lab = {
      id: uid('lab'),
      name,
      origin,
      createdAt: now,
      updatedAt: now,
      devices: [],
      links: [],
      vlans: [
        { id: 1, name: 'default' },
        { id: 10, name: 'USERS' },
        { id: 20, name: 'GUESTS' },
      ],
      faults: [],
    }
    return this.save(lab)
  }

  rename(id: string, name: string): void {
    const lab = this.get(id)
    if (!lab) return
    this.save({ ...lab, name })
  }

  duplicate(id: string): Lab | undefined {
    const lab = this.get(id)
    if (!lab) return undefined
    const copy: Lab = {
      ...structuredClone(lab),
      id: uid('lab'),
      name: `${lab.name} (copy)`,
      origin: 'user',
      createdAt: new Date().toISOString(),
    }
    return this.save(copy)
  }

  delete(id: string): void {
    this.ensureLoaded()
    this.labs = this.labs.filter((l) => l.id !== id)
    persist(this.labs)
    this.notify()
  }

  /**
   * Restore the built-in sample labs WITHOUT touching user labs: sample-origin
   * labs are refreshed to their pristine templates, everything else (user
   * labs, scenario imports) is kept as-is. A sample lab that the user renamed
   * or edited is refreshed too — the samples are the app's teaching material.
   */
  resetToSamples(): string[] {
    this.ensureLoaded()
    const userLabs = this.labs.filter((l) => l.origin !== 'sample')
    const samples = createSampleLabs()
    this.labs = [...userLabs, ...samples]
    persist(this.labs)
    this.notify()
    return samples.map((s) => s.id)
  }

  /**
   * Import a parsed lab as a NEW lab. A fresh id is always assigned so an
   * import can never overwrite an existing lab by identity — replacing an
   * existing lab requires the explicit replaceLab call.
   */
  importLab(lab: Lab): Lab {
    return this.save({ ...structuredClone(lab), id: uid('lab') })
  }

  /**
   * Replace an existing lab's contents (after explicit user confirmation in
   * the UI). The target keeps its id, name and creation date unless the
   * incoming lab is meant to be the new source of truth.
   */
  replaceLab(id: string, incoming: Lab): Lab | undefined {
    const existing = this.get(id)
    if (!existing) return undefined
    return this.save({
      ...structuredClone(incoming),
      id: existing.id,
      name: incoming.name || existing.name,
      origin: existing.origin === 'sample' ? 'user' : existing.origin,
    })
  }
}

export const labStore = new LabStore()
