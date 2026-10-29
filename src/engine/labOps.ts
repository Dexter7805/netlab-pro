// Pure lab mutation helpers. All functions return a NEW lab object
// (immutably updated) so React state stays predictable.

import { uid } from './ids'
import { formatIpv4, parseCidr, parseIpv4, maskOf } from './ip'
import type {
  AclEntry,
  Device,
  DeviceKind,
  DhcpPool,
  Fault,
  FaultKind,
  Lab,
  LabLink,
  NetInterface,
  StaticRoute,
  SubInterface,
} from './types'

export function touch(lab: Lab): Lab {
  return { ...lab, updatedAt: new Date().toISOString() }
}

export function makeInterface(role: NetInterface['role'], name: string): NetInterface {
  return {
    id: uid('if'),
    name,
    role,
    ipMode: 'static',
    cidr: null,
    enabled: true,
    accessVlan: 1,
    portMode: 'access',
    nativeVlan: 1,
    allowedVlans: [],
    subInterfaces: role === 'routed' ? [] : undefined,
    dhcpRelay: role === 'routed' ? null : undefined,
  }
}

// ---------------------------------------------------------------------------
// Router sub-interfaces (router-on-a-stick)
// ---------------------------------------------------------------------------

export function addSubInterface(lab: Lab, deviceId: string, interfaceId: string, vlanId: number): Lab {
  return touch({
    ...lab,
    devices: lab.devices.map((d) => {
      if (d.id !== deviceId) return d
      return {
        ...d,
        interfaces: d.interfaces.map((i) => {
          if (i.id !== interfaceId) return i
          const existing = i.subInterfaces ?? []
          if (existing.some((sub) => sub.vlanId === vlanId)) return i
          return {
            ...i,
            subInterfaces: [
              ...existing,
              { id: uid('sub'), name: `${i.name}.${vlanId}`, vlanId, cidr: null, enabled: true },
            ],
          }
        }),
      }
    }),
  })
}

export function updateSubInterface(lab: Lab, deviceId: string, interfaceId: string, subInterfaceId: string, patch: Partial<SubInterface>): Lab {
  return touch({
    ...lab,
    devices: lab.devices.map((d) =>
      d.id === deviceId
        ? {
            ...d,
            interfaces: d.interfaces.map((i) =>
              i.id === interfaceId
                ? { ...i, subInterfaces: (i.subInterfaces ?? []).map((sub) => (sub.id === subInterfaceId ? { ...sub, ...patch } : sub)) }
                : i,
            ),
          }
        : d,
    ),
  })
}

/**
 * Replace the ACL list of a router interface (or one of its sub-interfaces).
 * The ACL editor submits the whole array; entries keep their order.
 */
export function setAcls(lab: Lab, deviceId: string, interfaceId: string, subInterfaceId: string | null, acls: AclEntry[]): Lab {
  return touch({
    ...lab,
    devices: lab.devices.map((d) => {
      if (d.id !== deviceId) return d
      return {
        ...d,
        interfaces: d.interfaces.map((i) => {
          if (i.id !== interfaceId) return i
          if (subInterfaceId) {
            return {
              ...i,
              subInterfaces: (i.subInterfaces ?? []).map((s) => (s.id === subInterfaceId ? { ...s, acls } : s)),
            }
          }
          return { ...i, acls }
        }),
      }
    }),
  })
}

export function deleteSubInterface(lab: Lab, deviceId: string, interfaceId: string, subInterfaceId: string): Lab {
  return touch({
    ...lab,
    devices: lab.devices.map((d) =>
      d.id === deviceId
        ? {
            ...d,
            interfaces: d.interfaces.map((i) =>
              i.id === interfaceId ? { ...i, subInterfaces: (i.subInterfaces ?? []).filter((sub) => sub.id !== subInterfaceId) } : i,
            ),
          }
        : d,
    ),
  })
}

export function makeDevice(kind: DeviceKind, name: string, x: number, y: number): Device {
  const interfaces: NetInterface[] = []
  if (kind === 'router') {
    for (let i = 0; i < 2; i++) interfaces.push(makeInterface('routed', `Gi0/${i}`))
  } else if (kind === 'switch') {
    for (let i = 1; i <= 4; i++) interfaces.push(makeInterface('switchport', `Fa0/${i}`))
  } else {
    interfaces.push(makeInterface('host', 'Fa0'))
  }
  return {
    id: uid('dev'),
    name,
    kind,
    x,
    y,
    interfaces,
    gatewayIp: null,
    staticRoutes: [],
    dhcpPools: [],
  }
}

export function nextDeviceName(lab: Lab, kind: DeviceKind): string {
  const prefix = kind === 'router' ? 'R' : kind === 'switch' ? 'SW' : kind === 'pc' ? 'PC' : 'SRV'
  let index = 1
  const existing = new Set(lab.devices.map((d) => d.name))
  while (existing.has(`${prefix}${index}`)) index++
  return `${prefix}${index}`
}

