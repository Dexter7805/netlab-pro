// Layer-2 topology helpers: device/link lookups and VLAN-aware broadcast
// domain (L2 segment) computation used by the ping engine and NetDoctor.

import type { Device, Lab, LabLink, NetInterface } from './types'

export function findDevice(lab: Lab, deviceId: string): Device | undefined {
  return lab.devices.find((d) => d.id === deviceId)
}

export function findInterface(
  lab: Lab,
  deviceId: string,
  interfaceId: string,
): { device: Device; iface: NetInterface } | undefined {
  const device = findDevice(lab, deviceId)
  if (!device) return undefined
  const iface = device.interfaces.find((i) => i.id === interfaceId)
  return iface ? { device, iface } : undefined
}

export function findLink(lab: Lab, linkId: string): LabLink | undefined {
  return lab.links.find((l) => l.id === linkId)
}

export function deviceByName(lab: Lab, name: string): Device | undefined {
  return lab.devices.find((d) => d.name.toLowerCase() === name.toLowerCase())
}

export function linkEndpoints(lab: Lab, link: LabLink): {
  a: { device: Device; iface: NetInterface } | undefined
  b: { device: Device; iface: NetInterface } | undefined
} {
  return {
    a: findInterface(lab, link.aDeviceId, link.aInterfaceId),
    b: findInterface(lab, link.bDeviceId, link.bInterfaceId),
  }
}

export function linksOfInterface(lab: Lab, deviceId: string, interfaceId: string): LabLink[] {
  return lab.links.filter(
    (l) =>
      (l.aDeviceId === deviceId && l.aInterfaceId === interfaceId) ||
      (l.bDeviceId === deviceId && l.bInterfaceId === interfaceId),
  )
}

export function interfaceIsLinked(lab: Lab, deviceId: string, interfaceId: string): boolean {
  return linksOfInterface(lab, deviceId, interfaceId).length > 0
}

export function isSwitchDevice(device: Device): boolean {
  return device.kind === 'switch'
}

export interface L2Member {
  deviceId: string
  interfaceId: string
  /** Link ids traversed to reach this member (empty for the start interface). */
  viaLinkIds: string[]
}

export interface L2Segment {
  /** All interfaces sharing the broadcast domain, including the start interface. */
  members: L2Member[]
  /**
   * The 802.1Q VLAN this domain was built for. null for plain point-to-point
   * segments that cross no switch (and therefore have no tagging context).
   */
  vlan: number | null
  /** Enabled=false links that blocked traversal (evidence for diagnostics). */
  blockedByDownLinks: LabLink[]
  /** Disabled switchports that blocked traversal. */
  blockedByDownPorts: Array<{ deviceId: string; interfaceId: string }>
  /** True when a switch had ports in other VLANs adjacent to this domain. */
  adjacentOtherVlanPorts: number
  /**
   * Linked switch ports that do NOT carry the segment's VLAN (access ports in
   * another VLAN or trunks whose allowed list excludes it). Evidence for
   * "the path toward X is blocked" diagnostics.
   */
  excludedPorts: Array<{ deviceId: string; interfaceId: string; vlan: number }>
}

/** Does a switch port participate in the given VLAN? */
export function portCarriesVlan(port: NetInterface, vlan: number): boolean {
  if (port.role !== 'switchport') return false
  const mode = port.portMode ?? 'access'
  if (mode === 'trunk') return (port.allowedVlans ?? []).includes(vlan)
  return port.accessVlan === vlan
}

/** The VLAN untagged frames belong to on a port (used for host-facing trunks). */
export function nativeVlanOf(port: NetInterface): number {
  const mode = port.portMode ?? 'access'
  if (mode === 'trunk') return port.nativeVlan ?? 1
  return port.accessVlan
}

interface WalkState {
  lab: Lab
  visited: Set<string>
  members: L2Member[]
  vlan: number | null
  blockedByDownLinks: LabLink[]
  blockedByDownPorts: Array<{ deviceId: string; interfaceId: string }>
  adjacentOtherVlanPorts: number
  excludedPorts: Array<{ deviceId: string; interfaceId: string; vlan: number }>
}

