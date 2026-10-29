// Fault detection for NetDoctor.
// Detection works purely on the EFFECTIVE lab (base config + fault overlays):
// it inspects configuration consistency and runs a simulated connectivity
// suite, exactly like an engineer reading configs and pinging hosts. That is
// why a fault injected in NetLab is automatically detectable here, and why
// fixing it changes the detection and ping results.

import { parseCidr, parseIpv4, networkOf, isSameSubnet, formatIpv4, firstHostText, lastHostText } from './ip'
import { applyFaults } from './effective'
import { resolveDhcp, effectiveAddress, effectiveSubAddress, effectiveGateway, clientInterfaces, poolGatewayValid } from './dhcp'
import { findDevice, findInterface, getL2Segment, segmentInterfaces } from './topology'
import { simulatePing } from './ping'
import { buildRoutingTable, lookupRoute } from './routing'
import type {
  DetectedIssue,
  Device,
  FixAction,
  Fault,
  Lab,
  NetInterface,
  PingResult,
} from './types'

interface DetectorCtx {
  lab: Lab
  dhcp: ReturnType<typeof resolveDhcp>
}

function addrOf(iface: NetInterface, ctx: DetectorCtx): { ip: number | null; prefix: number | null; cidr: string | null } {
  const { cidr } = effectiveAddress(iface, ctx.dhcp)
  const parsed = cidr ? parseCidr(cidr) : null
  return parsed ? { ip: parsed.ip, prefix: parsed.prefix, cidr } : { ip: null, prefix: null, cidr: null }
}

/** Count how many enabled interfaces lab-wide live in a given network/prefix. */
function networkPopularity(ctx: DetectorCtx, network: number, prefix: number): number {
  let count = 0
  for (const device of ctx.lab.devices) {
    for (const iface of device.interfaces) {
      const a = addrOf(iface, ctx)
      if (a.ip === null || a.prefix === null) continue
      if (networkOf({ ip: a.ip, prefix: a.prefix }) === network && a.prefix === prefix) count++
    }
  }
  return count
}

/** Analyze one L2 segment for IP / mask inconsistencies. */
function detectSegmentIssues(
  ctx: DetectorCtx,
  deviceId: string,
  interfaceId: string,
  push: (issue: Omit<DetectedIssue, 'id'>) => void,
) {
  const segment = getL2Segment(ctx.lab, deviceId, interfaceId)
  const members = segmentInterfaces(ctx.lab, segment)
  // Only L3 endpoints matter for subnet consistency.
  const endpoints = members.filter(
    (m) => !(m.device.kind === 'switch' && m.iface.role === 'switchport'),
  )
  const addressed = endpoints
    .map((m) => ({ ...m, addr: addrOf(m.iface, ctx) }))
    .filter((m) => m.addr.ip !== null && m.addr.prefix !== null)
  if (addressed.length < 2) return

  // Group by (network, prefix).
  const groups = new Map<string, typeof addressed>()
  for (const member of addressed) {
    const key = `${networkOf({ ip: member.addr.ip!, prefix: member.addr.prefix! })}/${member.addr.prefix}`
    const list = groups.get(key) ?? []
    list.push(member)
    groups.set(key, list)
  }
  if (groups.size <= 1) return

  // Majority group = the segment's expected network; ties broken by lab-wide popularity.
  let dominant: { key: string; members: typeof addressed } | null = null
  for (const [key, list] of groups) {
    const [netText, prefixText] = key.split('/')
    const pop = networkPopularity(ctx, Number(netText), Number(prefixText))
    if (!dominant || list.length > dominant.members.length || (list.length === dominant.members.length && pop > networkPopularity(ctx, Number(dominant.key.split('/')[0]), Number(dominant.key.split('/')[1])))) {
      dominant = { key, members: list }
    }
  }
  if (!dominant) return
  const [domNet, domPrefix] = dominant.key.split('/').map(Number)
  const domMaskText = formatIpv4(domPrefix === 0 ? 0 : (0xffffffff << (32 - domPrefix)) >>> 0)

  for (const member of addressed) {
    const inDominant = isSameSubnet(member.addr.ip!, domNet, domPrefix)
    const memberNet = networkOf({ ip: member.addr.ip!, prefix: member.addr.prefix! })
    if (inDominant && member.addr.prefix === domPrefix) continue
    if (inDominant) {
      push({
        kind: 'wrong-mask',
        severity: 'warning',
        deviceId: member.device.id,
        interfaceId: member.iface.id,
        title: `Subnet mask mismatch on ${member.device.name} ${member.iface.name}`,
        evidence: `${member.device.name} ${member.iface.name} uses ${member.addr.cidr} while the rest of its segment uses ${formatIpv4(domNet)}/${domPrefix} (mask ${domMaskText}).`,
        explanation: 'A wrong mask makes the device treat part of its own subnet as remote (or the reverse), so some hosts become unreachable while others still work.',
        suggestedFix: `Set ${member.iface.name} to ${formatIpv4(member.addr.ip!)}/${domPrefix} to match the segment.`,
        fix: { type: 'set-cidr', deviceId: member.device.id, interfaceId: member.iface.id, value: `${formatIpv4(member.addr.ip!)}/${domPrefix}` },
      })
    } else {
      push({
        kind: 'wrong-ip',
        severity: 'critical',
        deviceId: member.device.id,
        interfaceId: member.iface.id,
        title: `${member.device.name} ${member.iface.name} is outside its segment network`,
        evidence: `${member.device.name} ${member.iface.name} uses ${member.addr.cidr} (network ${formatIpv4(memberNet)}/${member.addr.prefix}) but its segment's dominant network is ${formatIpv4(domNet)}/${domPrefix}.`,
        explanation: 'The IP address does not belong to the network of the other devices on the same wire/switch, so layer-3 neighbors cannot reach it directly.',
        suggestedFix: `Move ${member.iface.name} into ${formatIpv4(domNet)}/${domPrefix} (for example ${formatIpv4((domNet + 10) >>> 0)}/${domPrefix}) or correct the neighboring network.`,
      })
    }
  }
}

