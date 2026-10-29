// Configuration validation shared by the NetLab inspector and NetDoctor.
// Runs against the EFFECTIVE lab (post-fault) so faults are flagged like
// ordinary misconfigurations.

import {
  parseCidr,
  parseIpv4,
  networkOf,
  broadcastOf,
  isSameSubnet,
  validateHostCidrText,
  validateIpv4Text,
  formatIpv4,
} from './ip'
import { resolveDhcp, effectiveAddress, effectiveSubAddress, effectiveGateway } from './dhcp'
import { findInterface, getL2Segment, segmentInterfaces, linksOfInterface, interfaceIsLinked } from './topology'
import type { AclEntry, Device, Lab, NetInterface } from './types'

const ACL_PROTOCOLS = ['icmp', 'tcp', 'udp']

function aclTargetIsValid(target: string): boolean {
  const text = target.trim()
  if (text === '' || text === 'any') return true
  return parseCidr(text) !== null || parseIpv4(text) !== null
}

/** Validate one ACL container (physical interface or sub-interface). */
function validateAclContainer(device: Device, label: string, interfaceId: string, acls: AclEntry[] | undefined, issues: ValidationIssue[]) {
  const seenDirections = new Set<string>()
  for (const acl of acls ?? []) {
    if (acl.direction !== 'in' && acl.direction !== 'out') {
      issues.push({ deviceId: device.id, interfaceId, severity: 'error', message: `${device.name} ${label}: ACL "${acl.name}" has an invalid direction "${String(acl.direction)}" (expected "in" or "out")` })
      continue
    }
    if (seenDirections.has(acl.direction)) {
      issues.push({ deviceId: device.id, interfaceId, severity: 'error', message: `${device.name} ${label}: more than one ACL is attached for direction "${acl.direction}" — only the first is evaluated` })
    }
    seenDirections.add(acl.direction)
    if (acl.rules.length === 0) {
      issues.push({ deviceId: device.id, interfaceId, severity: 'info', message: `${device.name} ${label}: ACL "${acl.name}" has no rules and permits everything (implicit permit)` })
    }
    const ruleIds = new Set<string>()
    for (const rule of acl.rules) {
      if (ruleIds.has(rule.id)) {
        issues.push({ deviceId: device.id, interfaceId, severity: 'error', message: `${device.name} ${label}: ACL "${acl.name}" contains duplicate rule id "${rule.id}"` })
      }
      ruleIds.add(rule.id)
      if (!ACL_PROTOCOLS.includes(rule.protocol)) {
        issues.push({ deviceId: device.id, interfaceId, severity: 'error', message: `${device.name} ${label}: ACL "${acl.name}" rule uses unsupported protocol "${String(rule.protocol)}" (supported: icmp, tcp, udp)` })
      }
      for (const [field, target] of [['source', rule.source], ['destination', rule.destination]] as const) {
        if (!aclTargetIsValid(target)) {
          issues.push({ deviceId: device.id, interfaceId, severity: 'error', message: `${device.name} ${label}: ACL "${acl.name}" rule has an invalid ${field} "${target}" (expected "any", an IPv4 address or a CIDR range)` })
        }
      }
      if (rule.destPort != null) {
        if (!Number.isInteger(rule.destPort) || rule.destPort < 1 || rule.destPort > 65535) {
          issues.push({ deviceId: device.id, interfaceId, severity: 'error', message: `${device.name} ${label}: ACL "${acl.name}" rule has an invalid destination port ${String(rule.destPort)} (expected 1-65535)` })
        } else if (rule.protocol === 'icmp') {
          issues.push({ deviceId: device.id, interfaceId, severity: 'info', message: `${device.name} ${label}: ACL "${acl.name}" rule specifies a destination port on an icmp rule — the port is ignored for icmp` })
        }
      }
      if (rule.enabled === false) {
        issues.push({ deviceId: device.id, interfaceId, severity: 'info', message: `${device.name} ${label}: ACL "${acl.name}" contains a disabled rule that never matches` })
      }
    }
  }
}


export interface ValidationIssue {
  deviceId?: string
  interfaceId?: string
  poolId?: string
  linkId?: string
  severity: 'error' | 'warning' | 'info'
  message: string
}

function addrOf(iface: NetInterface, dhcp: ReturnType<typeof resolveDhcp>): { ip: number | null; prefix: number | null } {
  const { cidr } = effectiveAddress(iface, dhcp)
  const parsed = cidr ? parseCidr(cidr) : null
  return parsed ? { ip: parsed.ip, prefix: parsed.prefix } : { ip: null, prefix: null }
}

