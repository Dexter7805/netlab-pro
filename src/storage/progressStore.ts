// NetDoctor progress: scores, attempts and completion tracking per scenario,
// persisted in localStorage.

const STORAGE_KEY = 'netlab-pro.progress.v1'

export interface ScenarioProgress {
  scenarioId: string
  attempts: number
  bestScore: number
  maxScore: number
  hintsUsedBest: number
  completedAt: string | null
  lastAttemptAt: string
}

export interface ProgressData {
  scenarios: Record<string, ScenarioProgress>
}

type Listener = () => void

function storageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

function loadRaw(): ProgressData {
  if (!storageAvailable()) return { scenarios: {} }
  try {
    const text = localStorage.getItem(STORAGE_KEY)
    if (!text) return { scenarios: {} }
    const parsed = JSON.parse(text) as ProgressData
    if (!parsed || typeof parsed !== 'object' || !parsed.scenarios) return { scenarios: {} }
    return parsed
  } catch {
    return { scenarios: {} }
  }
}

function persist(data: ProgressData): void {
  if (!storageAvailable()) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    // ignore quota errors
  }
}

class ProgressStore {
  private data: ProgressData = { scenarios: {} }
  private listeners = new Set<Listener>()
  private loaded = false

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    this.data = loadRaw()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  all(): ProgressData {
    this.ensureLoaded()
    return this.data
  }

  forScenario(scenarioId: string): ScenarioProgress | undefined {
    this.ensureLoaded()
    return this.data.scenarios[scenarioId]
  }

  isCompleted(scenarioId: string): boolean {
    return this.forScenario(scenarioId)?.completedAt != null
  }

  recordAttempt(
    scenarioId: string,
    attempt: { score: number; maxScore: number; hintsUsed: number; solved: boolean },
  ): ScenarioProgress {
    this.ensureLoaded()
    const now = new Date().toISOString()
    const existing = this.data.scenarios[scenarioId]
    const next: ScenarioProgress = {
      scenarioId,
      attempts: (existing?.attempts ?? 0) + 1,
      bestScore: Math.max(existing?.bestScore ?? 0, attempt.score),
      maxScore: attempt.maxScore,
      hintsUsedBest: existing && existing.bestScore >= attempt.score ? existing.hintsUsedBest : attempt.hintsUsed,
      completedAt: attempt.solved ? (existing?.completedAt ?? now) : existing?.completedAt ?? null,
      lastAttemptAt: now,
    }
    this.data = { scenarios: { ...this.data.scenarios, [scenarioId]: next } }
    persist(this.data)
    this.notify()
    return next
  }

  reset(): void {
    this.data = { scenarios: {} }
    persist(this.data)
    this.notify()
  }
}

export const progressStore = new ProgressStore()
