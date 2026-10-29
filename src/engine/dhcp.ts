// Deterministic DHCP simulation: resolves dynamic addresses for interfaces
// configured with ipMode = 'dhcp'. Runs against the effective (post-fault) lab.

import { parseCidr, parseIpv4, formatIpv4, isNetworkAddress, isBroadcastAddress, networkOf, broadcastOf, isSameSubnet } from './ip'
import { findDevice, findInterface, getL2Segment, segmentInterfaces } from './topology'
import type { Device, Lab, NetInterface, SubInterface } from './types'
import { simulatePing } from './ping' // runtime-only use; ESM cycle is safe (no top-level calls)

export type DhcpFailureReason =
  | 'interface-down'
  | 'no-server'
  | 'pool-exhausted'
  | 'no-matching-pool'
  | 'server-no-ip'
  | 'relay-target-unresolved'
  | 'server-unreachable'

export interface DhcpFailure {
  reason: DhcpFailureReason
  detail: string
  poolId?: string
  poolDeviceId?: string
  /** Relay anchor: the router interface that forwarded (or would forward) the request. */
  relayDeviceId?: string
  relayInterfaceId?: string
  relaySubInterfaceId?: string
  serverDeviceId?: string
  serverIp?: string
  /** The relay agent's address in the client's subnet (giaddr). */
  giaddr?: string
  giaddrPrefix?: number
}

export interface RelayRecord {
  giaddr: string
  serverIp: string
  poolId: string
  poolLabel: string
  viaRouter: string
  viaInterface: string
  viaSub: string | null
}

export interface UnrelayedAgent {
  routerDeviceId: string
  routerLabel: string
  interfaceId: string
  subInterfaceId: string | null
  giaddr: string
  giaddrPrefix: number
}

export interface DhcpState {
  /** interfaceId -> assigned CIDR ("192.168.10.101/24") */
  assignments: Map<string, string>
  /** deviceId -> gateway handed out by the pool that served the lease */
  gateways: Map<string, string>
  /** interfaceId -> DNS server handed out with the lease (when configured) */
  dnsServers: Map<string, string>
  /** interfaceId -> failure (interfaces in dhcp mode without an address) */
  failures: Map<string, DhcpFailure>
  /** poolId -> how many addresses were handed out (for UI/diagnostics) */
  poolUsage: Map<string, { used: number; capacity: number }>
  /** interfaceId -> relay record for leases obtained through a relay */
  relays: Map<string, RelayRecord>
  /** interfaceId -> router address on the client's segment that has NO relay configured */
  unrelayed: Map<string, UnrelayedAgent>
}

export function clientInterfaces(lab: Lab): Array<{ device: Device; iface: NetInterface }> {
  const out: Array<{ device: Device; iface: NetInterface }> = []
  for (const device of lab.devices) {
    if (device.kind === 'switch') continue
    for (const iface of device.interfaces) {
      if (iface.ipMode === 'dhcp') out.push({ device, iface })
    }
  }
  return out.sort((a, b) =>
    a.device.name.localeCompare(b.device.name) || a.iface.name.localeCompare(b.iface.name),
  )
}

interface PoolRef {
  poolId: string
  poolName: string
  serverDevice: Device
  serverIface: NetInterface
  networkCidr: string
  gatewayIp: string
  dnsIp?: string
  startNum: number
  endNum: number
}

function collectPools(lab: Lab): PoolRef[] {
  const pools: PoolRef[] = []
  for (const device of lab.devices) {
    for (const pool of device.dhcpPools) {
      const serving = device.interfaces.find((i) => i.enabled && i.cidr)
      if (!serving) continue
      const net = parseCidr(pool.networkCidr)
      const start = parseIpv4(pool.rangeStart)
      const end = parseIpv4(pool.rangeEnd)
      if (!net || start === null || end === null) continue
      pools.push({
        poolId: pool.id,
        poolName: pool.name,
        serverDevice: device,
        serverIface: serving,
        networkCidr: pool.networkCidr,
        gatewayIp: pool.gatewayIp,
        dnsIp: pool.dnsIp,
        startNum: start,
        endNum: end,
      })
    }
  }
  return pools.sort(
    (a, b) => a.serverDevice.name.localeCompare(b.serverDevice.name) || a.poolName.localeCompare(b.poolName),
  )
}

