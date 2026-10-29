// Phase 2C feature tests: ACLs — rule ordering, permit/deny, protocol and
// port matching, directions, implicit permit, diagnostics and repair.

import { describe, expect, it } from 'vitest'
import { runPing } from './ping'
import { detectIssues, faultMatchesIssue, applyFixToLab, applyAllFixes } from './faults'
import { validateLab } from './validate'
import { parseLabFile, serializeLabFile } from './labFile'
import { buildAclLab, buildOfficeLab, buildTwoRouterLab } from '../data/sampleLabs'
import type { Lab } from './types'

const healthyLab = (): Lab => buildAclLab()

function aclOf(lab: Lab): { acl: NonNullable<NonNullable<Lab['devices'][number]['interfaces'][number]['acls']>>[number]; iface: Lab['devices'][number]['interfaces'][number] } {
  const iface = lab.devices.find((d) => d.id === 'r1')!.interfaces.find((i) => i.id === 'r1-gi01')!
  const acl = iface.acls![0]
  return { acl, iface }
}

describe('ACL simulation on the sample policy', () => {
  it('permitted ICMP pings succeed through the ACL', () => {
    const result = runPing(healthyLab(), 'pc1', '203.0.113.20')
    expect(result.success).toBe(true)
    // The decision is visible in the result.
    expect(result.aclHit).toBeDefined()
    expect(result.aclHit!.action).toBe('permit')
    expect(result.aclHit!.aclName).toBe('SERVER-POLICY')
    expect(result.aclHit!.direction).toBe('out')
    expect(result.aclHit!.ruleIndex).toBe(1)
  })

  it('denied tcp/23 telnet traffic fails with a structured ACL decision', () => {
    const result = runPing(healthyLab(), 'pc1', '203.0.113.20', { protocol: 'tcp', destPort: 23 })
    expect(result.success).toBe(false)
    expect(result.failCode).toBe('acl-denied')
    expect(result.aclHit).toMatchObject({
      deviceId: 'r1',
      interfaceId: 'r1-gi01',
      aclName: 'SERVER-POLICY',
      direction: 'out',
      action: 'deny',
      ruleIndex: 0,
      destPort: 23,
    })
    expect(result.explanation).toMatch(/first-match-wins/)
    expect(result.explanation).toMatch(/deny tcp any → 203\.0\.113\.20 port 23/)
  })

  it('tcp on a different port is permitted by a later rule (port matching)', () => {
    expect(runPing(healthyLab(), 'pc1', '203.0.113.20', { protocol: 'tcp', destPort: 80 }).success).toBe(true)
    expect(runPing(healthyLab(), 'pc1', '203.0.113.20', { protocol: 'udp', destPort: 53 }).success).toBe(true)
  })
})

describe('first-match-wins ordering', () => {
  it('a deny placed before a host permit shadows it', () => {
    const lab = healthyLab()
    const { acl } = aclOf(lab)
    acl.rules = [
      { id: 'r-broad', action: 'deny', protocol: 'icmp', source: '192.168.10.0/24', destination: 'any', destPort: null, enabled: true },
      { id: 'r-host', action: 'permit', protocol: 'icmp', source: '192.168.10.11', destination: 'any', destPort: null, enabled: true },
    ]
    const result = runPing(lab, 'pc1', '203.0.113.20')
    expect(result.success).toBe(false)
    expect(result.aclHit!.ruleId).toBe('r-broad')
  })

  it('reordering the same rules lets the specific permit win', () => {
    const lab = healthyLab()
    const { acl } = aclOf(lab)
    acl.rules = [
      { id: 'r-host', action: 'permit', protocol: 'icmp', source: '192.168.10.11', destination: 'any', destPort: null, enabled: true },
      { id: 'r-broad', action: 'deny', protocol: 'icmp', source: '192.168.10.0/24', destination: 'any', destPort: null, enabled: true },
    ]
    const result = runPing(lab, 'pc1', '203.0.113.20')
    expect(result.success).toBe(true)
    expect(result.aclHit!.ruleId).toBe('r-host')

    // A different host (not covered by the specific permit) is denied.
    const lab2 = structuredClone(lab)
    lab2.devices.find((d) => d.id === 'pc1')!.interfaces[0].cidr = '192.168.10.77/24'
    const result2 = runPing(lab2, 'pc1', '203.0.113.20')
    expect(result2.success).toBe(false)
    expect(result2.aclHit!.ruleId).toBe('r-broad')
  })

  it('unmatched traffic is implicitly permitted (no rules at all)', () => {
    const lab = healthyLab()
    const { iface } = aclOf(lab)
    iface.acls = [{ id: 'acl-empty', name: 'EMPTY', direction: 'out', rules: [] }]
    const result = runPing(lab, 'pc1', '203.0.113.20')
    expect(result.success).toBe(true)
    expect(result.aclHit).toBeUndefined()
  })
})

