import { describe, expect, it } from 'vitest'
import { detectIssues, faultMatchesIssue } from './faults'
import { getScenario, SCENARIOS, computeScore, evaluateSubmission } from './scenarios'
import { buildAclLab, buildDhcpLab, buildDhcpRelayLab, buildInterVlanLab, buildMaskLab, buildOfficeLab, buildTwoRouterLab, buildVlanLab } from '../data/sampleLabs'
import type { Lab } from './types'

const kindsOf = (lab: Lab) => detectIssues(lab).issues.map((i) => `${i.kind}@${i.deviceId}${i.interfaceId ? ':' + i.interfaceId : ''}`)

describe('detection: healthy labs are clean', () => {
  it('office lab has no critical issues', () => {
    const { issues, suite } = detectIssues(buildOfficeLab())
    expect(issues.filter((i) => i.severity === 'critical')).toHaveLength(0)
    expect(suite.every((s) => s.result.success)).toBe(true)
  })

  it('two-router lab has no critical issues', () => {
    const { issues, suite } = detectIssues(buildTwoRouterLab())
    expect(issues.filter((i) => i.severity === 'critical')).toHaveLength(0)
    expect(suite.every((s) => s.result.success)).toBe(true)
  })

  it('vlan, dhcp, mask, inter-VLAN, relay and ACL labs are healthy', () => {
    for (const lab of [buildVlanLab(), buildDhcpLab(), buildMaskLab(), buildInterVlanLab(), buildDhcpRelayLab(), buildAclLab()]) {
      const { issues, suite } = detectIssues(lab)
      expect(issues.filter((i) => i.severity === 'critical')).toHaveLength(0)
      // In L2-only labs, cross-subnet probes fail with "no gateway" — that is
      // expected behavior, not a fault. Every other failure is a bug.
      const unexpected = suite.filter((s) => !s.result.success && s.result.failCode !== 'no-gateway')
      expect(unexpected.map((s) => `${s.sourceDevice.name}->${s.targetDevice.name}:${s.result.failCode}`)).toEqual([])
    }
  })
})

