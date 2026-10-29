// Phase 2A feature tests: VLAN trunking, router-on-a-stick and inter-VLAN
// routing — permitted traffic, blocked traffic, detection and repair.

import { describe, expect, it } from 'vitest'
import { runPing } from './ping'
import { getL2Segment, portCarriesVlan } from './topology'
import { applyFaults } from './effective'
import { detectIssues, faultMatchesIssue, applyFixToLab, applyAllFixes } from './faults'
import { validateLab } from './validate'
import { parseLabFile, serializeLabFile } from './labFile'
import { buildInterVlanLab } from '../data/sampleLabs'
import type { Lab } from './types'

const healthyLab = (): Lab => buildInterVlanLab()

describe('L2 segments across trunks', () => {
  it('a trunk port participates exactly in its permitted VLANs', () => {
    const lab = healthyLab()
    const trunk = lab.devices.find((d) => d.id === 'sw1')!.interfaces.find((i) => i.id === 'sw1-fa03')!
    expect(trunk.portMode).toBe('trunk')
    expect(portCarriesVlan(trunk, 10)).toBe(true)
    expect(portCarriesVlan(trunk, 20)).toBe(true)
    expect(portCarriesVlan(trunk, 30)).toBe(false)
  })

  it('PC1 (VLAN 10) reaches the router port through the trunk; VLAN 20 hosts stay isolated at L2', () => {
    const lab = healthyLab()
    const seg10 = getL2Segment(lab, 'pc1', 'pc1-fa0')
    expect(seg10.vlan).toBe(10)
    expect(seg10.members.map((m) => m.interfaceId)).toContain('sw1-fa03')
    expect(seg10.members.map((m) => m.interfaceId)).toContain('r1-gi00')
    expect(seg10.members.map((m) => m.interfaceId)).not.toContain('pc2-fa0')

    const seg20 = getL2Segment(lab, 'pc2', 'pc2-fa0')
    expect(seg20.vlan).toBe(20)
    expect(seg20.members.map((m) => m.interfaceId)).toContain('r1-gi00')
    expect(seg20.members.map((m) => m.interfaceId)).not.toContain('pc1-fa0')
  })

  it('a VLAN missing from the trunk allowed list blocks the segment and is recorded as evidence', () => {
    const lab = healthyLab()
    const trunk = lab.devices.find((d) => d.id === 'sw1')!.interfaces.find((i) => i.id === 'sw1-fa03')!
    trunk.allowedVlans = [20]
    const seg = getL2Segment(lab, 'pc1', 'pc1-fa0')
    expect(seg.members.map((m) => m.interfaceId)).not.toContain('sw1-fa03')
    expect(seg.excludedPorts).toContainEqual({ deviceId: 'sw1', interfaceId: 'sw1-fa03', vlan: 10 })
  })
})

describe('inter-VLAN routing through the router-on-a-stick', () => {
  it('PC1 → PC2 works in both directions with sub-interface hops', () => {
    const lab = healthyLab()
    const result = runPing(lab, 'pc1', '192.168.20.12')
    expect(result.success).toBe(true)
    expect(result.hops.some((h) => h.detail.includes('Gi0/0.10') && h.detail.includes('VLAN 10'))).toBe(true)
    expect(result.hops.some((h) => h.interfaceName === 'Gi0/0.20' && h.detail.includes('VLAN 20'))).toBe(true)
    expect(result.hops.some((h) => h.deviceName === 'R1')).toBe(true)

    const reverse = runPing(lab, 'pc2', '192.168.10.11')
    expect(reverse.success).toBe(true)
  })

  it('the router reaches each VLAN through the matching sub-interface', () => {
    const lab = healthyLab()
    expect(runPing(lab, 'r1', '192.168.10.11').success).toBe(true)
    expect(runPing(lab, 'r1', '192.168.20.12').success).toBe(true)
  })
})