function keyOf(deviceId: string, interfaceId: string): string {
  return `${deviceId}/${interfaceId}`
}

function pushMember(state: WalkState, deviceId: string, interfaceId: string, viaLinkIds: string[]): boolean {
  const key = keyOf(deviceId, interfaceId)
  if (state.visited.has(key)) return false
  state.visited.add(key)
  state.members.push({ deviceId, interfaceId, viaLinkIds })
  return true
}

function peerOf(lab: Lab, deviceId: string, interfaceId: string): {
  link: LabLink
  peerDeviceId: string
  peerInterfaceId: string
} | null {
  for (const link of lab.links) {
    if (link.aDeviceId === deviceId && link.aInterfaceId === interfaceId) {
      return { link, peerDeviceId: link.bDeviceId, peerInterfaceId: link.bInterfaceId }
    }
    if (link.bDeviceId === deviceId && link.bInterfaceId === interfaceId) {
      return { link, peerDeviceId: link.aDeviceId, peerInterfaceId: link.aInterfaceId }
    }
  }
  return null
}

/**
 * Spread inside a switch: all *other* enabled switchports that carry the given
 * VLAN become part of the domain. Access ports match by accessVlan; trunk
 * ports match by their allowed-VLAN list. Ports that exclude the VLAN are
 * recorded as evidence when they have cables attached.
 */
function spreadThroughSwitch(state: WalkState, switchDevice: Device, vlan: number, enteredPortInterfaceId: string, viaLinkIds: string[]) {
  for (const port of switchDevice.interfaces) {
    if (port.id === enteredPortInterfaceId) continue
    if (port.role !== 'switchport') continue
    if (!port.enabled) {
      state.blockedByDownPorts.push({ deviceId: switchDevice.id, interfaceId: port.id })
      continue
    }
    if (!portCarriesVlan(port, vlan)) {
      if (interfaceIsLinked(state.lab, switchDevice.id, port.id)) {
        if ((port.portMode ?? 'access') === 'trunk') {
          state.excludedPorts.push({ deviceId: switchDevice.id, interfaceId: port.id, vlan })
        } else {
          // A port in another VLAN exists next to this domain: record as evidence.
          state.adjacentOtherVlanPorts++
        }
      }
      continue
    }
    if (!pushMember(state, switchDevice.id, port.id, viaLinkIds)) continue
    const peer = peerOf(state.lab, switchDevice.id, port.id)
    if (!peer) continue
    if (!peer.link.enabled) {
      state.blockedByDownLinks.push(peer.link)
      continue
    }
    crossLink(state, peer.peerDeviceId, peer.peerInterfaceId, peer.link.id)
  }
}

function crossLink(state: WalkState, peerDeviceId: string, peerInterfaceId: string, linkId: string) {
  const peer = findInterface(state.lab, peerDeviceId, peerInterfaceId)
  if (!peer) return
  const { device, iface } = peer
  if (!pushMember(state, device.id, iface.id, [linkId])) return
  if (isSwitchDevice(device) && iface.role === 'switchport') {
    if (!iface.enabled) {
      state.blockedByDownPorts.push({ deviceId: device.id, interfaceId: iface.id })
      return
    }
    // When the walk carries a specific VLAN (trunk context), the entered port
    // must carry it — otherwise the path is blocked here.
    if (state.vlan !== null && !portCarriesVlan(iface, state.vlan)) {
      state.excludedPorts.push({ deviceId: device.id, interfaceId: iface.id, vlan: state.vlan })
      return
    }
    // First hop without VLAN context: the entered port decides the domain —
    // its native VLAN for trunks (never a stale accessVlan left over from a
    // port that was converted access -> trunk).
    spreadThroughSwitch(state, device, state.vlan ?? nativeVlanOf(iface), iface.id, [linkId])
  }
  // Hosts and routers terminate the broadcast domain.
}

export interface L2SegmentOptions {
  /** Build the domain for a specific VLAN (used by sub-interface delivery). */
  vlan?: number
}

