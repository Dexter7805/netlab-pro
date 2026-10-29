// CLI-style rendering of a device's EFFECTIVE configuration (faults applied).
// Used by NetDoctor's diagnostics so users can "read the config" like an
// engineer would on a real box.

import { applyFaults } from '../engine/effective'
import { resolveDhcp, effectiveAddress, effectiveSubAddress, effectiveGateway } from '../engine/dhcp'
import { buildRoutingTable } from '../engine/routing'
import { maskTextOf, parseCidr, networkOf, formatIpv4 } from '../engine/ip'
import type { Device, Lab } from '../engine/types'

export function deviceConfigLines(lab: Lab, device: Device): string[] {
  const { lab: effective } = applyFaults(lab)
  const dhcp = resolveDhcp(effective)
  const live = effective.devices.find((d) => d.id === device.id)
  if (!live) return []
  const lines: string[] = []

  if (live.kind === 'router') {
    lines.push(`${live.name}# show running-config`)
    for (const iface of live.interfaces) {
      lines.push(`interface ${iface.name}`)
      const { cidr, origin } = effectiveAddress(iface, dhcp)
      if (cidr) {
        const parsed = parseCidr(cidr)
        if (parsed) {
          lines.push(` ip address ${formatIpv4(parsed.ip)} ${maskTextOf(parsed.prefix)}${origin === 'dhcp' ? '  ! via DHCP' : ''}`)
        }
      } else if (iface.ipMode === 'dhcp') {
        lines.push(' ip address dhcp  ! no lease')
      } else {
        lines.push(' ! no address configured')
      }
      lines.push(iface.enabled ? ' no shutdown' : ' shutdown')
      if (iface.dhcpRelay) lines.push(` ip helper-address ${iface.dhcpRelay}`)
      for (const acl of iface.acls ?? []) {
        lines.push(` ip access-group ${acl.name} ${acl.direction}`)
      }
      for (const acl of iface.acls ?? []) {
        lines.push(`ip access-list extended ${acl.name}`)
        for (const [index, rule] of acl.rules.entries()) {
          const port = rule.destPort != null ? ` eq ${rule.destPort}` : ''
          lines.push(` ${index + 1}. ${rule.action} ${rule.protocol} ${rule.source} → ${rule.destination}${port}${rule.enabled ? '' : ' (disabled)'}`)
        }
      }
      for (const sub of iface.subInterfaces ?? []) {
        const subCidr = effectiveSubAddress(sub).cidr
        lines.push(`interface ${sub.name}`)
        lines.push(` encapsulation dot1Q ${sub.vlanId}`)
        if (subCidr) {
          const parsed = parseCidr(subCidr)
          if (parsed) lines.push(` ip address ${formatIpv4(parsed.ip)} ${maskTextOf(parsed.prefix)}`)
        } else {
          lines.push(' ! no address configured')
        }
        if (sub.dhcpRelay) lines.push(` ip helper-address ${sub.dhcpRelay}`)
        for (const acl of sub.acls ?? []) {
          lines.push(` ip access-group ${acl.name} ${acl.direction}`)
          for (const [index, rule] of acl.rules.entries()) {
            const port = rule.destPort != null ? ` eq ${rule.destPort}` : ''
            lines.push(` ! ${acl.name} ${index + 1}. ${rule.action} ${rule.protocol} ${rule.source} → ${rule.destination}${port}`)
          }
        }
        lines.push(sub.enabled ? ' no shutdown' : ' shutdown')
      }
    }
    for (const route of live.staticRoutes) {
      lines.push(`ip route ${route.destinationCidr} ${route.nextHopIp}`)
    }
    if (live.staticRoutes.length === 0) {
      const table = buildRoutingTable(live, dhcp)
      lines.push('! no static routes configured')
      for (const entry of table.filter((r) => r.type === 'connected')) {
        lines.push(`! connected: ${entry.destinationCidr}`)
      }
    }
    return lines
  }

  if (live.kind === 'switch') {
    lines.push(`${live.name}# show running-config`)
    for (const iface of live.interfaces) {
      lines.push(`interface ${iface.name}`)
      const mode = iface.portMode ?? 'access'
      if (mode === 'trunk') {
        lines.push(' switchport mode trunk')
        lines.push(` switchport trunk allowed vlan ${(iface.allowedVlans ?? []).join(',') || 'none'}`)
        lines.push(` switchport trunk native vlan ${iface.nativeVlan ?? 1}`)
      } else {
        lines.push(' switchport mode access')
        lines.push(` switchport access vlan ${iface.accessVlan}`)
      }
      lines.push(iface.enabled ? ' ! port up' : ' shutdown')
    }
    return lines
  }

  // Hosts (PC / server)
  lines.push(`${live.name}> ipconfig /all`)
  for (const iface of live.interfaces) {
    const { cidr, origin } = effectiveAddress(iface, dhcp)
    lines.push(`   ${iface.name}: ${cidr ?? (iface.ipMode === 'dhcp' ? 'DHCP — no lease' : 'not configured')}${origin === 'dhcp' ? ' (DHCP lease)' : ''}`)
    if (!iface.enabled) lines.push(`   ${iface.name}: administratively down`)
  }
  lines.push(`   Default gateway . . . : ${effectiveGateway(live, dhcp) ?? '(none)'}`)
  for (const iface of live.interfaces) {
    const dns = dhcp.dnsServers.get(iface.id)
    if (dns) lines.push(`   DNS server . . . . . : ${dns} (via DHCP)`)
  }
  for (const pool of live.dhcpPools) {
    lines.push(`   DHCP pool "${pool.name}": ${pool.networkCidr}, range ${pool.rangeStart} - ${pool.rangeEnd}, gw ${pool.gatewayIp}${pool.dnsIp ? `, dns ${pool.dnsIp}` : ''}`)
  }
  return lines
}

export function deviceNetworkSummary(lab: Lab, device: Device): string {
  const { lab: effective } = applyFaults(lab)
  const live = effective.devices.find((d) => d.id === device.id)
  if (!live) return ''
  const parts: string[] = []
  for (const iface of live.interfaces) {
    const parsed = iface.cidr ? parseCidr(iface.cidr) : null
    parts.push(parsed ? `${formatIpv4(networkOf(parsed))}/${parsed.prefix}` : iface.name)
  }
  return parts.join(', ')
}