describe('inbound vs outbound directions', () => {
  it('an inbound ACL on the LAN interface blocks arriving packets', () => {
    const lab = healthyLab()
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    const sub = r1.interfaces.find((i) => i.id === 'r1-gi00')!.subInterfaces![0]
    // Inbound ACLs evaluate on the physical ingress port (documented model).
    const physical = r1.interfaces.find((i) => i.id === 'r1-gi00')!
    physical.acls = [
      { id: 'acl-in', name: 'LAN-IN', direction: 'in', rules: [{ id: 'r-in', action: 'deny', protocol: 'icmp', source: 'any', destination: 'any', destPort: null, enabled: true }] },
    ]
    void sub
    const result = runPing(lab, 'pc1', '203.0.113.20')
    expect(result.success).toBe(false)
    expect(result.failCode).toBe('acl-denied')
    expect(result.aclHit).toMatchObject({ interfaceId: 'r1-gi00', direction: 'in', aclName: 'LAN-IN' })
  })

  it('an outbound ACL on the LAN egress sub-interface blocks replies-direction traffic', () => {
    const lab = healthyLab()
    // Egress toward VLAN 10 happens through the sub-interface.
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    const sub = r1.interfaces.find((i) => i.id === 'r1-gi00')!.subInterfaces![0]
    sub.acls = [
      { id: 'acl-sub', name: 'VLAN10-OUT', direction: 'out', rules: [{ id: 'r-sub', action: 'deny', protocol: 'icmp', source: 'any', destination: 'any', destPort: null, enabled: true }] },
    ]
    // SRV1 pinging PC1: R1 egress via Gi0/0.10 → blocked by the sub-interface ACL.
    const result = runPing(lab, 'srv1', '192.168.10.11')
    expect(result.success).toBe(false)
    expect(result.aclHit).toMatchObject({ subInterfaceId: sub.id, subInterfaceName: 'Gi0/0.10', direction: 'out' })
  })

  it('a rule for the wrong direction never matches', () => {
    const lab = healthyLab()
    const { iface } = aclOf(lab)
    iface.acls = [
      { id: 'acl-in-only', name: 'IN-ONLY', direction: 'in', rules: [{ id: 'r', action: 'deny', protocol: 'icmp', source: 'any', destination: 'any', destPort: null, enabled: true }] },
    ]
    // Egress traffic is unaffected by an inbound ACL.
    expect(runPing(lab, 'pc1', '203.0.113.20').success).toBe(true)
  })
})

describe('ACL diagnostics and repair', () => {
  it('an injected deny rule is detected, anchored and fixable', () => {
    const lab = healthyLab()
    lab.faults = [{ id: 'f1', kind: 'acl-blocks-traffic', deviceId: 'r1', interfaceId: 'r1-gi01', value: 'out icmp any any', active: true }]
    const broken = runPing(lab, 'pc1', '203.0.113.20')
    expect(broken.failCode).toBe('acl-denied')

    const { issues, suite } = detectIssues(lab)
    const match = issues.find((i) => i.kind === 'acl-blocks-traffic' && i.deviceId === 'r1' && i.interfaceId === 'r1-gi01')
    expect(match).toBeDefined()
    expect(match!.evidence).toMatch(/deny icmp/)
    expect(lab.faults[0] && issues.some((i) => faultMatchesIssue(lab.faults[0], i))).toBe(true)
    expect(suite.some((s) => !s.result.success)).toBe(true)
    expect(match!.fix).toMatchObject({ type: 'remove-acl-rule', deviceId: 'r1', interfaceId: 'r1-gi01' })

    // Fixing restores connectivity (fault overlay deactivated first, as in the runner).
    let fixed: Lab = { ...lab, faults: [] }
    fixed = applyAllFixes(fixed).lab
    expect(detectIssues(fixed).suite.every((s) => s.result.success)).toBe(true)

    // Direct machine fix on a genuinely broken config also works.
    const manual = healthyLab()
    const { iface } = aclOf(manual)
    iface.acls![0].rules = [
      { id: 'bad-deny', action: 'deny', protocol: 'icmp', source: 'any', destination: 'any', destPort: null, enabled: true },
      ...iface.acls![0].rules,
    ]
    const detected = detectIssues(manual)
    const fix = detected.issues.find((i) => i.kind === 'acl-blocks-traffic')?.fix
    const repaired = applyFixToLab(manual, fix!)
    expect(runPing(repaired, 'pc1', '203.0.113.20').success).toBe(true)
    // The rule list shrank by exactly one.
    const repairedAcl = repaired.devices.find((d) => d.id === 'r1')!.interfaces.find((i) => i.id === 'r1-gi01')!.acls![0]
    expect(repairedAcl.rules.some((r) => r.id === 'bad-deny')).toBe(false)
  })
})

