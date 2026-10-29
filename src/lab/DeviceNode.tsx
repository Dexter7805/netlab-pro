import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { AlertTriangle, Bug } from 'lucide-react'
import { DeviceIcon, KIND_LABEL } from '../components/DeviceIcon'
import type { Device } from '../engine/types'

export interface DeviceNodeData extends Record<string, unknown> {
  device: Device
  warningCount: number
  activeFaultCount: number
  highlighted: boolean
  readOnly: boolean
}

function interfaceSide(index: number): 'left' | 'right' {
  return index % 2 === 0 ? 'right' : 'left'
}

function DeviceNodeInner({ data, selected }: NodeProps) {
  const { device, warningCount, activeFaultCount, highlighted, readOnly } = data as DeviceNodeData

  const renderHandle = (ifaceIndex: number) => {
    const iface = device.interfaces[ifaceIndex]
    const side = interfaceSide(ifaceIndex)
    const sameSide = device.interfaces.filter((_, i) => interfaceSide(i) === side)
    const posAmongSide = sameSide.findIndex((i) => i.id === iface.id)
    const top = `${((posAmongSide + 1) / (sameSide.length + 1)) * 100}%`
    return (
      <Handle
        key={iface.id}
        id={iface.id}
        type="source"
        position={side === 'left' ? Position.Left : Position.Right}
        style={{ top }}
        isConnectable={!readOnly}
        title={`${iface.name} (${iface.cidr ?? iface.ipMode})`}
      />
    )
  }

  return (
    <div
      className={`w-40 rounded-lg border bg-panel px-3 py-2 transition ${
        selected ? 'border-accent shadow-[0_0_0_2px_rgba(34,211,238,0.35)]' : 'border-edge'
      } ${highlighted ? 'border-good shadow-[0_0_0_2px_rgba(52,211,153,0.45)]' : ''}`}
    >
      {device.interfaces.map((_, i) => renderHandle(i))}
      <div className="flex items-center gap-2">
        <DeviceIcon kind={device.kind} size={20} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-100">{device.name}</div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">{KIND_LABEL[device.kind]}</div>
        </div>
        {activeFaultCount > 0 && !readOnly && (
          <span className="badge ml-auto border border-red-500/40 bg-red-500/10 text-red-300" title={`${activeFaultCount} active fault(s)`}>
            <Bug size={10} aria-hidden /> {activeFaultCount}
          </span>
        )}
        {warningCount > 0 && activeFaultCount === 0 && (
          <span className="badge ml-auto border border-amber-500/40 bg-amber-500/10 text-amber-300" title={`${warningCount} validation warning(s)`}>
            <AlertTriangle size={10} aria-hidden /> {warningCount}
          </span>
        )}
      </div>
      <div className="mt-1.5 space-y-0.5 border-t border-edge pt-1.5">
        {device.interfaces.slice(0, 4).map((iface) => (
          <div key={iface.id} className="flex items-center justify-between gap-1 text-[10px] leading-3">
            <span className={iface.enabled ? 'text-slate-400' : 'text-red-400 line-through'}>{iface.name}</span>
            <span className="truncate font-mono text-slate-500">
              {iface.role === 'switchport'
                ? (iface.portMode ?? 'access') === 'trunk'
                  ? `TRUNK ${(iface.allowedVlans ?? []).join(',') || 'none'}`
                  : `VLAN ${iface.accessVlan}`
                : iface.cidr ?? (iface.ipMode === 'dhcp' ? 'DHCP' : '—')}
            </span>
          </div>
        ))}
        {device.interfaces.length > 4 && <div className="text-[10px] text-slate-600">+{device.interfaces.length - 4} more…</div>}
        {device.kind === 'router' && device.interfaces.some((i) => (i.subInterfaces ?? []).length > 0) && (
          <div className="text-[10px] text-accent/70">
            {device.interfaces.flatMap((i) => i.subInterfaces ?? []).map((sub) => sub.name).join(', ')}
          </div>
        )}
      </div>
    </div>
  )
}

export const DeviceNode = memo(DeviceNodeInner)
