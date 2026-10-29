import { useMemo, useState } from 'react'
import { Bug, Plus, PowerOff, Trash2 } from 'lucide-react'
import type { FaultKind, Lab } from '../engine/types'
import { describeFaultMatch } from '../engine/scenarios'

export interface FaultPanelProps {
  lab: Lab
  onAdd: (draft: {
    kind: FaultKind
    deviceId: string
    interfaceId?: string
    linkId?: string
    routeId?: string
    poolId?: string
    subInterfaceId?: string
    value?: string
  }) => void
  onToggle: (faultId: string, active: boolean) => void
  onRemove: (faultId: string) => void
}

const KINDS: Array<{ kind: FaultKind; label: string; needs: 'interface' | 'device' | 'link' | 'pool' | 'route' | 'subinterface' | 'relay'; valueKind?: 'cidr' | 'ip' | 'vlan'; hint?: string }> = [
  { kind: 'wrong-ip', label: 'Wrong IP address', needs: 'interface', valueKind: 'cidr', hint: 'e.g. 192.168.9.10/24' },
  { kind: 'wrong-mask', label: 'Wrong subnet mask', needs: 'interface', valueKind: 'cidr', hint: 'e.g. 192.168.1.10/25' },
  { kind: 'wrong-gateway', label: 'Wrong default gateway', needs: 'device', valueKind: 'ip', hint: 'e.g. 192.168.1.99 (empty = none)' },
  { kind: 'interface-down', label: 'Interface shut down', needs: 'interface' },
  { kind: 'link-down', label: 'Cable / link down', needs: 'link' },
  { kind: 'vlan-mismatch', label: 'VLAN mismatch', needs: 'interface', valueKind: 'vlan', hint: 'Access VLAN id, e.g. 20' },
  { kind: 'dhcp-exhausted', label: 'DHCP pool exhausted', needs: 'pool' },
  { kind: 'remove-route', label: 'Remove static route', needs: 'route' },
  { kind: 'duplicate-ip', label: 'Duplicate IP conflict', needs: 'interface', valueKind: 'cidr', hint: 'IP of another device, e.g. 192.168.1.10/24' },
  { kind: 'trunk-vlan-missing', label: 'VLAN missing from trunk allowed list', needs: 'interface', valueKind: 'vlan', hint: 'VLAN id to remove, e.g. 10' },
  { kind: 'trunk-native-mismatch', label: 'Wrong native VLAN on trunk', needs: 'interface', valueKind: 'vlan', hint: 'New native VLAN id, e.g. 99' },
  { kind: 'missing-subinterface', label: 'Remove router sub-interface', needs: 'subinterface' },
  { kind: 'missing-dhcp-relay', label: 'Remove DHCP relay (helper)', needs: 'relay' },
  { kind: 'wrong-relay-target', label: 'Wrong DHCP relay target', needs: 'relay', valueKind: 'ip', hint: 'New relay target, e.g. 10.0.0.99' },
  { kind: 'missing-dhcp-scope', label: 'Remove DHCP scope from server', needs: 'pool' },
]