function detectGatewayIssues(ctx: DetectorCtx, push: (issue: Omit<DetectedIssue, 'id'>) => void) {
  for (const device of ctx.lab.devices) {
    if (device.kind !== 'pc' && device.kind !== 'server') continue
    const hostIface = device.interfaces.find((i) => i.enabled && addrOf(i, ctx).ip !== null)
    if (!hostIface) continue
    const addr = addrOf(hostIface, ctx)
    const gwText = effectiveGateway(device, ctx.dhcp)

    if (!gwText) {
      push({
        kind: 'config-warning',
        severity: 'info',
        deviceId: device.id,
        title: `${device.name} has no default gateway`,
        evidence: `${device.name} ${hostIface.name} is configured with ${addr.cidr} but no default gateway is set.`,
        explanation: 'Without a gateway the host can only communicate inside its own subnet.',
        suggestedFix: 'Set the default gateway to the LAN router interface address.',
      })
      continue
    }
    const gw = parseIpv4(gwText)
    if (gw === null) {
      push({
        kind: 'wrong-gateway',
        severity: 'critical',
        deviceId: device.id,
        title: `Invalid default gateway on ${device.name}`,
        evidence: `"${gwText}" is not a valid IPv4 address.`,
        explanation: 'The host cannot use an invalid gateway; all off-subnet traffic fails immediately.',
        suggestedFix: 'Set the gateway to a valid router address in the same subnet.',
        fix: { type: 'set-gateway', deviceId: device.id, value: null },
      })
      continue
    }
    if (addr.ip !== null && gw === addr.ip) {
      push({
        kind: 'wrong-gateway',
        severity: 'critical',
        deviceId: device.id,
        title: `${device.name} is its own default gateway`,
        evidence: `Gateway ${gwText} equals the host's own address on ${hostIface.name}.`,
        explanation: 'Traffic to other subnets loops back to the host itself and dies.',
        suggestedFix: 'Point the gateway at the router interface instead.',
      })
      continue
    }
    const inSubnet = addr.prefix !== null && addr.ip !== null && isSameSubnet(addr.ip, gw, addr.prefix)
    if (!inSubnet) {
      push({
        kind: 'wrong-gateway',
        severity: 'critical',
        deviceId: device.id,
        title: `Gateway ${gwText} is outside ${device.name}'s subnet`,
        evidence: `${device.name} uses ${addr.cidr} on ${hostIface.name}; gateway ${gwText} is not in ${formatIpv4(networkOf({ ip: addr.ip!, prefix: addr.prefix! }))}/${addr.prefix}.`,
        explanation: 'A gateway must be reachable on the local subnet; this one can never be ARPed.',
        suggestedFix: `Use the router interface address inside ${formatIpv4(networkOf({ ip: addr.ip!, prefix: addr.prefix! }))}/${addr.prefix}.`,
      })
      continue
    }
    // Gateway is in the subnet: is anyone actually owning it on the segment?
    const segment = getL2Segment(ctx.lab, device.id, hostIface.id)
    const members = segmentInterfaces(ctx.lab, segment)
    const gwOwner = members.find((m) => {
      if (m.device.id === device.id) return false
      // Router-on-a-stick: the gateway may live on a VLAN sub-interface of a
      // member router port, bound to exactly the segment's VLAN.
      for (const sub of m.iface.subInterfaces ?? []) {
        if (segment.vlan !== null && sub.vlanId !== segment.vlan) continue
        const { cidr } = effectiveSubAddress(sub)
        const parsed = cidr ? parseCidr(cidr) : null
        if (parsed && parsed.ip === gw) return true
      }
      const a = addrOf(m.iface, ctx)
      return a.ip !== null && a.ip === gw
    })
    if (!gwOwner) {
      // Classification, most specific first:
      // 1) A trunk on the path does not carry this VLAN.
      const blockedTrunk = segment.excludedPorts.find((p) => p.vlan === segment.vlan)
      if (blockedTrunk) {
        const blockedDevice = findDevice(ctx.lab, blockedTrunk.deviceId)
        const blockedIface = findInterface(ctx.lab, blockedTrunk.deviceId, blockedTrunk.interfaceId)
        push({
          kind: 'trunk-vlan-missing',
          severity: 'critical',
          deviceId: blockedTrunk.deviceId,
          interfaceId: blockedTrunk.interfaceId,
          title: `VLAN ${segment.vlan} is not permitted on trunk ${blockedDevice?.name ?? '?'} ${blockedIface?.iface.name ?? '?'}`,
          evidence: `${device.name} (VLAN ${segment.vlan}, ${addr.cidr}) cannot reach gateway ${gwText}: the path leaves ${device.name} through a trunk that does not carry VLAN ${segment.vlan}. Allowed VLANs there: [${(blockedIface?.iface.allowedVlans ?? []).join(', ') || 'none'}].`,
          explanation: 'A trunk only forwards frames for the VLANs on its allowed list. With this VLAN excluded, hosts behind it can never reach their gateway (or anything beyond the trunk).',
          suggestedFix: `Allow VLAN ${segment.vlan} on ${blockedDevice?.name ?? '?'} ${blockedIface?.iface.name ?? '?'} (or move the hosts to a permitted VLAN).`,
          fix: { type: 'allow-vlan', deviceId: blockedTrunk.deviceId, interfaceId: blockedTrunk.interfaceId, value: segment.vlan ?? 1 },
        })
        continue
      }
      // 2) A router is physically on the segment but owns no address at all in
      //    the host's subnet — its VLAN sub-interface is missing, on the wrong
      //    VLAN, or mis-addressed. (If the router HAS a subnet address but not
      //    the configured gateway IP, that is a plain wrong-gateway instead.)
      const hostNetwork = addr.ip !== null && addr.prefix !== null ? networkOf({ ip: addr.ip, prefix: addr.prefix }) : null
      const inHostSubnet = (cidr: string | null): boolean => {
        const parsed = cidr ? parseCidr(cidr) : null
        return parsed !== null && hostNetwork !== null && networkOf({ ip: parsed.ip, prefix: addr.prefix! }) === hostNetwork
      }
      const routerMember = members.find((m) => {
        if (m.device.kind !== 'router' || m.device.id === device.id) return false
        if (m.iface.role !== 'routed' || !m.iface.enabled) return false
        const ownsInSubnet =
          inHostSubnet(m.iface.cidr) ||
          (m.iface.subInterfaces ?? []).some(
            (sub) => (segment.vlan === null || sub.vlanId === segment.vlan) && inHostSubnet(effectiveSubAddress(sub).cidr),
          )
        return !ownsInSubnet
      })
      if (routerMember) {
        const ownedSubnets = [
          ...routerMember.iface.subInterfaces ?? [],
        ]
          .map((sub) => {
            const { cidr } = effectiveSubAddress(sub)
            return cidr ? `${sub.name} (VLAN ${sub.vlanId}, ${cidr})` : `${sub.name} (VLAN ${sub.vlanId}, no address)`
          })
          .concat(routerMember.iface.cidr ? [`${routerMember.iface.name} (${routerMember.iface.cidr})`] : [])
        push({
          kind: 'missing-subinterface',
          severity: 'critical',
          deviceId: routerMember.device.id,
          interfaceId: routerMember.iface.id,
          title: `${routerMember.device.name} has no address for VLAN ${segment.vlan ?? '?'} on ${routerMember.iface.name}`,
          evidence: `${device.name} expects its gateway ${gwText} in ${addr.cidr}. ${routerMember.device.name} is connected to the same segment, but no interface or sub-interface of it owns an address in this VLAN. Present: ${ownedSubnets.length ? ownedSubnets.join(', ') : 'nothing'}.`,
          explanation: 'With router-on-a-stick, each VLAN needs a sub-interface on the trunk with an address in that VLAN\'s subnet. Missing, disabled, or mis-addressed sub-interfaces leave the VLAN without a gateway.',
          suggestedFix: `Create ${routerMember.iface.name}.${segment.vlan ?? '?'} on ${routerMember.device.name} for VLAN ${segment.vlan ?? '?'} with an address in ${addr.cidr ? `${formatIpv4(networkOf({ ip: addr.ip!, prefix: addr.prefix! }))}/${addr.prefix}` : 'the host subnet'} (e.g. ${gwText}).`,
          fix: {
            type: 'create-subinterface',
            deviceId: routerMember.device.id,
            interfaceId: routerMember.iface.id,
            vlanId: segment.vlan ?? 1,
            cidr: gwText !== '' && addr.prefix !== null ? `${gwText}/${addr.prefix}` : '',
            name: `${routerMember.iface.name}.${segment.vlan ?? 1}`,
          },
        })
        continue
      }
      // 3) Nobody can own it: plain wrong gateway.
      const ownerIps = members
        .filter((m) => m.device.id !== device.id)
        .flatMap((m) => [
          addrOf(m.iface, ctx).cidr,
          ...(m.iface.subInterfaces ?? []).map((sub) => effectiveSubAddress(sub).cidr),
        ])
        .filter(Boolean)
      push({
        kind: 'wrong-gateway',
        severity: 'critical',
        deviceId: device.id,
        title: `No device owns the gateway ${gwText} on ${device.name}'s segment`,
        evidence: `Gateway ${gwText} is inside ${addr.cidr}, but no neighbor answers for it. Active addresses on the segment: ${ownerIps.length ? ownerIps.join(', ') : 'none'}.`,
        explanation: 'ARP for the default gateway will fail, so every off-subnet destination is unreachable ("request timed out").',
        suggestedFix: 'Set the gateway to the router interface IP on this subnet.',
      })
      continue
    }
    if (gwOwner.device.kind !== 'router') {
      push({
        kind: 'wrong-gateway',
        severity: 'critical',
        deviceId: device.id,
        title: `Gateway ${gwText} belongs to ${gwOwner.device.name}, which cannot route`,
        evidence: `${gwOwner.device.name} is a ${gwOwner.device.kind}, not a router.`,
        explanation: 'Only routers forward packets between subnets in this simulation.',
        suggestedFix: 'Point the gateway at a router interface.',
      })
    }
  }
}

