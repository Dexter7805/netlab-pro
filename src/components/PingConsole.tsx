import { useEffect, useMemo, useState } from 'react'
import { Play, Wifi, WifiOff } from 'lucide-react'
import { runPing } from '../engine/ping'
import type { Lab, PingResult } from '../engine/types'
import { SimBadge } from './SimBadge'
import { LearnBox } from './learn'

export interface PingConsoleProps {
  lab: Lab
  onHighlight?: (deviceIds: string[]) => void
  initialSourceId?: string
}

/**
 * Interactive simulated ping tool. Runs the real engine (`runPing`) —
 * faults applied, DHCP resolved — and explains the outcome.
 */
export function PingConsole({ lab, onHighlight, initialSourceId }: PingConsoleProps) {
  const candidates = useMemo(
    () => lab.devices.filter((d) => d.kind !== 'switch').sort((a, b) => a.name.localeCompare(b.name)),
    [lab.devices],
  )
  const [sourceId, setSourceId] = useState(initialSourceId ?? candidates[0]?.id ?? '')
  const [target, setTarget] = useState('')
  const [protocol, setProtocol] = useState<'icmp' | 'tcp' | 'udp'>('icmp')
  const [destPort, setDestPort] = useState('80')
  const [result, setResult] = useState<PingResult | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    if (!candidates.some((d) => d.id === sourceId) && candidates[0]) {
      setSourceId(candidates[0].id)
    }
  }, [candidates, sourceId])

  // Quick-target suggestions: every host/server with an address.
  const quickTargets = useMemo(() => {
    const out: Array<{ label: string; ip: string }> = []
    for (const device of lab.devices) {
      if (device.kind === 'switch') continue
      if (device.id === sourceId) continue
      for (const iface of device.interfaces) {
        if (iface.enabled && iface.cidr) {
          out.push({ label: `${device.name} ${iface.name}`, ip: iface.cidr.split('/')[0] })
        }
        for (const sub of iface.subInterfaces ?? []) {
          if (sub.enabled && sub.cidr) {
            out.push({ label: `${device.name} ${sub.name}`, ip: sub.cidr.split('/')[0] })
          }
        }
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label))
  }, [lab.devices, sourceId])

  const execute = () => {
    if (!sourceId || !target.trim()) return
    setRunning(true)
    setResult(null)
    onHighlight?.([])
    // Small delay so the interaction feels like a real command, then run the engine.
    window.setTimeout(() => {
      const port = Number(destPort)
      const res = runPing(lab, sourceId, target.trim(), {
        protocol,
        destPort: protocol === 'icmp' ? undefined : Number.isInteger(port) && port > 0 ? port : undefined,
      })
      setResult(res)
      setRunning(false)
      onHighlight?.(res.pathDeviceIds)
    }, 320)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">Ping tool</h3>
        <SimBadge />
      </div>
      {/* Responsive rows: source/target fill the width; protocol, port and the
          button share a wrapping row so nothing clips in narrow panels. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="min-w-0">
          <label className="label" htmlFor="ping-source">Source device</label>
          <select id="ping-source" className="input min-w-0" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            {candidates.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.kind})
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <label className="label" htmlFor="ping-target">Target IP</label>
          <input
            id="ping-target"
            className="input min-w-0 font-mono"
            placeholder="e.g. 10.0.0.20"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && execute()}
          />
        </div>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
          <div className="min-w-0 flex-1 basis-28">
            <label className="label" htmlFor="ping-protocol">Protocol</label>
            <select
              id="ping-protocol"
              className="input min-w-0"
              value={protocol}
              onChange={(e) => setProtocol(e.target.value as 'icmp' | 'tcp' | 'udp')}
              title="ICMP = classic ping; TCP/UDP simulate connection tests"
            >
              <option value="icmp">icmp</option>
              <option value="tcp">tcp</option>
              <option value="udp">udp</option>
            </select>
          </div>
          <div className="w-20 shrink-0">
            <label className="label" htmlFor="ping-port">Port</label>
            <input
              id="ping-port"
              className="input font-mono"
              type="number"
              min={1}
              max={65535}
              value={destPort}
              disabled={protocol === 'icmp'}
              onChange={(e) => setDestPort(e.target.value)}
            />
          </div>
          <div className="grow sm:grow-0">
            <button
              type="button"
              className="btn-primary w-full sm:min-w-28"
              onClick={execute}
              disabled={running || !sourceId || !target.trim()}
            >
              <Play size={14} aria-hidden /> {running ? 'Running…' : 'Ping'}
            </button>
          </div>
        </div>
      </div>

      {quickTargets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {quickTargets.slice(0, 6).map((qt) => (
            <button key={`${qt.label}-${qt.ip}`} type="button" className="btn-chip font-mono" onClick={() => setTarget(qt.ip)}>
              {qt.label}
            </button>
          ))}
        </div>
      )}

      {running && (
        <div className="animate-pulse rounded-lg border border-edge bg-panel-2 px-3 py-2 text-sm text-slate-400">
          Sending ICMP echo (simulated)…
        </div>
      )}

      <LearnBox topic="ping-results" />

      {result && !running && (
        <div
          className={`rounded-lg border px-3 py-2.5 text-sm ${
            result.success ? 'border-emerald-800/60 bg-emerald-950/30' : 'border-red-900/60 bg-red-950/25'
          }`}
          role="status"
        >
          <div className="mb-1.5 flex items-center gap-2 font-semibold">
            {result.success ? (
              <Wifi size={15} className="text-good" aria-hidden />
            ) : (
              <WifiOff size={15} className="text-bad" aria-hidden />
            )}
            <span className={result.success ? 'text-good' : 'text-bad'}>
              {result.success ? `Reply from ${result.targetIp}` : `Ping failed (${result.failCode})`}
            </span>
            <span className="ml-auto font-mono text-xs text-slate-400">
              {result.sourceDeviceName}
              {result.sourceIp ? ` [${result.sourceIp}]` : ' [no IP]'}
            </span>
          </div>
          <p className="text-slate-300">{result.explanation}</p>
          {result.aclHit && (
            <p className="mt-1 rounded border border-violet-800/60 bg-violet-950/30 px-2 py-1 text-xs text-violet-200">
              <span className="font-semibold">ACL decision:</span> rule {result.aclHit.ruleIndex + 1} of "{result.aclHit.aclName}" ({result.aclHit.action}{' '}
              {result.aclHit.protocol} {result.aclHit.source} → {result.aclHit.destination}
              {result.aclHit.destPort != null ? ` port ${result.aclHit.destPort}` : ''}) on {result.aclHit.deviceName}{' '}
              {result.aclHit.subInterfaceName ?? result.aclHit.interfaceName}, {result.aclHit.direction === 'in' ? 'inbound' : 'outbound'}.
            </p>
          )}
          {result.suggestion && <p className="mt-1 text-xs text-amber-300/90">Suggestion: {result.suggestion}</p>}
          {result.hops.length > 0 && (
            <ol className="mt-2 space-y-1 border-t border-white/5 pt-2 text-xs text-slate-400">
              {result.hops.map((hop, i) => (
                <li key={i} className="flex gap-2">
                  <span className="font-mono text-slate-600">{String(i + 1).padStart(2, '0')}</span>
                  <span>
                    <span className="font-semibold text-slate-300">{hop.deviceName}</span>
                    {hop.interfaceName ? <span className="font-mono"> ({hop.interfaceName})</span> : null} — {hop.detail}
                    {hop.rttMs != null && <span className="font-mono text-slate-500"> · {hop.rttMs} ms</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}
