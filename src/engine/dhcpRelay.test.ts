// Phase 2B feature tests: DHCP relay — successful relayed leases, giaddr-based
// scope selection, every failure mode, detection, fixes and regressions.

import { describe, expect, it } from 'vitest'
import { resolveDhcp } from './dhcp'
import { applyFaults } from './effective'
import { runPing } from './ping'
import { detectIssues, faultMatchesIssue, applyFixToLab } from './faults'
import { validateLab } from './validate'
import { parseLabFile, serializeLabFile } from './labFile'
import { buildDhcpLab, buildDhcpRelayLab } from '../data/sampleLabs'
import type { Lab } from './types'

const healthyLab = (): Lab => buildDhcpRelayLab()

describe('successful relayed DHCP', () => {
  it('PC1 receives a lease from the remote scope with gateway and DNS', () => {
    const lab = healthyLab()
    const dhcp = resolveDhcp(lab)
    expect(dhcp.failures.size).toBe(0)
    expect(dhcp.assignments.get('pc1-fa0')).toBe('192.168.10.100/24')
    expect(dhcp.gateways.get('pc1')).toBe('192.168.10.1')
    expect(dhcp.dnsServers.get('pc1-fa0')).toBe('10.0.0.20')
    const relay = dhcp.relays.get('pc1-fa0')
    expect(relay).toMatchObject({ giaddr: '192.168.10.1', serverIp: '10.0.0.20', viaRouter: 'R1', viaSub: 'Gi0/0.10' })
  })

  it('a relayed client can reach the server and remote subnets through its lease', () => {
    const lab = healthyLab()
    const result = runPing(lab, 'pc1', '10.0.0.20')
    expect(result.success).toBe(true)
    expect(result.hops.some((h) => h.deviceName === 'R1')).toBe(true)
  })

  it('scope selection uses giaddr: a second scope for another subnet stays untouched', () => {
    const lab = healthyLab()
    const srv1 = lab.devices.find((d) => d.id === 'srv1')!
    srv1.dhcpPools = [
      ...srv1.dhcpPools,
      {
        id: 'pool-other-subnet',
        name: 'OTHER-SUBNET',
        networkCidr: '192.168.99.0/24',
        rangeStart: '192.168.99.50',
        rangeEnd: '192.168.99.60',
        gatewayIp: '192.168.99.1',
      },
    ]
    const dhcp = resolveDhcp(lab)
    expect(dhcp.assignments.get('pc1-fa0')).toBe('192.168.10.100/24')
    // The wrong-subnet scope handed out nothing.
    expect(dhcp.poolUsage.get('pool-other-subnet')?.used).toBe(0)
    expect(dhcp.poolUsage.get('pool-srv1-remote')?.used).toBe(1)
  })
})