/**
 * Trunk-specific configuration checks (evidence-grade, config level):
 * native VLAN mismatches on trunk-to-trunk links, trunks that permit no VLANs,
 * and trunk pairs whose allowed lists share nothing.
 */
function detectTrunkIssues(ctx: DetectorCtx, push: (issue: Omit<DetectedIssue, 'id'>) => void) {
  for (const link of ctx.lab.links) {
    if (!link.enabled) continue
    const a = findInterface(ctx.lab, link.aDeviceId, link.aInterfaceId)
    const b = findInterface(ctx.lab, link.bDeviceId, link.bInterfaceId)
    if (!a || !b) continue
    if (a.device.kind !== 'switch' || b.device.kind !== 'switch') continue
    if (a.iface.role !== 'switchport' || b.iface.role !== 'switchport') continue
    const modeA = a.iface.portMode ?? 'access'
    const modeB = b.iface.portMode ?? 'access'
    if (modeA !== 'trunk' || modeB !== 'trunk') continue

    const nativeA = a.iface.nativeVlan ?? 1
    const nativeB = b.iface.nativeVlan ?? 1
    const allowedA = a.iface.allowedVlans ?? []
    const allowedB = b.iface.allowedVlans ?? []

    if (nativeA !== nativeB) {
      push({
        kind: 'trunk-native-mismatch',
        severity: 'warning',
        deviceId: a.device.id,
        interfaceId: a.iface.id,
        linkId: link.id,
        title: 'Native VLAN mismatch on a trunk link',
        evidence: `${a.device.name} ${a.iface.name} uses native VLAN ${nativeA}, while ${b.device.name} ${b.iface.name} uses native VLAN ${nativeB}.`,
        explanation: "Untagged frames on a trunk are classified into the port's native VLAN. With mismatched native VLANs, untagged traffic from one side lands in a different VLAN on the other — a classic hidden fault.",
        suggestedFix: 'Set the same native VLAN on both ends of the trunk.',
        fix: { type: 'set-vlan', deviceId: a.device.id, interfaceId: a.iface.id, value: nativeB },
      })
    }
    if (allowedA.length === 0 || allowedB.length === 0) {
      push({
        kind: 'config-warning',
        severity: 'warning',
        deviceId: a.device.id,
        interfaceId: a.iface.id,
        linkId: link.id,
        title: 'A trunk permits no VLANs',
        evidence: `Allowed VLANs: ${a.device.name} ${a.iface.name} [${allowedA.join(', ') || 'none'}] vs ${b.device.name} ${b.iface.name} [${allowedB.join(', ') || 'none'}].`,
        explanation: 'A trunk with an empty allowed list forwards no traffic at all.',
        suggestedFix: 'Add the required VLANs to both ends of the trunk.',
      })
      continue
    }
    const common = allowedA.filter((v) => allowedB.includes(v))
    if (common.length === 0) {
      push({
        kind: 'config-warning',
        severity: 'warning',
        deviceId: a.device.id,
        interfaceId: a.iface.id,
        linkId: link.id,
        title: 'Trunk ends share no permitted VLAN',
        evidence: `${a.device.name} ${a.iface.name} allows [${allowedA.join(', ')}]; ${b.device.name} ${b.iface.name} allows [${allowedB.join(', ')}].`,
        explanation: 'Frames can only cross the trunk for VLANs permitted on BOTH ends — with no overlap, nothing passes.',
        suggestedFix: 'Align the allowed VLAN lists on both ends.',
      })
    }
  }
}