export function addDevice(lab: Lab, kind: DeviceKind, x: number, y: number): Lab {
  const device = makeDevice(kind, nextDeviceName(lab, kind), Math.round(x), Math.round(y))
  return touch({ ...lab, devices: [...lab.devices, device] })
}

export function updateDevice(lab: Lab, deviceId: string, patch: Partial<Pick<Device, 'name' | 'x' | 'y' | 'gatewayIp'>>): Lab {
  return touch({
    ...lab,
    devices: lab.devices.map((d) => (d.id === deviceId ? { ...d, ...patch } : d)),
  })
}

export function deleteDevice(lab: Lab, deviceId: string): Lab {
  return touch({
    ...lab,
    devices: lab.devices.filter((d) => d.id !== deviceId),
    links: lab.links.filter((l) => l.aDeviceId !== deviceId && l.bDeviceId !== deviceId),
    faults: lab.faults.filter((f) => f.deviceId !== deviceId),
  })
}

export function addInterface(lab: Lab, deviceId: string): Lab {
  return touch({
    ...lab,
    devices: lab.devices.map((d) => {
      if (d.id !== deviceId) return d
      const role: NetInterface['role'] = d.kind === 'router' ? 'routed' : d.kind === 'switch' ? 'switchport' : 'host'
      const used = new Set(d.interfaces.map((i) => i.name))
      let index = d.interfaces.length
      let name = ''
      do {
        name =
          role === 'routed'
            ? `Gi0/${index}`
            : role === 'switchport'
              ? `Fa0/${index + 1}`
              : index === 0
                ? 'Fa0'
                : `Fa${index}`
        index++
      } while (used.has(name))
      return { ...d, interfaces: [...d.interfaces, makeInterface(role, name)] }
    }),
  })
}

export function updateInterface(lab: Lab, deviceId: string, interfaceId: string, patch: Partial<NetInterface>): Lab {
  return touch({
    ...lab,
    devices: lab.devices.map((d) =>
      d.id === deviceId
        ? { ...d, interfaces: d.interfaces.map((i) => (i.id === interfaceId ? { ...i, ...patch } : i)) }
        : d,
    ),
  })
}

export function deleteInterface(lab: Lab, deviceId: string, interfaceId: string): Lab {
  return touch({
    ...lab,
    devices: lab.devices.map((d) =>
      d.id === deviceId ? { ...d, interfaces: d.interfaces.filter((i) => i.id !== interfaceId) } : d,
    ),
    links: lab.links.filter(
      (l) =>
        !(l.aDeviceId === deviceId && l.aInterfaceId === interfaceId) &&
        !(l.bDeviceId === deviceId && l.bInterfaceId === interfaceId),
    ),
  })
}

export function interfaceInUse(lab: Lab, deviceId: string, interfaceId: string): boolean {
  return lab.links.some(
    (l) =>
      (l.aDeviceId === deviceId && l.aInterfaceId === interfaceId) ||
      (l.bDeviceId === deviceId && l.bInterfaceId === interfaceId),
  )
}

/** First interface of a device not yet used by any link (or null). */
export function freeInterface(lab: Lab, deviceId: string): NetInterface | null {
  const device = lab.devices.find((d) => d.id === deviceId)
  if (!device) return null
  for (const iface of device.interfaces) {
    if (!interfaceInUse(lab, deviceId, iface.id)) return iface
  }
  return null
}

export function connectDevices(lab: Lab, aDeviceId: string, aIfaceId: string, bDeviceId: string, bIfaceId: string): { lab: Lab; error?: string } {
  if (aDeviceId === bDeviceId) return { lab, error: 'Cannot connect a device to itself' }
  if (
    lab.links.some(
      (l) =>
        (l.aDeviceId === aDeviceId && l.aInterfaceId === aIfaceId && l.bDeviceId === bDeviceId && l.bInterfaceId === bIfaceId) ||
        (l.aDeviceId === bDeviceId && l.aInterfaceId === bIfaceId && l.bDeviceId === aDeviceId && l.bInterfaceId === aIfaceId),
    )
  ) {
    return { lab, error: 'These interfaces are already connected' }
  }
  if (interfaceInUse(lab, aDeviceId, aIfaceId) || interfaceInUse(lab, bDeviceId, bIfaceId)) {
    return { lab, error: 'One of the interfaces is already in use' }
  }
  const link: LabLink = {
    id: uid('lnk'),
    aDeviceId,
    aInterfaceId: aIfaceId,
    bDeviceId,
    bInterfaceId: bIfaceId,
    enabled: true,
  }
  return { lab: touch({ ...lab, links: [...lab.links, link] }) }
}

/** Connect two devices, auto-picking free interfaces (creating one if needed). */
export function autoConnect(lab: Lab, aDeviceId: string, bDeviceId: string): { lab: Lab; error?: string } {
  let working = lab
  const getFree = (l: Lab, deviceId: string) => freeInterface(l, deviceId)
  let a = getFree(working, aDeviceId)
  let b = getFree(working, bDeviceId)
  if (!a) {
    working = addInterface(working, aDeviceId)
    const dev = working.devices.find((d) => d.id === aDeviceId)
    a = dev ? dev.interfaces[dev.interfaces.length - 1] : null
  }
  if (!b) {
    working = addInterface(working, bDeviceId)
    const dev = working.devices.find((d) => d.id === bDeviceId)
    b = dev ? dev.interfaces[dev.interfaces.length - 1] : null
  }
  if (!a || !b) return { lab, error: 'No free interface available' }
  return connectDevices(working, aDeviceId, a.id, bDeviceId, b.id)
}

