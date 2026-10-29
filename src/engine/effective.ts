// Applies fault overlays to a base lab, producing the "effective" lab that
// both NetLab and NetDoctor simulate against. Keeping this in its own module
// avoids circular imports between the ping engine and fault detection.

import { parseIpv4, parseCidr, networkOf, formatIpv4 } from './ip'
import type { Lab } from './types'

export interface EffectiveLab {
  lab: Lab
  /** Human-readable list of overlays that were applied (for the UI). */
  applied: string[]
}

function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Produce the effective configuration: base config with all *active* fault
 * overlays applied. NetLab edits the base config; NetDoctor detects the
 * resulting misconfiguration — both use this function, so a fault injected in
 * NetLab is guaranteed to be visible to NetDoctor.
 */
export function applyFaults(lab: Lab): EffectiveLab {
  const effective = deepClone(lab)
  const applied: string[] = []

  for (const fault of lab.faults) {
    if (!fault.active) continue
    const device = effective.devices.find((d) => d.id === fault.deviceId)
    if (!device) continue
    const deviceLabel = `${device.name}`

    switch (fault.kind) {
      case 'wrong-ip':
      case 'wrong-mask':
      case 'duplicate-ip': {
        const iface = fault.interfaceId ? device.interfaces.find((i) => i.id === fault.interfaceId) : undefined
        if (!iface || !fault.value) break
        const parsed = parseCidr(fault.value)
        if (!parsed) break
        iface.cidr = `${formatIpv4(parsed.ip)}/${parsed.prefix}`
        applied.push(`${deviceLabel} ${iface.name}: IP set to ${iface.cidr}`)
        break
      }
      case 'wrong-gateway': {
        if (fault.value === undefined) break
        device.gatewayIp = fault.value === '' ? null : fault.value
        applied.push(`${deviceLabel}: default gateway set to ${device.gatewayIp ?? '(none)'}`)
        break
      }
      case 'interface-down': {
        const iface = fault.interfaceId ? device.interfaces.find((i) => i.id === fault.interfaceId) : undefined
        if (!iface) break
        iface.enabled = false
        applied.push(`${deviceLabel} ${iface.name}: administratively down`)
        break
      }
      case 'link-down': {
        const link = fault.linkId ? effective.links.find((l) => l.id === fault.linkId) : undefined
        if (!link) break
        link.enabled = false
        applied.push(`Link ${link.id} disabled`)
        break
      }
      case 'vlan-mismatch': {
        const iface = fault.interfaceId ? device.interfaces.find((i) => i.id === fault.interfaceId) : undefined
        if (!iface || fault.value === undefined) break
        const vlanId = Number(fault.value)
        if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) break
        iface.accessVlan = vlanId
        if (!effective.vlans.some((v) => v.id === vlanId)) {
          effective.vlans.push({ id: vlanId, name: `VLAN${vlanId}` })
        }
        applied.push(`${deviceLabel} ${iface.name}: access VLAN set to ${vlanId}`)
        break
      }
      case 'dhcp-exhausted': {
        const pool = fault.poolId ? device.dhcpPools.find((p) => p.id === fault.poolId) : undefined
        if (!pool) break
        const net = parseCidr(pool.networkCidr)
        if (net) {
          // Collapse the range to the network address (always excluded) so no
          // lease can be given => the pool behaves as fully consumed.
          pool.rangeStart = formatIpv4(networkOf(net))
          pool.rangeEnd = formatIpv4(networkOf(net))
        }
        applied.push(`${deviceLabel} pool "${pool.name}": exhausted`)
        break
      }
      case 'remove-route': {
        const before = device.staticRoutes.length
        device.staticRoutes = device.staticRoutes.filter((r) => r.id !== fault.routeId)
        if (device.staticRoutes.length < before) {
          applied.push(`${deviceLabel}: static route removed`)
        }
        break
      }
      case 'trunk-vlan-missing': {
        const iface = fault.interfaceId ? device.interfaces.find((i) => i.id === fault.interfaceId) : undefined
        if (!iface || fault.value === undefined) break
        const vlanId = Number(fault.value)
        if (!Number.isInteger(vlanId)) break
        iface.allowedVlans = (iface.allowedVlans ?? []).filter((v) => v !== vlanId)
        applied.push(`${deviceLabel} ${iface.name}: VLAN ${vlanId} removed from the allowed list`)
        break
      }
      case 'trunk-native-mismatch': {
        const iface = fault.interfaceId ? device.interfaces.find((i) => i.id === fault.interfaceId) : undefined
        if (!iface || fault.value === undefined) break
        const vlanId = Number(fault.value)
        if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) break
        iface.nativeVlan = vlanId
        applied.push(`${deviceLabel} ${iface.name}: native VLAN set to ${vlanId}`)
        break
      }
      case 'missing-subinterface': {
        const iface = fault.interfaceId ? device.interfaces.find((i) => i.id === fault.interfaceId) : undefined
        if (!iface) break
        const before = (iface.subInterfaces ?? []).length
        iface.subInterfaces = (iface.subInterfaces ?? []).filter((sub) => sub.id !== fault.subInterfaceId)
        if ((iface.subInterfaces ?? []).length < before) {
          applied.push(`${deviceLabel} ${iface.name}: sub-interface removed`)
        }
        break
      }
      case 'missing-dhcp-scope': {
        // Hide a pool from the effective configuration (e.g. scope deleted).
        const poolServer = fault.poolId ? effective.devices.find((d) => d.dhcpPools.some((p) => p.id === fault.poolId)) : undefined
        if (poolServer) {
          const before = poolServer.dhcpPools.length
          poolServer.dhcpPools = poolServer.dhcpPools.filter((p) => p.id !== fault.poolId)
          if (poolServer.dhcpPools.length < before) {
            applied.push(`${poolServer.name}: DHCP scope removed`)
          }
        }
        break
      }
      case 'acl-blocks-traffic': {
        // Value format: "[in|out] <icmp|tcp|udp> <src> <dst> [port]".
        // Prepends a deny rule so it decides BEFORE any configured permit
        // (first-match-wins) — the classic "wrong rule order" failure.
        const iface = fault.interfaceId ? device.interfaces.find((i) => i.id === fault.interfaceId) : undefined
        if (!iface) break
        const parts = (fault.value ?? 'icmp any any').trim().split(/\s+/)
        let direction: 'in' | 'out' = 'out'
        if (parts[0] === 'in' || parts[0] === 'out') {
          direction = parts[0]
          parts.shift()
        }
        const protocol = ['icmp', 'tcp', 'udp'].includes(parts[0] ?? '') ? (parts[0] as 'icmp' | 'tcp' | 'udp') : 'icmp'
        const source = parts[1] ?? 'any'
        const destination = parts[2] ?? 'any'
        const port = parts[3] !== undefined && Number.isInteger(Number(parts[3])) ? Number(parts[3]) : null
        const entry = {
          id: `acl-${fault.id}`,
          name: `INJECTED-${direction.toUpperCase()}`,
          direction,
          rules: [
            { id: `rule-${fault.id}`, action: 'deny' as const, protocol, source, destination, destPort: port, enabled: true },
          ],
        }
        if (fault.subInterfaceId) {
          const sub = iface.subInterfaces?.find((s) => s.id === fault.subInterfaceId)
          if (sub) sub.acls = [entry, ...(sub.acls ?? [])]
        } else {
          iface.acls = [entry, ...(iface.acls ?? [])]
        }
        applied.push(`${deviceLabel}: deny ${protocol} ${source} → ${destination}${port ? ` port ${port}` : ''} injected on ${iface.name} (${direction})`)
        break
      }
      case 'missing-dhcp-relay': {
        if (fault.subInterfaceId) {
          const iface = device.interfaces.find((i) => i.id === fault.interfaceId)
          const sub = iface?.subInterfaces?.find((sub) => sub.id === fault.subInterfaceId)
          if (sub && sub.dhcpRelay) {
            sub.dhcpRelay = null
            applied.push(`${deviceLabel} ${sub.name}: DHCP relay removed`)
          }
        } else {
          const iface = fault.interfaceId ? device.interfaces.find((i) => i.id === fault.interfaceId) : undefined
          if (iface && iface.dhcpRelay) {
            iface.dhcpRelay = null
            applied.push(`${deviceLabel} ${iface.name}: DHCP relay removed`)
          }
        }
        break
      }
      case 'wrong-relay-target': {
        if (fault.value === undefined) break
        if (fault.subInterfaceId) {
          const iface = device.interfaces.find((i) => i.id === fault.interfaceId)
          const sub = iface?.subInterfaces?.find((sub) => sub.id === fault.subInterfaceId)
          if (sub) {
            sub.dhcpRelay = fault.value
            applied.push(`${deviceLabel} ${sub.name}: DHCP relay target set to ${fault.value}`)
          }
        } else {
          const iface = fault.interfaceId ? device.interfaces.find((i) => i.id === fault.interfaceId) : undefined
          if (iface) {
            iface.dhcpRelay = fault.value
            applied.push(`${deviceLabel} ${iface.name}: DHCP relay target set to ${fault.value}`)
          }
        }
        break
      }
    }
  }

  return { lab: effective, applied }
}

/** Parse helper used by diagnostics to describe a fault value. */
export function describeFaultValue(kind: string, value: string | undefined): string {
  if (value === undefined || value === '') return '(none)'
  if (parseIpv4(value) !== null || parseCidr(value) !== null || kind === 'vlan-mismatch') return value
  return value
}
