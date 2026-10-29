import { useMemo, useState } from 'react'
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  Lightbulb,
  Send,
  Wrench,
  XCircle,
} from 'lucide-react'
import { detectIssues, runConnectivitySuite, applyAllFixes } from '../engine/faults'
import { applyFaults } from '../engine/effective'
import type { FaultKind, Lab } from '../engine/types'
import { evaluateSubmission, computeScore, DIFFICULTY_LABEL } from '../engine/scenarios'
import type { Difficulty, Scenario, Submission } from '../engine/scenarios'
import { progressStore } from '../storage/progressStore'
import { TopologyCanvas } from '../lab/TopologyCanvas'
import { PingConsole } from '../components/PingConsole'
import { SimBadge, SimNotice } from '../components/SimBadge'
import { deviceConfigLines } from '../components/configText'

export interface ScenarioRunnerProps {
  scenario: Scenario
  lab: Lab
  onExit: () => void
}

type Tab = 'investigate' | 'hints' | 'submit'

const DIFFICULTY_STYLE: Record<Difficulty, string> = {
  easy: 'border-emerald-700/60 bg-emerald-950/40 text-emerald-300',
  medium: 'border-amber-700/60 bg-amber-950/40 text-amber-300',
  hard: 'border-red-700/60 bg-red-950/40 text-red-300',
}

