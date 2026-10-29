// Simulated ICMP ping engine.
// Walks the topology hop by hop using L2 segments, host gateways and router
// routing tables, and returns a structured result with a human explanation.
// All results are simulated — never live network data.

import { parseIpv4, parseCidr, networkOf, isSameSubnet, formatIpv4 } from './ip'
import { applyFaults } from './effective'
import { resolveDhcp, effectiveAddress, effectiveSubAddress, effectiveGateway, ownerOfIp } from './dhcp'
import type { DhcpState } from './dhcp'
import { buildRoutingTable, lookupRoute } from './routing'
import { findDevice, findInterface, getL2Segment, segmentInterfaces } from './topology'
import type { AclHit, AclProtocol, Device, Lab, NetInterface, PingFailCode, PingHop, PingResult, SubInterface } from './types'

export interface PingOptions {
  ttl?: number
  /** Simulated traffic type. Ping is ICMP by default; tcp/udp model connection tests. */
  protocol?: 'icmp' | 'tcp' | 'udp'
  /** Destination port for tcp/udp connection tests. */
  destPort?: number
}

const DEFAULT_TTL = 128

interface SimPacket {
  protocol: AclProtocol
  /** Dotted source IP, or null when the sender has no address. */
  sourceIp: string | null
  destIp: string
  destPort?: number
}

interface WalkCtx {
  lab: Lab
  dhcp: DhcpState
  hops: PingHop[]
  pathDeviceIds: string[]
  routerHops: number
  ttl: number
  packet: SimPacket
  decidingAclHit: AclHit | null
}

function fail(
  ctx: WalkCtx,
  source: { deviceId: string; deviceName: string; interfaceName: string | null; ip: string | null },
  targetIp: string,
  failCode: PingFailCode,
  explanation: string,
  suggestion?: string,
): PingResult {
  return {
    success: false,
    sourceDeviceId: source.deviceId,
    sourceDeviceName: source.deviceName,
    sourceInterfaceName: source.interfaceName,
    sourceIp: source.ip,
    targetIp,
    hops: ctx.hops,
    failCode,
    explanation,
    suggestion,
    pathDeviceIds: [...ctx.pathDeviceIds],
    aclHit: ctx.decidingAclHit ?? undefined,
  }
}

function success(
  ctx: WalkCtx,
  source: { deviceId: string; deviceName: string; interfaceName: string | null; ip: string | null },
  targetIp: string,
): PingResult {
  return {
    success: true,
    sourceDeviceId: source.deviceId,
    sourceDeviceName: source.deviceName,
    sourceInterfaceName: source.interfaceName,
    sourceIp: source.ip,
    targetIp,
    hops: ctx.hops,
    explanation: `Reply received from ${targetIp} after ${ctx.routerHops} router hop${ctx.routerHops === 1 ? '' : 's'} (simulated, TTL ${ctx.ttl}).`,
    pathDeviceIds: [...ctx.pathDeviceIds],
    aclHit: ctx.decidingAclHit ?? undefined,
  }
}

function resolvedIp(iface: NetInterface, dhcp: DhcpState): { ip: number | null; cidr: string | null; origin: string } {
  const { cidr, origin } = effectiveAddress(iface, dhcp)
  if (!cidr) return { ip: null, cidr: null, origin }
  const parsed = parseCidr(cidr)
  return parsed ? { ip: parsed.ip, cidr, origin } : { ip: null, cidr: null, origin }
}

function addHop(ctx: WalkCtx, deviceName: string, interfaceName: string | null, detail: string, withRtt = false) {
  ctx.hops.push({
    deviceName,
    interfaceName,
    detail,
    rttMs: withRtt ? 1 + ctx.routerHops * 2 : null,
  })
}

/** Does an ACL target ("any", plain IP or CIDR) cover the packet address? */
function aclTargetCovers(ruleTarget: string, ip: number): boolean {
  const text = ruleTarget.trim()
  if (text === '' || text === 'any' || text === '0.0.0.0/0') return true
  const cidr = parseCidr(text)
  if (cidr) return isSameSubnet(cidr.ip, ip, cidr.prefix)
  const plain = parseIpv4(text)
  if (plain !== null) return plain === ip
  return false
}

