import { useMemo, useState } from 'react'
import { CheckCircle2, ClipboardList, Play, Stethoscope, Trophy, Wrench } from 'lucide-react'
import { SCENARIOS, DIFFICULTY_LABEL } from '../engine/scenarios'
import type { Scenario } from '../engine/scenarios'
import type { FaultKind, Lab } from '../engine/types'
import { addFault, removeFault, updateFault } from '../engine/labOps'
import { useLabs, useProgress } from '../state/useStores'
import { ScenarioRunner } from './ScenarioRunner'
import { FaultPanel } from '../components/FaultPanel'
import { SimNotice } from '../components/SimBadge'

const DIFF_STYLE: Record<string, string> = {
  easy: 'border-emerald-700/60 bg-emerald-950/40 text-emerald-300',
  medium: 'border-amber-700/60 bg-amber-950/40 text-amber-300',
  hard: 'border-red-700/60 bg-red-950/40 text-red-300',
}

interface ActiveCase {
  scenario: Scenario
  lab: Lab
  runKey: number
}

export function DoctorView() {
  const { labs } = useLabs()
  const progress = useProgress()
  const [active, setActive] = useState<ActiveCase | null>(null)
  const [practiceLabId, setPracticeLabId] = useState<string>('')
  const [practiceLab, setPracticeLab] = useState<Lab | null>(null)
  const [configuring, setConfiguring] = useState(false)

  const completedCount = useMemo(
    () => SCENARIOS.filter((s) => progress.scenarios[s.id]?.completedAt != null).length,
    [progress],
  )
  const totalScore = useMemo(
    () => Object.values(progress.scenarios).reduce((sum, p) => sum + p.bestScore, 0),
    [progress],
  )

  const startScenario = (scenario: Scenario) => {
    setActive({ scenario, lab: scenario.buildLab(), runKey: Date.now() })
  }

  const startPractice = () => {
    if (!practiceLab) return
    const scenario: Scenario = {
      id: `practice-${practiceLab.id}-${Date.now()}`,
      title: `Practice: ${practiceLab.name}`,
      difficulty: practiceLab.faults.filter((f) => f.active).length > 1 ? 'hard' : 'medium',
      points: 100,
      brief: `Open practice case on your lab "${practiceLab.name}". ${practiceLab.faults.filter((f) => f.active).length} fault(s) were injected while you were configuring it — find and identify at least one of them using the diagnostic tools.`,
      objectives: ['Reproduce the symptom with the ping tool', 'Inspect device configurations', 'Identify the device and fault type'],
      hints: [
        'Start with the connectivity matrix: which source/destination pairs fail, and how?',
        'Read the failing devices’ configurations — compare addresses, masks, gateways, VLANs and routes.',
        'The ping failure code and hop list tell you where the packet dies; that device is usually where the fault lives.',
      ],
      faultKinds: [
        'wrong-ip',
        'wrong-mask',
        'wrong-gateway',
        'interface-down',
        'link-down',
        'vlan-mismatch',
        'dhcp-exhausted',
        'remove-route',
        'duplicate-ip',
      ] as FaultKind[],
      buildLab: () => practiceLab,
      solution: 'Practice case: review the detection report above and compare it with your diagnosis.',
    }
    setActive({ scenario, lab: structuredClone(practiceLab), runKey: Date.now() })
  }

  if (active) {
    return (
      <ScenarioRunner
        key={active.runKey}
        scenario={active.scenario}
        lab={active.lab}
        onExit={() => setActive(null)}
      />
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-bold text-slate-100">
              <Stethoscope size={22} className="text-accent" aria-hidden /> NetDoctor Academy
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Diagnose realistic network faults using the same simulation engine as NetLab. Investigate, then submit your
              diagnosis to score points.
            </p>
          </div>
          <div className="flex gap-2">
            <div className="card flex items-center gap-2 px-4 py-2 text-sm">
              <Trophy size={16} className="text-amber-400" aria-hidden />
              <span className="text-slate-300">
                {totalScore} pts
              </span>
            </div>
            <div className="card flex items-center gap-2 px-4 py-2 text-sm">
              <CheckCircle2 size={16} className="text-good" aria-hidden />
              <span className="text-slate-300">
                {completedCount}/{SCENARIOS.length} solved
              </span>
            </div>
          </div>
        </header>

        <SimNotice label="Simulated cases">All cases run on the local simulation engine against stored labs — no live network is involved.</SimNotice>

        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
            <ClipboardList size={14} aria-hidden /> Built-in cases
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {SCENARIOS.map((scenario) => {
              const prog = progress.scenarios[scenario.id]
              const done = prog?.completedAt != null
              return (
                <article key={scenario.id} className="card flex flex-col p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <h3 className="flex-1 text-sm font-semibold text-slate-100">{scenario.title}</h3>
                    <span className={`badge border ${DIFF_STYLE[scenario.difficulty]}`}>{DIFFICULTY_LABEL[scenario.difficulty]}</span>
                  </div>
                  <p className="mb-3 flex-1 text-xs leading-relaxed text-slate-400">{scenario.brief}</p>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">
                      {scenario.points} pts
                      {prog?.bestScore ? ` · best ${prog.bestScore}` : ''}
                      {done ? ' · completed' : ''}
                    </span>
                    <button type="button" className="btn-primary" onClick={() => startScenario(scenario)}>
                      <Play size={13} aria-hidden /> {done ? 'Replay' : 'Start case'}
                    </button>
                  </div>
                  {done && (
                    <div className="mt-2 flex items-center gap-1 text-[11px] text-good">
                      <CheckCircle2 size={11} aria-hidden /> Solved {new Date(prog!.completedAt!).toLocaleDateString()}
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        </section>

        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
            <Wrench size={14} aria-hidden /> Practice on your own NetLab topology
          </h2>
          <div className="card space-y-4 p-4">
            <p className="text-sm text-slate-400">
              Pick any saved lab, inject faults exactly like in NetLab, then run a practice diagnosis against it.
            </p>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto_auto]">
              <select
                className="input"
                value={practiceLabId}
                onChange={(e) => {
                  setPracticeLabId(e.target.value)
                  const lab = labs.find((l) => l.id === e.target.value) ?? null
                  setPracticeLab(lab ? structuredClone(lab) : null)
                  setConfiguring(false)
                }}
              >
                <option value="">(select a lab)</option>
                {labs.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.devices.length} devices)
                  </option>
                ))}
              </select>
              <button type="button" className="btn-ghost" disabled={!practiceLab} onClick={() => setConfiguring((c) => !c)}>
                {configuring ? 'Hide fault editor' : 'Configure faults'}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!practiceLab || practiceLab.faults.filter((f) => f.active).length === 0}
                onClick={startPractice}
                title={practiceLab && practiceLab.faults.filter((f) => f.active).length === 0 ? 'Inject at least one fault first' : ''}
              >
                <Play size={13} aria-hidden /> Start practice run
              </button>
            </div>
            {practiceLab && configuring && (
              <div className="rounded-lg border border-edge bg-panel-2 p-4">
                <FaultPanel
                  lab={practiceLab}
                  onAdd={(draft) =>
                    setPracticeLab((prev) => (prev ? addFault(prev, draft as { kind: FaultKind; deviceId: string }) : prev))
                  }
                  onToggle={(faultId, activeFlag) =>
                    setPracticeLab((prev) => (prev ? updateFault(prev, faultId, { active: activeFlag }) : prev))
                  }
                  onRemove={(faultId) => setPracticeLab((prev) => (prev ? removeFault(prev, faultId) : prev))}
                />
              </div>
            )}
            {practiceLab && practiceLab.faults.length > 0 && !configuring && (
              <p className="text-xs text-slate-500">
                {practiceLab.faults.filter((f) => f.active).length} active fault(s) configured for this practice run.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