function poolCapacity(pool: PoolRef): number {
  if (pool.endNum < pool.startNum) return 0
  let count = 0
  for (let ip = pool.startNum; ip <= pool.endNum; ip++) {
    const candidate = { ip, prefix: parseCidr(pool.networkCidr)!.prefix }
    if (isNetworkAddress(candidate) || isBroadcastAddress(candidate)) continue
    count++
    if (count > 4096) break // sanity cap
  }
  return count
}

/**
 * Resolve DHCP for every client interface. Allocation order is deterministic
 * (clients sorted by device/interface name, pools by server/pool name) so the
 * simulation and its tests are reproducible.
 */
export function resolveDhcp(lab: Lab): DhcpState {
  const state: DhcpState = {
    assignments: new Map(),
    gateways: new Map(),
    dnsServers: new Map(),
    failures: new Map(),
    poolUsage: new Map(),
    relays: new Map(),
    unrelayed: new Map(),
  }
  const pools = collectPools(lab)
  for (const pool of pools) state.poolUsage.set(pool.poolId, { used: 0, capacity: poolCapacity(pool) })

  // Addresses already taken by static configuration anywhere in the lab
  // (physical interfaces AND VLAN sub-interfaces — a lease must never collide
  // with the router's own giaddr).
  const taken = new Set<number>()
  for (const device of lab.devices) {
    for (const iface of device.interfaces) {
      if (iface.ipMode === 'static' && iface.cidr) {
        const ip = parseCidr(iface.cidr)
        if (ip) taken.add(ip.ip)
      }
      for (const sub of iface.subInterfaces ?? []) {
        const subCidr = effectiveSubAddress(sub).cidr
        const parsed = subCidr ? parseCidr(subCidr) : null
        if (parsed) taken.add(parsed.ip)
      }
    }
  }

  for (const { device, iface } of clientInterfaces(lab)) {
    if (!iface.enabled) {
      state.failures.set(iface.id, {
        reason: 'interface-down',
        detail: `${device.name} ${iface.name} is administratively down, so no DHCP request can be sent.`,
      })
      continue
    }
    // Pools whose server interface shares an L2 segment with this client.
    const serving = pools.filter((pool) => {
      const segment = getL2Segment(lab, pool.serverDevice.id, pool.serverIface.id)
      return segment.members.some((m) => m.deviceId === device.id && m.interfaceId === iface.id)
    })
    if (serving.length === 0) {
      resolveViaRelay(lab, state, device, iface, taken)
      continue
    }
    let assigned = false
    for (const pool of serving) {
      const net = parseCidr(pool.networkCidr)
      if (!net) continue
      const usage = state.poolUsage.get(pool.poolId)
      let lease: number | null = null
      for (let ip = pool.startNum; ip <= pool.endNum; ip++) {
        const candidate = { ip, prefix: net.prefix }
        if (isNetworkAddress(candidate) || isBroadcastAddress(candidate)) continue
        if (taken.has(ip)) continue
        lease = ip
        break
      }
      if (lease === null) {
        if (usage) usage.used = usage.capacity // exhausted
        state.failures.set(iface.id, {
          reason: 'pool-exhausted',
          detail: `DHCP pool "${pool.poolName}" on ${pool.serverDevice.name} has no free addresses in ${formatIpv4(pool.startNum)}-${formatIpv4(pool.endNum)}.`,
          poolId: pool.poolId,
          poolDeviceId: pool.serverDevice.id,
        })
        continue
      }
      taken.add(lease)
      state.assignments.set(iface.id, `${formatIpv4(lease)}/${net.prefix}`)
      if (poolGatewayValid(pool.networkCidr, pool.gatewayIp ?? '')) {
        state.gateways.set(device.id, pool.gatewayIp)
      }
      if (pool.dnsIp && parseIpv4(pool.dnsIp) !== null) {
        state.dnsServers.set(iface.id, pool.dnsIp)
      }
      if (usage) usage.used++
      assigned = true
      break
    }
    if (!assigned && !state.failures.has(iface.id)) {
      state.failures.set(iface.id, { reason: 'no-matching-pool', detail: 'No usable DHCP pool could serve this interface.' })
    }
  }
  return state
}