export function deleteLink(lab: Lab, linkId: string): Lab {
  return touch({ ...lab, links: lab.links.filter((l) => l.id !== linkId), faults: lab.faults.filter((f) => f.linkId !== linkId) })
}

export function setLinkEnabled(lab: Lab, linkId: string, enabled: boolean): Lab {
  return touch({ ...lab, links: lab.links.map((l) => (l.id === linkId ? { ...l, enabled } : l)) })
}

export function addStaticRoute(lab: Lab, deviceId: string, route: Omit<StaticRoute, 'id'>): Lab {
  return touch({
    ...lab,
    devices: lab.devices.map((d) =>
      d.id === deviceId ? { ...d, staticRoutes: [...d.staticRoutes, { ...route, id: uid('rt') }] } : d,
    ),
  })
}

export function deleteStaticRoute(lab: Lab, deviceId: string, routeId: string): Lab {
  return touch({
    ...lab,
    devices: lab.devices.map((d) =>
      d.id === deviceId ? { ...d, staticRoutes: d.staticRoutes.filter((r) => r.id !== routeId) } : d,
    ),
  })
}

export function addDhcpPool(lab: Lab, deviceId: string, pool: Omit<DhcpPool, 'id'>): Lab {
  return touch({
    ...lab,
    devices: lab.devices.map((d) =>
      d.id === deviceId ? { ...d, dhcpPools: [...d.dhcpPools, { ...pool, id: uid('pool') }] } : d,
    ),
  })
}

export function updateDhcpPool(lab: Lab, deviceId: string, poolId: string, patch: Partial<DhcpPool>): Lab {
  return touch({
    ...lab,
    devices: lab.devices.map((d) =>
      d.id === deviceId
        ? { ...d, dhcpPools: d.dhcpPools.map((p) => (p.id === poolId ? { ...p, ...patch } : p)) }
        : d,
    ),
  })
}

export function deleteDhcpPool(lab: Lab, deviceId: string, poolId: string): Lab {
  return touch({
    ...lab,
    devices: lab.devices.map((d) =>
      d.id === deviceId ? { ...d, dhcpPools: d.dhcpPools.filter((p) => p.id !== poolId) } : d,
    ),
    faults: lab.faults.filter((f) => f.poolId !== poolId),
  })
}

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------

export interface FaultDraft {
  kind: FaultKind
  deviceId: string
  interfaceId?: string
  linkId?: string
  routeId?: string
  poolId?: string
  subInterfaceId?: string
  value?: string
  note?: string
}

export function addFault(lab: Lab, draft: FaultDraft): Lab {
  const fault: Fault = { ...draft, id: uid('flt'), active: true }
  return touch({ ...lab, faults: [...lab.faults, fault] })
}

export function updateFault(lab: Lab, faultId: string, patch: Partial<Fault>): Lab {
  return touch({ ...lab, faults: lab.faults.map((f) => (f.id === faultId ? { ...f, ...patch } : f)) })
}

export function removeFault(lab: Lab, faultId: string): Lab {
  return touch({ ...lab, faults: lab.faults.filter((f) => f.id !== faultId) })
}

/** Quick presets for the fault editor. */
export function suggestFaultValue(lab: Lab, kind: FaultKind, deviceId: string, interfaceId?: string): string | undefined {
  const device = lab.devices.find((d) => d.id === deviceId)
  if (!device) return undefined
  const iface = interfaceId ? device.interfaces.find((i) => i.id === interfaceId) : device.interfaces[0]
  switch (kind) {
    case 'wrong-gateway':
      return device.gatewayIp === null ? '192.168.1.99' : device.gatewayIp === '192.168.1.1' ? '192.168.1.99' : '192.168.1.1'
    case 'wrong-ip':
    case 'duplicate-ip':
      return iface?.cidr ? incrementIp(iface.cidr.split('/')[0], 3) : '192.168.9.10'
    case 'wrong-mask': {
      const cidr = iface?.cidr ? parseCidr(iface.cidr) : null
      if (!cidr) return undefined
      const alt = cidr.prefix <= 24 ? cidr.prefix + 8 : cidr.prefix - 8
      return `${formatIpv4(cidr.ip)}/${Math.min(30, Math.max(8, alt))}`
    }
    case 'vlan-mismatch':
      return String(iface && iface.accessVlan === 1 ? 20 : 1)
    default:
      return undefined
  }
}

function incrementIp(ipText: string, delta: number): string {
  const ip = parseIpv4(ipText)
  if (ip === null) return ipText
  const mask = maskOf(24)
  const hostPortion = (ip & ~mask >>> 0) + delta
  return formatIpv4(((ip & mask) >>> 0) + hostPortion)
}