function detectVlanIssues(ctx: DetectorCtx, push: (issue: Omit<DetectedIssue, 'id'>) => void) {
  for (const device of ctx.lab.devices) {
    if (device.kind !== 'switch') continue
    const ports = device.interfaces.filter(
      (i) => i.role === 'switchport' && i.enabled,
    )
    for (let i = 0; i < ports.length; i++) {
      for (let j = i + 1; j < ports.length; j++) {
        const p1 = ports[i]
        const p2 = ports[j]
        if (p1.accessVlan === p2.accessVlan) continue
        const e1 = peerEndpoint(ctx.lab, device.id, p1.id)
        const e2 = peerEndpoint(ctx.lab, device.id, p2.id)
        if (!e1 || !e2) continue
        const a1 = addrOf(e1.iface, ctx)
        const a2 = addrOf(e2.iface, ctx)
        if (a1.ip === null || a2.ip === null) continue
        const sameSubnet =
          (a1.prefix !== null && isSameSubnet(a1.ip, a2.ip, a1.prefix)) ||
          (a2.prefix !== null && isSameSubnet(a2.ip, a1.ip, a2.prefix))
        if (!sameSubnet) continue
        for (const [portA, portB] of [
          [p1, p2],
          [p2, p1],
        ] as const) {
          push({
            kind: 'vlan-mismatch',
            severity: 'critical',
            deviceId: device.id,
            interfaceId: portA.id,
            title: `VLAN isolation splits the subnet between ${e1.device.name} and ${e2.device.name}`,
            evidence: `${e1.device.name} (${a1.cidr}) and ${e2.device.name} (${a2.cidr}) share a subnet, but ${device.name} ports ${p1.name} and ${p2.name} are in different VLANs (${p1.accessVlan} vs ${p2.accessVlan}).`,
            explanation: 'Layer 2 forwarding between the two ports is blocked by VLAN isolation, so the hosts cannot ARP each other even though their IP settings look consistent.',
            suggestedFix: `Put ${p1.name} and ${p2.name} into the same access VLAN.`,
            fix: { type: 'set-vlan', deviceId: device.id, interfaceId: portA.id, value: portB.accessVlan },
          })
        }
      }
    }
    // Directly linked switch-to-switch ports with different VLANs.
    for (const port of ports) {
      const peer = peerEndpoint(ctx.lab, device.id, port.id)
      if (!peer || peer.device.kind !== 'switch') continue
      if (peer.iface.role !== 'switchport') continue
      if (peer.iface.accessVlan === port.accessVlan) continue
      push({
        kind: 'vlan-mismatch',
        severity: 'critical',
        deviceId: device.id,
        interfaceId: port.id,
        title: `Switch-to-switch link has mismatched VLANs`,
        evidence: `${device.name} ${port.name} (VLAN ${port.accessVlan}) is cabled to ${peer.device.name} ${peer.iface.name} (VLAN ${peer.iface.accessVlan}).`,
        explanation: 'The uplink bridges two different VLANs, so traffic from one side never appears on the other.',
        suggestedFix: 'Align the access VLAN on both ends of the uplink.',
        fix: { type: 'set-vlan', deviceId: device.id, interfaceId: port.id, value: peer.iface.accessVlan },
      })
    }
  }
}

function peerEndpoint(lab: Lab, deviceId: string, interfaceId: string): { device: Device; iface: NetInterface } | null {
  for (const link of lab.links) {
    if (link.aDeviceId === deviceId && link.aInterfaceId === interfaceId) {
      const found = findInterface(lab, link.bDeviceId, link.bInterfaceId)
      if (found) return { device: found.device, iface: found.iface }
    }
    if (link.bDeviceId === deviceId && link.bInterfaceId === interfaceId) {
      const found = findInterface(lab, link.aDeviceId, link.aInterfaceId)
      if (found) return { device: found.device, iface: found.iface }
    }
  }
  return null
}

function detectInterfaceAndLinkIssues(ctx: DetectorCtx, push: (issue: Omit<DetectedIssue, 'id'>) => void) {
  for (const device of ctx.lab.devices) {
    for (const iface of device.interfaces) {
      if (iface.enabled) continue
      const hasLink = ctx.lab.links.some(
        (l) =>
          (l.aDeviceId === device.id && l.aInterfaceId === iface.id) ||
          (l.bDeviceId === device.id && l.bInterfaceId === iface.id),
      )
      if (!hasLink) continue
      push({
        kind: 'interface-down',
        severity: 'critical',
        deviceId: device.id,
        interfaceId: iface.id,
        title: `${device.name} ${iface.name} is administratively down`,
        evidence: `${iface.name} on ${device.name} is shut down (enabled = false) while a cable is attached.`,
        explanation: 'A shut interface neither sends nor receives frames; traffic through it fails.',
        suggestedFix: `Enable ${iface.name} on ${device.name}.`,
        fix: { type: 'enable-interface', deviceId: device.id, interfaceId: iface.id },
      })
    }
  }
  for (const link of ctx.lab.links) {
    if (link.enabled) continue
    const a = findInterface(ctx.lab, link.aDeviceId, link.aInterfaceId)
    const b = findInterface(ctx.lab, link.bDeviceId, link.bInterfaceId)
    push({
      kind: 'link-down',
      severity: 'critical',
      deviceId: a?.device.id ?? link.aDeviceId,
      linkId: link.id,
      title: `Link between ${a?.device.name ?? '?'} and ${b?.device.name ?? '?'} is down`,
      evidence: `The simulated cable between ${a?.device.name ?? '?'} ${a?.iface.name ?? '?'} and ${b?.device.name ?? '?'} ${b?.iface.name ?? '?'} is administratively disabled.`,
      explanation: 'No frames cross a down link; both sides appear isolated.',
      suggestedFix: 'Re-enable the link.',
      fix: { type: 'enable-link', linkId: link.id },
    })
  }
}

function detectDuplicateIpIssues(ctx: DetectorCtx, push: (issue: Omit<DetectedIssue, 'id'>) => void) {
  // Address holders include VLAN sub-interfaces — a sub-interface IP collides
  // exactly like a physical one.
  const holders: Array<{ device: Device; iface: NetInterface; sub: import('./types').SubInterface | null; label: string; ipText: string }> = []
  const devices = [...ctx.lab.devices].sort((a, b) => a.name.localeCompare(b.name))
  for (const device of devices) {
    for (const iface of device.interfaces) {
      if (!iface.enabled) continue
      const a = addrOf(iface, ctx)
      if (a.ip !== null && a.cidr) {
        holders.push({ device, iface, sub: null, label: `${device.name} ${iface.name}`, ipText: formatIpv4(a.ip) })
      }
      for (const sub of iface.subInterfaces ?? []) {
        const subCidr = effectiveSubAddress(sub).cidr
        const parsed = subCidr ? parseCidr(subCidr) : null
        if (parsed) {
          holders.push({ device, iface, sub, label: `${device.name} ${sub.name}`, ipText: formatIpv4(parsed.ip) })
        }
      }
    }
  }
  const seen = new Map<string, (typeof holders)[number]>()
  for (const holder of holders) {
    const first = seen.get(holder.ipText)
    if (first && !(first.device.kind === 'switch' && holder.device.kind === 'switch')) {
      push({
        kind: 'duplicate-ip',
        severity: 'critical',
        deviceId: holder.device.id,
        interfaceId: holder.iface.id,
        subInterfaceId: holder.sub?.id,
        title: `Duplicate IP ${holder.ipText}`,
        evidence: `${holder.label} and ${first.label} both use ${holder.ipText}.`,
        explanation: 'With a duplicate address, ARP replies conflict and traffic to that IP lands on the wrong device or nowhere at all.',
        suggestedFix: `Give ${holder.label} a unique address in its subnet.`,
      })
    } else if (!first) {
      seen.set(holder.ipText, holder)
    }
  }
}


function directionLabel(direction: 'in' | 'out'): string {
  return direction === 'in' ? 'inbound' : 'outbound'
}