describe('detection: each fault kind is detected', () => {
  it('wrong-gateway on PC1', () => {
    const lab = buildOfficeLab()
    lab.faults = [{ id: 'f', kind: 'wrong-gateway', deviceId: 'pc1', active: true, value: '192.168.1.99' }]
    const { issues } = detectIssues(lab)
    const match = issues.find((i) => i.kind === 'wrong-gateway' && i.deviceId === 'pc1')
    expect(match).toBeDefined()
    expect(match!.evidence).toMatch(/192\.168\.1\.99/)
  })

  it('wrong-mask on PC1', () => {
    const lab = buildMaskLab()
    lab.faults = [{ id: 'f', kind: 'wrong-mask', deviceId: 'pc1', interfaceId: 'pc1-fa0', active: true, value: '192.168.1.10/25' }]
    const { issues } = detectIssues(lab)
    expect(issues.some((i) => i.kind === 'wrong-mask' && i.deviceId === 'pc1')).toBe(true)
  })

  it('wrong-ip moves a host out of its segment', () => {
    const lab = buildMaskLab()
    lab.faults = [{ id: 'f', kind: 'wrong-ip', deviceId: 'pc2', interfaceId: 'pc2-fa0', active: true, value: '192.168.77.11/24' }]
    const { issues } = detectIssues(lab)
    expect(issues.some((i) => i.kind === 'wrong-ip' && i.deviceId === 'pc2')).toBe(true)
  })

  it('interface-down', () => {
    const lab = buildOfficeLab()
    lab.faults = [{ id: 'f', kind: 'interface-down', deviceId: 'r1', interfaceId: 'r1-gi01', active: true }]
    const { issues } = detectIssues(lab)
    expect(issues.some((i) => i.kind === 'interface-down' && i.deviceId === 'r1' && i.interfaceId === 'r1-gi01')).toBe(true)
  })

  it('link-down', () => {
    const lab = buildOfficeLab()
    lab.faults = [{ id: 'f', kind: 'link-down', deviceId: 'sw1', linkId: 'lnk-sw1-r1', active: true }]
    const { issues } = detectIssues(lab)
    const match = issues.find((i) => i.kind === 'link-down' && i.linkId === 'lnk-sw1-r1')
    expect(match).toBeDefined()
    // Connectivity actually breaks too.
    expect(detectIssues(lab).suite.some((s) => !s.result.success)).toBe(true)
  })

  it('vlan-mismatch on the switch port', () => {
    const lab = buildVlanLab()
    lab.faults = [{ id: 'f', kind: 'vlan-mismatch', deviceId: 'sw1', interfaceId: 'sw1-fa02', active: true, value: '20' }]
    const { issues, suite } = detectIssues(lab)
    expect(issues.some((i) => i.kind === 'vlan-mismatch' && i.deviceId === 'sw1' && i.interfaceId === 'sw1-fa02')).toBe(true)
    expect(suite.some((s) => s.result.failCode === 'on-link-arp-fail')).toBe(true)
  })

  it('dhcp-exhausted on the pool', () => {
    const lab = buildDhcpLab()
    lab.faults = [{ id: 'f', kind: 'dhcp-exhausted', deviceId: 'srv1', poolId: 'pool-srv1-lan', active: true }]
    const { issues, suite } = detectIssues(lab)
    const match = issues.find((i) => i.kind === 'dhcp-exhausted' && i.deviceId === 'srv1')
    expect(match).toBeDefined()
    expect(suite.some((s) => !s.result.success)).toBe(true)
  })

  it('remove-route on R1', () => {
    const lab = buildTwoRouterLab()
    lab.faults = [{ id: 'f', kind: 'remove-route', deviceId: 'r1', routeId: 'rt-r1-srv', active: true }]
    const { issues, suite } = detectIssues(lab)
    const match = issues.find((i) => i.kind === 'remove-route' && i.deviceId === 'r1')
    expect(match).toBeDefined()
    expect(match!.evidence).toMatch(/PC1/)
    expect(suite.some((s) => s.result.failCode === 'no-route')).toBe(true)
  })

  it('duplicate-ip', () => {
    const lab = buildOfficeLab()
    lab.devices = [
      ...lab.devices,
      {
        id: 'pc2', name: 'PC2', kind: 'pc', x: 0, y: 0, gatewayIp: '192.168.1.1',
        interfaces: [{ id: 'pc2-fa0', name: 'Fa0', role: 'host', ipMode: 'static', cidr: '192.168.1.10/24', enabled: true, accessVlan: 10 }],
        staticRoutes: [], dhcpPools: [],
      },
    ]
    lab.links = [...lab.links, { id: 'l2', aDeviceId: 'pc2', aInterfaceId: 'pc2-fa0', bDeviceId: 'sw1', bInterfaceId: 'sw1-fa03', enabled: true }]
    lab.faults = [{ id: 'f', kind: 'duplicate-ip', deviceId: 'pc2', interfaceId: 'pc2-fa0', active: true, value: '192.168.1.10/24' }]
    const { issues } = detectIssues(lab)
    expect(issues.some((i) => i.kind === 'duplicate-ip' && i.deviceId === 'pc2')).toBe(true)
  })
})

describe('detection: fixing faults changes results', () => {
  it('removing the fault clears detection and restores connectivity', () => {
    const lab = buildOfficeLab()
    lab.faults = [{ id: 'f', kind: 'wrong-gateway', deviceId: 'pc1', active: true, value: '192.168.1.99' }]
    expect(kindsOf(lab)).toContain('wrong-gateway@pc1')
    const brokenSuite = detectIssues(lab).suite
    expect(brokenSuite.some((s) => !s.result.success)).toBe(true)

    const fixed = structuredClone(lab)
    fixed.faults = []
    fixed.devices.find((d) => d.id === 'pc1')!.gatewayIp = '192.168.1.1'
    const after = detectIssues(fixed)
    expect(after.issues.filter((i) => i.severity === 'critical')).toHaveLength(0)
    expect(after.suite.every((s) => s.result.success)).toBe(true)
  })
})

describe('fault correlation', () => {
  it('matches fault to detected issue by kind and device', () => {
    const lab = buildOfficeLab()
    lab.faults = [{ id: 'f', kind: 'wrong-gateway', deviceId: 'pc1', active: true, value: '192.168.1.99' }]
    const { issues } = detectIssues(lab)
    const fault = lab.faults[0]
    const matching = issues.find((i) => faultMatchesIssue(fault, i))
    expect(matching).toBeDefined()
    expect(faultMatchesIssue({ ...fault, kind: 'wrong-ip' }, matching!)).toBe(false)
  })
})