describe('ACL validation', () => {
  it('flags invalid source/destination targets, ports and protocols', () => {
    const lab = healthyLab()
    const { acl } = aclOf(lab)
    acl.rules = [
      { id: 'r1', action: 'deny', protocol: 'tcp', source: 'not-an-ip', destination: '203.0.113.20', destPort: 23, enabled: true },
      { id: 'r2', action: 'deny', protocol: 'icmp', source: 'any', destination: 'any', destPort: 80, enabled: true },
      { id: 'r3', action: 'deny', protocol: 'gre' as never, source: 'any', destination: 'any', destPort: null, enabled: true },
      { id: 'r4', action: 'deny', protocol: 'tcp', source: 'any', destination: 'any', destPort: 99999, enabled: true },
    ]
    const messages = validateLab(lab).map((i) => i.message).join(' ')
    expect(messages).toMatch(/invalid source "not-an-ip"/)
    expect(messages).toMatch(/destination port on an icmp rule/)
    expect(messages).toMatch(/unsupported protocol "gre"/)
    expect(messages).toMatch(/invalid destination port 99999/)
  })

  it('flags duplicate directions and duplicate rule ids', () => {
    const lab = healthyLab()
    const { iface, acl } = aclOf(lab)
    iface.acls = [
      acl,
      { ...acl, id: 'acl-second', name: 'SECOND', direction: 'out', rules: [{ ...acl.rules[0], id: 'dup' }] },
    ]
    const copy = structuredClone(acl)
    copy.rules = [
      { id: 'dup', action: 'permit', protocol: 'icmp', source: 'any', destination: 'any', destPort: null, enabled: true },
      { id: 'dup', action: 'deny', protocol: 'icmp', source: 'any', destination: 'any', destPort: null, enabled: true },
    ]
    iface.acls = [copy, { ...acl, id: 'acl-second', name: 'SECOND', direction: 'out', rules: [] }]
    const messages = validateLab(lab).map((i) => i.message).join(' ')
    expect(messages).toMatch(/more than one ACL is attached for direction "out"/)
    expect(messages).toMatch(/duplicate rule id "dup"/)
  })

  it('flags ACLs on non-routed interfaces as ignored', () => {
    const lab = healthyLab()
    const sw1 = lab.devices.find((d) => d.id === 'sw1')!
    sw1.interfaces[0].acls = [{ id: 'acl-sw', name: 'SW-ACL', direction: 'in', rules: [] }]
    const messages = validateLab(lab).map((i) => i.message).join(' ')
    expect(messages).toMatch(/ACLs are only evaluated on routed router interfaces/)
  })

  it('the healthy ACL lab passes without errors', () => {
    expect(validateLab(healthyLab()).filter((i) => i.severity === 'error')).toEqual([])
  })
})

