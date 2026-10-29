import {
  ArrowRight,
  CheckCircle2,
  FilePlus2,
  LayoutDashboard,
  Play,
  Stethoscope,
  Trophy,
} from 'lucide-react'
import { SCENARIOS } from './engine/scenarios'
import { useLabs, useProgress } from './state/useStores'
import { labStore } from './storage/labStore'
import { SimNotice } from './components/SimBadge'
import { DeviceIcon } from './components/DeviceIcon'

export type ViewKey = 'dashboard' | 'lab' | 'doctor'

export function Dashboard({ onNavigate, onOpenLab }: { onNavigate: (v: ViewKey) => void; onOpenLab: (id: string) => void }) {
  const { labs } = useLabs()
  const progress = useProgress()
  const completed = SCENARIOS.filter((s) => progress.scenarios[s.id]?.completedAt != null).length
  const totalScore = Object.values(progress.scenarios).reduce((sum, p) => sum + p.bestScore, 0)
  const deviceCount = labs.reduce((sum, l) => sum + l.devices.length, 0)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-bold text-slate-100">
            <LayoutDashboard size={22} className="text-accent" aria-hidden /> Dashboard
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            NetLab Pro combines an interactive network simulator with a troubleshooting academy. Everything runs locally
            in your browser.
          </p>
        </header>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard icon={<Trophy size={16} className="text-amber-400" />} label="Doctor score" value={`${totalScore} pts`} />
          <StatCard icon={<CheckCircle2 size={16} className="text-good" />} label="Cases solved" value={`${completed}/${SCENARIOS.length}`} />
          <StatCard icon={<DeviceIcon kind="router" size={16} />} label="Saved labs" value={String(labs.length)} />
          <StatCard icon={<DeviceIcon kind="switch" size={16} />} label="Devices in labs" value={String(deviceCount)} />
        </div>

        <SimNotice />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <section className="card flex flex-col p-5">
            <h2 className="flex items-center gap-2 text-base font-semibold text-slate-100">
              <DeviceIcon kind="router" size={18} /> NetLab Simulator
            </h2>
            <p className="mb-4 mt-1 flex-1 text-sm leading-relaxed text-slate-400">
              Build topologies with routers, switches, PCs and servers. Configure IPv4 addresses, masks, gateways, VLANs,
              static routes and DHCP pools. Run simulated pings with detailed explanations, inject faults, and save your
              labs in the browser.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary" onClick={() => onNavigate('lab')}>
                Open simulator <ArrowRight size={14} aria-hidden />
              </button>
              <button type="button" className="btn-ghost" onClick={() => onOpenLab(labStore.create('New Lab').id)}>
                <FilePlus2 size={14} aria-hidden /> New empty lab
              </button>
            </div>
          </section>

          <section className="card flex flex-col p-5">
            <h2 className="flex items-center gap-2 text-base font-semibold text-slate-100">
              <Stethoscope size={18} className="text-accent" /> NetDoctor Academy
            </h2>
            <p className="mb-4 mt-1 flex-1 text-sm leading-relaxed text-slate-400">
              Seven built-in troubleshooting cases — from wrong gateways and masks to VLAN isolation, DHCP exhaustion and
              missing routes — plus practice runs on your own topologies. Hints, scoring and completion tracking included.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary" onClick={() => onNavigate('doctor')}>
                Start a case <Play size={14} aria-hidden />
              </button>
            </div>
          </section>
        </div>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">Recent labs</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {labs.slice(0, 4).map((lab) => (
              <button
                key={lab.id}
                type="button"
                className="card group p-4 text-left transition hover:border-accent/60"
                onClick={() => onOpenLab(lab.id)}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-200">{lab.name}</span>
                  <span className="badge border border-edge bg-panel-2 text-slate-400">
                    {lab.origin === 'sample' ? 'sample' : 'user'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {lab.devices.length} devices · {lab.links.length} links
                  {lab.faults.filter((f) => f.active).length > 0
                    ? ` · ${lab.faults.filter((f) => f.active).length} active faults`
                    : ''}
                </p>
              </button>
            ))}
            {labs.length === 0 && <p className="text-sm text-slate-500">No labs yet — create one in the simulator.</p>}
          </div>
        </section>
      </div>
    </div>
  )
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="card flex items-center gap-3 p-4">
      <span className="grid size-9 place-items-center rounded-lg border border-edge bg-panel-2">{icon}</span>
      <div>
        <div className="text-lg font-bold text-slate-100">{value}</div>
        <div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div>
      </div>
    </div>
  )
}
