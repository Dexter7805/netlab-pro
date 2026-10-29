import { FlaskConical } from 'lucide-react'

/** Always-visible label marking results as simulated, never live data. */
export function SimBadge({ label = 'Simulated' }: { label?: string }) {
  return (
    <span
      className="badge border border-amber-500/40 bg-amber-500/10 text-amber-300"
      title="This result comes from the built-in simulator — it is not live network data."
    >
      <FlaskConical size={11} aria-hidden />
      {label}
    </span>
  )
}

export function SimNotice({ label, children }: { label?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-600/30 bg-amber-950/30 px-3 py-2 text-xs text-amber-200/90">
      <FlaskConical size={14} className="mt-0.5 shrink-0 text-amber-400" aria-hidden />
      <p>
        <strong className="font-semibold text-amber-300">{label ?? 'Simulated environment.'}</strong>{' '}
        {children ?? 'All results shown here are produced by the local simulation engine — no live network data is used anywhere in this app.'}
      </p>
    </div>
  )
}