describe('relay failures', () => {
  it('missing relay: client gets no lease, detection anchors the router sub-interface with a safe fix', () => {
    const lab = healthyLab()
    lab.faults = [
      { id: 'f1', kind: 'missing-dhcp-relay', deviceId: 'r1', interfaceId: 'r1-gi00', subInterfaceId: 'r1-gi00-sub10', active: true },
    ]
    const eff = lab // detection applies faults internally
    const dhcp = resolveDhcp(applyFaultsForTest(lab))
    expect(dhcp.assignments.has('pc1-fa0')).toBe(false)
    expect(dhcp.failures.get('pc1-fa0')?.reason).toBe('no-server')
    expect(dhcp.unrelayed.get('pc1-fa0')).toMatchObject({ routerDeviceId: 'r1', routerLabel: 'R1 Gi0/0.10', giaddr: '192.168.10.1' })

    const { issues } = detectIssues(eff)
    const match = issues.find((i) => i.kind === 'missing-dhcp-relay' && i.deviceId === 'r1' && i.subInterfaceId === 'r1-gi00-sub10')
    expect(match).toBeDefined()
    expect(lab.faults[0] && issues.some((i) => faultMatchesIssue(lab.faults[0], i))).toBe(true)
    // Safe fix: exactly one pool server exists → set-relay to its address.
    expect(match!.fix).toMatchObject({ type: 'set-relay', value: '10.0.0.20' })

    // Connectivity actually breaks: PC1 has no address.
    const { suite } = detectIssues(eff)
    expect(suite.some((s) => s.sourceDevice.id === 'pc1' && !s.result.success)).toBe(true)

    // Machine fix repairs the lab (fault overlay deactivated first, as in the runner).
    const repaired = applyFixToLab({ ...lab, faults: [] }, match!.fix!)
    const after = resolveDhcp(repaired)
    expect(after.assignments.get('pc1-fa0')).toBe('192.168.10.100/24')
  })

  it('invalid relay target (unowned IP): wrong-relay-target detection with fix', () => {
    const lab = healthyLab()
    lab.faults = [
      { id: 'f1', kind: 'wrong-relay-target', deviceId: 'r1', interfaceId: 'r1-gi00', subInterfaceId: 'r1-gi00-sub10', value: '10.0.0.99', active: true },
    ]
    const dhcp = resolveDhcp(applyFaultsForTest(lab))
    expect(dhcp.failures.get('pc1-fa0')?.reason).toBe('relay-target-unresolved')
    expect(dhcp.failures.get('pc1-fa0')?.detail).toMatch(/no device owns/)

    const { issues } = detectIssues(lab)
    const match = issues.find((i) => i.kind === 'wrong-relay-target' && i.deviceId === 'r1')
    expect(match).toBeDefined()
    expect(match!.fix).toMatchObject({ type: 'set-relay', value: '10.0.0.20' })
  })

  it('relay target owned by a device without DHCP pools is classified as wrong target', () => {
    const lab = healthyLab()
    lab.faults = [
      { id: 'f1', kind: 'wrong-relay-target', deviceId: 'r1', interfaceId: 'r1-gi00', subInterfaceId: 'r1-gi00-sub10', value: '10.0.0.1', active: true },
    ]
    const dhcp = resolveDhcp(applyFaultsForTest(lab))
    expect(dhcp.failures.get('pc1-fa0')?.reason).toBe('relay-target-unresolved')
    expect(dhcp.failures.get('pc1-fa0')?.detail).toMatch(/without offering any DHCP pool/)
    const { issues } = detectIssues(lab)
    expect(issues.some((i) => i.kind === 'wrong-relay-target')).toBe(true)
  })

  it('unreachable server: relay configured, routing broken → unreachable-server', () => {
    const lab = healthyLab()
    // Break the path between R1 and SRV1 while keeping SRV1's address resolvable.
    lab.links = lab.links.filter((l) => l.id !== 'lnk-r1-srv1')
    const dhcp = resolveDhcp(lab)
    expect(dhcp.failures.get('pc1-fa0')?.reason).toBe('server-unreachable')
    expect(dhcp.failures.get('pc1-fa0')?.detail).toMatch(/cannot reach it/i)

    const { issues } = detectIssues(lab)
    const match = issues.find((i) => i.kind === 'unreachable-server' && i.deviceId === 'r1')
    expect(match).toBeDefined()
  })

  it('missing matching scope: relay reaches a server with no scope for the client subnet', () => {
    const lab = healthyLab()
    const srv1 = lab.devices.find((d) => d.id === 'srv1')!
    srv1.dhcpPools = [
      { ...srv1.dhcpPools[0], id: 'pool-wrong', name: 'WRONG-SUBNET', networkCidr: '192.168.77.0/24', rangeStart: '192.168.77.50', rangeEnd: '192.168.77.60', gatewayIp: '192.168.77.1' },
    ]
    const dhcp = resolveDhcp(lab)
    expect(dhcp.failures.get('pc1-fa0')?.reason).toBe('no-matching-pool')
    expect(dhcp.failures.get('pc1-fa0')?.detail).toMatch(/none of its scopes serves 192\.168\.10\.0\/24/)

    const { issues } = detectIssues(lab)
    const match = issues.find((i) => i.kind === 'missing-dhcp-scope' && i.deviceId === 'srv1')
    expect(match).toBeDefined()
    expect(match!.fix?.type).toBe('create-dhcp-pool')

    // The generated scope fixes the problem (first free address after the
    // router's own giaddr, which is now correctly excluded from the pool).
    const repaired = applyFixToLab(lab, match!.fix!)
    const after = resolveDhcp(repaired)
    expect(after.assignments.get('pc1-fa0')).toBe('192.168.10.2/24')
    expect(after.gateways.get('pc1')).toBe('192.168.10.1')
  })

  it('pool exhaustion over relay is detected and anchored at the pool', () => {
    const lab = healthyLab()
    const srv1 = lab.devices.find((d) => d.id === 'srv1')!
    srv1.dhcpPools[0].rangeEnd = '192.168.10.100' // capacity 1
    const pc2 = structuredClone(lab.devices.find((d) => d.id === 'pc1')!)
    pc2.id = 'pc2'
    pc2.name = 'PC2'
    pc2.x = 80
    pc2.y = 340
    pc2.interfaces[0].id = 'pc2-fa0'
    lab.devices = [...lab.devices, pc2]
    lab.links = [
      ...lab.links,
      { id: 'lnk-pc2-sw1', aDeviceId: 'pc2', aInterfaceId: 'pc2-fa0', bDeviceId: 'sw1', bInterfaceId: 'sw1-fa02', enabled: true },
    ]
    const dhcp = resolveDhcp(lab)
    // Deterministic order: PC1 gets the only address, PC2 finds the pool exhausted.
    expect(dhcp.assignments.get('pc1-fa0')).toBe('192.168.10.100/24')
    expect(dhcp.failures.get('pc2-fa0')?.reason).toBe('pool-exhausted')
    expect(dhcp.failures.get('pc2-fa0')?.poolId).toBe('pool-srv1-remote')

    const { issues } = detectIssues(lab)
    const match = issues.find((i) => i.kind === 'dhcp-exhausted' && i.deviceId === 'srv1' && i.poolId === 'pool-srv1-remote')
    expect(match).toBeDefined()
  })

  it('invalid pool gateway: lease is granted but off-subnet pings fail, with a safe fix', () => {
    const lab = healthyLab()
    lab.devices.find((d) => d.id === 'srv1')!.dhcpPools[0].gatewayIp = '192.168.99.1'
    const dhcp = resolveDhcp(lab)
    // Lease still granted from the correct scope, but the gateway is unusable.
    expect(dhcp.assignments.get('pc1-fa0')).toBe('192.168.10.100/24')
    expect(dhcp.gateways.has('pc1')).toBe(false)

    const { issues } = detectIssues(lab)
    const match = issues.find((i) => i.kind === 'config-warning' && i.poolId === 'pool-srv1-remote')
    expect(match).toBeDefined()
    expect(match!.title).toMatch(/invalid gateway/)
    expect(match!.fix).toMatchObject({ type: 'set-pool-gateway', value: '192.168.10.1' })

    const repaired = applyFixToLab(lab, match!.fix!)
    expect(runPing(repaired, 'pc1', '10.0.0.20').success).toBe(true)
  })
})