/** All addresses that currently belong to devices offering DHCP pools (for safe relay fixes). */
function collectPoolServerIps(ctx: DetectorCtx): string[] {
  const ips: string[] = []
  for (const device of ctx.lab.devices) {
    if (device.dhcpPools.length === 0) continue
    const serving = device.interfaces.find((i) => i.enabled && i.cidr)
    if (serving?.cidr) ips.push(serving.cidr.split('/')[0])
  }
  return ips.sort()
}

function detectDhcpIssues(ctx: DetectorCtx, push: (issue: Omit<DetectedIssue, 'id'>) => void) {
  for (const { device, iface } of clientInterfaces(ctx.lab)) {
    const failure = ctx.dhcp.failures.get(iface.id)
    if (!failure) continue
    if (failure.reason === 'pool-exhausted' && failure.poolId && failure.poolDeviceId) {
      push({
        kind: 'dhcp-exhausted',
        severity: 'critical',
        deviceId: failure.poolDeviceId,
        poolId: failure.poolId,
        title: `DHCP pool is exhausted`,
        evidence: `${device.name} ${iface.name} could not get a lease: ${failure.detail}`,
        explanation: 'The DHCP scope has no free addresses left, so clients fall back to no address at all and cannot communicate.',
        suggestedFix: 'Enlarge the pool range or free up addresses.',
        fix: { type: 'dhcp-reconfigure' },
      })
    } else if (failure.reason === 'no-server') {
      // Relay-aware classification: when a router address exists on the
      // client's segment but has no helper configured, that is a specific,
      // fixable fault — not a generic "no server".
      const unrelayed = ctx.dhcp.unrelayed.get(iface.id)
      if (unrelayed) {
        const serverIps = collectPoolServerIps(ctx)
        const uniqueServerIp = serverIps.length === 1 ? serverIps[0] : null
        push({
          kind: 'missing-dhcp-relay',
          severity: 'critical',
          deviceId: unrelayed.routerDeviceId,
          interfaceId: unrelayed.interfaceId,
          subInterfaceId: unrelayed.subInterfaceId ?? undefined,
          title: `DHCP relay missing on ${unrelayed.routerLabel}`,
          evidence: failure.detail,
          explanation: 'The client sits in a subnet without its own DHCP server. A router interface with an address in the client\'s subnet must forward the request (ip helper-address) — without it, the request never leaves the segment.',
          suggestedFix: uniqueServerIp
            ? `Configure a DHCP relay on ${unrelayed.routerLabel} pointing at ${uniqueServerIp}.`
            : `Configure a DHCP relay (ip helper-address) on ${unrelayed.routerLabel} pointing at the DHCP server.`,
          fix: uniqueServerIp
            ? { type: 'set-relay', deviceId: unrelayed.routerDeviceId, interfaceId: unrelayed.interfaceId, subInterfaceId: unrelayed.subInterfaceId ?? undefined, value: uniqueServerIp }
            : undefined,
        })
      } else {
        push({
          kind: 'config-warning',
          severity: 'critical',
          deviceId: device.id,
          interfaceId: iface.id,
          title: `${device.name} ${iface.name} has no reachable DHCP server`,
          evidence: failure.detail,
          explanation: 'The interface is set to DHCP but no server shares its segment, so it stays without an address.',
          suggestedFix: 'Add a DHCP server on the segment, configure a DHCP relay on the router, or use a static address.',
        })
      }
    } else if (failure.reason === 'relay-target-unresolved') {
      const serverIps = collectPoolServerIps(ctx)
      const uniqueServerIp = serverIps.length === 1 ? serverIps[0] : null
      push({
        kind: 'wrong-relay-target',
        severity: 'critical',
        deviceId: failure.relayDeviceId ?? device.id,
        interfaceId: failure.relayInterfaceId,
        subInterfaceId: failure.relaySubInterfaceId,
        title: `DHCP relay target is invalid`,
        evidence: failure.detail,
        explanation: 'The relay forwards the request to a unicast address; if nothing owns it (or the owner offers no DHCP pools), the request dies at the relay.',
        suggestedFix: uniqueServerIp
          ? `Point the relay at ${uniqueServerIp}.`
          : 'Point the relay at the DHCP server\'s address.',
        fix: uniqueServerIp && failure.relayDeviceId && failure.relayInterfaceId
          ? { type: 'set-relay', deviceId: failure.relayDeviceId, interfaceId: failure.relayInterfaceId, subInterfaceId: failure.relaySubInterfaceId, value: uniqueServerIp }
          : undefined,
      })
    } else if (failure.reason === 'server-unreachable') {
      push({
        kind: 'unreachable-server',
        severity: 'critical',
        deviceId: failure.relayDeviceId ?? device.id,
        interfaceId: failure.relayInterfaceId,
        subInterfaceId: failure.relaySubInterfaceId,
        title: 'DHCP server unreachable from the relay agent',
        evidence: failure.detail,
        explanation: 'The relay is configured, but the router cannot route to the server address. Check links, interface state and routing between them.',
        suggestedFix: 'Repair the routing path between the relay agent and the DHCP server.',
      })
    } else if (failure.reason === 'no-matching-pool') {
      const scopeFix =
        failure.serverDeviceId && failure.giaddr && failure.giaddrPrefix !== undefined
          ? (() => {
              const netIp = parseIpv4(failure.giaddr)
              if (netIp === null) return undefined
              const network = networkOf({ ip: netIp, prefix: failure.giaddrPrefix })
              const pool = {
                name: 'RELAY-SCOPE',
                networkCidr: `${formatIpv4(network)}/${failure.giaddrPrefix}`,
                rangeStart: firstHostText(failure.giaddrPrefix, network),
                rangeEnd: lastHostText(failure.giaddrPrefix, network),
                gatewayIp: failure.giaddr,
              }
              return { type: 'create-dhcp-pool', deviceId: failure.serverDeviceId, pool } as const
            })()
          : undefined
      push({
        kind: 'missing-dhcp-scope',
        severity: 'critical',
        deviceId: failure.serverDeviceId ?? device.id,
        title: 'No DHCP scope matches the relayed subnet',
        evidence: failure.detail,
        explanation: 'A relayed request carries the relay agent\'s address (giaddr); the server only answers from a scope whose network matches it. A scope for another subnet is never used.',
        suggestedFix: failure.giaddr
          ? `Add a DHCP scope for ${failure.giaddr}/${failure.giaddrPrefix} on the server.`
          : 'Add a DHCP scope for the relayed subnet.',
        fix: scopeFix,
      })
    } else if (failure.reason === 'interface-down') {
      // Already reported by the interface-down detector.
    } else {
      push({
        kind: 'config-warning',
        severity: 'warning',
        deviceId: device.id,
        interfaceId: iface.id,
        title: `${device.name} ${iface.name}: DHCP failed`,
        evidence: failure.detail,
        explanation: 'The interface depends on DHCP but could not obtain a lease.',
        suggestedFix: 'Check the DHCP server configuration and reachability.',
      })
    }
  }
  // Pools that served a lease but hand out an unusable gateway.
  for (const device of ctx.lab.devices) {
    for (const pool of device.dhcpPools) {
      const usage = ctx.dhcp.poolUsage.get(pool.id)
      if (!usage || usage.used === 0) continue
      if (poolGatewayValid(pool.networkCidr, pool.gatewayIp ?? '')) continue
      const relayGiaddr = [...ctx.dhcp.relays.entries()].find(([, r]) => r.poolId === pool.id)?.[1].giaddr
      const safeGateway = relayGiaddr ?? null
      push({
        kind: 'config-warning',
        severity: 'warning',
        deviceId: device.id,
        poolId: pool.id,
        title: `DHCP pool "${pool.name}" hands out an invalid gateway`,
        evidence: `Pool ${pool.networkCidr} leases addresses but its gateway ${pool.gatewayIp || '(empty)'} is not a usable host address in that subnet. Clients received leases but cannot leave their subnet.`,
        explanation: 'The pool gateway must be a router address inside the pool network. Clients keep their address but lose all off-subnet connectivity.',
        suggestedFix: safeGateway
          ? `Set the pool gateway to ${safeGateway} (the relay agent's address in that subnet).`
          : `Set the pool gateway to a router address inside ${pool.networkCidr}.`,
        fix: safeGateway ? { type: 'set-pool-gateway', deviceId: device.id, poolId: pool.id, value: safeGateway } : undefined,
      })
    }
  }
  // Pool sanity checks.
  for (const device of ctx.lab.devices) {
    for (const pool of device.dhcpPools) {
      const start = parseIpv4(pool.rangeStart)
      const end = parseIpv4(pool.rangeEnd)
      if (start === null || end === null || end < start) {
        push({
          kind: 'dhcp-exhausted',
          severity: 'critical',
          deviceId: device.id,
          poolId: pool.id,
          title: `DHCP pool "${pool.name}" has an empty range`,
          evidence: `Range ${pool.rangeStart} - ${pool.rangeEnd} contains no assignable addresses.`,
          explanation: 'Clients on this pool cannot obtain leases.',
          suggestedFix: 'Widen the pool range.',
          fix: { type: 'dhcp-reconfigure' },
        })
        continue
      }
      const servingIface = device.interfaces.find((i) => i.enabled && i.cidr)
      if (servingIface) {
        const a = addrOf(servingIface, ctx)
        const net = parseCidr(pool.networkCidr)
        if (a.ip !== null && net && networkOf({ ip: a.ip, prefix: net.prefix }) !== networkOf(net)) {
          push({
            kind: 'config-warning',
            severity: 'warning',
            deviceId: device.id,
            poolId: pool.id,
            title: `DHCP pool "${pool.name}" network does not match the server interface`,
            evidence: `Pool serves ${pool.networkCidr} but ${device.name}'s interface ${servingIface.name} uses ${a.cidr}.`,
            explanation: 'Clients behind the server interface are unlikely to match this pool.',
            suggestedFix: 'Align the pool network with the server interface subnet.',
          })
        }
      }
    }
  }
}