/** First-match-wins rule evaluation for one simulated packet. */
function aclRuleMatches(
  rule: { protocol: AclProtocol; source: string; destination: string; destPort?: number | null },
  packet: SimPacket,
): boolean {
  if (rule.protocol !== packet.protocol) return false
  if (packet.sourceIp === null) return false
  if (!aclTargetCovers(rule.source, parseIpv4(packet.sourceIp) ?? -1)) return false
  if (!aclTargetCovers(rule.destination, parseIpv4(packet.destIp) ?? -1)) return false
  if (rule.protocol !== 'icmp' && rule.destPort != null && packet.destPort !== rule.destPort) return false
  return true
}

/**
 * Evaluate the ACLs of one interface container (physical or sub-interface) in
 * one direction. Returns the hit when a DENY rule matched; null when a permit
 * matched or no rule matched (implicit permit — documented default).
 */
function evaluateAcl(
  ctx: WalkCtx,
  deviceId: string,
  ifaceId: string,
  subInterfaceId: string | null,
  direction: 'in' | 'out',
): AclHit | null {
  const device = findDevice(ctx.lab, deviceId)
  const iface = device?.interfaces.find((i) => i.id === ifaceId)
  if (!device || !iface) return null
  if (device.kind !== 'router') return null // ACLs only exist on routers
  if (ctx.packet.sourceIp === null) return null

  let containers: Array<{ iface: NetInterface; sub: SubInterface | null; acls: import('./types').AclEntry[] }>
  if (subInterfaceId) {
    const sub = (iface.subInterfaces ?? []).find((s) => s.id === subInterfaceId)
    if (!sub) return null
    containers = [{ iface, sub, acls: sub.acls ?? [] }]
  } else {
    containers = [{ iface, sub: null, acls: iface.acls ?? [] }]
  }

  for (const container of containers) {
    for (const acl of container.acls) {
      if (acl.direction !== direction) continue
      for (let index = 0; index < acl.rules.length; index++) {
        const rule = acl.rules[index]
        if (!rule.enabled) continue
        if (!aclRuleMatches(rule, ctx.packet)) continue
        return {
          deviceId: device.id,
          deviceName: device.name,
          interfaceId: iface.id,
          interfaceName: iface.name,
          subInterfaceId: container.sub?.id,
          subInterfaceName: container.sub?.name,
          aclId: acl.id,
          aclName: acl.name,
          direction,
          ruleId: rule.id,
          ruleIndex: index,
          action: rule.action,
          protocol: rule.protocol,
          source: rule.source,
          destination: rule.destination,
          destPort: rule.destPort ?? null,
        }
      }
    }
  }
  return null // no rule matched: implicit permit (documented default)
}

/**
 * Evaluate the ACL in one direction. On DENY, records a hop and returns the
 * failure result; on PERMIT, records the deciding hit on the context (picked
 * up by success()) and returns null so the packet continues.
 */
function checkAcl(
  ctx: WalkCtx,
  deviceId: string,
  ifaceId: string,
  subInterfaceId: string | null,
  direction: 'in' | 'out',
  source: { deviceId: string; deviceName: string; interfaceName: string | null; ip: string | null },
  targetIp: string,
): PingResult | null {
  const hit = evaluateAcl(ctx, deviceId, ifaceId, subInterfaceId, direction)
  if (!hit) return null
  ctx.decidingAclHit = hit
  if (hit.action === 'permit') return null
  const where = `${hit.deviceName} ${hit.subInterfaceName ?? hit.interfaceName}`
  const ruleText = `${hit.action} ${hit.protocol} ${hit.source} → ${hit.destination}${hit.destPort != null ? ` port ${hit.destPort}` : ''}`
  addHop(ctx, hit.deviceName, hit.subInterfaceName ?? hit.interfaceName, `Blocked by ACL "${hit.aclName}" (${direction}) — rule ${hit.ruleIndex + 1}: ${ruleText}`)
  return fail(
    ctx,
    source,
    targetIp,
    'acl-denied',
    `Destination unreachable (administratively denied): the packet was blocked by ACL "${hit.aclName}" on ${where}, ${direction === 'in' ? 'inbound' : 'outbound'}. Matching rule ${hit.ruleIndex + 1}: ${ruleText}. ACLs use first-match-wins — an earlier rule decides before later permits are ever checked (simulated).`,
    `Review the ACL on ${where}: either remove/adjust this deny rule or add a more specific permit rule BEFORE it.`,
  )
}

