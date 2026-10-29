// ACL editor: ordered rules per direction (in/out), first match wins.
// Submits the whole ACL array on every change; the engine owns semantics.

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import type { AclAction, AclDirection, AclEntry, AclProtocol, AclRule } from '../engine/types'
import { uid } from '../engine/ids'
import { LearnBox } from './learn'

interface AclEditorProps {
  acls: AclEntry[]
  onChange: (acls: AclEntry[]) => void
  compact?: boolean
}

const DIRECTIONS: AclDirection[] = ['in', 'out']
const DIRECTION_LABEL: Record<AclDirection, string> = { in: 'Inbound', out: 'Outbound' }

export function AclEditor({ acls, onChange, compact = false }: AclEditorProps) {
  const updateEntry = (entryId: string, patch: Partial<AclEntry>) => {
    onChange(acls.map((acl) => (acl.id === entryId ? { ...acl, ...patch } : acl)))
  }

  const addEntry = (direction: AclDirection) => {
    onChange([
      ...acls,
      {
        id: uid('acl'),
        name: direction === 'in' ? 'IN-ACL' : 'OUT-ACL',
        direction,
        rules: [],
      },
    ])
  }

  const removeEntry = (entryId: string) => {
    onChange(acls.filter((acl) => acl.id !== entryId))
  }

  const addRule = (entryId: string) => {
    onChange(
      acls.map((acl) =>
        acl.id === entryId
          ? {
              ...acl,
              rules: [
                ...acl.rules,
                { id: uid('rule'), action: 'deny' as AclAction, protocol: 'icmp' as AclProtocol, source: 'any', destination: 'any', destPort: null, enabled: true },
              ],
            }
          : acl,
      ),
    )
  }

  const updateRule = (entryId: string, ruleId: string, patch: Partial<AclRule>) => {
    onChange(
      acls.map((acl) =>
        acl.id === entryId
          ? { ...acl, rules: acl.rules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)) }
          : acl,
      ),
    )
  }

  const deleteRule = (entryId: string, ruleId: string) => {
    onChange(acls.map((acl) => (acl.id === entryId ? { ...acl, rules: acl.rules.filter((rule) => rule.id !== ruleId) } : acl)))
  }

  const moveRule = (entryId: string, ruleId: string, delta: -1 | 1) => {
    onChange(
      acls.map((acl) => {
        if (acl.id !== entryId) return acl
        const index = acl.rules.findIndex((rule) => rule.id === ruleId)
        const target = index + delta
        if (index === -1 || target < 0 || target >= acl.rules.length) return acl
        const rules = [...acl.rules]
        const [moved] = rules.splice(index, 1)
        rules.splice(target, 0, moved)
        return { ...acl, rules }
      }),
    )
  }

  return (
    <div className="space-y-2">
      {DIRECTIONS.map((direction) => {
        const entry = acls.find((acl) => acl.direction === direction)
        return (
          <div key={direction} className="rounded-md border border-edge bg-night-950/40 p-2">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                {DIRECTION_LABEL[direction]} ({direction})
              </span>
              {entry ? (
                <>
                  <input
                    className="input h-6 min-w-0 flex-1 truncate py-0 font-mono text-xs"
                    value={entry.name}
                    onChange={(e) => updateEntry(entry.id, { name: e.target.value })}
                    aria-label="ACL name"
                  />
                  <button type="button" className="rounded p-1 text-slate-600 hover:text-red-400" title="Remove this ACL" onClick={() => removeEntry(entry.id)}>
                    <Trash2 size={11} aria-hidden />
                  </button>
                </>
              ) : (
                <button type="button" className="btn-chip ml-auto" onClick={() => addEntry(direction)}>
                  <Plus size={11} aria-hidden /> Add {DIRECTION_LABEL[direction].toLowerCase()} ACL
                </button>
              )}
            </div>

            {entry && (
              <>
                <div className="space-y-1">
                  {entry.rules.map((rule, index) => (
                    <div
                      key={rule.id}
                      className="flex flex-wrap items-center gap-1 rounded-md border border-edge/70 bg-night-950/40 px-1.5 py-1"
                      title={'Rule ' + (index + 1) + ' — evaluated in order, first match wins'}
                    >
                      <span className="w-4 shrink-0 text-center font-mono text-[10px] text-slate-600" title="Rule number (first match wins)">
                        {index + 1}
                      </span>
                      <select
                        className="input h-6 w-[4.5rem] shrink-0 py-0 font-mono text-xs"
                        value={rule.action}
                        onChange={(e) => updateRule(entry.id, rule.id, { action: e.target.value as AclAction })}
                        aria-label="Action"
                      >
                        <option value="permit">permit</option>
                        <option value="deny">deny</option>
                      </select>
                      <select
                        className="input h-6 w-[4.5rem] shrink-0 py-0 font-mono text-xs"
                        value={rule.protocol}
                        onChange={(e) => updateRule(entry.id, rule.id, { protocol: e.target.value as AclProtocol })}
                        aria-label="Protocol"
                      >
                        <option value="icmp">icmp</option>
                        <option value="tcp">tcp</option>
                        <option value="udp">udp</option>
                      </select>
                      <input
                        className="input h-6 min-w-0 flex-[1_1_7rem] py-0 font-mono text-xs"
                        placeholder="src (any/ip/cidr)"
                        value={rule.source}
                        onChange={(e) => updateRule(entry.id, rule.id, { source: e.target.value })}
                        aria-label="Source"
                      />
                      <input
                        className="input h-6 min-w-0 flex-[1_1_7rem] py-0 font-mono text-xs"
                        placeholder="dst (any/ip/cidr)"
                        value={rule.destination}
                        onChange={(e) => updateRule(entry.id, rule.id, { destination: e.target.value })}
                        aria-label="Destination"
                      />
                      <input
                        className="input h-6 w-16 shrink-0 py-0 font-mono text-xs"
                        placeholder="port"
                        type="number"
                        min={1}
                        max={65535}
                        value={rule.destPort ?? ''}
                        disabled={rule.protocol === 'icmp'}
                        onChange={(e) => updateRule(entry.id, rule.id, { destPort: e.target.value === '' ? null : Number(e.target.value) })}
                        aria-label="Destination port"
                      />
                      <span className="ml-auto flex shrink-0 items-center gap-0.5">
                        <button type="button" className="rounded p-0.5 text-slate-600 hover:text-accent disabled:opacity-25" disabled={index === 0} onClick={() => moveRule(entry.id, rule.id, -1)} title="Move rule up (evaluated earlier)" aria-label="Move rule up">
                          <ArrowUp size={11} aria-hidden />
                        </button>
                        <button type="button" className="rounded p-0.5 text-slate-600 hover:text-accent disabled:opacity-25" disabled={index === entry.rules.length - 1} onClick={() => moveRule(entry.id, rule.id, 1)} title="Move rule down (evaluated later)" aria-label="Move rule down">
                          <ArrowDown size={11} aria-hidden />
                        </button>
                        <button type="button" className="rounded p-0.5 text-slate-600 hover:text-red-400" onClick={() => deleteRule(entry.id, rule.id)} title="Delete rule" aria-label="Delete rule">
                          <Trash2 size={11} aria-hidden />
                        </button>
                      </span>
                    </div>
                  ))}
                  {entry.rules.length === 0 && (
                    <p className="text-[11px] text-slate-600">No rules — this ACL permits everything (implicit permit).</p>
                  )}
                </div>
                <button type="button" className="btn-chip mt-1.5" onClick={() => addRule(entry.id)}>
                  <Plus size={11} aria-hidden /> Add rule
                </button>
              </>
            )}
          </div>
        )
      })}
      {!compact && (
        <div className="space-y-1.5">
          <LearnBox topic="acl-basics" />
          <LearnBox topic="acl-rule-order" />
          <LearnBox topic="acl-directions" />
        </div>
      )}
    </div>
  )
}