function detectMissingIpIssues(ctx: DetectorCtx, push: (issue: Omit<DetectedIssue, 'id'>) => void) {
  for (const device of ctx.lab.devices) {
    if (device.kind === 'switch') continue
    for (const iface of device.interfaces) {
      if (!iface.enabled || iface.ipMode !== 'static') continue
      if (iface.role === 'switchport') continue
      const a = addrOf(iface, ctx)
      if (a.ip === null) {
        push({
          kind: 'missing-ip',
          severity: 'warning',
          deviceId: device.id,
          interfaceId: iface.id,
          title: `${device.name} ${iface.name} has no IP address`,
          evidence: `${iface.name} is enabled with static addressing but no address is configured.`,
          explanation: 'Without an address the interface cannot send or receive IP traffic.',
          suggestedFix: 'Configure an address in the subnet of the attached segment.',
        })
      }
    }
  }
}

/** Infer a sensible next hop when a router is missing a route to a network. */
function inferRestoredRoute(
  ctx: DetectorCtx,
  routerId: string,
  destNetwork: number,
): { nextHopIp: string; viaRouter: string } | null {
  const router = findDevice(ctx.lab, routerId)
  if (!router) return null
  for (const candidate of ctx.lab.devices) {
    if (candidate.kind !== 'router' || candidate.id === routerId) continue
    // Does the candidate reach the destination network?
    const candTable = buildRoutingTable(candidate, ctx.dhcp)
    if (!lookupRoute(candTable, destNetwork)) continue
    // Shared subnet with the router that lacks the route?
    for (const candIface of candidate.interfaces) {
      const candAddr = addrOf(candIface, ctx)
      if (candAddr.ip === null || candAddr.prefix === null) continue
      for (const routerIface of router.interfaces) {
        const rAddr = addrOf(routerIface, ctx)
        if (rAddr.ip === null || rAddr.prefix === null) continue
        if (rAddr.prefix === candAddr.prefix && isSameSubnet(rAddr.ip, candAddr.ip, rAddr.prefix)) {
          return { nextHopIp: formatIpv4(candAddr.ip), viaRouter: candidate.name }
        }
      }
    }
  }
  return null
}

/**
 * Run the simulated connectivity suite: every pair of end hosts (PC/server)
 * in both directions. Hosts without an address (e.g. failed DHCP) are still
 * probed so their failure is visible; targets without an address are skipped.
 */
export function runConnectivitySuite(
  lab: Lab,
  dhcp: ReturnType<typeof resolveDhcp> = resolveDhcp(lab),
): Array<{
  sourceDevice: Device
  targetDevice: Device
  result: PingResult
}> {
  const hosts = lab.devices
    .filter((d) => d.kind === 'pc' || d.kind === 'server')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => {
      const addr = d.interfaces.map((i) => effectiveAddress(i, dhcp)).find((a) => a.cidr)?.cidr ?? null
      const dhcpFailed = d.interfaces.some((i) => dhcp.failures.has(i.id))
      return { device: d, addr, probeable: addr !== null || dhcpFailed }
    })
  const results: Array<{ sourceDevice: Device; targetDevice: Device; result: PingResult }> = []
  for (let i = 0; i < hosts.length; i++) {
    for (let j = 0; j < hosts.length; j++) {
      if (i === j) continue
      const target = hosts[j]
      if (!target.addr) continue // nothing to ping
      const targetIp = target.addr.split('/')[0]
      const result = simulatePing(lab, hosts[i].device.id, targetIp, dhcp)
      results.push({ sourceDevice: hosts[i].device, targetDevice: target.device, result })
    }
  }
  return results
}