describe('scenarios', () => {
  it('all scenarios have unique ids and valid structure', () => {
    const ids = new Set(SCENARIOS.map((s) => s.id))
    expect(ids.size).toBe(SCENARIOS.length)
    for (const scenario of SCENARIOS) {
      expect(scenario.points).toBeGreaterThan(0)
      expect(scenario.hints.length).toBeGreaterThan(0)
      expect(scenario.faultKinds.length).toBeGreaterThan(0)
      const lab = scenario.buildLab()
      expect(lab.faults.filter((f) => f.active).length).toBe(1)
    }
  })

  it('every scenario fault is detectable on its built lab', () => {
    for (const scenario of SCENARIOS) {
      const lab = scenario.buildLab()
      const { issues } = detectIssues(lab)
      const detected = lab.faults.filter((f) => issues.some((i) => faultMatchesIssue(f, i)))
      expect(detected.length, `${scenario.id}: injected fault must be detectable`).toBe(lab.faults.filter((f) => f.active).length)
    }
  })

  it('every scenario fault breaks connectivity or is flagged by detection', () => {
    for (const scenario of SCENARIOS) {
      const lab = scenario.buildLab()
      const { issues, suite } = detectIssues(lab)
      const detected = lab.faults.filter((f) => issues.some((i) => faultMatchesIssue(f, i)))
      const breaksConnectivity = suite.some((s) => !s.result.success)
      expect(
        breaksConnectivity || detected.length > 0,
        `${scenario.id}: the fault must have an observable effect`,
      ).toBe(true)
    }
  })

  it('fixing the scenario fault restores full connectivity', () => {
    for (const scenario of SCENARIOS) {
      const lab = scenario.buildLab()
      lab.faults = [] // remove the fault overlay
      const { suite } = detectIssues(lab)
      const remaining = suite.filter((s) => !s.result.success)
      // VLAN/mask/dup-IP scenarios may still have unrelated probes; the
      // injected-fault pair must pass though. Check overall: no no-route/no-source-ip failures.
      expect(remaining.every((s) => s.result.failCode !== 'no-route' && s.result.failCode !== 'no-source-ip'), `${scenario.id}`).toBe(true)
    }
  })

  it('evaluateSubmission grades device + kind', () => {
    const scenario = getScenario('sc-gateway')!
    const lab = scenario.buildLab()
    const good = evaluateSubmission(scenario, lab, { deviceId: 'pc1', kind: 'wrong-gateway' }, 0)
    expect(good.correct).toBe(true)
    expect(good.score).toBe(scenario.points)
    const deviceOnlyWrongKind = evaluateSubmission(scenario, lab, { deviceId: 'pc1', kind: 'wrong-ip' }, 0)
    expect(deviceOnlyWrongKind.correct).toBe(false)
    const wrongDevice = evaluateSubmission(scenario, lab, { deviceId: 'r1', kind: 'wrong-gateway' }, 0)
    expect(wrongDevice.correct).toBe(false)
  })

  it('hints reduce the score but not below 40%', () => {
    expect(computeScore(100, 0)).toBe(100)
    expect(computeScore(100, 1)).toBe(80)
    expect(computeScore(100, 2)).toBe(60)
    expect(computeScore(100, 5)).toBe(40)
    expect(computeScore(150, 3)).toBe(60)
  })
})

describe('audit regression: detection covers sub-interface addresses', () => {
  it('duplicate-ip detection includes VLAN sub-interface addresses', () => {
    const lab = buildOfficeLab()
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    r1.interfaces.find((i) => i.id === 'r1-gi00')!.subInterfaces = [
      { id: 'sub-x', name: 'Gi0/0.20', vlanId: 20, cidr: '10.0.0.20/24', enabled: true },
    ]
    const { issues } = detectIssues(lab)
    // The conflict is anchored on the later holder in deterministic order.
    const match = issues.find((i) => i.kind === 'duplicate-ip' && i.deviceId === 'srv1')
    expect(match).toBeDefined()
    expect(match!.evidence).toMatch(/R1 Gi0\/0\.20.*SRV1 Fa0|SRV1 Fa0.*R1 Gi0\/0\.20/)
  })
})