/** Find a sub-interface of `iface` that owns `ipText` and carries `vlan`. */
function subOwningIp(iface: NetInterface, ipText: string, vlan: number | null): SubInterface | null {
  for (const sub of iface.subInterfaces ?? []) {
    if (vlan !== null && sub.vlanId !== vlan) continue
    const { cidr } = effectiveSubAddress(sub)
    if (!cidr) continue
    const parsed = parseCidr(cidr)
    if (parsed && formatIpv4(parsed.ip) === ipText) return sub
  }
  return null
}

/** Try to deliver on the local segment by "ARPing" for the target IP. */
function attemptOnLink(
  ctx: WalkCtx,
  deviceId: string,
  iface: NetInterface,
  targetIp: string,
  source: { deviceId: string; deviceName: string; interfaceName: string | null; ip: string | null },
  vlan?: number,
): PingResult {
  const segment = getL2Segment(ctx.lab, deviceId, iface.id, vlan !== undefined ? { vlan } : {})
  const members = segmentInterfaces(ctx.lab, segment)

  // A member interface (or one of its VLAN sub-interfaces) owning the target IP.
  for (const entry of members) {
    const sub = subOwningIp(entry.iface, targetIp, segment.vlan)
    if (sub) {
      if (!entry.iface.enabled) {
        addHop(ctx, entry.device.name, sub.name, 'Parent interface is administratively down')
        return fail(ctx, source, targetIp, 'destination-unreachable', `Host unreachable: ${entry.device.name} ${sub.name} owns ${targetIp} but its parent interface is shut down (simulated).`, `Enable ${entry.iface.name} on ${entry.device.name}.`)
      }
      if (!sub.enabled) {
        addHop(ctx, entry.device.name, sub.name, 'Sub-interface is administratively down')
        return fail(ctx, source, targetIp, 'destination-unreachable', `Host unreachable: ${entry.device.name} ${sub.name} owns ${targetIp} but the sub-interface is shut down (simulated).`, `Enable ${sub.name} on ${entry.device.name}.`)
      }
      addHop(ctx, entry.device.name, sub.name, `ARP resolved ${targetIp} on VLAN ${sub.vlanId} — reply received`, true)
      ctx.pathDeviceIds.push(entry.device.id)
      return success(ctx, source, targetIp)
    }
    const addr = resolvedIp(entry.iface, ctx.dhcp)
    if (addr.ip !== null && formatIpv4(addr.ip) === targetIp) {
      if (!entry.iface.enabled) {
        addHop(ctx, entry.device.name, entry.iface.name, 'Destination interface is administratively down')
        return fail(ctx, source, targetIp, 'destination-unreachable', `Host unreachable: ${entry.device.name} ${entry.iface.name} owns ${targetIp} but the interface is shut down (simulated).`, `Enable ${entry.iface.name} on ${entry.device.name}.`)
      }
      addHop(ctx, entry.device.name, entry.iface.name, `ARP resolved ${targetIp} — reply received`, true)
      ctx.pathDeviceIds.push(entry.device.id)
      return success(ctx, source, targetIp)
    }
  }

  // Nothing on the segment owns the IP — build a useful explanation.
  const owner = ownerOfIp(ctx.lab, ctx.dhcp, targetIp)
  if (owner) {
    const why = whyNotInSegment(ctx.lab, deviceId, iface.id, owner.device.id, owner.iface.id, segment.vlan, targetIp)
    addHop(ctx, owner.device.name, owner.sub?.name ?? owner.iface.name, 'No ARP reply (not reachable at layer 2)')
    const ownerCidr = owner.sub?.cidr ?? owner.iface.cidr ?? 'DHCP'
    return fail(
      ctx,
      source,
      targetIp,
      'on-link-arp-fail',
      `Request timed out: ${owner.label} owns ${targetIp} (${ownerCidr}) but is not reachable at layer 2 from ${iface.name}.${why ? ` ${why}` : ''}`,
      why ?? 'Check cabling, VLAN assignment and interface state between the two devices.',
    )
  }
  const ownerNote = segment.members.length <= 1 ? 'The interface has no active neighbors on this segment.' : ''
  addHop(ctx, '—', iface.name, `ARP for ${targetIp} failed on the local segment`)
  return fail(
    ctx,
    source,
    targetIp,
    'on-link-arp-fail',
    `Request timed out: no device on the simulated segment of ${iface.name} owns ${targetIp}. ${ownerNote} If the target should be reachable through a gateway, verify its IP address and subnet mask.`,
    'Verify the target device exists and its IP/mask are correct, or ping through the default gateway.',
  )
}