function detectRoutingIssues(
  ctx: DetectorCtx,
  push: (issue: Omit<DetectedIssue, 'id'>) => void,
): Array<{ sourceDevice: Device; targetDevice: Device; result: PingResult }> {
  const suite = runConnectivitySuite(ctx.lab, ctx.dhcp)
  for (const { sourceDevice, targetDevice, result } of suite) {
    if (result.success) continue
    if (result.failCode === 'no-route') {
      const routerId = result.pathDeviceIds[result.pathDeviceIds.length - 1]
      const router = routerId ? findDevice(ctx.lab, routerId) : undefined
      if (!router || router.kind !== 'router') continue
      // Target network of the destination device.
      const targetIface = targetDevice.interfaces.find((i) => effectiveAddress(i, ctx.dhcp).cidr)
      if (!targetIface) continue
      const targetAddr = addrOf(targetIface, ctx)
      if (targetAddr.ip === null || targetAddr.prefix === null) continue
      const destNetwork = networkOf({ ip: targetAddr.ip, prefix: targetAddr.prefix })
      const destCidr = `${formatIpv4(destNetwork)}/${targetAddr.prefix}`
      const inferred = inferRestoredRoute(ctx, router.id, destNetwork)
      push({
        kind: 'remove-route',
        severity: 'critical',
        deviceId: router.id,
        routeId: undefined,
        title: `${router.name} has no route to ${destCidr}`,
        evidence: `Ping ${sourceDevice.name} → ${targetDevice.name} (${result.targetIp}) fails: ${result.explanation}`,
        explanation: `Traffic from ${sourceDevice.name}'s network reaches ${router.name}, but the router cannot forward toward ${destCidr} (${targetDevice.name}'s network). A static route is missing.`,
        suggestedFix: inferred
          ? `Add a static route on ${router.name}: ${destCidr} via ${inferred.nextHopIp} (${inferred.viaRouter}).`
          : `Add a static route on ${router.name} for ${destCidr}.`,
        fix: inferred
          ? { type: 'restore-route', deviceId: router.id, route: { destinationCidr: destCidr, nextHopIp: inferred.nextHopIp } }
          : undefined,
      })
    }
  }
  return suite
}

/**
 * Detect issues in a lab (fault overlays included).
 * Returns the detected issues plus the connectivity suite evidence.
 */
export function detectIssues(lab: Lab): {
  issues: DetectedIssue[]
  suite: Array<{ sourceDevice: Device; targetDevice: Device; result: PingResult }>
  appliedFaults: string[]
} {
  const { lab: effective, applied } = applyFaults(lab)
  const ctx: DetectorCtx = { lab: effective, dhcp: resolveDhcp(effective) }
  const raw: Array<Omit<DetectedIssue, 'id'>> = []
  const push = (issue: Omit<DetectedIssue, 'id'>) => raw.push(issue)

  detectInterfaceAndLinkIssues(ctx, push)
  detectDuplicateIpIssues(ctx, push)
  detectGatewayIssues(ctx, push)
  detectVlanIssues(ctx, push)
  detectTrunkIssues(ctx, push)
  detectDhcpIssues(ctx, push)
  detectMissingIpIssues(ctx, push)

  // Segment analysis for every addressed endpoint interface.
  const visitedSegments = new Set<string>()
  for (const device of ctx.lab.devices) {
    if (device.kind === 'switch') continue
    for (const iface of device.interfaces) {
      if (!iface.enabled) continue
      const a = addrOf(iface, ctx)
      if (a.ip === null) continue
      const segKey = [...getL2Segment(ctx.lab, device.id, iface.id).members]
        .map((m) => `${m.deviceId}/${m.interfaceId}`)
        .sort()
        .join('|')
      if (visitedSegments.has(segKey)) continue
      visitedSegments.add(segKey)
      detectSegmentIssues(ctx, device.id, iface.id, push)
    }
  }

  // Ping-suite based detection (missing routes) + evidence.
  const suite = detectRoutingIssues(ctx, push)

  // ACL decisions are observable in the suite: a deny rule that blocked a
  // probe becomes an anchored, fixable issue (first deny wins).
  const seenAclBlocks = new Set<string>()
  for (const { result } of suite) {
    if (result.failCode !== 'acl-denied' || !result.aclHit) continue
    const hit = result.aclHit
    if (hit.action !== 'deny') continue
    const key = `${hit.deviceId}:${hit.interfaceId}:${hit.subInterfaceId ?? ''}:${hit.aclId}:${hit.ruleId}`
    if (seenAclBlocks.has(key)) continue
    seenAclBlocks.add(key)
    const ruleText = `${hit.action} ${hit.protocol} ${hit.source} → ${hit.destination}${hit.destPort != null ? ` port ${hit.destPort}` : ''}`
    push({
      kind: 'acl-blocks-traffic',
      severity: 'critical',
      deviceId: hit.deviceId,
      interfaceId: hit.interfaceId,
      subInterfaceId: hit.subInterfaceId,
      title: `ACL "${hit.aclName}" blocks traffic on ${hit.deviceName} ${hit.subInterfaceName ?? hit.interfaceName}`,
      evidence: `${result.explanation} (observed on a simulated probe to ${result.targetIp}.)`,
      explanation: `The deny rule "${ruleText}" is rule ${hit.ruleIndex + 1} in "${hit.aclName}" (${directionLabel(hit.direction)} on ${hit.subInterfaceName ?? hit.interfaceName}). ACLs evaluate top-down and the first match decides; everything unmatched is permitted.`,
      suggestedFix: `Remove or adjust rule ${hit.ruleIndex + 1} ("${ruleText}") in ACL "${hit.aclName}" on ${hit.subInterfaceName ?? hit.interfaceName}, or place a more specific permit above it.`,
      fix: { type: 'remove-acl-rule', deviceId: hit.deviceId, interfaceId: hit.interfaceId, subInterfaceId: hit.subInterfaceId, aclId: hit.aclId, ruleId: hit.ruleId },
    })
  }

  // Catch-all: connectivity failures not explained by any config issue above.
  const coveredDevices = new Set(raw.map((i) => i.deviceId))
  const seenEvidence = new Set<string>()
  for (const { sourceDevice, targetDevice, result } of suite) {
    if (result.success || !result.failCode) continue
    if (result.failCode === 'no-route') continue // handled above
    if (result.failCode === 'acl-denied') continue // handled above
    const covered =
      coveredDevices.has(sourceDevice.id) ||
      coveredDevices.has(targetDevice.id) ||
      result.pathDeviceIds.some((id) => coveredDevices.has(id))
    if (covered) continue
    const evidenceKey = `${sourceDevice.id}->${result.targetIp}:${result.failCode}`
    if (seenEvidence.has(evidenceKey)) continue
    seenEvidence.add(evidenceKey)
    push({
      kind: 'config-warning',
      severity: 'critical',
      deviceId: sourceDevice.id,
      title: `Connectivity test failed: ${sourceDevice.name} → ${result.targetIp}`,
      evidence: result.explanation,
      explanation: 'No configuration inconsistency was pinpointed automatically; investigate the path manually.',
      suggestedFix: result.suggestion ?? 'Inspect interfaces, VLANs and addresses along the path.',
    })
  }

  // Deduplicate identical issues (same kind + device + anchor).
  const seen = new Set<string>()
  const issues: DetectedIssue[] = []
  raw.forEach((issue, index) => {
    const key = `${issue.kind}:${issue.deviceId}:${issue.interfaceId ?? ''}:${issue.linkId ?? ''}:${issue.poolId ?? ''}:${issue.title}`
    if (seen.has(key)) return
    seen.add(key)
    issues.push({ ...issue, id: `iss-${index}-${issue.kind}` })
  })
  const severityOrder = { critical: 0, warning: 1, info: 2 } as const
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
  return { issues, suite, appliedFaults: applied }
}