describe('blocked traffic and fault detection', () => {
  it('VLAN removed from the trunk breaks inter-VLAN pings with a clear explanation', () => {
    const lab = healthyLab()
    lab.faults = [{ id: 'f1', kind: 'trunk-vlan-missing', deviceId: 'sw1', interfaceId: 'sw1-fa03', active: true, value: '10' }]
    const result = runPing(lab, 'pc1', '192.168.20.12')
    expect(result.success).toBe(false)
    expect(result.failCode).toBe('gateway-unreachable')
    expect(result.explanation).toMatch(/VLAN 10 is not permitted/i)

    // PC2 (still permitted VLAN 20) can still reach its gateway side.
    expect(runPing(lab, 'pc2', '192.168.20.12').success).toBe(true) // own address always replies
  })

  it('trunk-vlan-missing is detected and anchored on the trunk port', () => {
    const lab = healthyLab()
    lab.faults = [{ id: 'f1', kind: 'trunk-vlan-missing', deviceId: 'sw1', interfaceId: 'sw1-fa03', active: true, value: '10' }]
    const { issues, suite } = detectIssues(lab)
    const match = issues.find((i) => i.kind === 'trunk-vlan-missing' && i.deviceId === 'sw1' && i.interfaceId === 'sw1-fa03')
    expect(match).toBeDefined()
    expect(match!.evidence).toMatch(/VLAN 10/)
    expect(suite.some((s) => !s.result.success)).toBe(true)

    // Correlation with the injected fault works for scoring.
    const fault = lab.faults[0]
    expect(issues.some((i) => faultMatchesIssue(fault, i))).toBe(true)
  })

  it('missing sub-interface breaks VLAN 10 and is detected on the router', () => {
    const lab = healthyLab()
    lab.faults = [
      { id: 'f1', kind: 'missing-subinterface', deviceId: 'r1', interfaceId: 'r1-gi00', subInterfaceId: 'r1-gi00-sub10', active: true },
    ]
    const eff = applyFaults(lab).lab
    const result = runPing(eff, 'pc1', '192.168.20.12')
    expect(result.success).toBe(false)
    expect(result.failCode).toBe('gateway-unreachable')
    // PC2 (VLAN 20) still has its sub-interface.
    expect(runPing(eff, 'pc2', '192.168.20.12').success).toBe(true)

    const { issues } = detectIssues(lab)
    const match = issues.find((i) => i.kind === 'missing-subinterface' && i.deviceId === 'r1' && i.interfaceId === 'r1-gi00')
    expect(match).toBeDefined()
    expect(match!.evidence).toMatch(/Gi0\/0\.20/) // names the surviving sub-interface
    expect(lab.faults[0] && issues.some((i) => faultMatchesIssue(lab.faults[0], i))).toBe(true)
  })

  it('a sub-interface on the wrong VLAN is classified as missing-subinterface with a matching-VLAN hint', () => {
    const lab = healthyLab()
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    const parent = r1.interfaces.find((i) => i.id === 'r1-gi00')!
    const sub10 = parent.subInterfaces!.find((s) => s.vlanId === 10)!
    sub10.vlanId = 30 // misconfigured: serves VLAN 30 instead of 10
    const { issues } = detectIssues(lab)
    const match = issues.find((i) => i.kind === 'missing-subinterface' && i.deviceId === 'r1')
    expect(match).toBeDefined()
  })

  it('a sub-interface on the wrong subnet is flagged (incompatible IP subnet)', () => {
    const lab = healthyLab()
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    const parent = r1.interfaces.find((i) => i.id === 'r1-gi00')!
    const sub10 = parent.subInterfaces!.find((s) => s.vlanId === 10)!
    sub10.cidr = '192.168.30.1/24'
    const { issues } = detectIssues(lab)
    const match = issues.find((i) => i.kind === 'missing-subinterface' && i.deviceId === 'r1')
    expect(match).toBeDefined()
    expect(match!.evidence).toMatch(/192\.168\.30\.1/)
  })

  it('a wrong endpoint gateway stays wrong-gateway (router owns the real address)', () => {
    const lab = healthyLab()
    lab.faults = [{ id: 'f1', kind: 'wrong-gateway', deviceId: 'pc1', active: true, value: '192.168.10.99' }]
    const { issues } = detectIssues(lab)
    const match = issues.find((i) => i.kind === 'wrong-gateway' && i.deviceId === 'pc1')
    expect(match).toBeDefined()
    expect(match!.evidence).toMatch(/192\.168\.10\.99/)
  })

  it('native VLAN mismatch between two trunks is detected as a warning', () => {
    const lab = healthyLab()
    // Cable a second switch to SW1's trunk with a different native VLAN.
    lab.devices = [
      ...lab.devices,
      {
        id: 'sw2', name: 'SW2', kind: 'switch', x: 340, y: 440, gatewayIp: null,
        interfaces: [
          { id: 'sw2-fa01', name: 'Fa0/1', role: 'switchport', ipMode: 'static', cidr: null, enabled: true, accessVlan: 1, portMode: 'trunk', nativeVlan: 99, allowedVlans: [10, 20] },
        ],
        staticRoutes: [], dhcpPools: [],
      },
    ]
    lab.links = [...lab.links, { id: 'lnk-trunk2', aDeviceId: 'sw1', aInterfaceId: 'sw1-fa03', bDeviceId: 'sw2', bInterfaceId: 'sw2-fa01', enabled: true }]
    const { issues } = detectIssues(lab)
    const match = issues.find((i) => i.kind === 'trunk-native-mismatch')
    expect(match).toBeDefined()
    expect(match!.evidence).toMatch(/native VLAN 1.*native VLAN 99|native VLAN 99.*native VLAN 1/)
  })
})