/**
 * Compute the L2 broadcast domain visible from an interface.
 *
 * VLANs are honored: access ports join only their access VLAN; trunk ports
 * join only VLANs in their allowed list. When starting from an endpoint the
 * VLAN is determined by the first switch port reached (access VLAN, or the
 * native VLAN for a trunk), unless an explicit `vlan` is requested — in that
 * case ports that do not carry it are recorded in `excludedPorts`.
 */
export function getL2Segment(lab: Lab, deviceId: string, interfaceId: string, options: L2SegmentOptions = {}): L2Segment {
  const requestedVlan = options.vlan
  const state: WalkState = {
    lab,
    visited: new Set(),
    members: [],
    vlan: requestedVlan ?? null,
    blockedByDownLinks: [],
    blockedByDownPorts: [],
    adjacentOtherVlanPorts: 0,
    excludedPorts: [],
  }
  const start = findInterface(lab, deviceId, interfaceId)
  if (!start) {
    return {
      members: [],
      vlan: requestedVlan ?? null,
      blockedByDownLinks: [],
      blockedByDownPorts: [],
      adjacentOtherVlanPorts: 0,
      excludedPorts: [],
    }
  }
  pushMember(state, deviceId, interfaceId, [])
  if (isSwitchDevice(start.device) && start.iface.role === 'switchport' && start.iface.enabled) {
    // Trunk ports spread on their native VLAN (untagged frames); access ports
    // on their access VLAN — nativeVlanOf covers both.
    const vlan = requestedVlan ?? nativeVlanOf(start.iface)
    state.vlan = vlan
    spreadThroughSwitch(state, start.device, vlan, start.iface.id, [])
  } else {
    // Endpoint interface: cross each attached link directly.
    for (const link of linksOfInterface(lab, deviceId, interfaceId)) {
      if (!link.enabled) {
        state.blockedByDownLinks.push(link)
        continue
      }
      const peer =
        link.aDeviceId === deviceId
          ? { deviceId: link.bDeviceId, interfaceId: link.bInterfaceId }
          : { deviceId: link.aDeviceId, interfaceId: link.aInterfaceId }
      const peerInfo = findInterface(lab, peer.deviceId, peer.interfaceId)
      if (peerInfo && requestedVlan !== undefined && isSwitchDevice(peerInfo.device) && peerInfo.iface.role === 'switchport') {
        if (!peerInfo.iface.enabled) {
          state.blockedByDownPorts.push({ deviceId: peerInfo.device.id, interfaceId: peerInfo.iface.id })
          continue
        }
        if (!portCarriesVlan(peerInfo.iface, requestedVlan)) {
          state.excludedPorts.push({ deviceId: peerInfo.device.id, interfaceId: peerInfo.iface.id, vlan: requestedVlan })
          continue
        }
        if (!pushMember(state, peerInfo.device.id, peerInfo.iface.id, [link.id])) continue
        spreadThroughSwitch(state, peerInfo.device, requestedVlan, peerInfo.iface.id, [link.id])
        continue
      }
      crossLink(state, peer.deviceId, peer.interfaceId, link.id)
    }
  }
  // Without an explicit VLAN request, remember the VLAN the first switch hop
  // resolved to (native VLAN for trunks, access VLAN for access ports).
  if (requestedVlan === undefined && state.vlan === null) {
    for (const member of state.members) {
      const found = findInterface(lab, member.deviceId, member.interfaceId)
      if (found && isSwitchDevice(found.device) && found.iface.role === 'switchport') {
        state.vlan = nativeVlanOf(found.iface)
        break
      }
    }
  }
  return {
    members: state.members,
    vlan: state.vlan,
    blockedByDownLinks: state.blockedByDownLinks,
    blockedByDownPorts: state.blockedByDownPorts,
    adjacentOtherVlanPorts: state.adjacentOtherVlanPorts,
    excludedPorts: state.excludedPorts,
  }
}

/** Resolve the concrete interfaces of an L2 segment (skips missing objects). */
export function segmentInterfaces(lab: Lab, segment: L2Segment): Array<{ device: Device; iface: NetInterface; member: L2Member }> {
  const out: Array<{ device: Device; iface: NetInterface; member: L2Member }> = []
  for (const member of segment.members) {
    const found = findInterface(lab, member.deviceId, member.interfaceId)
    if (found) out.push({ ...found, member })
  }
  return out
}