export function FaultPanel({ lab, onAdd, onToggle, onRemove }: FaultPanelProps) {
  const devices = useMemo(() => [...lab.devices].sort((a, b) => a.name.localeCompare(b.name)), [lab.devices])
  const [kind, setKind] = useState<FaultKind>('wrong-gateway')
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? '')
  const [interfaceId, setInterfaceId] = useState('')
  const [linkId, setLinkId] = useState('')
  const [poolId, setPoolId] = useState('')
  const [routeId, setRouteId] = useState('')
  const [subInterfaceId, setSubInterfaceId] = useState('')
  const [relayIfaceId, setRelayIfaceId] = useState('')
  const [relaySubId, setRelaySubId] = useState('')
  const [value, setValue] = useState('')

  const kindMeta = KINDS.find((k) => k.kind === kind)!
  const selectedDevice = devices.find((d) => d.id === deviceId)
  const selectedRouter = devices.find((d) => d.id === deviceId && d.kind === 'router')
  const selectedServer = devices.find((d) => d.id === deviceId && d.kind === 'server')
  const parentIface = selectedDevice?.interfaces.find((i) => (i.subInterfaces ?? []).length > 0)
  const relayIface = selectedDevice?.interfaces.find((i) => i.id === relayIfaceId)
  const relaySubOptions = relayIface?.role === 'routed' ? relayIface.subInterfaces ?? [] : []

  const linkLabel = (l: Lab['links'][number]) => {
    const nameOf = (id: string) => devices.find((d) => d.id === id)?.name ?? '?'
    return `${nameOf(l.aDeviceId)} ↔ ${nameOf(l.bDeviceId)}`
  }

  const switchKind = (nextKind: FaultKind) => {
    setKind(nextKind)
    setValue('')
    setInterfaceId('')
    setLinkId('')
    setPoolId('')
    setRouteId('')
    setSubInterfaceId('')
    setRelayIfaceId('')
    setRelaySubId('')
  }

  const submit = () => {
    if (!deviceId) return
    onAdd({
      kind,
      deviceId,
      interfaceId:
        kindMeta.needs === 'subinterface' && parentIface
          ? parentIface.id
          : kindMeta.needs === 'relay' && relayIfaceId
            ? relayIfaceId
            : kindMeta.needs === 'interface' && interfaceId
              ? interfaceId
              : undefined,
      linkId: kindMeta.needs === 'link' && linkId ? linkId : undefined,
      poolId: kindMeta.needs === 'pool' && poolId ? poolId : undefined,
      routeId: kindMeta.needs === 'route' && routeId ? routeId : undefined,
      subInterfaceId: kindMeta.needs === 'subinterface' && subInterfaceId ? subInterfaceId : kindMeta.needs === 'relay' && relaySubId ? relaySubId : undefined,
      value: kindMeta.valueKind && value.trim() !== '' ? value.trim() : undefined,
    })
    setValue('')
  }

  const devicePickerDisabled = kindMeta.needs === 'pool' || kindMeta.needs === 'route'

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-edge bg-panel-2 p-3">
        <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
          <Bug size={12} aria-hidden /> Inject a fault
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2">
            <label className="label">Fault type</label>
            <select className="input" value={kind} onChange={(e) => switchKind(e.target.value as FaultKind)}>
              {KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
          <div className={kindMeta.needs === 'link' ? 'hidden' : devicePickerDisabled ? 'col-span-2' : ''}>
            <label className="label">
              {kindMeta.needs === 'pool' ? 'DHCP server' : kindMeta.needs === 'route' ? 'Router' : 'Device'}
            </label>
            <select
              className="input"
              value={deviceId}
              onChange={(e) => {
                setDeviceId(e.target.value)
                setInterfaceId('')
                setPoolId('')
                setRouteId('')
              }}
            >
              {devices
                .filter((d) =>
                  kindMeta.needs === 'pool'
                    ? d.dhcpPools.length > 0
                    : kindMeta.needs === 'route'
                      ? d.staticRoutes.length > 0
                      : kindMeta.needs === 'subinterface'
                        ? d.interfaces.some((i) => (i.subInterfaces ?? []).length > 0)
                        : true,
                )
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.kind})
                  </option>
                ))}
            </select>
          </div>
          {kindMeta.needs === 'interface' && (
            <div>
              <label className="label">Interface</label>
              <select className="input" value={interfaceId} onChange={(e) => setInterfaceId(e.target.value)}>
                <option value="">(auto)</option>
                {(selectedDevice?.interfaces ?? []).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                    {i.role === 'switchport' ? ` (VLAN ${i.accessVlan})` : i.cidr ? ` (${i.cidr})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          {kindMeta.needs === 'link' && (
            <div className="col-span-2">
              <label className="label">Link</label>
              <select className="input" value={linkId} onChange={(e) => setLinkId(e.target.value)}>
                <option value="">(select a cable)</option>
                {lab.links.map((l) => (
                  <option key={l.id} value={l.id}>
                    {linkLabel(l)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {kindMeta.needs === 'pool' && selectedServer && (
            <div>
              <label className="label">Pool</label>
              <select className="input" value={poolId} onChange={(e) => setPoolId(e.target.value)}>
                <option value="">(select pool)</option>
                {selectedServer.dhcpPools.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.rangeStart}–{p.rangeEnd})
                  </option>
                ))}
              </select>
            </div>
          )}
          {kindMeta.needs === 'subinterface' && parentIface && (
            <div className="col-span-2">
              <label className="label">Sub-interface to remove</label>
              <select className="input" value={subInterfaceId} onChange={(e) => setSubInterfaceId(e.target.value)}>
                <option value="">(select sub-interface)</option>
                {(parentIface.subInterfaces ?? []).map((sub) => (
                  <option key={sub.id} value={sub.id}>
                    {sub.name} (VLAN {sub.vlanId}, {sub.cidr ?? 'no address'})
                  </option>
                ))}
              </select>
            </div>
          )}
          {kindMeta.needs === 'relay' && (
            <>
              <div>
                <label className="label">Router interface</label>
                <select
                  className="input"
                  value={relayIfaceId}
                  onChange={(e) => {
                    setRelayIfaceId(e.target.value)
                    setRelaySubId('')
                  }}
                >
                  <option value="">(select routed interface)</option>
                  {(selectedDevice?.interfaces ?? [])
                    .filter((i) => i.role === 'routed')
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="label">Sub-interface (optional)</label>
                <select className="input" value={relaySubId} onChange={(e) => setRelaySubId(e.target.value)}>
                  <option value="">(the physical interface)</option>
                  {relaySubOptions.map((sub) => (
                    <option key={sub.id} value={sub.id}>
                      {sub.name} (VLAN {sub.vlanId})
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
          {kindMeta.needs === 'route' && selectedRouter && (
            <div className="col-span-2">
              <label className="label">Static route to remove</label>
              <select className="input" value={routeId} onChange={(e) => setRouteId(e.target.value)}>
                <option value="">(select route)</option>
                {selectedRouter.staticRoutes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.destinationCidr} via {r.nextHopIp}
                  </option>
                ))}
              </select>
            </div>
          )}
          {kindMeta.valueKind && (
            <div className="col-span-2">
              <label className="label">
                {kindMeta.valueKind === 'vlan' ? 'New VLAN id' : kindMeta.valueKind === 'ip' ? 'Gateway value' : 'Replacement address/prefix'}
              </label>
              <input
                className="input font-mono"
                placeholder={kindMeta.hint ?? ''}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          )}
        </div>
        <button
          type="button"
          className="btn-primary mt-3 w-full"
          onClick={submit}
          disabled={
            (kindMeta.needs === 'link' && !linkId) ||
            (kindMeta.needs === 'pool' && !poolId) ||
            (kindMeta.needs === 'route' && !routeId) ||
            (kindMeta.needs === 'subinterface' && (!subInterfaceId || !parentIface)) ||
            (kindMeta.needs === 'relay' && !relayIfaceId) ||
            !deviceId
          }
        >
          <Plus size={14} aria-hidden /> Add fault
        </button>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
          Active faults ({lab.faults.length})
        </h4>
        {lab.faults.length === 0 && <p className="text-sm text-slate-500">No faults injected. The configuration runs as authored.</p>}
        <ul className="space-y-1.5">
          {lab.faults.map((fault) => {
            const device = devices.find((d) => d.id === fault.deviceId)
            const iface = device?.interfaces.find((i) => i.id === fault.interfaceId)
            return (
              <li
                key={fault.id}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm ${
                  fault.active ? 'border-red-900/60 bg-red-950/20' : 'border-edge bg-panel-2 opacity-60'
                }`}
              >
                <button
                  type="button"
                  className={`rounded p-1 ${fault.active ? 'text-red-400' : 'text-slate-500'}`}
                  title={fault.active ? 'Deactivate fault' : 'Activate fault'}
                  onClick={() => onToggle(fault.id, !fault.active)}
                >
                  <PowerOff size={13} aria-hidden />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-slate-200">
                    {device?.name ?? '?'}
                    {iface ? ` ${iface.name}` : ''}: {describeFaultMatch(fault)}
                  </div>
                </div>
                <button
                  type="button"
                  className="rounded p-1 text-slate-500 hover:text-red-400"
                  title="Remove fault"
                  onClick={() => onRemove(fault.id)}
                >
                  <Trash2 size={13} aria-hidden />
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}