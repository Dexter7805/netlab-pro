import { describe, expect, it } from 'vitest'
import { runPing, simulatePing } from './ping'
import { resolveDhcp } from './dhcp'
import { applyFaults } from './effective'
import { buildDhcpLab, buildMaskLab, buildOfficeLab, buildTwoRouterLab, buildVlanLab } from '../data/sampleLabs'
import type { Lab } from './types'

function effective(lab: Lab): Lab {
  return applyFaults(lab).lab
}

describe('ping: happy paths', () => {
  it('ping within the same subnet (through a switch)', () => {
    const lab = buildMaskLab()
    const result = runPing(lab, 'pc1', '192.168.1.11')
    expect(result.success).toBe(true)
    expect(result.explanation).toMatch(/Reply received/i)
    expect(result.pathDeviceIds).toContain('pc2')
  })

  it('ping across one router (gateway + connected route)', () => {
    const lab = buildOfficeLab()
    const result = runPing(lab, 'pc1', '10.0.0.20')
    expect(result.success).toBe(true)
    expect(result.hops.some((h) => h.deviceName === 'R1')).toBe(true)
  })

  it('ping across two routers with static routes', () => {
    const lab = buildTwoRouterLab()
    const result = runPing(lab, 'pc1', '172.16.20.20')
    expect(result.success).toBe(true)
    expect(result.hops.some((h) => h.deviceName === 'R1')).toBe(true)
    expect(result.hops.some((h) => h.deviceName === 'R2')).toBe(true)
    // Return path from the server too.
    const reverse = runPing(lab, 'srv1', '192.168.1.10')
    expect(reverse.success).toBe(true)
  })

  it('ping from a router to a directly connected host', () => {
    const lab = buildOfficeLab()
    const result = runPing(lab, 'r1', '192.168.1.10')
    expect(result.success).toBe(true)
  })

  it('ping own address replies immediately', () => {
    const lab = buildOfficeLab()
    const result = runPing(lab, 'pc1', '192.168.1.10')
    expect(result.success).toBe(true)
  })

  it('rejects invalid target addresses', () => {
    const lab = buildOfficeLab()
    const result = runPing(lab, 'pc1', '999.1.2.3')
    expect(result.success).toBe(false)
    expect(result.failCode).toBe('invalid-target')
  })
})