/** Explain why an owner of an IP is not reachable in the source's L2 segment. */
function whyNotInSegment(
  lab: Lab,
  fromDeviceId: string,
  fromIfaceId: string,
  toDeviceId: string,
  toIfaceId: string,
  vlan: number | null = null,
  targetIp?: string,
): string {
  const segment = getL2Segment(lab, fromDeviceId, fromIfaceId, vlan !== null ? { vlan } : {})
  const inSegment = segment.members.some((m) => m.deviceId === toDeviceId && m.interfaceId === toIfaceId)
  if (inSegment) {
    // The device is a member, but the owning address may sit on a sub-interface
    // bound to a different VLAN than the one the traffic arrives on.
    if (vlan !== null && targetIp) {
      const target = findInterface(lab, toDeviceId, toIfaceId)
      const mismatched = (target?.iface.subInterfaces ?? []).find((sub) => {
        if (sub.vlanId === vlan || !sub.cidr) return false
        const parsed = parseCidr(sub.cidr)
        return parsed !== null && formatIpv4(parsed.ip) === targetIp
      })
      if (mismatched) {
        return `${target!.device.name} ${mismatched.name} serves VLAN ${mismatched.vlanId}, but the traffic arrives on VLAN ${vlan} — the sub-interface VLAN does not match.`
      }
    }
    return ''
  }
  const target = findInterface(lab, toDeviceId, toIfaceId)
  if (!target) return ''
  // The owning device is outside the segment entirely: sub-interface VLAN mismatch?
  if (vlan !== null && targetIp) {
    const mismatched = (target.iface.subInterfaces ?? []).find((sub) => {
      if (sub.vlanId === vlan || !sub.cidr) return false
      const parsed = parseCidr(sub.cidr)
      return parsed !== null && formatIpv4(parsed.ip) === targetIp
    })
    if (mismatched) {
      return `${target.device.name} ${mismatched.name} serves VLAN ${mismatched.vlanId}, but the source's traffic arrives on VLAN ${vlan} — the sub-interface VLAN does not match.`
    }
  }
  // Different VLAN on a shared switch?
  const srcSegmentIfaces = segmentInterfaces(lab, segment)
  const srcSwitchPorts = srcSegmentIfaces.filter((m) => m.device.kind === 'switch' && m.iface.role === 'switchport')
  for (const link of lab.links) {
    const involvesTarget =
      (link.aDeviceId === toDeviceId && link.aInterfaceId === toIfaceId) ||
      (link.bDeviceId === toDeviceId && link.bInterfaceId === toIfaceId)
    if (!involvesTarget) continue
    const other =
      link.aDeviceId === toDeviceId
        ? findInterface(lab, link.bDeviceId, link.bInterfaceId)
        : findInterface(lab, link.aDeviceId, link.aInterfaceId)
    if (other && other.device.kind === 'switch' && other.iface.role === 'switchport') {
      const srcVlans = new Set(srcSwitchPorts.filter((m) => m.device.id === other.device.id).map((m) => m.iface.accessVlan))
      if (srcVlans.size > 0 && !srcVlans.has(other.iface.accessVlan)) {
        return `${other.device.name} port ${other.iface.name} is in VLAN ${other.iface.accessVlan}, while the source side uses VLAN ${[...srcVlans].join(', ')} — VLAN isolation blocks the traffic.`
      }
    }
    if (!link.enabled) {
      return 'The link between the two devices is administratively down.'
    }
  }
  if (!target.iface.enabled) {
    return `${target.device.name} ${target.iface.name} is administratively down.`
  }
  return 'The two interfaces are on different segments (a router is in between, or the path is broken).'
}

/**
 * Router-originated ping source selection: the packet's source IP comes from
 * the interface the routing table actually selects as egress for the
 * destination — the longest-prefix connected route, including router-on-a-stick
 * sub-interfaces; for static routes, from the interface that reaches the next
 * hop. Falls back to the first addressable interface (physical interfaces in
 * order, then their sub-interfaces) when no egress is determinable.
 */