/** Validate a single interface's static CIDR text (for live editor feedback). */
export function validateInterfaceCidrInput(text: string, ipMode: string): string | null {
  if (ipMode === 'dhcp') return null
  if (!text || !text.trim()) return null // empty is allowed (unset)
  return validateHostCidrText(text)
}

/** Validate a gateway text (for live editor feedback). */
export function validateGatewayInput(text: string): string | null {
  if (!text || !text.trim()) return null
  return validateIpv4Text(text)
}

/** Whole-lab validation. Cheap enough to run on every render. */
export function validateLab(lab: Lab): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const dhcp = resolveDhcp(lab)

  // Device names should be unique — duplicates make ping output ambiguous.
  const names = new Map<string, number>()
  for (const device of lab.devices) {
    const key = device.name.trim().toLowerCase()
    names.set(key, (names.get(key) ?? 0) + 1)
  }
  for (const device of lab.devices) {
    if (device.name.trim() && (names.get(device.name.trim().toLowerCase()) ?? 0) > 1) {
      issues.push({
        deviceId: device.id,
        severity: 'warning',
        message: `More than one device is named "${device.name}" — rename one so tools can refer to devices unambiguously`,
      })
    }
  }

  // Duplicate IPs across enabled interfaces AND their VLAN sub-interfaces.
  const byIp = new Map<string, Array<{ device: Device; label: string }>>()
  for (const device of lab.devices) {
    for (const iface of device.interfaces) {
      if (!iface.enabled) continue
      const holders: Array<{ label: string; cidr: string | null }> = [
        { label: iface.name, cidr: effectiveAddress(iface, dhcp).cidr },
        ...(iface.subInterfaces ?? []).map((sub) => ({ label: sub.name, cidr: effectiveSubAddress(sub).cidr })),
      ]
      for (const holder of holders) {
        if (!holder.cidr) continue
        const ipText = holder.cidr.split('/')[0]
        const list = byIp.get(ipText) ?? []
        list.push({ device, label: holder.label })
        byIp.set(ipText, list)
      }
    }
  }
  for (const [ipText, owners] of byIp) {
    if (owners.length > 1) {
      issues.push({
        severity: 'error',
        message: `Duplicate IP ${ipText} is configured on ${owners.map((o) => `${o.device.name} (${o.label})`).join(' and ')}`,
      })
    }
  }

  for (const device of lab.devices) {
    // End hosts should have a gateway that lives in one of their subnets.
    if (device.kind === 'pc' || device.kind === 'server') {
      const addrIps: Array<{ iface: NetInterface; ip: number; prefix: number }> = []
      for (const iface of device.interfaces) {
        const { ip, prefix } = addrOf(iface, dhcp)
        if (ip !== null && prefix !== null) addrIps.push({ iface, ip, prefix })
      }
      const effectiveGw = effectiveGateway(device, dhcp)
      if (effectiveGw) {
        const gw = parseIpv4(effectiveGw)
        if (gw === null) {
          issues.push({ deviceId: device.id, severity: 'error', message: `${device.name}: default gateway "${device.gatewayIp}" is not a valid IPv4 address` })
        } else {
          const inSomeSubnet = addrIps.some((a) => a.prefix !== null && isSameSubnet(a.ip, gw, a.prefix))
          if (!inSomeSubnet) {
            issues.push({
              deviceId: device.id,
              severity: 'warning',
              message: `${device.name}: default gateway ${effectiveGw} is not inside any of its interface subnets`,
            })
          } else {
            // The gateway must be a usable host address, not the network or broadcast address.
            const matching = addrIps.find((a) => a.prefix !== null && isSameSubnet(a.ip, gw, a.prefix))!
            const net = networkOf({ ip: matching.ip, prefix: matching.prefix })
            const broadcast = (net | (~((0xffffffff << (32 - matching.prefix)) >>> 0) >>> 0)) >>> 0
            if (gw === net || gw === broadcast) {
              issues.push({
                deviceId: device.id,
                severity: 'error',
                message: `${device.name}: default gateway ${effectiveGw} is the network or broadcast address of ${formatIpv4(net)}/${matching.prefix} and can never answer ARP`,
              })
            }
          }
        }
      } else if (addrIps.length > 0) {
        issues.push({ deviceId: device.id, severity: 'info', message: `${device.name} has no default gateway; only its own subnet is reachable` })
      }
    }

    for (const iface of device.interfaces) {
      if (iface.role !== 'switchport' && iface.ipMode === 'static' && iface.cidr) {
        const err = validateHostCidrText(iface.cidr)
        if (err) issues.push({ deviceId: device.id, interfaceId: iface.id, severity: 'error', message: `${device.name} ${iface.name}: ${err}` })
      }
      if (iface.role === 'routed' && iface.enabled && !iface.cidr && iface.ipMode === 'static') {
        issues.push({ deviceId: device.id, interfaceId: iface.id, severity: 'warning', message: `${device.name} ${iface.name} is up but has no IP address` })
      }
      if (iface.role === 'switchport' && iface.cidr) {
        issues.push({ deviceId: device.id, interfaceId: iface.id, severity: 'info', message: `${device.name} ${iface.name} is a switch port; its IP setting is ignored in this simulation` })
      }
      if (iface.role === 'switchport' && (!Number.isInteger(iface.accessVlan) || iface.accessVlan < 1 || iface.accessVlan > 4094)) {
        issues.push({
          deviceId: device.id,
          interfaceId: iface.id,
          severity: 'error',
          message: `${device.name} ${iface.name}: access VLAN must be an integer between 1 and 4094 (currently ${iface.accessVlan})`,
        })
      }
      // Trunk port configuration.
      if (iface.role === 'switchport' && (iface.portMode ?? 'access') === 'trunk') {
        const native = iface.nativeVlan ?? 1
        if (!Number.isInteger(native) || native < 1 || native > 4094) {
          issues.push({
            deviceId: device.id,
            interfaceId: iface.id,
            severity: 'error',
            message: `${device.name} ${iface.name}: native VLAN must be an integer between 1 and 4094 (currently ${native})`,
          })
        }
        const allowed = iface.allowedVlans ?? []
        if (allowed.length === 0) {
          issues.push({
            deviceId: device.id,
            interfaceId: iface.id,
            severity: 'warning',
            message: `${device.name} ${iface.name} is a trunk that permits no VLANs — no frames will cross it`,
          })
        }
        for (const vlan of allowed) {
          if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) {
            issues.push({
              deviceId: device.id,
              interfaceId: iface.id,
              severity: 'error',
              message: `${device.name} ${iface.name}: allowed VLAN ${vlan} is not an integer between 1 and 4094`,
            })
          }
        }
      }
      // ACL configuration (routed ports and sub-interfaces only in this model).
      if (iface.role === 'routed') {
        validateAclContainer(device, iface.name, iface.id, iface.acls, issues)
        for (const sub of iface.subInterfaces ?? []) {
          validateAclContainer(device, sub.name, iface.id, sub.acls, issues)
        }
      } else if ((iface.acls ?? []).length > 0 || (iface.subInterfaces ?? []).some((sub) => (sub.acls ?? []).length > 0)) {
        issues.push({ deviceId: device.id, interfaceId: iface.id, severity: 'warning', message: `${device.name} ${iface.name}: ACLs are only evaluated on routed router interfaces — this ACL is ignored` })
      }

      // DHCP relay configuration on routed ports.
      if (iface.role === 'routed') {
        const relayTargets: Array<{ label: string; target: string | null }> = [
          { label: iface.name, target: iface.dhcpRelay ?? null },
          ...(iface.subInterfaces ?? []).map((sub) => ({ label: sub.name, target: sub.dhcpRelay ?? null })),
        ]
        for (const { label, target } of relayTargets) {
          if (!target) continue
          const err = validateIpv4Text(target)
          if (err) {
            issues.push({ deviceId: device.id, interfaceId: iface.id, severity: 'error', message: `${device.name} ${label}: DHCP relay target ${err}` })
            continue
          }
          const ownAddresses = [iface.cidr, ...(iface.subInterfaces ?? []).map((sub) => sub.cidr)].filter(Boolean) as string[]
          if (ownAddresses.some((cidr) => cidr.split('/')[0] === target)) {
            issues.push({
              deviceId: device.id,
              interfaceId: iface.id,
              severity: 'warning',
              message: `${device.name} ${label}: DHCP relay target ${target} is the router's own address — the relay would point at itself`,
            })
          }
        }
      }

      // Router VLAN sub-interfaces.
      const seenSubVlans = new Set<number>()
      for (const sub of iface.subInterfaces ?? []) {
        if (!Number.isInteger(sub.vlanId) || sub.vlanId < 1 || sub.vlanId > 4094) {
          issues.push({
            deviceId: device.id,
            interfaceId: iface.id,
            severity: 'error',
            message: `${device.name} ${sub.name}: VLAN id must be an integer between 1 and 4094 (currently ${sub.vlanId})`,
          })
        }
        if (seenSubVlans.has(sub.vlanId)) {
          issues.push({
            deviceId: device.id,
            interfaceId: iface.id,
            severity: 'error',
            message: `${device.name} ${iface.name}: more than one sub-interface is bound to VLAN ${sub.vlanId}`,
          })
        }
        seenSubVlans.add(sub.vlanId)
        if (sub.cidr) {
          const err = validateHostCidrText(sub.cidr)
          if (err) issues.push({ deviceId: device.id, interfaceId: iface.id, severity: 'error', message: `${device.name} ${sub.name}: ${err}` })
        }
        if (!interfaceIsLinked(lab, device.id, iface.id)) {
          issues.push({
            deviceId: device.id,
            interfaceId: iface.id,
            severity: 'info',
            message: `${device.name} ${sub.name} has no connected trunk on ${iface.name} — it cannot serve VLAN ${sub.vlanId} until the port is cabled`,
          })
        }
      }
      if (!interfaceIsLinked(lab, device.id, iface.id)) {
        issues.push({
          deviceId: device.id,
          interfaceId: iface.id,
          severity: 'info',
          message: `${device.name} ${iface.name} is not connected to anything${iface.cidr ? ` (its address ${iface.cidr} is unused)` : ''}`,
        })
      }
    }

    for (const route of device.staticRoutes) {
      const parsed = parseCidr(route.destinationCidr)
      const nextHop = parseIpv4(route.nextHopIp)
      if (!parsed) {
        issues.push({ deviceId: device.id, severity: 'error', message: `${device.name}: static route "${route.destinationCidr}" is not a valid prefix` })
        continue
      }
      if (nextHop === null) {
        issues.push({ deviceId: device.id, severity: 'error', message: `${device.name}: static route to ${route.destinationCidr} has invalid next hop "${route.nextHopIp}"` })
        continue
      }
      const onConnected = device.interfaces.some((iface) => {
        if (!iface.enabled) return false
        const { ip, prefix } = addrOf(iface, dhcp)
        return ip !== null && prefix !== null && isSameSubnet(ip, nextHop, prefix)
      })
      if (!onConnected) {
        issues.push({ deviceId: device.id, severity: 'warning', message: `${device.name}: static route to ${route.destinationCidr} via ${route.nextHopIp} — next hop is not on a connected subnet` })
      }
    }
  }

  // DHCP pool configuration sanity (config-on-paper view).
  for (const device of lab.devices) {
    for (const pool of device.dhcpPools) {
      if (device.interfaces.every((i) => !i.enabled || !i.cidr)) {
        issues.push({ deviceId: device.id, poolId: pool.id, severity: 'warning', message: `${device.name} has DHCP pool "${pool.name}" but no enabled, addressed interface to serve it from` })
      }
      const gw = parseIpv4(pool.gatewayIp)
      const net = parseCidr(pool.networkCidr)
      if (gw !== null && net) {
        const isUsable = isSameSubnet(net.ip, gw, net.prefix) && gw !== networkOf(net) && gw !== broadcastOf(net)
        if (!isUsable) {
          issues.push({
            deviceId: device.id,
            poolId: pool.id,
            severity: 'error',
            message: `DHCP pool "${pool.name}": gateway ${pool.gatewayIp} is not a usable host address inside ${pool.networkCidr} — clients would get an unusable gateway`,
          })
        }
      }
      if (pool.dnsIp) {
        const dnsErr = validateIpv4Text(pool.dnsIp)
        if (dnsErr) {
          issues.push({ deviceId: device.id, poolId: pool.id, severity: 'error', message: `DHCP pool "${pool.name}": DNS server ${dnsErr}` })
        }
      }
    }
  }

  // Link sanity.
  const usedInterfaces = new Map<string, string>() // `device/iface` -> linkId
  for (const link of lab.links) {
    const a = findInterface(lab, link.aDeviceId, link.aInterfaceId)
    const b = findInterface(lab, link.bDeviceId, link.bInterfaceId)
    if (!a || !b) {
      issues.push({ linkId: link.id, severity: 'error', message: 'A link references a missing device or interface' })
      continue
    }
    if (link.aDeviceId === link.bDeviceId) {
      issues.push({ linkId: link.id, severity: 'error', message: `Link loops back to the same device (${a.device.name})` })
    }
    const keyA = `${link.aDeviceId}/${link.aInterfaceId}`
    const keyB = `${link.bDeviceId}/${link.bInterfaceId}`
    if (usedInterfaces.has(keyA) || usedInterfaces.has(keyB)) {
      issues.push({ linkId: link.id, severity: 'error', message: `Interface of ${a.device.name} or ${b.device.name} is used by more than one link` })
    }
    usedInterfaces.set(keyA, link.id)
    usedInterfaces.set(keyB, link.id)
    if (!link.enabled) {
      issues.push({
        linkId: link.id,
        deviceId: a.device.id,
        severity: 'warning',
        message: `The link between ${a.device.name} ${a.iface.name} and ${b.device.name} ${b.iface.name} is administratively down`,
      })
    }
    // Access-mode switch-to-switch uplinks must share the access VLAN.
    const modeA = a.iface.portMode ?? 'access'
    const modeB = b.iface.portMode ?? 'access'
    if (
      link.enabled &&
      a.device.kind === 'switch' &&
      b.device.kind === 'switch' &&
      a.iface.role === 'switchport' &&
      b.iface.role === 'switchport' &&
      modeA === 'access' &&
      modeB === 'access' &&
      a.iface.accessVlan !== b.iface.accessVlan
    ) {
      issues.push({
        linkId: link.id,
        deviceId: a.device.id,
        interfaceId: a.iface.id,
        severity: 'warning',
        message: `Switch-to-switch link ${a.device.name} ${a.iface.name} (VLAN ${a.iface.accessVlan}) ↔ ${b.device.name} ${b.iface.name} (VLAN ${b.iface.accessVlan}) uses different VLANs on each end, so no frames will cross`,
      })
    }
    // Trunk-to-trunk links: shared allowed VLANs and matching native VLANs.
    if (link.enabled && modeA === 'trunk' && modeB === 'trunk') {
      const allowedA = a.iface.allowedVlans ?? []
      const allowedB = b.iface.allowedVlans ?? []
      const common = allowedA.filter((v) => allowedB.includes(v))
      if (common.length === 0) {
        issues.push({
          linkId: link.id,
          deviceId: a.device.id,
          interfaceId: a.iface.id,
          severity: 'error',
          message: `Trunk link ${a.device.name} ${a.iface.name} [${allowedA.join(', ') || 'none'}] ↔ ${b.device.name} ${b.iface.name} [${allowedB.join(', ') || 'none'}] has no VLAN permitted on both ends — no frames can cross`,
        })
      }
      if ((a.iface.nativeVlan ?? 1) !== (b.iface.nativeVlan ?? 1)) {
        issues.push({
          linkId: link.id,
          deviceId: a.device.id,
          interfaceId: a.iface.id,
          severity: 'warning',
          message: `Trunk link ${a.device.name} ${a.iface.name} (native VLAN ${a.iface.nativeVlan ?? 1}) ↔ ${b.device.name} ${b.iface.name} (native VLAN ${b.iface.nativeVlan ?? 1}) has a native VLAN mismatch — untagged frames land in different VLANs on each side`,
        })
      }
    }
  }

  return issues
}