describe('validation of relay and pool configuration', () => {
  it('flags invalid relay target addresses', () => {
    const lab = healthyLab()
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    const sub = r1.interfaces.find((i) => i.id === 'r1-gi00')!.subInterfaces![0]
    sub.dhcpRelay = 'not-an-ip'
    const messages = validateLab(lab).map((i) => i.message).join(' ')
    expect(messages).toMatch(/DHCP relay target/)
  })

  it('flags a relay pointing at the router itself', () => {
    const lab = healthyLab()
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    const sub = r1.interfaces.find((i) => i.id === 'r1-gi00')!.subInterfaces![0]
    sub.dhcpRelay = '192.168.10.1'
    const messages = validateLab(lab).map((i) => i.message).join(' ')
    expect(messages).toMatch(/relay would point at itself/)
  })

  it('flags pools with unusable gateways and invalid DNS entries', () => {
    const lab = healthyLab()
    const srv1 = lab.devices.find((d) => d.id === 'srv1')!
    srv1.dhcpPools[0].gatewayIp = '10.0.0.20' // real address, wrong subnet
    srv1.dhcpPools[0].dnsIp = '999.1.1.1'
    const messages = validateLab(lab).map((i) => i.message).join(' ')
    expect(messages).toMatch(/unusable gateway/)
    expect(messages).toMatch(/DNS server/)
  })

  it('the healthy relay lab passes without errors', () => {
    expect(validateLab(healthyLab()).filter((i) => i.severity === 'error')).toEqual([])
  })
})