function routerSourceFor(device: Device, targetNum: number, dhcp: DhcpState): { ip: string | null; interfaceName: string | null } {
  const table = buildRoutingTable(device, dhcp)
  let route = lookupRoute(table, targetNum)
  if (route && route.type === 'static' && route.nextHopIp) {
    const nextHopNum = parseIpv4(route.nextHopIp)
    const nextHopRoute = nextHopNum !== null ? lookupRoute(table, nextHopNum) : null
    if (nextHopRoute && nextHopRoute.type === 'connected') route = nextHopRoute
  }
  if (route && route.type === 'connected' && route.interfaceId) {
    const iface = device.interfaces.find((i) => i.id === route.interfaceId)
    if (iface && iface.enabled) {
      if (route.vlanId != null && route.subInterfaceId) {
        const sub = (iface.subInterfaces ?? []).find((s) => s.id === route.subInterfaceId)
        if (sub) {
          const subCidr = effectiveSubAddress(sub).cidr
          if (subCidr) return { ip: subCidr.split('/')[0], interfaceName: sub.name }
        }
      }
      const { cidr } = effectiveAddress(iface, dhcp)
      if (cidr) return { ip: cidr.split('/')[0], interfaceName: iface.name }
    }
  }
  for (const iface of device.interfaces) {
    if (!iface.enabled) continue
    const { cidr } = effectiveAddress(iface, dhcp)
    if (cidr) return { ip: cidr.split('/')[0], interfaceName: iface.name }
    for (const sub of iface.subInterfaces ?? []) {
      if (!sub.enabled) continue
      const subCidr = effectiveSubAddress(sub).cidr
      if (subCidr) return { ip: subCidr.split('/')[0], interfaceName: sub.name }
    }
  }
  return { ip: null, interfaceName: null }
}

function chooseHostEgress(device: Device, targetIp: number, dhcp: DhcpState): NetInterface | null {
  const candidates = device.interfaces.filter((i) => i.enabled && effectiveAddress(i, dhcp).cidr)
  if (candidates.length === 0) return null
  for (const iface of candidates) {
    const addr = effectiveAddress(iface, dhcp)
    const parsed = addr.cidr ? parseCidr(addr.cidr) : null
    if (parsed && isSameSubnet(parsed.ip, targetIp, parsed.prefix)) return iface
  }
  return candidates[0]
}