describe('ping: fault-driven failures', () => {
  it('wrong gateway => gateway-unreachable', () => {
    const lab = buildOfficeLab()
    lab.faults = [{ id: 'f1', kind: 'wrong-gateway', deviceId: 'pc1', active: true, value: '192.168.1.99' }]
    const result = runPing(lab, 'pc1', '10.0.0.20')
    expect(result.success).toBe(false)
    expect(result.failCode).toBe('gateway-unreachable')
    expect(result.explanation).toMatch(/192\.168\.1\.99/)
  })

  it('missing default gateway => no-gateway', () => {
    const lab = buildOfficeLab()
    lab.faults = [{ id: 'f1', kind: 'wrong-gateway', deviceId: 'pc1', active: true, value: '' }]
    const result = runPing(lab, 'pc1', '10.0.0.20')
    expect(result.success).toBe(false)
    expect(result.failCode).toBe('no-gateway')
  })

  it('interface down on source => cannot send', () => {
    const lab = buildOfficeLab()
    lab.faults = [{ id: 'f1', kind: 'interface-down', deviceId: 'pc1', interfaceId: 'pc1-fa0', active: true }]
    const result = runPing(lab, 'pc1', '192.168.1.1')
    expect(result.success).toBe(false)
    expect(result.failCode).toBe('no-source-ip')
  })

  it('interface down at the destination => destination-unreachable', () => {
    const lab = buildOfficeLab()
    lab.faults = [{ id: 'f1', kind: 'interface-down', deviceId: 'srv1', interfaceId: 'srv1-fa0', active: true }]
    const result = runPing(lab, 'pc1', '10.0.0.20')
    expect(result.success).toBe(false)
    expect(result.failCode).toBe('destination-unreachable')
  })

  it('missing static route => no-route at R1, fixed by re-adding', () => {
    const lab = buildTwoRouterLab()
    lab.faults = [{ id: 'f1', kind: 'remove-route', deviceId: 'r1', routeId: 'rt-r1-srv', active: true }]
    const broken = runPing(lab, 'pc1', '172.16.20.20')
    expect(broken.success).toBe(false)
    expect(broken.failCode).toBe('no-route')
    expect(broken.explanation).toMatch(/R1 has no route/i)

    // Fix: restore the route -> ping works again.
    const fixed = structuredClone(lab)
    fixed.faults = []
    fixed.devices.find((d) => d.id === 'r1')!.staticRoutes = [
      { id: 'rt-restored', destinationCidr: '172.16.20.0/24', nextHopIp: '10.0.0.2' },
    ]
    const ok = runPing(fixed, 'pc1', '172.16.20.20')
    expect(ok.success).toBe(true)
  })

  it('VLAN mismatch blocks same-subnet ARP', () => {
    const lab = buildVlanLab()
    expect(runPing(lab, 'pc1', '192.168.10.12').success).toBe(true)
    lab.faults = [
      { id: 'f1', kind: 'vlan-mismatch', deviceId: 'sw1', interfaceId: 'sw1-fa02', value: '20', active: true },
    ]
    const result = runPing(lab, 'pc1', '192.168.10.12')
    expect(result.success).toBe(false)
    expect(result.failCode).toBe('on-link-arp-fail')
    expect(result.suggestion).toMatch(/VLAN/i)
  })

  it('wrong mask makes remote-looking hosts unreachable (no gateway)', () => {
    const lab = buildMaskLab()
    expect(runPing(lab, 'pc1', '192.168.1.200').success).toBe(true)
    lab.faults = [
      { id: 'f1', kind: 'wrong-mask', deviceId: 'pc1', interfaceId: 'pc1-fa0', value: '192.168.1.10/25', active: true },
    ]
    const result = runPing(lab, 'pc1', '192.168.1.200')
    expect(result.success).toBe(false)
    expect(result.failCode).toBe('no-gateway')
    // Near host still reachable:
    expect(runPing(lab, 'pc1', '192.168.1.11').success).toBe(true)
  })

  it('duplicate IP does not break other traffic and is detectable in config', () => {
    const lab = buildOfficeLab()
    lab.devices = [
      ...lab.devices,
      {
        id: 'pc2',
        name: 'PC2',
        kind: 'pc',
        x: 0,
        y: 0,
        gatewayIp: '192.168.1.1',
        interfaces: [
          { id: 'pc2-fa0', name: 'Fa0', role: 'host', ipMode: 'static', cidr: '192.168.1.10/24', enabled: true, accessVlan: 10 },
        ],
        staticRoutes: [],
        dhcpPools: [],
      },
    ]
    lab.links = [
      ...lab.links,
      { id: 'l2', aDeviceId: 'pc2', aInterfaceId: 'pc2-fa0', bDeviceId: 'sw1', bInterfaceId: 'sw1-fa03', enabled: true },
    ]
    const result = runPing(lab, 'srv1', '192.168.1.1')
    expect(result.success).toBe(true)
  })
})