describe('regressions: local DHCP and inter-VLAN routing', () => {
  it('local (same-segment) DHCP still works without any relay configured', () => {
    const lab = buildDhcpLab()
    const dhcp = resolveDhcp(lab)
    expect(dhcp.assignments.get('pc1-fa0')).toBe('192.168.10.100/24')
    expect(dhcp.assignments.get('pc2-fa0')).toBe('192.168.10.101/24')
    expect(dhcp.relays.size).toBe(0)
  })

  it('a local server still wins over the relay path', () => {
    const lab = healthyLab()
    // Give SW1's segment a local server: SRV1 moved into VLAN 10.
    const srv1 = lab.devices.find((d) => d.id === 'srv1')!
    srv1.x = 80
    srv1.y = 380
    srv1.interfaces[0].cidr = '192.168.10.2/24'
    lab.links = [
      ...lab.links.filter((l) => l.id !== 'lnk-r1-srv1'),
      { id: 'lnk-srv1-sw1', aDeviceId: 'srv1', aInterfaceId: 'srv1-fa0', bDeviceId: 'sw1', bInterfaceId: 'sw1-fa02', enabled: true },
    ]
    const dhcp = resolveDhcp(lab)
    expect(dhcp.assignments.get('pc1-fa0')).toBe('192.168.10.100/24')
    expect(dhcp.relays.size).toBe(0) // served locally, no relay used
  })

  it('relay works through the trunked sub-interface without breaking inter-VLAN behavior', () => {
    const lab = healthyLab()
    // After the lease, PC1 behaves like any other host on the subnet.
    const dhcp = resolveDhcp(lab)
    expect(dhcp.assignments.get('pc1-fa0')).toBeDefined()
    const result = runPing(lab, 'pc1', '10.0.0.20')
    expect(result.success).toBe(true)
  })
})

describe('import/export keeps relay and DNS configuration', () => {
  it('round-trips relay targets, sub-interface relays and pool DNS', () => {
    const lab = healthyLab()
    const parsed = parseLabFile(serializeLabFile(lab))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const imported = parsed.lab
    const sub = imported.devices.find((d) => d.id === 'r1')!.interfaces.find((i) => i.id === 'r1-gi00')!.subInterfaces![0]
    expect(sub.dhcpRelay).toBe('10.0.0.20')
    const pool = imported.devices.find((d) => d.id === 'srv1')!.dhcpPools[0]
    expect(pool.dnsIp).toBe('10.0.0.20')
    // Imported lab keeps working behavior.
    expect(resolveDhcp(imported).assignments.get('pc1-fa0')).toBe('192.168.10.100/24')
  })

  it('rejects invalid relay and DNS addresses on import', () => {
    const file = JSON.parse(serializeLabFile(healthyLab()))
    const r1 = file.lab.devices.find((d: { id: string }) => d.id === 'r1')
    r1.interfaces[0].subInterfaces[0].dhcpRelay = '999.9.9.9'
    const failed = parseLabFile(JSON.stringify(file))
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error).toMatch(/DHCP relay target/)

    const file2 = JSON.parse(serializeLabFile(healthyLab()))
    file2.lab.devices.find((d: { id: string }) => d.id === 'srv1').dhcpPools[0].dnsIp = 'nope'
    const failed2 = parseLabFile(JSON.stringify(file2))
    expect(failed2.ok).toBe(false)
    if (!failed2.ok) expect(failed2.error).toMatch(/invalid DNS server/)
  })
})

/** Apply fault overlays the same way the engine does before resolving DHCP. */
function applyFaultsForTest(lab: Lab): Lab {
  return applyFaults(lab).lab
}
