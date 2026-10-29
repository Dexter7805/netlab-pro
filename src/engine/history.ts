// Undo/redo history for lab editing.
// Pure data-structure logic, no React: the UI records the PREVIOUS lab state
// before each mutation and navigates the stacks with undo()/redo().
// Snapshots are the complete immutable lab objects, so undo/redo can never
// leave the persisted store and the editor out of sync: applying an entry
// always goes through the same save path as an ordinary edit.

import type { Lab } from './types'

interface HistoryEntry {
  lab: Lab
  /**
   * Optional coalescing key: consecutive records with the same key (e.g.
   * continuous device drags) do not add new entries, so one undo step reverts
   * the whole interaction.
   */
  mergeKey?: string
}

export class LabHistory {
  private past: HistoryEntry[] = []
  private future: HistoryEntry[] = []
  private readonly limit: number

  constructor(limit = 100) {
    this.limit = Math.max(1, limit)
  }

  /** Record the state that existed BEFORE a mutation. */
  record(lab: Lab, mergeKey?: string): void {
    const top = this.past[this.past.length - 1]
    if (top && mergeKey !== undefined && top.mergeKey === mergeKey) {
      // Coalesce: keep the oldest snapshot of the interaction (no new entry).
      this.future = []
      return
    }
    this.past.push({ lab, mergeKey })
    if (this.past.length > this.limit) this.past.shift()
    // Any new edit invalidates the redo branch.
    this.future = []
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  /**
   * Revert to the most recent recorded state. The current lab is pushed to the
   * redo stack so redo() can restore it exactly.
   */
  undo(current: Lab): Lab | null {
    const entry = this.past.pop()
    if (!entry) return null
    this.future.push({ lab: current })
    return entry.lab
  }

  /** Re-apply the most recently undone state. */
  redo(current: Lab): Lab | null {
    const entry = this.future.pop()
    if (!entry) return null
    this.past.push({ lab: current })
    return entry.lab
  }

  /** Drop all history (e.g. when switching labs or replacing state wholesale). */
  clear(): void {
    this.past = []
    this.future = []
  }
}