describe('import/export of ACLs', () => {
  it('round-trips the SERVER-POLICY ACL', () => {
    const parsed = parseLabFile(serializeLabFile(healthyLab()))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const acl = parsed.lab.devices.find((d) => d.id === 'r1')!.interfaces.find((i) => i.id === 'r1-gi01')!.acls![0]
    expect(acl.name).toBe('SERVER-POLICY')
    expect(acl.direction).toBe('out')
    expect(acl.rules[0]).toMatchObject({ action: 'deny', protocol: 'tcp', destination: '203.0.113.20', destPort: 23 })
    expect(acl.rules).toHaveLength(4)
    // Behavior survives the round-trip.
    expect(runPing(parsed.lab, 'pc1', '203.0.113.20').success).toBe(true)
    expect(runPing(parsed.lab, 'pc1', '203.0.113.20', { protocol: 'tcp', destPort: 23 }).success).toBe(false)
  })

  it('rejects malformed ACL rules on import', () => {
    const file = JSON.parse(serializeLabFile(healthyLab()))
    const r1 = file.lab.devices.find((d: { id: string }) => d.id === 'r1')
    const acl = r1.interfaces.find((i: { id: string }) => i.id === 'r1-gi01').acls[0]
    acl.rules[0].action = 'maybe'
    const failed = parseLabFile(JSON.stringify(file))
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error).toMatch(/permit" or "deny"/)

    const file2 = JSON.parse(serializeLabFile(healthyLab()))
    const acl2 = file2.lab.devices.find((d: { id: string }) => d.id === 'r1').interfaces.find((i: { id: string }) => i.id === 'r1-gi01').acls[0]
    acl2.rules[0].source = '192.168.1.0/33'
    const failed2 = parseLabFile(JSON.stringify(file2))
    expect(failed2.ok).toBe(false)
    if (!failed2.ok) expect(failed2.error).toMatch(/CIDR range/)
  })

  it('imports older labs without ACL fields using safe defaults', () => {
    const file = JSON.parse(serializeLabFile(healthyLab()))
    delete file.lab.devices.find((d: { id: string }) => d.id === 'r1').interfaces.find((i: { id: string }) => i.id === 'r1-gi01').acls
    const parsed = parseLabFile(JSON.stringify(file))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const iface = parsed.lab.devices.find((d) => d.id === 'r1')!.interfaces.find((i) => i.id === 'r1-gi01')!
    expect(iface.acls).toBeUndefined()
    expect(runPing(parsed.lab, 'pc1', '203.0.113.20').success).toBe(true)
  })
})

