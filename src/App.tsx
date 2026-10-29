import { useState } from 'react'
import { LayoutDashboard, Network, Stethoscope } from 'lucide-react'
import { Dashboard } from './Dashboard'
import type { ViewKey } from './Dashboard'
import { NetLabView } from './lab/NetLabView'
import { DoctorView } from './doctor/DoctorView'
import { LearningModeToggle } from './components/learn'

const NAV: Array<{ key: ViewKey; label: string; icon: typeof Network }> = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'lab', label: 'NetLab Simulator', icon: Network },
  { key: 'doctor', label: 'NetDoctor Academy', icon: Stethoscope },
]

export default function App() {
  const [view, setView] = useState<ViewKey>('dashboard')
  const [labId, setLabId] = useState<string | null>(null)

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* Sidebar */}
      <nav className="flex shrink-0 flex-row items-center gap-1 border-b border-edge bg-night-950 px-3 py-2 md:w-56 md:flex-col md:items-stretch md:gap-1 md:border-b-0 md:border-r md:px-3 md:py-4">
        <button
          type="button"
          className="mr-2 flex items-center gap-2 rounded-lg px-1 py-1 text-left transition hover:bg-panel md:mb-6 md:mr-0"
          onClick={() => setView('dashboard')}
          title="Go to Dashboard"
          aria-label="NetLab Pro — go to Dashboard"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent font-black text-night-950">N</span>
          <div className="leading-tight">
            <div className="text-sm font-bold text-slate-100">NetLab Pro</div>
            <div className="hidden text-[10px] uppercase tracking-wider text-slate-500 md:block">
              Simulator &amp; Academy
            </div>
          </div>
        </button>
        {NAV.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition md:w-full ${
              view === key ? 'bg-accent/15 text-accent' : 'text-slate-400 hover:bg-panel hover:text-slate-200'
            }`}
            aria-current={view === key ? 'page' : undefined}
          >
            <Icon size={16} aria-hidden />
            <span className="hidden md:inline">{label}</span>
          </button>
        ))}
        <div className="ml-auto hidden flex-col gap-1 md:mt-auto md:ml-0 md:flex">
          <LearningModeToggle />
          <p className="px-3 text-[10px] leading-4 text-slate-600">
            All network behavior is <span className="font-semibold text-amber-500/80">simulated</span> — no live network
            data is used.
          </p>
        </div>
      </nav>

      {/* Content */}
      <main className="min-h-0 min-w-0 flex-1">
        {view === 'dashboard' && <Dashboard onNavigate={setView} onOpenLab={(id) => { setLabId(id); setView('lab') }} />}
        {view === 'lab' && <NetLabView labId={labId} onLabCreated={setLabId} />}
        {view === 'doctor' && <DoctorView />}
      </main>
    </div>
  )
}
