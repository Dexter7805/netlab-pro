import { describe, expect, it } from 'vitest'
import { LabHistory } from './history'
import { buildOfficeLab } from '../data/sampleLabs'
import type { Lab } from './types'

function labWithName(name: string): Lab {
  const lab = buildOfficeLab()
  return { ...lab, name }
}

describe('LabHistory', () => {
  it('undoes and redos single edits', () => {
    const history = new LabHistory()
    const v0 = labWithName('v0')
    history.record(v0)
    const v1 = labWithName('v1')

    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(false)
    const undone = history.undo(v1)
    expect(undone?.name).toBe('v0')

    expect(history.canRedo).toBe(true)
    const redone = history.redo(v0)
    expect(redone?.name).toBe('v1')
    expect(history.canRedo).toBe(false)
  })

  it('walks a long edit chain both ways', () => {
    const history = new LabHistory()
    const versions = ['v0', 'v1', 'v2', 'v3'].map(labWithName)
    for (let i = 0; i < versions.length - 1; i++) history.record(versions[i])

    let current = versions[3]
    for (let i = 2; i >= 0; i--) {
      const next = history.undo(current)
      expect(next?.name).toBe(versions[i].name)
      current = next!
    }
    expect(history.canUndo).toBe(false)

    // Redo back to v3.
    const expected = ['v1', 'v2', 'v3']
    for (const name of expected) {
      const next = history.redo(current)
      expect(next?.name).toBe(name)
      current = next!
    }
    expect(history.canRedo).toBe(false)
  })

  it('a new edit clears the redo branch', () => {
    const history = new LabHistory()
    history.record(labWithName('v0'))
    const v1 = labWithName('v1')
    history.undo(v1)
    expect(history.canRedo).toBe(true)

    history.record(v1) // edit again after undo
    expect(history.canRedo).toBe(false)
    // Undo must now return to v1 (the state before the new edit), not v0's redo branch.
    expect(history.undo(labWithName('v2'))?.name).toBe('v1')
  })

  it('coalesces consecutive entries with the same merge key (device drags)', () => {
    const history = new LabHistory()
    const v0 = labWithName('v0')
    history.record(v0, 'move-dev1')
    history.record(labWithName('drag1'), 'move-dev1')
    history.record(labWithName('drag2'), 'move-dev1')
    history.record(labWithName('drag3'), 'move-dev1')

    // One undo reverts the whole drag interaction back to v0.
    expect(history.undo(labWithName('drag4'))?.name).toBe('v0')
  })

  it('does not coalesce different merge keys', () => {
    const history = new LabHistory()
    history.record(labWithName('v0'), 'move-a')
    history.record(labWithName('moveA'), 'move-b')
    expect(history.undo(labWithName('moveB'))?.name).toBe('moveA')
  })

  it('respects the size limit and drops the oldest entries', () => {
    const history = new LabHistory(3)
    for (let i = 0; i < 6; i++) history.record(labWithName(`v${i}`))
    expect(history.undo(labWithName('v6'))?.name).toBe('v5')
    expect(history.undo(labWithName('v5'))?.name).toBe('v4')
    expect(history.undo(labWithName('v4'))?.name).toBe('v3')
    expect(history.canUndo).toBe(false)
  })

  it('clear() resets both stacks', () => {
    const history = new LabHistory()
    history.record(labWithName('v0'))
    history.clear()
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)
    expect(history.undo(labWithName('v1'))).toBeNull()
    expect(history.redo(labWithName('v1'))).toBeNull()
  })

  it('stores the recorded lab objects intact (no mutation leakage)', () => {
    const history = new LabHistory()
    const v0 = labWithName('v0')
    history.record(v0)
    // The editor mutates nothing; snapshots must come back identical.
    const undone = history.undo(labWithName('v1'))
    expect(undone).toBe(v0)
  })
})