function forward(
  ctx: WalkCtx,
  deviceId: string,
  entryIfaceId: string | null,
  targetIp: string,
  source: { deviceId: string; deviceName: string; interfaceName: string | null; ip: string | null },
): PingResult {
  const device = findDevice(ctx.lab, deviceId)
  if (!device) {
    return fail(ctx, source, targetIp, 'no-route', 'Internal simulation error: device not found.')
  }
  const targetNum = parseIpv4(targetIp)
  if (targetNum === null) {
    return fail(ctx, source, targetIp, 'invalid-target', `"${targetIp}" is not a valid IPv4 address.`)
  }

  // Ingress ACLs of the router interface the packet arrived on (simulated:
  // evaluated on the physical ingress port; sub-interface traffic is filtered
  // by attaching ACLs to the egress sub-interface instead).
  if (device.kind === 'router' && entryIfaceId) {
    const denied = checkAcl(ctx, device.id, entryIfaceId, null, 'in', source, targetIp)
    if (denied) return denied
  }

  // Arrived? (physical addresses and VLAN sub-interface addresses both count)
  for (const iface of device.interfaces) {
    for (const sub of iface.subInterfaces ?? []) {
      const subCidr = effectiveSubAddress(sub).cidr
      const subParsed = subCidr ? parseCidr(subCidr) : null
      if (subParsed && subParsed.ip === targetNum) {
        if (!iface.enabled || !sub.enabled) {
          addHop(ctx, device.name, sub.name, 'Destination sub-interface is administratively down')
          return fail(ctx, source, targetIp, 'destination-unreachable', `Host unreachable: ${device.name} ${sub.name} owns ${targetIp} but is shut down (simulated).`, `Enable ${sub.name} on ${device.name}.`)
        }
        ctx.pathDeviceIds.push(device.id)
        addHop(ctx, device.name, sub.name, 'Reply received from destination', true)
        return success(ctx, source, targetIp)
      }
    }
    const addr = resolvedIp(iface, ctx.dhcp)
    if (addr.ip !== null && addr.ip === targetNum) {
      if (!iface.enabled) {
        addHop(ctx, device.name, iface.name, 'Destination interface is administratively down')
        return fail(ctx, source, targetIp, 'destination-unreachable', `Host unreachable: ${device.name} ${iface.name} owns ${targetIp} but is shut down (simulated).`, `Enable ${iface.name} on ${device.name}.`)
      }
      ctx.pathDeviceIds.push(device.id)
      addHop(ctx, device.name, iface.name, 'Reply received from destination', true)
      return success(ctx, source, targetIp)
    }
  }

  if (device.kind === 'switch') {
    return fail(ctx, source, targetIp, 'no-route', `${device.name} is a switch and does not route in this simulation.`)
  }

  if (ctx.pathDeviceIds.includes(device.id)) {
    return fail(ctx, source, targetIp, 'ttl-exceeded', `TTL exceeded: a routing loop was detected at ${device.name} (simulated).`, 'Check static routes so they do not point at each other.')
  }
  ctx.pathDeviceIds.push(device.id)

  if (device.kind === 'pc' || device.kind === 'server') {
    const egress = chooseHostEgress(device, targetNum, ctx.dhcp)
    if (!egress) {
      return fail(ctx, source, targetIp, 'no-source-ip', `${device.name} has no interface with an IP address (static or DHCP).`, 'Configure an address or enable DHCP on an interface.')
    }
    const addr = effectiveAddress(egress, ctx.dhcp)
    const parsed = addr.cidr ? parseCidr(addr.cidr) : null
    if (parsed && isSameSubnet(parsed.ip, targetNum, parsed.prefix)) {
      return attemptOnLink(ctx, device.id, egress, targetIp, source)
    }
    // Off-link: use the default gateway (explicit setting, then DHCP-provided).
    const gateway = effectiveGateway(device, ctx.dhcp)
    if (!gateway) {
      return fail(ctx, source, targetIp, 'no-gateway', `Network unreachable: ${targetIp} is outside ${device.name}'s subnet ${parsed ? `${formatIpv4(networkOf(parsed))}/${parsed.prefix}` : '(unknown)'} and no default gateway is configured.`, `Set the default gateway to the router interface IP (e.g. ${parsed ? formatIpv4((networkOf(parsed) + 1) >>> 0) : 'the router IP'}).`)
    }
    const segment = getL2Segment(ctx.lab, device.id, egress.id)
    const members = segmentInterfaces(ctx.lab, segment)
    let gwEntry: { device: Device; iface: NetInterface; viaSub: SubInterface | null } | null = null
    for (const member of members) {
      if (member.device.id === device.id) continue
      // Router-on-a-stick: the gateway may live on a VLAN sub-interface of a
      // member router port, bound to exactly the VLAN this segment uses.
      for (const sub of member.iface.subInterfaces ?? []) {
        if (segment.vlan !== null && sub.vlanId !== segment.vlan) continue
        const subCidr = effectiveSubAddress(sub).cidr
        const subParsed = subCidr ? parseCidr(subCidr) : null
        if (subParsed && formatIpv4(subParsed.ip) === gateway) {
          gwEntry = { device: member.device, iface: member.iface, viaSub: sub }
          break
        }
      }
      if (gwEntry) break
      const mAddr = resolvedIp(member.iface, ctx.dhcp)
      if (mAddr.ip !== null && formatIpv4(mAddr.ip) === gateway) {
        gwEntry = { device: member.device, iface: member.iface, viaSub: null }
        break
      }
    }
    if (!gwEntry) {
      const blocked = segment.excludedPorts.find((p) => p.vlan === segment.vlan)
      const blockedNote = blocked
        ? ` The path is blocked at ${findDevice(ctx.lab, blocked.deviceId)?.name ?? '?'} port ${findInterface(ctx.lab, blocked.deviceId, blocked.interfaceId)?.iface.name ?? '?'} (VLAN ${segment.vlan} is not permitted there).`
        : ''
      return fail(ctx, source, targetIp, 'gateway-unreachable', `Default gateway ${gateway} did not answer ARP on ${device.name}'s segment — no device owns that address (simulated).${blockedNote}`, 'Verify the gateway IP matches the router interface (or VLAN sub-interface) on the same subnet.')
    }
    if (gwEntry.device.kind !== 'router') {
      return fail(ctx, source, targetIp, 'gateway-not-a-router', `Default gateway ${gateway} belongs to ${gwEntry.device.name}, which is not a router and cannot forward the packet.`)
    }
    if (gwEntry.viaSub && !gwEntry.viaSub.enabled) {
      return fail(ctx, source, targetIp, 'gateway-unreachable', `Default gateway ${gateway} belongs to ${gwEntry.device.name} ${gwEntry.viaSub.name}, which is shut down (simulated).`, `Enable ${gwEntry.viaSub.name} on ${gwEntry.device.name}.`)
    }
    if (ctx.ttl <= 1) {
      return fail(ctx, source, targetIp, 'ttl-exceeded', 'TTL exceeded while reaching the default gateway (routing loop, simulated).')
    }
    ctx.ttl -= 1
    ctx.routerHops += 1
    addHop(ctx, device.name, egress.name, `Sent to default gateway ${gateway}${gwEntry.viaSub ? ` (via ${gwEntry.viaSub.name}, VLAN ${gwEntry.viaSub.vlanId})` : ''}`)
    return forward(ctx, gwEntry.device.id, gwEntry.iface.id, targetIp, source)
  }

  // Router: routing table lookup.
  const table = buildRoutingTable(device, ctx.dhcp)
  const route = lookupRoute(table, targetNum)
  if (!route) {
    const known = table.filter((r) => r.type === 'connected').map((r) => r.destinationCidr)
    return fail(ctx, source, targetIp, 'no-route', `Destination unreachable: ${device.name} has no route to ${targetIp} (simulated).`, known.length > 0 ? `Known connected networks: ${known.join(', ')}. Add a static route or the remote network summary.` : 'The router has no connected networks or static routes.')
  }
  if (route.type === 'connected' && route.interfaceId) {
    const iface = device.interfaces.find((i) => i.id === route.interfaceId)
    if (!iface || !iface.enabled) {
      return fail(ctx, source, targetIp, 'source-interface-down', `${device.name} has a connected route to ${route.destinationCidr} but the egress interface is down.`, `Enable the interface leading to ${route.destinationCidr}.`)
    }
    if (route.vlanId != null) {
      const denied = checkAcl(ctx, device.id, iface.id, route.subInterfaceId ?? null, 'out', source, targetIp)
      if (denied) return denied
      addHop(ctx, device.name, route.subInterfaceName ?? iface.name, `Connected route to ${route.destinationCidr} on VLAN ${route.vlanId} — ARP for ${targetIp}`)
      return attemptOnLink(ctx, device.id, iface, targetIp, source, route.vlanId)
    }
    const denied = checkAcl(ctx, device.id, iface.id, null, 'out', source, targetIp)
    if (denied) return denied
    addHop(ctx, device.name, iface.name, `Connected route to ${route.destinationCidr} — ARP for ${targetIp}`)
    return attemptOnLink(ctx, device.id, iface, targetIp, source)
  }
  // Static route with next hop.
  const nextHop = route.nextHopIp ?? ''
  const nextHopNum = parseIpv4(nextHop)
  let egressIface: NetInterface | null = null
  if (nextHopNum !== null) {
    let bestPrefix = -1
    for (const r of table) {
      if (r.type !== 'connected' || !r.interfaceId) continue
      const mask = r.prefix === 0 ? 0 : (0xffffffff << (32 - r.prefix)) >>> 0
      if (((nextHopNum & mask) >>> 0) === r.network && r.prefix > bestPrefix) {
        bestPrefix = r.prefix
        egressIface = device.interfaces.find((i) => i.id === r.interfaceId) ?? null
      }
    }
  }
  if (!egressIface) {
    return fail(ctx, source, targetIp, 'next-hop-unreachable', `${device.name} has a static route to ${route.destinationCidr} via ${nextHop || '(unset)'}, but that next hop is not on any connected subnet (simulated).`, 'Point the static route at an IP inside a directly connected subnet.')
  }
  const segment = getL2Segment(ctx.lab, device.id, egressIface.id)
  const members = segmentInterfaces(ctx.lab, segment)
  let nextHopOwner: Device | null = null
  for (const member of members) {
    if (member.device.id === device.id) continue
    const mAddr = resolvedIp(member.iface, ctx.dhcp)
    if (mAddr.ip !== null && formatIpv4(mAddr.ip) === nextHop) {
      nextHopOwner = member.device
      break
    }
  }
  if (!nextHopOwner) {
    return fail(ctx, source, targetIp, 'next-hop-unreachable', `${device.name} cannot reach next hop ${nextHop} for route ${route.destinationCidr} — no ARP reply on ${egressIface.name} (simulated).`, 'Verify the next hop IP and the link to the neighbor router.')
  }
  if (nextHopOwner.kind !== 'router') {
    return fail(ctx, source, targetIp, 'next-hop-unreachable', `Static route next hop ${nextHop} belongs to ${nextHopOwner.name}, which cannot route packets.`)
  }
  if (ctx.ttl <= 1) {
    return fail(ctx, source, targetIp, 'ttl-exceeded', `TTL exceeded at ${device.name} (routing loop, simulated).`)
  }
  const denied = checkAcl(ctx, device.id, egressIface.id, null, 'out', source, targetIp)
  if (denied) return denied
  ctx.ttl -= 1
  ctx.routerHops += 1
  addHop(ctx, device.name, egressIface.name, `Static route ${route.destinationCidr} via ${nextHop}`)
  return forward(ctx, nextHopOwner.id, egressIface.id, targetIp, source)
}