/** The pool that would serve a given client interface, or null. */
export function servingPoolFor(lab: Lab, deviceId: string, interfaceId: string): PoolRef | null {
  const pools = collectPools(lab)
  for (const pool of pools) {
    const segment = getL2Segment(lab, pool.serverDevice.id, pool.serverIface.id)
    if (segment.members.some((m) => m.deviceId === deviceId && m.interfaceId === interfaceId)) return pool
  }
  return null
}

/**
 * Effective address of an interface: static CIDR, or the DHCP lease when available.
 */
export function effectiveAddress(
  iface: NetInterface,
  dhcp: DhcpState,
): { cidr: string | null; origin: 'static' | 'dhcp' | 'none' } {
  if (iface.ipMode === 'static') {
    return iface.cidr ? { cidr: iface.cidr, origin: 'static' } : { cidr: null, origin: 'none' }
  }
  const lease = dhcp.assignments.get(iface.id)
  if (lease) return { cidr: lease, origin: 'dhcp' }
  return { cidr: null, origin: 'none' }
}

/** A device's effective default gateway: explicit setting wins, then the DHCP-provided one. */
export function effectiveGateway(device: Device, dhcp: DhcpState): string | null {
  if (device.gatewayIp) return device.gatewayIp
  return dhcp.gateways.get(device.id) ?? null
}

/** Effective address of a router sub-interface (static only; no DHCP on subs). */
export function effectiveSubAddress(sub: SubInterface): { cidr: string | null; origin: 'static' | 'none' } {
  return sub.cidr ? { cidr: sub.cidr, origin: 'static' } : { cidr: null, origin: 'none' }
}

export type IpOwner =
  | { device: Device; iface: NetInterface; sub: null; label: string }
  | { device: Device; iface: NetInterface; sub: SubInterface; label: string }

/** Find the physical interface or VLAN sub-interface that currently owns an IP. */
export function ownerOfIp(lab: Lab, dhcp: DhcpState, ipText: string): IpOwner | null {
  const target = parseIpv4(ipText)
  if (target === null) return null
  for (const device of lab.devices) {
    for (const iface of device.interfaces) {
      for (const sub of iface.subInterfaces ?? []) {
        const { cidr } = effectiveSubAddress(sub)
        if (!cidr) continue
        const parsed = parseCidr(cidr)
        if (parsed && parsed.ip === target) {
          return { device, iface, sub, label: `${device.name} ${sub.name}` }
        }
      }
      const { cidr } = effectiveAddress(iface, dhcp)
      if (!cidr) continue
      const parsed = parseCidr(cidr)
      if (parsed && parsed.ip === target) {
        return { device, iface, sub: null, label: `${device.name} ${iface.name}` }
      }
    }
  }
  return null
}

function emptyDhcpState(): DhcpState {
  return {
    assignments: new Map(),
    gateways: new Map(),
    dnsServers: new Map(),
    failures: new Map(),
    poolUsage: new Map(),
    relays: new Map(),
    unrelayed: new Map(),
  }
}

interface RelayAgent {
  device: Device
  iface: NetInterface
  sub: SubInterface | null
  giaddr: string
  giaddrPrefix: number
  relayTarget: string | null
}

/**
 * DHCP relay (ip helper-address): when no DHCP server shares the client's
 * segment, a router interface (or VLAN sub-interface) with an address on that
 * segment can forward the request to a remote server. The relayed request
 * carries the agent's address (giaddr), and the server must pick a scope whose
 * network matches it — never a scope from another subnet.
 *
 * Failure order is deterministic: relay target resolution, then routing
 * reachability (simulated with a static-only view so DHCP state is not
 * circular), then scope selection, then allocation.
 */