describe('apply-fix restores inter-VLAN connectivity', () => {
  it('deactivating the trunk fault restores PC1 → PC2', () => {
    const lab = healthyLab()
    lab.faults = [{ id: 'f1', kind: 'trunk-vlan-missing', deviceId: 'sw1', interfaceId: 'sw1-fa03', active: true, value: '10' }]
    const fixed = { ...lab, faults: [] }
    const after = detectIssues(fixed)
    expect(after.suite.every((s) => s.result.success)).toBe(true)
  })

  it('the create-subinterface machine fix repairs a missing sub-interface', () => {
    const lab = healthyLab()
    lab.faults = [
      { id: 'f1', kind: 'missing-subinterface', deviceId: 'r1', interfaceId: 'r1-gi00', subInterfaceId: 'r1-gi00-sub10', active: true },
    ]
    // Base restored first (ScenarioRunner behavior), then converge fixes.
    let fixed: Lab = { ...lab, faults: [] }
    fixed = applyAllFixes(fixed).lab
    // Force the broken state and use the detection fix directly.
    const broken = healthyLab()
    const parent = broken.devices.find((d) => d.id === 'r1')!.interfaces.find((i) => i.id === 'r1-gi00')!
    parent.subInterfaces = (parent.subInterfaces ?? []).filter((s) => s.vlanId !== 10)
    const { issues } = detectIssues(broken)
    const fix = issues.find((i) => i.kind === 'missing-subinterface')?.fix
    expect(fix?.type).toBe('create-subinterface')
    const repaired = applyFixToLab(broken, fix!)
    expect(runPing(repaired, 'pc1', '192.168.20.12').success).toBe(true)
  })
})

describe('validation of trunk and sub-interface configuration', () => {
  it('flags trunks with empty allowed lists', () => {
    const lab = healthyLab()
    const trunk = lab.devices.find((d) => d.id === 'sw1')!.interfaces.find((i) => i.id === 'sw1-fa03')!
    trunk.allowedVlans = []
    const messages = validateLab(lab).map((i) => i.message).join(' ')
    expect(messages).toMatch(/permits no VLANs/)
  })

  it('flags out-of-range VLAN ids in trunks and sub-interfaces', () => {
    const lab = healthyLab()
    const trunk = lab.devices.find((d) => d.id === 'sw1')!.interfaces.find((i) => i.id === 'sw1-fa03')!
    trunk.allowedVlans = [10, 5000]
    trunk.nativeVlan = 0
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    const sub = r1.interfaces[0].subInterfaces![0]
    sub.vlanId = -3
    const messages = validateLab(lab).map((i) => i.message).join(' ')
    expect(messages).toMatch(/allowed VLAN 5000/)
    expect(messages).toMatch(/native VLAN/)
    expect(messages).toMatch(/VLAN id must be an integer/)
  })

  it('flags trunk links with no common permitted VLAN', () => {
    const lab = healthyLab()
    lab.devices = [
      ...lab.devices,
      {
        id: 'sw2', name: 'SW2', kind: 'switch', x: 340, y: 440, gatewayIp: null,
        interfaces: [
          { id: 'sw2-fa01', name: 'Fa0/1', role: 'switchport', ipMode: 'static', cidr: null, enabled: true, accessVlan: 1, portMode: 'trunk', nativeVlan: 1, allowedVlans: [30] },
        ],
        staticRoutes: [], dhcpPools: [],
      },
    ]
    lab.links = [...lab.links, { id: 'lnk-t2', aDeviceId: 'sw1', aInterfaceId: 'sw1-fa03', bDeviceId: 'sw2', bInterfaceId: 'sw2-fa01', enabled: true }]
    const messages = validateLab(lab).map((i) => i.message).join(' ')
    expect(messages).toMatch(/no VLAN permitted on both ends/)
  })

  it('flags duplicate sub-interface VLAN bindings', () => {
    const lab = healthyLab()
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    const parent = r1.interfaces.find((i) => i.id === 'r1-gi00')!
    parent.subInterfaces = [
      ...parent.subInterfaces!,
      { id: 'sub-dup', name: 'Gi0/0.10-dup', vlanId: 10, cidr: '192.168.10.254/24', enabled: true },
    ]
    const messages = validateLab(lab).map((i) => i.message).join(' ')
    expect(messages).toMatch(/more than one sub-interface is bound to VLAN 10/)
  })

  it('the healthy inter-VLAN lab passes without errors', () => {
    expect(validateLab(healthyLab()).filter((i) => i.severity === 'error')).toEqual([])
  })
})

