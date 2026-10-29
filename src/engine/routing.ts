// Routing table construction + longest-prefix lookup for the ping engine.

import { parseCidr, networkOf, formatIpv4 } from './ip'
import { effectiveAddress } from './dhcp'
import type { DhcpState } from './dhcp'
import type { Device } from './types'

export interface RouteEntry {
  network: number
  prefix: number
  type: 'connected' | 'static'
  /** Physical (parent) interface used for egress. */
  interfaceId: string | null
  destinationCidr: string
  nextHopIp: string | null
  /** Set when the route is a connected route of a VLAN sub-interface. */
  vlanId?: number
  subInterfaceName?: string
  subInterfaceId?: string
}

/** Build the routing table of a router (connected networks + static routes). */
export function buildRoutingTable(device: Device, dhcp: DhcpState): RouteEntry[] {
  const table: RouteEntry[] = []
  if (device.kind !== 'router') return table
  for (const iface of device.interfaces) {
    if (!iface.enabled) continue
    const { cidr } = effectiveAddress(iface, dhcp)
    if (cidr) {
      const parsed = parseCidr(cidr)
      if (parsed) {
        table.push({
          network: networkOf(parsed),
          prefix: parsed.prefix,
          type: 'connected',
          interfaceId: iface.id,
          destinationCidr: `${formatIpv4(networkOf(parsed))}/${parsed.prefix}`,
          nextHopIp: null,
        })
      }
    }
    // 802.1Q sub-interfaces contribute one connected route each.
    for (const sub of iface.subInterfaces ?? []) {
      if (!sub.enabled || !sub.cidr) continue
      const parsed = parseCidr(sub.cidr)
      if (!parsed) continue
      table.push({
        network: networkOf(parsed),
        prefix: parsed.prefix,
        type: 'connected',
        interfaceId: iface.id,
        destinationCidr: `${formatIpv4(networkOf(parsed))}/${parsed.prefix}`,
        nextHopIp: null,
        vlanId: sub.vlanId,
        subInterfaceName: sub.name,
        subInterfaceId: sub.id,
      })
    }
  }
  for (const route of device.staticRoutes) {
    const parsed = parseCidr(route.destinationCidr)
    if (!parsed) continue
    table.push({
      network: networkOf(parsed),
      prefix: parsed.prefix,
      type: 'static',
      interfaceId: null,
      destinationCidr: route.destinationCidr,
      nextHopIp: route.nextHopIp,
    })
  }
  return table
}

/** Longest-prefix match. Connected routes win ties (more specific source). */
export function lookupRoute(table: RouteEntry[], destIp: number): RouteEntry | null {
  let best: RouteEntry | null = null
  for (const route of table) {
    const mask = route.prefix === 0 ? 0 : (0xffffffff << (32 - route.prefix)) >>> 0
    if (((destIp & mask) >>> 0) !== route.network) continue
    if (!best || route.prefix > best.prefix || (route.prefix === best.prefix && route.type === 'connected' && best.type !== 'connected')) {
      best = route
    }
  }
  return best
}
