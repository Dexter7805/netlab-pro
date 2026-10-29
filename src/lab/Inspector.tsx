import { useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import type { Device, Lab } from '../engine/types'
import type { ValidationIssue } from '../engine/validate'
import { validateInterfaceCidrInput } from '../engine/validate'
import { DeviceIcon, KIND_LABEL } from '../components/DeviceIcon'
import { LearnBox } from '../components/learn'
import { AclEditor } from '../components/AclEditor'

export interface InspectorProps {
  lab: Lab
  device: Device | null
  issues: ValidationIssue[]
  onChangeDevice: (patch: Partial<Pick<Device, 'name' | 'gatewayIp'>>) => void
  onChangeInterface: (interfaceId: string, patch: Record<string, unknown>) => void
  onAddInterface: () => void
  onDeleteInterface: (interfaceId: string) => void
  onAddStaticRoute: (destinationCidr: string, nextHopIp: string) => void
  onDeleteStaticRoute: (routeId: string) => void
  onAddDhcpPool: () => void
  onChangeDhcpPool: (poolId: string, patch: Record<string, unknown>) => void
  onDeleteDhcpPool: (poolId: string) => void
  onAddSubInterface: (interfaceId: string, vlanId: number) => void
  onChangeSubInterface: (interfaceId: string, subInterfaceId: string, patch: Record<string, unknown>) => void
  onDeleteSubInterface: (interfaceId: string, subInterfaceId: string) => void
  onChangeAcls: (interfaceId: string, subInterfaceId: string | null, acls: import('../engine/types').AclEntry[]) => void
  onDeleteDevice: () => void
  onClose: () => void
}

export function Inspector(props: InspectorProps) {
  const { lab, device, issues } = props
  const [routeDest, setRouteDest] = useState('')
  const [routeNextHop, setRouteNextHop] = useState('')

  if (!device) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-slate-500">
        <DeviceIcon kind="router" size={28} className="opacity-40" />
        Select a device on the canvas to inspect and edit its configuration.
      </div>
    )
  }

  const deviceIssues = issues.filter((i) => i.deviceId === device.id)
  const liveDevice = lab.devices.find((d) => d.id === device.id) ?? device

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-edge bg-panel px-4 py-3">
        <DeviceIcon kind={liveDevice.kind} size={18} />
        <input
          className="input flex-1 font-semibold"
          value={liveDevice.name}
          onChange={(e) => props.onChangeDevice({ name: e.target.value })}
          aria-label="Device name"
        />
        <span className="badge border border-edge bg-panel-2 text-slate-400">{KIND_LABEL[liveDevice.kind]}</span>
        <button type="button" className="rounded p-1 text-slate-500 hover:text-slate-200" onClick={props.onClose} title="Close inspector">
          <X size={16} aria-hidden />
        </button>
      </div>

      <div className="space-y-4 p-4">
        <LearnBox topic="switch-vs-router" />

        {/* End-host gateway */}
        {(liveDevice.kind === 'pc' || liveDevice.kind === 'server') && (
          <div>
            <label className="label" htmlFor="gateway-input">Default gateway</label>
            <input
              id="gateway-input"
              className="input font-mono"
              placeholder="e.g. 192.168.1.1"
              value={liveDevice.gatewayIp ?? ''}
              onChange={(e) => {
                const text = e.target.value
                props.onChangeDevice({ gatewayIp: text.trim() === '' ? null : text })
              }}
            />
            <div className="mt-2">
              <LearnBox topic="default-gateway" />
            </div>
          </div>
        )}

        {/* Interfaces */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Interfaces</h4>
            {(liveDevice.kind === 'router' || liveDevice.kind === 'switch') && (
              <button type="button" className="btn-chip" onClick={props.onAddInterface}>
                <Plus size={12} aria-hidden /> Add
              </button>
            )}
          </div>
          <div className="space-y-2">
            {liveDevice.interfaces.map((iface) => {
              const cidrError = validateInterfaceCidrInput(iface.cidr ?? '', iface.ipMode)
              return (
                <div key={iface.id} className="rounded-lg border border-edge bg-panel-2 p-2.5">
                  <div className="mb-2 flex items-center gap-2">
                    <input
                      className="input w-24 font-mono text-xs"
                      value={iface.name}
                      onChange={(e) => props.onChangeInterface(iface.id, { name: e.target.value })}
                      aria-label="Interface name"
                    />
                    <button
                      type="button"
                      className={`badge cursor-pointer border ${
                        iface.enabled
                          ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300'
                          : 'border-red-800 bg-red-950/40 text-red-300'
                      }`}
                      onClick={() => props.onChangeInterface(iface.id, { enabled: !iface.enabled })}
                      title={iface.enabled ? 'Click to shut down' : 'Click to enable (no shutdown)'}
                    >
                      {iface.enabled ? 'up' : 'down'}
                    </button>
                    <button
                      type="button"
                      className="ml-auto rounded p-1 text-slate-600 hover:text-red-400 disabled:opacity-30"
                      disabled={lab.links.some(
                        (l) =>
                          (l.aDeviceId === liveDevice.id && l.aInterfaceId === iface.id) ||
                          (l.bDeviceId === liveDevice.id && l.bInterfaceId === iface.id),
                      )}
                      title={lab.links.some((l) => l.aInterfaceId === iface.id || l.bInterfaceId === iface.id) ? 'Remove the cable first' : 'Delete interface'}
                      onClick={() => props.onDeleteInterface(iface.id)}
                    >
                      <Trash2 size={13} aria-hidden />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="label">Address mode</label>
                      <select
                        className="input"
                        value={iface.ipMode}
                        onChange={(e) => props.onChangeInterface(iface.id, { ipMode: e.target.value, cidr: e.target.value === 'dhcp' ? null : iface.cidr })}
                      >
                        <option value="static">Static</option>
                        <option value="dhcp">DHCP</option>
                      </select>
                    </div>
                    {iface.role === 'switchport' ? (
                      <div>
                        <label className="label">Port mode</label>
                        <select
                          className="input"
                          value={iface.portMode ?? 'access'}
                          onChange={(e) =>
                            props.onChangeInterface(iface.id, {
                              portMode: e.target.value,
                              allowedVlans: e.target.value === 'trunk' ? (iface.allowedVlans ?? [iface.accessVlan]) : iface.allowedVlans,
                            })
                          }
                        >
                          <option value="access">Access</option>
                          <option value="trunk">Trunk (802.1Q)</option>
                        </select>
                      </div>
                    ) : (
                      <div>
                        <label className="label">IP / prefix</label>
                        <input
                          className={`input font-mono ${cidrError ? 'border-red-700' : ''}`}
                          placeholder="192.168.1.10/24"
                          value={iface.cidr ?? ''}
                          disabled={iface.ipMode === 'dhcp'}
                          onChange={(e) => props.onChangeInterface(iface.id, { cidr: e.target.value === '' ? null : e.target.value })}
                        />
                      </div>
                    )}
                  </div>
                  {iface.role === 'switchport' && (iface.portMode ?? 'access') === 'access' && (
                    <div className="mt-2">
                      <label className="label">Access VLAN</label>
                      <input
                        className="input font-mono"
                        type="number"
                        min={1}
                        max={4094}
                        value={iface.accessVlan}
                        onChange={(e) => props.onChangeInterface(iface.id, { accessVlan: Number(e.target.value) || 1 })}
                      />
                    </div>
                  )}
                  {iface.role === 'switchport' && (iface.portMode ?? 'access') === 'trunk' && (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div>
                        <label className="label">Allowed VLANs</label>
                        <input
                          className="input font-mono"
                          placeholder="10,20"
                          value={(iface.allowedVlans ?? []).join(',')}
                          onChange={(e) =>
                            props.onChangeInterface(iface.id, {
                              allowedVlans: e.target.value
                                .split(',')
                                .map((v) => Number(v.trim()))
                                .filter((v) => Number.isInteger(v) && v > 0),
                            })
                          }
                        />
                      </div>
                      <div>
                        <label className="label">Native VLAN</label>
                        <input
                          className="input font-mono"
                          type="number"
                          min={1}
                          max={4094}
                          value={iface.nativeVlan ?? 1}
                          onChange={(e) => props.onChangeInterface(iface.id, { nativeVlan: Number(e.target.value) || 1 })}
                        />
                      </div>
                    </div>
                  )}
                  {cidrError && <p className="mt-1 text-xs text-red-400">{cidrError}</p>}
                  {iface.role === 'switchport' && (
                    <div className="mt-2 space-y-1.5">
                      <LearnBox topic={(iface.portMode ?? 'access') === 'trunk' ? 'trunk-ports' : 'vlan-access'} />
                      {(iface.portMode ?? 'access') === 'trunk' && <LearnBox topic="vlan-tagging" />}
                    </div>
                  )}
                  {iface.role !== 'switchport' && (
                    <div className="mt-2">
                      <label className="label">DHCP relay (ip helper-address)</label>
                      <input
                        className="input font-mono text-xs"
                        placeholder="DHCP server IP, e.g. 10.0.0.20 (optional)"
                        value={iface.dhcpRelay ?? ''}
                        onChange={(e) => props.onChangeInterface(iface.id, { dhcpRelay: e.target.value === '' ? null : e.target.value })}
                      />
                    </div>
                  )}
                  {iface.role === 'routed' && (
                    <div className="mt-2 rounded-md border border-edge bg-night-950/40 p-2">
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Access Control Lists</div>
                      <AclEditor acls={iface.acls ?? []} onChange={(acls) => props.onChangeAcls(iface.id, null, acls)} />
                    </div>
                  )}
                  {iface.role !== 'switchport' && (
                    <div className="mt-2 space-y-1.5">
                      <LearnBox topic="ip-and-mask" />
                      <LearnBox topic="network-and-broadcast" />
                    </div>
                  )}

                  {/* Router VLAN sub-interfaces */}
                  {iface.role === 'routed' && (
                    <div className="mt-2 rounded-md border border-edge bg-night-950/40 p-2">
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                          Sub-interfaces ({(iface.subInterfaces ?? []).length})
                        </span>
                        <button
                          type="button"
                          className="btn-chip"
                          onClick={() => {
                            const used = new Set((iface.subInterfaces ?? []).map((sub) => sub.vlanId))
                            let vlan = 10
                            while (used.has(vlan) && vlan < 4094) vlan += 10
                            props.onAddSubInterface(iface.id, vlan)
                          }}
                        >
                          <Plus size={11} aria-hidden /> Add
                        </button>
                      </div>
                      {(iface.subInterfaces ?? []).length === 0 && (
                        <p className="text-[11px] text-slate-600">No sub-interfaces. Add one per VLAN served through this port.</p>
                      )}
                      <div className="space-y-1.5">
                        {(iface.subInterfaces ?? []).map((sub) => (
                          <div key={sub.id} className="flex flex-wrap items-center gap-1.5 rounded-md border border-edge/70 bg-night-950/40 px-1.5 py-1">
                            <input
                              className="input w-20 min-w-0 shrink-0 font-mono text-xs"
                              value={sub.name}
                              onChange={(e) => props.onChangeSubInterface(iface.id, sub.id, { name: e.target.value })}
                              aria-label="Sub-interface name"
                            />
                            <input
                              className="input w-14 shrink-0 font-mono text-xs"
                              type="number"
                              min={1}
                              max={4094}
                              value={sub.vlanId}
                              title="VLAN id"
                              aria-label="VLAN id"
                              onChange={(e) => props.onChangeSubInterface(iface.id, sub.id, { vlanId: Number(e.target.value) || 1 })}
                            />
                            <input
                              className="input min-w-0 flex-[1_1_8rem] font-mono text-xs"
                              placeholder="192.168.10.1/24"
                              value={sub.cidr ?? ''}
                              onChange={(e) => props.onChangeSubInterface(iface.id, sub.id, { cidr: e.target.value === '' ? null : e.target.value })}
                            />
                            <input
                              className="input min-w-0 flex-[1_1_7rem] font-mono text-xs"
                              placeholder="relay → IP"
                              title="DHCP relay (ip helper-address)"
                              aria-label="DHCP relay target"
                              value={sub.dhcpRelay ?? ''}
                              onChange={(e) => props.onChangeSubInterface(iface.id, sub.id, { dhcpRelay: e.target.value === '' ? null : e.target.value })}
                            />
                            <span className="ml-auto flex shrink-0 items-center gap-1">
                              <button
                                type="button"
                                className={`badge cursor-pointer border ${sub.enabled ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300' : 'border-red-800 bg-red-950/40 text-red-300'}`}
                                onClick={() => props.onChangeSubInterface(iface.id, sub.id, { enabled: !sub.enabled })}
                                title={sub.enabled ? 'Click to shut down' : 'Click to enable'}
                              >
                                {sub.enabled ? 'up' : 'down'}
                              </button>
                              <button
                                type="button"
                                className="rounded p-0.5 text-slate-600 hover:text-red-400"
                                onClick={() => props.onDeleteSubInterface(iface.id, sub.id)}
                                title="Delete sub-interface"
                                aria-label="Delete sub-interface"
                              >
                                <Trash2 size={11} aria-hidden />
                              </button>
                            </span>
                          </div>
                        ))}
                      </div>
                      {(iface.subInterfaces ?? []).map((sub) => {
                        const acls = sub.acls ?? []
                        if (acls.length === 0) return null
                        return (
                          <div key={`acl-${sub.id}`} className="mt-1.5 rounded-md border border-edge bg-night-950/40 p-2">
                            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                              Access Control Lists — {sub.name}
                            </div>
                            <AclEditor acls={acls} onChange={(next) => props.onChangeAcls(iface.id, sub.id, next)} compact />
                          </div>
                        )
                      })}
                      <div className="mt-1.5 space-y-1.5">
                        <LearnBox topic="router-subinterfaces" />
                        <LearnBox topic="inter-vlan-routing" />
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Static routes */}
        {liveDevice.kind === 'router' && (
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Static routes</h4>
            <div className="mb-2">
              <LearnBox topic="static-routes" />
            </div>
            <ul className="mb-2 space-y-1">
              {liveDevice.staticRoutes.map((route) => (
                <li key={route.id} className="flex items-center justify-between rounded-md border border-edge bg-panel-2 px-2.5 py-1.5 font-mono text-xs text-slate-300">
                  <span>
                    {route.destinationCidr} <span className="text-slate-500">via</span> {route.nextHopIp}
                  </span>
                  <button type="button" className="rounded p-0.5 text-slate-600 hover:text-red-400" onClick={() => props.onDeleteStaticRoute(route.id)} title="Delete route">
                    <Trash2 size={12} aria-hidden />
                  </button>
                </li>
              ))}
              {liveDevice.staticRoutes.length === 0 && <li className="text-xs text-slate-600">No static routes configured.</li>}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <input className="input min-w-0 flex-[1_1_8rem] font-mono text-xs" placeholder="172.16.20.0/24" value={routeDest} onChange={(e) => setRouteDest(e.target.value)} />
              <input className="input min-w-0 flex-[1_1_7rem] font-mono text-xs" placeholder="next hop" value={routeNextHop} onChange={(e) => setRouteNextHop(e.target.value)} />
              <button
                type="button"
                className="btn-ghost"
                disabled={!routeDest.trim() || !routeNextHop.trim()}
                onClick={() => {
                  props.onAddStaticRoute(routeDest.trim(), routeNextHop.trim())
                  setRouteDest('')
                  setRouteNextHop('')
                }}
              >
                <Plus size={13} aria-hidden />
              </button>
            </div>
          </div>
        )}

        {/* DHCP pools */}
        {liveDevice.kind === 'server' && (
          <div>
            <div className="mb-2">
              <LearnBox topic="dhcp" />
            </div>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">DHCP pools</h4>
              <button type="button" className="btn-chip" onClick={props.onAddDhcpPool}>
                <Plus size={12} aria-hidden /> Add pool
              </button>
            </div>
            <div className="space-y-2">
              {liveDevice.dhcpPools.map((pool) => (
                <div key={pool.id} className="rounded-lg border border-edge bg-panel-2 p-2.5">
                  <div className="mb-2 flex items-center gap-2">
                    <input
                      className="input flex-1 text-xs"
                      value={pool.name}
                      onChange={(e) => props.onChangeDhcpPool(pool.id, { name: e.target.value })}
                      aria-label="Pool name"
                    />
                    <button type="button" className="rounded p-1 text-slate-600 hover:text-red-400" onClick={() => props.onDeleteDhcpPool(pool.id)} title="Delete pool">
                      <Trash2 size={13} aria-hidden />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="label">Network</label>
                      <input className="input font-mono text-xs" value={pool.networkCidr} onChange={(e) => props.onChangeDhcpPool(pool.id, { networkCidr: e.target.value })} />
                    </div>
                    <div>
                      <label className="label">Gateway</label>
                      <input className="input font-mono text-xs" value={pool.gatewayIp} onChange={(e) => props.onChangeDhcpPool(pool.id, { gatewayIp: e.target.value })} />
                    </div>
                    <div>
                      <label className="label">Range start</label>
                      <input className="input font-mono text-xs" value={pool.rangeStart} onChange={(e) => props.onChangeDhcpPool(pool.id, { rangeStart: e.target.value })} />
                    </div>
                    <div>
                      <label className="label">Range end</label>
                      <input className="input font-mono text-xs" value={pool.rangeEnd} onChange={(e) => props.onChangeDhcpPool(pool.id, { rangeEnd: e.target.value })} />
                    </div>
                    <div className="col-span-2">
                      <label className="label">DNS server (optional)</label>
                      <input className="input font-mono text-xs" placeholder="e.g. 10.0.0.20" value={pool.dnsIp ?? ''} onChange={(e) => props.onChangeDhcpPool(pool.id, { dnsIp: e.target.value })} />
                    </div>
                  </div>
                </div>
              ))}
              {liveDevice.dhcpPools.length === 0 && <p className="text-xs text-slate-600">No DHCP pools. Add one to serve dynamic addresses.</p>}
            </div>
          </div>
        )}

        {/* Validation issues for this device */}
        {deviceIssues.length > 0 && (
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Validation</h4>
            <ul className="space-y-1">
              {deviceIssues.map((issue, i) => (
                <li
                  key={i}
                  className={`rounded-md border px-2.5 py-1.5 text-xs ${
                    issue.severity === 'error'
                      ? 'border-red-900/60 bg-red-950/25 text-red-200'
                      : issue.severity === 'warning'
                        ? 'border-amber-900/60 bg-amber-950/20 text-amber-200'
                        : 'border-edge bg-panel-2 text-slate-400'
                  }`}
                >
                  {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <button type="button" className="btn-danger w-full" onClick={props.onDeleteDevice}>
          <Trash2 size={14} aria-hidden /> Delete {liveDevice.name}
        </button>
      </div>
    </div>
  )
}