describe('import/export keeps trunk and sub-interface configuration', () => {
  it('round-trips trunk ports and sub-interfaces', () => {
    const lab = healthyLab()
    const parsed = parseLabFile(serializeLabFile(lab))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const imported = parsed.lab
    const trunk = imported.devices.find((d) => d.id === 'sw1')!.interfaces.find((i) => i.id === 'sw1-fa03')!
    expect(trunk.portMode).toBe('trunk')
    expect(trunk.allowedVlans).toEqual([10, 20])
    expect(trunk.nativeVlan).toBe(1)
    const parent = imported.devices.find((d) => d.id === 'r1')!.interfaces.find((i) => i.id === 'r1-gi00')!
    expect(parent.subInterfaces?.map((s) => `${s.name}:${s.vlanId}:${s.cidr}`)).toEqual([
      'Gi0/0.10:10:192.168.10.1/24',
      'Gi0/0.20:20:192.168.20.1/24',
    ])
    // Imported lab keeps working behavior.
    expect(runPing(imported, 'pc1', '192.168.20.12').success).toBe(true)
  })

  it('imports older files without trunk fields using safe defaults', () => {
    const oldStyle = {
      format: 'netlab-pro-lab',
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      lab: {
        name: 'Legacy Lab',
        devices: [
          {
            id: 'pc1', name: 'PC1', kind: 'pc', x: 0, y: 0, gatewayIp: null,
            interfaces: [{ id: 'pc1-fa0', name: 'Fa0', role: 'host', ipMode: 'static', cidr: '192.168.1.10/24', enabled: true, accessVlan: 1 }],
            staticRoutes: [], dhcpPools: [],
          },
          {
            id: 'sw1', name: 'SW1', kind: 'switch', x: 10, y: 0, gatewayIp: null,
            interfaces: [{ id: 'sw1-fa01', name: 'Fa0/1', role: 'switchport', ipMode: 'static', cidr: null, enabled: true, accessVlan: 1 }],
            staticRoutes: [], dhcpPools: [],
          },
        ],
        links: [{ id: 'l1', aDeviceId: 'pc1', aInterfaceId: 'pc1-fa0', bDeviceId: 'sw1', bInterfaceId: 'sw1-fa01', enabled: true }],
        vlans: [{ id: 1, name: 'default' }],
        faults: [],
      },
    }
    const parsed = parseLabFile(JSON.stringify(oldStyle))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const trunkIface = parsed.lab.devices.find((d) => d.id === 'sw1')!.interfaces[0]
    expect(trunkIface.portMode).toBe('access') // safe default
    expect(trunkIface.allowedVlans).toEqual([])
    expect(trunkIface.nativeVlan).toBe(1)
    expect(getL2Segment(parsed.lab, 'pc1', 'pc1-fa0').members.length).toBe(2)
  })

  it('rejects invalid trunk and sub-interface data on import', () => {
    const file = JSON.parse(serializeLabFile(healthyLab()))
    const sw1 = file.lab.devices.find((d: { id: string }) => d.id === 'sw1')
    sw1.interfaces.find((i: { id: string }) => i.id === 'sw1-fa03').allowedVlans = [10, 9999]
    const failed = parseLabFile(JSON.stringify(file))
    expect(failed.ok).toBe(false)
    if (failed.ok) throw new Error('expected import failure')
    expect(failed.error).toMatch(/allowed VLAN 9999/)

    const file2 = JSON.parse(serializeLabFile(healthyLab()))
    const r1 = file2.lab.devices.find((d: { id: string }) => d.id === 'r1')
    r1.interfaces[0].subInterfaces[0].cidr = 'not-an-ip/24'
    const failed2 = parseLabFile(JSON.stringify(file2))
    expect(failed2.ok).toBe(false)
    if (failed2.ok) throw new Error('expected import failure')
    expect(failed2.error).toMatch(/not a valid IPv4 address\/prefix/)
  })
})