/**
 * Correlate an injected fault with a detected issue (used for scoring):
 * same kind and anchored on the same device/interface.
 */
export function faultMatchesIssue(fault: Fault, issue: DetectedIssue): boolean {
  if (fault.kind !== issue.kind) return false
  if (issue.deviceId !== fault.deviceId) return false
  if (fault.kind === 'link-down') return issue.linkId === fault.linkId
  if (fault.kind === 'dhcp-exhausted') return issue.poolId === fault.poolId
  if (fault.interfaceId && issue.interfaceId && fault.interfaceId !== issue.interfaceId) return false
  if (fault.subInterfaceId && issue.subInterfaceId && fault.subInterfaceId !== issue.subInterfaceId) return false
  return true
}

/** Apply a machine fix produced by detection to a lab (returns a new lab). */
export function applyFixToLab(lab: Lab, fix: FixAction): Lab {
  const next = structuredClone(lab) as Lab
  switch (fix.type) {
    case 'set-cidr': {
      const dev = next.devices.find((d) => d.id === fix.deviceId)
      const iface = dev?.interfaces.find((i) => i.id === fix.interfaceId)
      if (iface) iface.cidr = fix.value
      break
    }
    case 'set-gateway': {
      const dev = next.devices.find((d) => d.id === fix.deviceId)
      if (dev) dev.gatewayIp = fix.value
      break
    }
    case 'enable-interface': {
      const dev = next.devices.find((d) => d.id === fix.deviceId)
      const iface = dev?.interfaces.find((i) => i.id === fix.interfaceId)
      if (iface) iface.enabled = true
      break
    }
    case 'enable-link': {
      const link = next.links.find((l) => l.id === fix.linkId)
      if (link) link.enabled = true
      break
    }
    case 'set-vlan': {
      const dev = next.devices.find((d) => d.id === fix.deviceId)
      const iface = dev?.interfaces.find((i) => i.id === fix.interfaceId)
      if (iface) iface.accessVlan = fix.value
      break
    }
    case 'restore-route': {
      const dev = next.devices.find((d) => d.id === fix.deviceId)
      if (dev && !dev.staticRoutes.some((r) => r.destinationCidr === fix.route.destinationCidr && r.nextHopIp === fix.route.nextHopIp)) {
        dev.staticRoutes.push({ id: `route-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`, ...fix.route })
      }
      break
    }
    case 'dhcp-reconfigure':
      // Advisory fix: cannot be applied safely without policy; user edits pool.
      break
    case 'allow-vlan': {
      const dev = next.devices.find((d) => d.id === fix.deviceId)
      const iface = dev?.interfaces.find((i) => i.id === fix.interfaceId)
      if (iface) iface.allowedVlans = [...new Set([...(iface.allowedVlans ?? []), fix.value])]
      break
    }
    case 'create-subinterface': {
      const dev = next.devices.find((d) => d.id === fix.deviceId)
      const iface = dev?.interfaces.find((i) => i.id === fix.interfaceId)
      if (!iface) break
      const exists = (iface.subInterfaces ?? []).some((sub) => sub.vlanId === fix.vlanId)
      if (!exists) {
        iface.subInterfaces = [
          ...(iface.subInterfaces ?? []),
          {
            id: `sub-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
            name: fix.name,
            vlanId: fix.vlanId,
            cidr: fix.cidr,
            enabled: true,
          },
        ]
      }
      break
    }
    case 'set-relay': {
      const dev = next.devices.find((d) => d.id === fix.deviceId)
      const iface = dev?.interfaces.find((i) => i.id === fix.interfaceId)
      if (!iface) break
      if (fix.subInterfaceId) {
        const sub = (iface.subInterfaces ?? []).find((sub) => sub.id === fix.subInterfaceId)
        if (sub) sub.dhcpRelay = fix.value
      } else {
        iface.dhcpRelay = fix.value
      }
      break
    }
    case 'create-dhcp-pool': {
      const dev = next.devices.find((d) => d.id === fix.deviceId)
      if (!dev) break
      const exists = dev.dhcpPools.some((p) => p.networkCidr === fix.pool.networkCidr)
      if (!exists) {
        dev.dhcpPools = [
          ...dev.dhcpPools,
          {
            id: `pool-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
            name: fix.pool.name,
            networkCidr: fix.pool.networkCidr,
            rangeStart: fix.pool.rangeStart,
            rangeEnd: fix.pool.rangeEnd,
            gatewayIp: fix.pool.gatewayIp,
            ...(fix.pool.dnsIp ? { dnsIp: fix.pool.dnsIp } : {}),
          },
        ]
      }
      break
    }
    case 'set-pool-gateway': {
      const dev = next.devices.find((d) => d.id === fix.deviceId)
      const pool = dev?.dhcpPools.find((p) => p.id === fix.poolId)
      if (pool) pool.gatewayIp = fix.value
      break
    }
    case 'remove-acl-rule': {
      const dev = next.devices.find((d) => d.id === fix.deviceId)
      const iface = dev?.interfaces.find((i) => i.id === fix.interfaceId)
      if (!iface) break
      const container = fix.subInterfaceId
        ? (iface.subInterfaces ?? []).find((sub) => sub.id === fix.subInterfaceId)
        : iface
      if (!container) break
      container.acls = (container.acls ?? []).map((acl) =>
        acl.id === fix.aclId ? { ...acl, rules: acl.rules.filter((rule) => rule.id !== fix.ruleId) } : acl,
      )
      break
    }
  }
  return next
}

/**
 * Iteratively apply detection fixes until the lab is clean: apply ONE fix,
 * re-run detection, repeat. Applying all fixes of a single report at once can
 * contradict itself (e.g. mirrored VLAN fixes on both ends of a pair), so a
 * converge-and-recheck loop is the safe strategy. Advisory-only fixes
 * (dhcp-reconfigure) are skipped since they cannot change state.
 */
export function applyAllFixes(lab: Lab, maxIterations = 10): { lab: Lab; applied: FixAction[] } {
  let current = lab
  const applied: FixAction[] = []
  let lastSnapshot = JSON.stringify(current)
  for (let i = 0; i < maxIterations; i++) {
    const { issues } = detectIssues(current)
    const fixable = issues.find((issue) => issue.fix && issue.fix.type !== 'dhcp-reconfigure')
    if (!fixable?.fix) break
    current = applyFixToLab(current, fixable.fix)
    applied.push(fixable.fix)
    const snapshot = JSON.stringify(current)
    if (snapshot === lastSnapshot) break // the fix had no effect; stop early
    lastSnapshot = snapshot
  }
  return { lab: current, applied }
}
