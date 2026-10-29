import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Minimal localStorage stub so storage modules can be tested in node.
class MemoryLocalStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}

describe('labStore persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    ;(globalThis as Record<string, unknown>).localStorage = new MemoryLocalStorage()
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage
  })

  it('seeds sample labs on first run and persists them', async () => {
    const { labStore } = await import('./labStore')
    const labs = labStore.list()
    expect(labs.length).toBeGreaterThanOrEqual(4)
    expect(labs.every((l) => l.origin === 'sample')).toBe(true)
  })

  it('creates, renames, duplicates and deletes labs', async () => {
    const { labStore } = await import('./labStore')
    const lab = labStore.create('My Test Lab')
    expect(lab.name).toBe('My Test Lab')
    expect(labStore.get(lab.id)).toBeDefined()

    labStore.rename(lab.id, 'Renamed Lab')
    expect(labStore.get(lab.id)!.name).toBe('Renamed Lab')

    const copy = labStore.duplicate(lab.id)!
    expect(copy.name).toBe('Renamed Lab (copy)')
    expect(copy.id).not.toBe(lab.id)
    expect(copy.devices).toHaveLength(0)

    labStore.delete(lab.id)
    expect(labStore.get(lab.id)).toBeUndefined()
    labStore.delete(copy.id)
  })

  it('saves and reloads edited labs across store instances', async () => {
    const { labStore } = await import('./labStore')
    const lab = labStore.create('Persistence Lab')
    lab.devices.push({
      id: 'd1',
      name: 'R1',
      kind: 'router',
      x: 0,
      y: 0,
      interfaces: [
        { id: 'i1', name: 'Gi0/0', role: 'routed', ipMode: 'static', cidr: '10.1.1.1/24', enabled: true, accessVlan: 1 },
      ],
      gatewayIp: null,
      staticRoutes: [],
      dhcpPools: [],
    })
    labStore.save(lab)

    // New instance simulates a fresh page load.
    vi.resetModules()
    const { labStore: freshStore } = await import('./labStore')
    const reloaded = freshStore.get(lab.id)
    expect(reloaded).toBeDefined()
    expect(reloaded!.devices).toHaveLength(1)
    expect(reloaded!.devices[0].interfaces[0].cidr).toBe('10.1.1.1/24')
  })
})

describe('progressStore', () => {
  beforeEach(() => {
    vi.resetModules()
    ;(globalThis as Record<string, unknown>).localStorage = new MemoryLocalStorage()
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage
  })

  it('records attempts, best score and completion', async () => {
    const { progressStore } = await import('./progressStore')
    expect(progressStore.isCompleted('sc-x')).toBe(false)

    progressStore.recordAttempt('sc-x', { score: 60, maxScore: 100, hintsUsed: 2, solved: false })
    const afterFirst = progressStore.forScenario('sc-x')!
    expect(afterFirst.attempts).toBe(1)
    expect(afterFirst.bestScore).toBe(60)
    expect(afterFirst.completedAt).toBeNull()

    progressStore.recordAttempt('sc-x', { score: 100, maxScore: 100, hintsUsed: 0, solved: true })
    const afterSecond = progressStore.forScenario('sc-x')!
    expect(afterSecond.attempts).toBe(2)
    expect(afterSecond.bestScore).toBe(100)
    expect(afterSecond.completedAt).not.toBeNull()
    expect(progressStore.isCompleted('sc-x')).toBe(true)

    // A worse later attempt keeps the completion and best score.
    progressStore.recordAttempt('sc-x', { score: 40, maxScore: 100, hintsUsed: 3, solved: false })
    const afterThird = progressStore.forScenario('sc-x')!
    expect(afterThird.bestScore).toBe(100)
    expect(afterThird.completedAt).not.toBeNull()
  })

  it('resets progress', async () => {
    const { progressStore } = await import('./progressStore')
    progressStore.recordAttempt('sc-y', { score: 80, maxScore: 100, hintsUsed: 0, solved: true })
    progressStore.reset()
    expect(progressStore.forScenario('sc-y')).toBeUndefined()
  })
})

describe('lab safety guarantees', () => {
  beforeEach(() => {
    vi.resetModules()
    ;(globalThis as Record<string, unknown>).localStorage = new MemoryLocalStorage()
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage
  })

  it('deleting every lab is respected — no silent re-seed on next load', async () => {
    const { labStore } = await import('./labStore')
    for (const lab of labStore.list()) labStore.delete(lab.id)
    expect(labStore.list()).toHaveLength(0)

    vi.resetModules()
    const { labStore: fresh } = await import('./labStore')
    expect(fresh.list()).toHaveLength(0)
  })

  it('resetToSamples keeps user labs and refreshes samples', async () => {
    const { labStore } = await import('./labStore')
    // The user duplicates + renames a sample and creates their own labs.
    const editedCopy = labStore.duplicate('lab-office')!
    labStore.rename(editedCopy.id, 'My edited office')
    const custom = labStore.create('My Custom Lab')
    const otherCustom = labStore.create('Second Custom')

    const sampleIds = labStore.resetToSamples()

    const labs = labStore.list()
    // The five sample templates are back at their pristine names/ids…
    expect(sampleIds.sort()).toEqual(
      ['lab-acl', 'lab-dhcp', 'lab-dhcprelay', 'lab-intervlan', 'lab-office', 'lab-two-router', 'lab-vlan'].sort(),
    )
    expect(labs.find((l) => l.id === 'lab-office')!.name).toBe('Branch Office (sample)')
    // …and BOTH user labs survived.
    expect(labs.find((l) => l.id === custom.id)?.name).toBe('My Custom Lab')
    expect(labs.find((l) => l.id === otherCustom.id)?.name).toBe('Second Custom')
    // The duplicated, renamed copy remains (it is a separate lab entry).
    expect(labs.some((l) => l.name === 'My edited office')).toBe(true)
  })

  it('importLab adds a new lab; replaceLab overwrites only the confirmed target', async () => {
    const { labStore } = await import('./labStore')
    const before = labStore.list().length

    const incoming = structuredClone(labStore.get('lab-office')!)
    incoming.name = 'Imported Office'
    incoming.devices = []
    const stored = labStore.importLab(incoming)
    // Import always lands under a fresh id — never over an existing lab.
    expect(stored.id).not.toBe('lab-office')
    expect(labStore.list().length).toBe(before + 1)
    // The original lab-office is untouched.
    expect(labStore.get('lab-office')!.devices.length).toBeGreaterThan(0)

    // Explicit replace overwrites the target's contents but keeps its identity.
    const replacement = structuredClone(labStore.get('lab-dhcp')!)
    replacement.name = 'Replaced content'
    const replaced = labStore.replaceLab('lab-two-router', replacement)!
    expect(replaced.id).toBe('lab-two-router')
    expect(replaced.name).toBe('Replaced content')
    // Replacing a sample's contents demotes it to user origin, keeping
    // "restore samples" semantics predictable.
    expect(replaced.origin).toBe('user')
    expect(labStore.get('lab-two-router')!.devices.map((d) => d.id)).toEqual(replacement.devices.map((d) => d.id))
  })

  it('replaceLab on a missing id returns undefined without side effects', async () => {
    const { labStore } = await import('./labStore')
    const replacement = structuredClone(labStore.get('lab-office')!)
    expect(labStore.replaceLab('nope-does-not-exist', replacement)).toBeUndefined()
  })
})