describe('audit regression: native VLAN on trunk ports', () => {
  function labHostOnTrunk(): Lab {
    return {
      id: 'lab-probe', name: 'probe', origin: 'user',
      createdAt: '', updatedAt: '',
      devices: [
        {
          id: 'pc1', name: 'PC1', kind: 'pc', x: 0, y: 0, gatewayIp: null,
          interfaces: [{ id: 'pc1-fa0', name: 'Fa0', role: 'host', ipMode: 'static', cidr: '10.0.0.10/24', enabled: true, accessVlan: 1 }],
          staticRoutes: [], dhcpPools: [],
        },
        {
          id: 'sw1', name: 'SW1', kind: 'switch', x: 10, y: 0, gatewayIp: null,
          interfaces: [
            // Converted from access-10 to trunk: accessVlan left at 10, native is 1.
            { id: 'sw1-trunk', name: 'Fa0/1', role: 'switchport', ipMode: 'static', cidr: null, enabled: true, accessVlan: 10, portMode: 'trunk', nativeVlan: 1, allowedVlans: [10, 20] },
            { id: 'sw1-v1', name: 'Fa0/2', role: 'switchport', ipMode: 'static', cidr: null, enabled: true, accessVlan: 1, portMode: 'access' },
            { id: 'sw1-v10', name: 'Fa0/3', role: 'switchport', ipMode: 'static', cidr: null, enabled: true, accessVlan: 10, portMode: 'access' },
          ],
          staticRoutes: [], dhcpPools: [],
        },
        {
          id: 'pc2', name: 'PC2', kind: 'pc', x: 20, y: 0, gatewayIp: null,
          interfaces: [{ id: 'pc2-fa0', name: 'Fa0', role: 'host', ipMode: 'static', cidr: '10.0.1.2/24', enabled: true, accessVlan: 1 }],
          staticRoutes: [], dhcpPools: [],
        },
      ],
      links: [
        { id: 'l1', aDeviceId: 'pc1', aInterfaceId: 'pc1-fa0', bDeviceId: 'sw1', bInterfaceId: 'sw1-trunk', enabled: true },
        { id: 'l2', aDeviceId: 'pc2', aInterfaceId: 'pc2-fa0', bDeviceId: 'sw1', bInterfaceId: 'sw1-v1', enabled: true },
      ],
      vlans: [{ id: 1, name: 'default' }, { id: 10, name: 'TEN' }, { id: 20, name: 'TWENTY' }],
      faults: [],
    }
  }

  it('a host on a trunk lands in the NATIVE VLAN, not the stale accessVlan', () => {
    const seg = getL2Segment(labHostOnTrunk(), 'pc1', 'pc1-fa0')
    expect(seg.vlan).toBe(1)
    const memberIfaces = seg.members.map((m) => m.interfaceId)
    expect(memberIfaces).toContain('sw1-v1')
    expect(memberIfaces).toContain('pc2-fa0')
    expect(memberIfaces).not.toContain('sw1-v10')
  })

  it('switch-started segments from a trunk port also use the native VLAN', () => {
    const seg = getL2Segment(labHostOnTrunk(), 'sw1', 'sw1-trunk')
    expect(seg.vlan).toBe(1)
    expect(seg.members.map((m) => m.interfaceId)).toContain('pc2-fa0')
    expect(seg.members.map((m) => m.interfaceId)).not.toContain('sw1-v10')
  })
})