export interface ValidationSummary {
  errors: number
  warnings: number
  infos: number
  total: number
}

/** Aggregate counts for badges and headlines. */
export function summarizeValidation(issues: ValidationIssue[]): ValidationSummary {
  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.filter((i) => i.severity === 'warning').length
  const infos = issues.filter((i) => i.severity === 'info').length
  return { errors, warnings, infos, total: issues.length }
}

/** Describe the dominant network of an L2 segment (for evidence messages). */
export function segmentNetworkSummary(lab: Lab, deviceId: string, interfaceId: string, dhcp: ReturnType<typeof resolveDhcp>): string {
  const segment = getL2Segment(lab, deviceId, interfaceId)
  const members = segmentInterfaces(lab, segment).filter((m) => m.device.id !== deviceId)
  const parts: string[] = []
  for (const member of members) {
    const { cidr } = effectiveAddress(member.iface, dhcp)
    if (cidr) parts.push(`${member.device.name} ${member.iface.name} = ${cidr}`)
  }
  return parts.join('; ')
}

/** Count interfaces currently linked (used by the UI to warn before deleting). */
export function interfaceLinkCount(lab: Lab, deviceId: string, interfaceId: string): number {
  return linksOfInterface(lab, deviceId, interfaceId).length
}

export function subnetOfCidr(cidrText: string | null): string {
  const parsed = cidrText ? parseCidr(cidrText) : null
  return parsed ? `${formatIpv4(networkOf(parsed))}/${parsed.prefix}` : '(no subnet)'
}