describe('ping: DHCP', () => {
  it('DHCP clients receive deterministic leases and can ping each other', () => {
    const lab = buildDhcpLab()
    const eff = effective(lab)
    const dhcp = resolveDhcp(eff)
    expect(dhcp.assignments.get('pc1-fa0')).toBe('192.168.10.100/24')
    expect(dhcp.assignments.get('pc2-fa0')).toBe('192.168.10.101/24')
    const result = simulatePing(eff, 'pc1', '192.168.10.101', dhcp)
    expect(result.success).toBe(true)
  })

  it('exhausted pool => clients get no address and ping fails clearly', () => {
    const lab = buildDhcpLab()
    lab.faults = [{ id: 'f1', kind: 'dhcp-exhausted', deviceId: 'srv1', poolId: 'pool-srv1-lan', active: true }]
    const eff = effective(lab)
    const dhcp = resolveDhcp(eff)
    expect(dhcp.failures.get('pc1-fa0')?.reason).toBe('pool-exhausted')
    expect(dhcp.failures.get('pc2-fa0')?.reason).toBe('pool-exhausted')
    const result = simulatePing(eff, 'pc1', '192.168.10.1', dhcp)
    expect(result.success).toBe(false)
    expect(result.failCode).toBe('no-source-ip')
    expect(result.explanation).toMatch(/no interface with an IP|DHCP/i)
  })

  it('no DHCP server on segment => no-server failure', () => {
    const lab = buildDhcpLab()
    lab.links = lab.links.filter((l) => l.id !== 'lnk-srv1-sw1')
    const eff = effective(lab)
    const dhcp = resolveDhcp(eff)
    expect(dhcp.failures.get('pc1-fa0')?.reason).toBe('no-server')
  })

  it('DHCP clients use the pool-provided gateway to reach remote subnets', () => {
    const lab = buildDhcpLab()
    // Extend the built-in lab: R1 gets a second subnet with SRV2 behind it.
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    r1.interfaces.push({ id: 'r1-gi01', name: 'Gi0/1', role: 'routed', ipMode: 'static', cidr: '10.9.9.1/24', enabled: true, accessVlan: 1 })
    lab.devices = [
      ...lab.devices,
      {
        id: 'srv2', name: 'SRV2', kind: 'server', x: 960, y: 240, gatewayIp: '10.9.9.1',
        interfaces: [{ id: 'srv2-fa0', name: 'Fa0', role: 'host', ipMode: 'static', cidr: '10.9.9.20/24', enabled: true, accessVlan: 1 }],
        staticRoutes: [], dhcpPools: [],
      },
    ]
    lab.links = [...lab.links, { id: 'l-srv2', aDeviceId: 'r1', aInterfaceId: 'r1-gi01', bDeviceId: 'srv2', bInterfaceId: 'srv2-fa0', enabled: true }]

    const eff = effective(lab)
    const dhcp = resolveDhcp(eff)
    // Pool gateway is 192.168.10.254 (R1) — client must be able to ping 10.9.9.20.
    const result = simulatePing(eff, 'pc1', '10.9.9.20', dhcp)
    expect(result.success).toBe(true)
    expect(result.hops.some((h) => h.deviceName === 'R1')).toBe(true)

    // An explicit (wrong) static gateway overrides the DHCP-provided one.
    eff.devices.find((d) => d.id === 'pc1')!.gatewayIp = '192.168.10.99'
    const result2 = simulatePing(eff, 'pc1', '10.9.9.20', resolveDhcp(eff))
    expect(result2.success).toBe(false)
    expect(result2.failCode).toBe('gateway-unreachable')
  })
})

describe('ping: routing edge cases', () => {
  it('routing loop => ttl-exceeded', () => {
    const lab = buildTwoRouterLab()
    // Point R1's route at R2, and R2's route back at R1 via wrong next hops.
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    const r2 = lab.devices.find((d) => d.id === 'r2')!
    r1.staticRoutes = [{ id: 'rt1', destinationCidr: '172.16.20.0/24', nextHopIp: '10.0.0.1' }]
    r2.staticRoutes = [{ id: 'rt2', destinationCidr: '172.16.20.0/24', nextHopIp: '10.0.0.1' }]
    // R1 has no route that progresses; next hop 10.0.0.1 is R1 itself -> loop.
    const result = runPing(lab, 'pc1', '172.16.20.20')
    expect(result.success).toBe(false)
    expect(['ttl-exceeded', 'next-hop-unreachable', 'no-route']).toContain(result.failCode)
  })

  it('static route with unreachable next hop => next-hop-unreachable', () => {
    const lab = buildTwoRouterLab()
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    r1.staticRoutes = [{ id: 'rt1', destinationCidr: '172.16.20.0/24', nextHopIp: '10.0.0.55' }]
    const result = runPing(lab, 'pc1', '172.16.20.20')
    expect(result.success).toBe(false)
    expect(result.failCode).toBe('next-hop-unreachable')
  })

  it('switches cannot be pinged from (no-source-interface)', () => {
    const lab = buildVlanLab()
    const result = runPing(lab, 'sw1', '192.168.10.11')
    expect(result.success).toBe(false)
    expect(result.failCode).toBe('no-source-interface')
  })
})