function resolveViaRelay(lab: Lab, state: DhcpState, device: Device, iface: NetInterface, taken: Set<number>): void {
  const clientLabel = `${device.name} ${iface.name}`
  const segment = getL2Segment(lab, device.id, iface.id)

  // Candidate relay agents: router ports on the client's segment that own an
  // address there (physical address, or a sub-interface bound to the segment VLAN).
  const agents: RelayAgent[] = []
  for (const member of segmentInterfaces(lab, segment)) {
    if (member.device.kind !== 'router' || !member.iface.enabled) continue
    if (member.iface.cidr) {
      const parsed = parseCidr(member.iface.cidr)
      if (parsed) {
        agents.push({
          device: member.device,
          iface: member.iface,
          sub: null,
          giaddr: member.iface.cidr,
          giaddrPrefix: parsed.prefix,
          relayTarget: member.iface.dhcpRelay ?? null,
        })
      }
    }
    for (const sub of member.iface.subInterfaces ?? []) {
      if (!sub.enabled) continue
      if (segment.vlan !== null && sub.vlanId !== segment.vlan) continue
      const subCidr = effectiveSubAddress(sub).cidr
      const parsed = subCidr ? parseCidr(subCidr) : null
      if (parsed) {
        agents.push({
          device: member.device,
          iface: member.iface,
          sub,
          giaddr: subCidr!,
          giaddrPrefix: parsed.prefix,
          relayTarget: sub.dhcpRelay ?? null,
        })
      }
    }
  }

  if (agents.length === 0) {
    state.failures.set(iface.id, {
      reason: 'no-server',
      detail: `No DHCP server shares the segment of ${clientLabel}, and no router interface on that segment has an address to relay from.`,
    })
    return
  }

  const agent = agents.find((a) => a.relayTarget)
  if (!agent) {
    const first = agents[0]
    state.unrelayed.set(iface.id, {
      routerDeviceId: first.device.id,
      routerLabel: `${first.device.name} ${first.sub?.name ?? first.iface.name}`,
      interfaceId: first.iface.id,
      subInterfaceId: first.sub?.id ?? null,
      giaddr: formatIpv4(parseCidr(first.giaddr)!.ip),
      giaddrPrefix: first.giaddrPrefix,
    })
    state.failures.set(iface.id, {
      reason: 'no-server',
      detail: `No DHCP server shares ${clientLabel}'s segment, and ${first.device.name} ${first.sub?.name ?? first.iface.name} (${first.giaddr}) has no DHCP relay configured, so the request cannot leave the segment.`,
      relayDeviceId: first.device.id,
      relayInterfaceId: first.iface.id,
      relaySubInterfaceId: first.sub?.id,
      giaddr: formatIpv4(parseCidr(first.giaddr)!.ip),
      giaddrPrefix: first.giaddrPrefix,
    })
    return
  }

  const agentLabel = `${agent.device.name} ${agent.sub?.name ?? agent.iface.name}`
  const relayAnchor = {
    relayDeviceId: agent.device.id,
    relayInterfaceId: agent.iface.id,
    relaySubInterfaceId: agent.sub?.id,
  }
  const target = agent.relayTarget!

  // Step 1: does anything own the relay target address?
  const staticView = emptyDhcpState()
  const owner = ownerOfIp(lab, staticView, target)
  if (!owner) {
    state.failures.set(iface.id, {
      reason: 'relay-target-unresolved',
      detail: `${agentLabel} relays DHCP to ${target}, but no device owns that address (simulated).`,
      ...relayAnchor,
    })
    return
  }
  if (owner.device.dhcpPools.length === 0) {
    state.failures.set(iface.id, {
      reason: 'relay-target-unresolved',
      detail: `${agentLabel} relays DHCP to ${target}, but ${owner.label} owns that address without offering any DHCP pool.`,
      ...relayAnchor,
      serverDeviceId: owner.device.id,
      serverIp: target,
    })
    return
  }

  // Step 2: can the relay agent's router actually reach the server? (static view)
  const reach = simulatePing(lab, agent.device.id, target, staticView)
  if (!reach.success) {
    state.failures.set(iface.id, {
      reason: 'server-unreachable',
      detail: `${agentLabel} relays DHCP to ${target}, but the relay agent cannot reach it: ${reach.explanation}`,
      ...relayAnchor,
      serverDeviceId: owner.device.id,
      serverIp: target,
      giaddr: formatIpv4(parseCidr(agent.giaddr)!.ip),
      giaddrPrefix: agent.giaddrPrefix,
    })
    return
  }

  // Step 3: scope selection by giaddr — the relayed request carries the agent's
  // address, so only pools whose network matches it may answer.
  const giaddrIp = parseCidr(agent.giaddr)!.ip
  const giaddrNet = networkOf({ ip: giaddrIp, prefix: agent.giaddrPrefix })
  const matching = (owner.device.dhcpPools ?? [])
    .map((pool) => ({ pool, net: parseCidr(pool.networkCidr) }))
    .filter((entry) => {
      if (!entry.net) return false
      return networkOf(entry.net) === giaddrNet && entry.net.prefix === agent.giaddrPrefix
    })
    .sort((a, b) => a.pool.name.localeCompare(b.pool.name))

  if (matching.length === 0) {
    state.failures.set(iface.id, {
      reason: 'no-matching-pool',
      detail: `The relayed request (giaddr ${formatIpv4(giaddrIp)}/${agent.giaddrPrefix}) reached ${owner.label}, but none of its scopes serves ${formatIpv4(giaddrNet)}/${agent.giaddrPrefix}.`,
      ...relayAnchor,
      serverDeviceId: owner.device.id,
      serverIp: target,
      giaddr: formatIpv4(giaddrIp),
      giaddrPrefix: agent.giaddrPrefix,
    })
    return
  }

  // Step 4: allocation from the matching scope(s), same rules as local DHCP.
  let exhaustedDetail: { poolId: string; poolDeviceId: string; detail: string } | null = null
  for (const { pool, net } of matching) {
    const usage = state.poolUsage.get(pool.id)
    let lease: number | null = null
    for (let ip = parseIpv4(pool.rangeStart)!; ip <= parseIpv4(pool.rangeEnd)!; ip++) {
      const candidate = { ip, prefix: net!.prefix }
      if (isNetworkAddress(candidate) || isBroadcastAddress(candidate)) continue
      if (taken.has(ip)) continue
      lease = ip
      break
    }
    if (lease === null) {
      if (usage) usage.used = usage.capacity
      exhaustedDetail = {
        poolId: pool.id,
        poolDeviceId: owner.device.id,
        detail: `DHCP pool "${pool.name}" on ${owner.device.name} has no free addresses in ${pool.rangeStart}-${pool.rangeEnd} for the relayed request from ${clientLabel}.`,
      }
      continue
    }
    taken.add(lease)
    state.assignments.set(iface.id, `${formatIpv4(lease)}/${net!.prefix}`)
    if (poolGatewayValid(pool.networkCidr, pool.gatewayIp ?? '')) {
      state.gateways.set(device.id, pool.gatewayIp)
    }
    if (pool.dnsIp && parseIpv4(pool.dnsIp) !== null) {
      state.dnsServers.set(iface.id, pool.dnsIp)
    }
    if (usage) usage.used++
    state.relays.set(iface.id, {
      giaddr: formatIpv4(giaddrIp),
      serverIp: target,
      poolId: pool.id,
      poolLabel: `${owner.device.name} "${pool.name}"`,
      viaRouter: agent.device.name,
      viaInterface: agent.iface.name,
      viaSub: agent.sub?.name ?? null,
    })
    return
  }
  if (exhaustedDetail) {
    state.failures.set(iface.id, {
      reason: 'pool-exhausted',
      detail: exhaustedDetail.detail,
      poolId: exhaustedDetail.poolId,
      poolDeviceId: exhaustedDetail.poolDeviceId,
      ...relayAnchor,
      serverDeviceId: exhaustedDetail.poolDeviceId,
      serverIp: target,
    })
  }
}

/** Verify that a DHCP pool's declared gateway actually sits in the pool network. */

export function poolGatewayValid(poolNetworkCidr: string, gatewayIp: string): boolean {
  const net = parseCidr(poolNetworkCidr)
  const gw = parseIpv4(gatewayIp)
  if (!net || gw === null) return false
  return isSameSubnet(net.ip, gw, net.prefix) && gw !== networkOf(net) && gw !== broadcastOf(net)
}

export { findDevice, findInterface }