/**
 * Simulate a ping from a device to an IP address on the given lab.
 * The lab is used as-is: callers that want faults applied should pass the
 * effective lab (see `runPing` which applies faults + DHCP automatically).
 */
export function simulatePing(
  lab: Lab,
  sourceDeviceId: string,
  targetIp: string,
  dhcp: DhcpState = resolveDhcp(lab),
  options: PingOptions = {},
): PingResult {
  const device = findDevice(lab, sourceDeviceId)
  const base: { deviceId: string; deviceName: string; interfaceName: string | null; ip: string | null } = {
    deviceId: sourceDeviceId,
    deviceName: device?.name ?? sourceDeviceId,
    interfaceName: null,
    ip: null,
  }
  if (!device) {
    return fail({ lab, dhcp, hops: [], pathDeviceIds: [], routerHops: 0, ttl: options.ttl ?? DEFAULT_TTL, packet: { protocol: options.protocol ?? 'icmp', sourceIp: null, destIp: targetIp, destPort: options.destPort }, decidingAclHit: null }, base, targetIp, 'invalid-target', `Unknown source device "${sourceDeviceId}".`)
  }
  if (parseIpv4(targetIp) === null) {
    return fail({ lab, dhcp, hops: [], pathDeviceIds: [], routerHops: 0, ttl: options.ttl ?? DEFAULT_TTL, packet: { protocol: options.protocol ?? 'icmp', sourceIp: null, destIp: targetIp, destPort: options.destPort }, decidingAclHit: null }, base, targetIp, 'invalid-target', `"${targetIp}" is not a valid IPv4 address (expected e.g. 192.168.1.10).`)
  }
  if (device.kind === 'switch') {
    return fail({ lab, dhcp, hops: [], pathDeviceIds: [], routerHops: 0, ttl: options.ttl ?? DEFAULT_TTL, packet: { protocol: options.protocol ?? 'icmp', sourceIp: null, destIp: targetIp, destPort: options.destPort }, decidingAclHit: null }, base, targetIp, 'no-source-interface', `${device.name} is a switch: layer-3 ping is not simulated from switches in this version.`, 'Ping from a PC, server or router instead.')
  }
  const packet: SimPacket = {
    protocol: options.protocol ?? 'icmp',
    sourceIp: null,
    destIp: targetIp,
    destPort: options.destPort,
  }
  const ctx: WalkCtx = { lab, dhcp, hops: [], pathDeviceIds: [], routerHops: 0, ttl: options.ttl ?? DEFAULT_TTL, packet, decidingAclHit: null }
  // Source selection: routers source the packet from the egress interface the
  // routing table selects (so ACL source matching sees the real source);
  // hosts keep their first addressable interface.
  if (device.kind === 'router') {
    const src = routerSourceFor(device, parseIpv4(targetIp)!, ctx.dhcp)
    base.interfaceName = src.interfaceName
    base.ip = src.ip
  } else {
    const firstUsable = device.interfaces.find((i) => i.enabled && effectiveAddress(i, ctx.dhcp).cidr)
    base.interfaceName = firstUsable?.name ?? null
    base.ip = firstUsable ? (effectiveAddress(firstUsable, ctx.dhcp).cidr?.split('/')[0] ?? null) : null
  }
  ctx.packet.sourceIp = base.ip
  return forward(ctx, device.id, null, targetIp, base)
}

/** Convenience: apply faults, resolve DHCP, then simulate the ping. */
export function runPing(lab: Lab, sourceDeviceId: string, targetIp: string, options?: PingOptions): PingResult {
  const { lab: effectiveLab } = applyFaults(lab)
  return simulatePing(effectiveLab, sourceDeviceId, targetIp, resolveDhcp(effectiveLab), options)
}