export function ScenarioRunner({ scenario, lab: initialLab, onExit }: ScenarioRunnerProps) {
  const [lab, setLab] = useState<Lab>(initialLab)
  const [tab, setTab] = useState<Tab>('investigate')
  const [revealedHints, setRevealedHints] = useState(0)
  const [submission, setSubmission] = useState<Submission>({ deviceId: '', kind: 'no-fault' })
  const [evaluation, setEvaluation] = useState<ReturnType<typeof evaluateSubmission> | null>(null)
  const [solved, setSolved] = useState(false)
  const [fixed, setFixed] = useState(false)
  const [highlighted, setHighlighted] = useState<string[]>([])
  const [configDeviceId, setConfigDeviceId] = useState(lab.devices[0]?.id ?? '')

  const effective = useMemo(() => applyFaults(lab).lab, [lab])
  const suite = useMemo(() => runConnectivitySuite(effective), [effective])
  const afterFixSuite = useMemo(() => (fixed ? runConnectivitySuite(applyFaults(lab).lab) : null), [fixed, lab])

  const devices = useMemo(() => [...lab.devices].sort((a, b) => a.name.localeCompare(b.name)), [lab.devices])
  const configText = useMemo(() => {
    const device = lab.devices.find((d) => d.id === configDeviceId)
    return device ? deviceConfigLines(lab, device).join('\n') : ''
  }, [lab, configDeviceId])

  const submit = () => {
    const result = evaluateSubmission(scenario, lab, submission, revealedHints)
    setEvaluation(result)
    // Practice runs (custom labs) are scored for the session only — completion
    // tracking is reserved for built-in cases.
    const isPractice = scenario.id.startsWith('practice-')
    if (result.correct) {
      setSolved(true)
      if (!isPractice) {
        progressStore.recordAttempt(scenario.id, {
          score: result.score,
          maxScore: scenario.points,
          hintsUsed: revealedHints,
          solved: true,
        })
      }
    } else if (!isPractice) {
      progressStore.recordAttempt(scenario.id, {
        score: 0,
        maxScore: scenario.points,
        hintsUsed: revealedHints,
        solved: false,
      })
    }
  }

  const revealHint = () => setRevealedHints((n) => Math.min(n + 1, scenario.hints.length))
  const potentialScore = computeScore(scenario.points, revealedHints)

  return (
    <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[auto_1fr] xl:grid-cols-[1.1fr_1fr] xl:grid-rows-1">
      {/* Left: case + topology + connectivity matrix */}
      <div className="flex min-h-0 min-w-0 flex-col overflow-y-auto border-b border-edge xl:border-b-0 xl:border-r">
        <div className="border-b border-edge bg-panel-2 px-4 py-3">
          <button type="button" className="btn-chip mb-2" onClick={onExit}>
            <ArrowLeft size={13} aria-hidden /> All cases
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-100">{scenario.title}</h2>
            <span className={`badge border ${DIFFICULTY_STYLE[scenario.difficulty]}`}>{DIFFICULTY_LABEL[scenario.difficulty]}</span>
            <span className="badge border border-edge bg-panel text-slate-300">{scenario.points} pts</span>
            <span className="badge border border-edge bg-panel text-slate-400">max now: {potentialScore} pts</span>
            <SimBadge label="Simulated case" />
          </div>
        </div>

        <div className="space-y-4 p-4">
          <div className="card p-4">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">Trouble ticket</h3>
            <p className="text-sm leading-relaxed text-slate-300">{scenario.brief}</p>
            <ul className="mt-2 space-y-0.5 text-xs text-slate-500">
              {scenario.objectives.map((o) => (
                <li key={o}>• {o}</li>
              ))}
            </ul>
          </div>

          <div className="card overflow-hidden">
            <div className="border-b border-edge px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              Topology (read-only)
            </div>
            <div className="h-[300px]">
              <TopologyCanvas
                lab={effective}
                readOnly
                highlightedDeviceIds={highlighted}
                warningCounts={{}}
                activeFaultCounts={{}}
              />
            </div>
          </div>

          <ConnectivityMatrix suite={suite} afterFixSuite={afterFixSuite} />
        </div>
      </div>

      {/* Right: tools */}
      <div className="flex min-h-0 min-w-0 flex-col bg-panel-2">
        <div className="flex border-b border-edge bg-panel">
          {(
            [
              ['investigate', 'Investigate'],
              ['hints', `Hints (${revealedHints}/${scenario.hints.length})`],
              ['submit', solved ? 'Solved' : 'Submit diagnosis'],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button key={key} type="button" className={`tab ${tab === key ? 'tab-active' : ''}`} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {tab === 'investigate' && (
            <>
              <SimNotice label="Diagnostic tools" />
              <div className="card p-4">
                <PingConsole lab={effective} onHighlight={setHighlighted} />
              </div>
              <div className="card p-4">
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-200">
                  <Eye size={14} aria-hidden /> Device configuration
                </h3>
                <select className="input mb-2" value={configDeviceId} onChange={(e) => setConfigDeviceId(e.target.value)}>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.kind})
                    </option>
                  ))}
                </select>
                <pre className="max-h-72 overflow-auto rounded-lg border border-edge bg-night-950 p-3 font-mono text-xs leading-5 text-slate-300">
                  {configText}
                </pre>
              </div>
            </>
          )}

          {tab === 'hints' && (
            <div className="space-y-3">
              <SimNotice label="Hint policy">Each revealed hint reduces the final score by 20% (minimum 40%).</SimNotice>
              {scenario.hints.map((hint, i) => (
                <div key={i} className={`card p-4 ${i < revealedHints ? '' : 'opacity-80'}`}>
                  <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    <Lightbulb size={12} className={i < revealedHints ? 'text-amber-300' : ''} aria-hidden />
                    Hint {i + 1}
                  </div>
                  {i < revealedHints ? (
                    <p className="text-sm text-slate-300">{hint}</p>
                  ) : (
                    <button type="button" className="btn-ghost" onClick={revealHint} disabled={i !== revealedHints}>
                      Reveal hint {i + 1} (−20%)
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'submit' && !solved && (
            <div className="space-y-4">
              <div className="card space-y-3 p-4">
                <h3 className="text-sm font-semibold text-slate-200">Your diagnosis</h3>
                <div>
                  <label className="label">Faulty device</label>
                  <select
                    className="input"
                    value={submission.deviceId}
                    onChange={(e) => setSubmission((s) => ({ ...s, deviceId: e.target.value }))}
                  >
                    <option value="">(select device)</option>
                    {devices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.kind})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Fault type</label>
                  <select
                    className="input"
                    value={submission.kind}
                    onChange={(e) => setSubmission((s) => ({ ...s, kind: e.target.value as Submission['kind'] }))}
                  >
                    <option value="no-fault">No fault — configuration is correct</option>
                    {scenario.faultKinds.map((k) => (
                      <option key={k} value={k}>
                        {kindLabel(k)}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="button" className="btn-primary w-full" disabled={!submission.deviceId} onClick={submit}>
                  <Send size={14} aria-hidden /> Submit diagnosis ({potentialScore} pts)
                </button>
              </div>
              {evaluation && !evaluation.correct && (
                <div className="flex items-start gap-2 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2.5 text-sm text-red-200">
                  <XCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
                  <div>
                    <p className="font-semibold">Not solved yet</p>
                    <p>{evaluation.feedback}</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {solved && (
            <div className="space-y-4">
              <div className="rounded-lg border border-emerald-800/60 bg-emerald-950/30 p-4">
                <div className="flex items-center gap-2 text-emerald-300">
                  <CheckCircle2 size={18} aria-hidden />
                  <h3 className="text-base font-semibold">Case solved — {evaluation?.score ?? 0} / {scenario.points} pts</h3>
                </div>
                <p className="mt-1 text-sm text-emerald-100/80">{evaluation?.feedback}</p>
                {revealedHints > 0 && (
                  <p className="mt-1 text-xs text-emerald-200/60">{revealedHints} hint(s) used.</p>
                )}
              </div>

              <div className="card space-y-2 p-4">
                <h3 className="text-sm font-semibold text-slate-200">Solution</h3>
                <p className="text-sm leading-relaxed text-slate-300">{scenario.solution}</p>
              </div>

              <DetectionReport lab={lab} />

              {!fixed && (
                <button
                  type="button"
                  className="btn-primary w-full"
                  onClick={() => {
                    // Restore the base configuration first (deactivate fault
                    // overlays), then converge machine fixes with re-detection
                    // between steps. Fixing an overlay while it is active would
                    // leave a broken base configuration once deactivated.
                    let next = { ...lab, faults: lab.faults.map((f) => ({ ...f, active: false })) }
                    next = applyAllFixes(next).lab
                    setLab(next)
                    setFixed(true)
                  }}
                >
                  <Wrench size={14} aria-hidden /> Apply fix and re-run tests
                </button>
              )}
              {fixed && (
                <div className="rounded-lg border border-emerald-800/60 bg-emerald-950/25 p-4 text-sm text-emerald-100">
                  <p className="font-semibold text-emerald-300">Fix applied.</p>
                  <p className="mt-1">
                    The connectivity matrix on the left and every diagnostic now run against the repaired configuration —
                    notice how the previously failing probes turn green.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function kindLabel(kind: FaultKind): string {
  const labels: Record<FaultKind, string> = {
    'wrong-ip': 'Incorrect IP address',
    'wrong-mask': 'Incorrect subnet mask',
    'wrong-gateway': 'Incorrect default gateway',
    'interface-down': 'Interface administratively down',
    'link-down': 'Link / cable down',
    'vlan-mismatch': 'VLAN mismatch',
    'dhcp-exhausted': 'DHCP pool exhausted',
    'remove-route': 'Missing static route',
    'duplicate-ip': 'Duplicate IP address',
    'trunk-vlan-missing': 'VLAN missing from trunk allowed list',
    'trunk-native-mismatch': 'Trunk native VLAN mismatch',
    'missing-subinterface': 'Missing router sub-interface',
    'missing-dhcp-relay': 'Missing DHCP relay configuration',
    'wrong-relay-target': 'Wrong DHCP relay target',
    'missing-dhcp-scope': 'Missing DHCP scope for relayed subnet',
    'acl-blocks-traffic': 'ACL blocks required traffic',
  }
  return labels[kind]
}

function ConnectivityMatrix({
  suite,
  afterFixSuite,
}: {
  suite: Array<{ sourceDevice: { id: string; name: string }; targetDevice: { id: string; name: string }; result: { success: boolean; targetIp: string; failCode?: string; explanation: string } }>
  afterFixSuite: Array<{ sourceDevice: { id: string; name: string }; targetDevice: { id: string; name: string }; result: { success: boolean } }> | null
}) {
  const sources = useMemo(() => {
    const map = new Map<string, { name: string; targets: Map<string, { ok: boolean; tooltip: string }> }>()
    for (const probe of suite) {
      if (!map.has(probe.sourceDevice.id)) map.set(probe.sourceDevice.id, { name: probe.sourceDevice.name, targets: new Map() })
      map.get(probe.sourceDevice.id)!.targets.set(probe.targetDevice.id, {
        ok: probe.result.success,
        tooltip: `${probe.sourceDevice.name} → ${probe.result.targetIp}: ${probe.result.explanation}`,
      })
    }
    return [...map.entries()].map(([id, v]) => ({ id, ...v }))
  }, [suite])

  const targetOrder = useMemo(() => {
    const ids: Array<{ id: string; name: string }> = []
    const seen = new Set<string>()
    for (const probe of suite) {
      if (!seen.has(probe.targetDevice.id)) {
        seen.add(probe.targetDevice.id)
        ids.push({ id: probe.targetDevice.id, name: probe.targetDevice.name })
      }
    }
    return ids
  }, [suite])

  if (sources.length === 0) {
    return (
      <div className="card p-4 text-sm text-slate-500">
        No end-host pairs to test. Add PCs or servers with addresses to see the connectivity matrix.
      </div>
    )
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Connectivity matrix (simulated pings)</h3>
        <SimBadge />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left font-medium text-slate-500">From \ To</th>
              {targetOrder.map((t) => (
                <th key={t.id} className="px-3 py-2 text-left font-medium text-slate-400">
                  {t.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id} className="border-t border-edge/60">
                <td className="px-3 py-2 font-medium text-slate-300">{s.name}</td>
                {targetOrder.map((t) => {
                  const cell = s.targets.get(t.id)
                  if (!cell) return <td key={t.id} className="px-3 py-2 text-slate-600">—</td>
                  const afterFix = afterFixSuite?.find(
                    (p) => p.sourceDevice.id === s.id && p.targetDevice.id === t.id,
                  )
                  const ok = afterFix ? afterFix.result.success : cell.ok
                  return (
                    <td key={t.id} className="px-3 py-2" title={cell.tooltip}>
                      {ok ? (
                        <CheckCircle2 size={15} className="text-good" aria-label="reachable" />
                      ) : (
                        <XCircle size={15} className="text-bad" aria-label="unreachable" />
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function DetectionReport({ lab }: { lab: Lab }) {
  const { issues } = useMemo(() => detectIssues(lab), [lab])
  return (
    <div className="card space-y-2 p-4">
      <h3 className="text-sm font-semibold text-slate-200">Detection report</h3>
      {issues.length === 0 && <p className="text-sm text-good">No issues detected — the configuration is clean.</p>}
      <ul className="space-y-2">
        {issues.map((issue) => (
          <li key={issue.id} className="rounded-lg border border-edge bg-panel-2 p-3 text-xs">
            <div className="flex items-center gap-2">
              <span
                className={`badge border ${
                  issue.severity === 'critical'
                    ? 'border-red-700/60 bg-red-950/40 text-red-300'
                    : issue.severity === 'warning'
                      ? 'border-amber-700/60 bg-amber-950/40 text-amber-300'
                      : 'border-edge text-slate-400'
                }`}
              >
                {issue.kind}
              </span>
              <span className="font-semibold text-slate-200">{issue.title}</span>
            </div>
            <p className="mt-1 text-slate-400">{issue.evidence}</p>
            <p className="mt-1 text-slate-400">{issue.explanation}</p>
            {issue.suggestedFix && <p className="mt-1 text-amber-300/90">Fix: {issue.suggestedFix}</p>}
          </li>
        ))}
      </ul>
    </div>
  )
}