describe('router ping source selection (audit follow-up)', () => {
  function sw1In(lab: Lab) {
    return lab.devices.find((d) => d.id === 'sw1')!
  }

  function labSubOnlyRouter(): Lab {
    // Router-on-a-stick with TWO sub-interfaces and no physical address:
    // egress toward each VLAN must select that VLAN's sub-interface address.
    const lab = healthyLab()
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    const gi00 = r1.interfaces.find((i) => i.id === 'r1-gi00')!
    gi00.subInterfaces = [
      ...(gi00.subInterfaces ?? []),
      { id: 'r1-gi00-sub20', name: 'Gi0/0.20', vlanId: 20, cidr: '192.168.20.1/24', enabled: true },
    ]
    // Permit VLAN 20 on the trunk and add a second switch segment with PC2 behind it.
    const trunk = sw1In(lab).interfaces.find((i) => i.id === 'sw1-fa03')!
    trunk.allowedVlans = [10, 20]
    lab.devices = [
      ...lab.devices,
      {
        id: 'pc2', name: 'PC2', kind: 'pc', x: 80, y: 360, gatewayIp: '192.168.20.1',
        interfaces: [{ id: 'pc2-fa0', name: 'Fa0', role: 'host', ipMode: 'static', cidr: '192.168.20.12/24', enabled: true, accessVlan: 20 }],
        staticRoutes: [], dhcpPools: [],
      },
    ]
    const sw1 = sw1In(lab)
    sw1.interfaces = [
      ...sw1.interfaces,
      { id: 'sw1-fa04', name: 'Fa0/4', role: 'switchport', ipMode: 'static', cidr: null, enabled: true, accessVlan: 20, portMode: 'access' },
    ]
    lab.links = [
      ...lab.links,
      { id: 'lnk-pc2-sw1', aDeviceId: 'pc2', aInterfaceId: 'pc2-fa0', bDeviceId: 'sw1', bInterfaceId: 'sw1-fa04', enabled: true },
    ]
    return lab
  }

  it('a sub-interface-only router sources pings from the egress sub-interface', () => {
    const lab = labSubOnlyRouter()
    const toVlan10 = runPing(lab, 'r1', '192.168.10.11')
    expect(toVlan10.success).toBe(true)
    expect(toVlan10.sourceIp).toBe('192.168.10.1')
    expect(toVlan10.sourceInterfaceName).toBe('Gi0/0.10')

    const toVlan20 = runPing(lab, 'r1', '192.168.20.12')
    expect(toVlan20.success).toBe(true)
    expect(toVlan20.sourceIp).toBe('192.168.20.1')
    expect(toVlan20.sourceInterfaceName).toBe('Gi0/0.20')
  })

  it('outbound ACLs match the SELECTED source IP (deny and permit)', () => {
    const lab = labSubOnlyRouter()
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    const gi00 = r1.interfaces.find((i) => i.id === 'r1-gi00')!
    const sub10 = gi00.subInterfaces!.find((s) => s.id === 'r1-gi00-sub10')!
    // Deny only traffic sourced from 192.168.10.1 (the selected source).
    sub10.acls = [
      { id: 'acl-src', name: 'SOURCE-FILTER', direction: 'out', rules: [{ id: 'r-deny', action: 'deny', protocol: 'icmp', source: '192.168.10.1', destination: 'any', destPort: null, enabled: true }] },
    ]
    const denied = runPing(lab, 'r1', '192.168.10.11')
    expect(denied.success).toBe(false)
    expect(denied.failCode).toBe('acl-denied')
    expect(denied.aclHit).toMatchObject({ subInterfaceId: 'r1-gi00-sub10', ruleIndex: 0 })

    // A source-based permit: deny everything EXCEPT the selected source.
    sub10.acls = [
      { id: 'acl-src2', name: 'SOURCE-FILTER-2', direction: 'out', rules: [{ id: 'r-permit', action: 'permit', protocol: 'icmp', source: '192.168.10.1', destination: 'any', destPort: null, enabled: true }] },
    ]
    const permitted = runPing(lab, 'r1', '192.168.10.11')
    expect(permitted.success).toBe(true)
    expect(permitted.aclHit).toMatchObject({ action: 'permit', source: '192.168.10.1' })
  })

  it('source selection follows the actual egress path per destination', () => {
    const lab = labSubOnlyRouter()
    // PC1 (VLAN 10) vs PC2 (VLAN 20) select different sub-interface sources.
    expect(runPing(lab, 'r1', '192.168.10.11').sourceIp).toBe('192.168.10.1')
    expect(runPing(lab, 'r1', '192.168.20.12').sourceIp).toBe('192.168.20.1')
    // And with an any-source deny on sub 10, VLAN 20 traffic is unaffected.
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    const sub10 = r1.interfaces.find((i) => i.id === 'r1-gi00')!.subInterfaces!.find((s) => s.id === 'r1-gi00-sub10')!
    sub10.acls = [
      { id: 'acl-10', name: 'VLAN10-DENY', direction: 'out', rules: [{ id: 'r', action: 'deny', protocol: 'icmp', source: 'any', destination: 'any', destPort: null, enabled: true }] },
    ]
    expect(runPing(lab, 'r1', '192.168.10.11').success).toBe(false)
    expect(runPing(lab, 'r1', '192.168.20.12').success).toBe(true)
  })

  it('static-route pings source from the interface that reaches the next hop', () => {
    const twoRouter = buildTwoRouterLab()
    const result = runPing(twoRouter, 'r1', '172.16.20.20')
    expect(result.success).toBe(true)
    expect(result.sourceIp).toBe('10.0.0.1')
    expect(result.sourceInterfaceName).toBe('Gi0/1')
  })

  it('existing host pings and the ACL sample lab keep their behavior', () => {
    // Host source selection is unchanged.
    const office = buildOfficeLab()
    expect(runPing(office, 'pc1', '10.0.0.20').sourceIp).toBe('192.168.1.10')
    // The ACL sample lab router now sources from the egress sub toward the LAN.
    const aclLab = healthyLab()
    const toLan = runPing(aclLab, 'r1', '192.168.10.11')
    expect(toLan.success).toBe(true)
    expect(toLan.sourceIp).toBe('192.168.10.1')
    // Server-direction traffic still passes the outbound SERVER-POLICY ACL.
    expect(runPing(aclLab, 'pc1', '203.0.113.20').success).toBe(true)
  })
})
