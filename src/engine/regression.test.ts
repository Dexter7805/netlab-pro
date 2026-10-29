// Regression tests for the integration and safety guarantees between
// NetLab and NetDoctor: engine functions never mutate their inputs, scenario
// labs are independent copies, and applying detection fixes both corrects the
// intended fault and restores connectivity.

import { describe, expect, it } from 'vitest'
import { applyFaults } from './effective'
import { applyAllFixes, applyFixToLab, detectIssues, faultMatchesIssue } from './faults'
import { SCENARIOS, evaluateSubmission, getScenario } from './scenarios'
import { buildOfficeLab, buildTwoRouterLab } from '../data/sampleLabs'
import type { Lab } from './types'

function snapshot(lab: Lab): string {
  return JSON.stringify(lab)
}

describe('engine functions are pure (no input mutation)', () => {
  it('applyFaults does not mutate the base lab', () => {
    const lab = buildTwoRouterLab()
    lab.faults = [{ id: 'f', kind: 'wrong-gateway', deviceId: 'pc1', active: true, value: '192.168.1.99' }]
    const before = snapshot(lab)
    applyFaults(lab)
    expect(snapshot(lab)).toBe(before)
  })

  it('detectIssues does not mutate the lab (faults included)', () => {
    const lab = getScenario('sc-gateway')!.buildLab()
    const before = snapshot(lab)
    detectIssues(lab)
    expect(snapshot(lab)).toBe(before)
  })

  it('applyFixToLab returns a new lab and leaves the original untouched', () => {
    const lab = getScenario('sc-route')!.buildLab()
    const before = snapshot(lab)
    const fixed = applyFixToLab(lab, {
      type: 'restore-route',
      deviceId: 'r1',
      route: { destinationCidr: '172.16.20.0/24', nextHopIp: '10.0.0.2' },
    })
    expect(fixed).not.toBe(lab)
    expect(snapshot(lab)).toBe(before)
    expect(fixed.devices.find((d) => d.id === 'r1')!.staticRoutes).toHaveLength(1)
  })
})

describe('scenario labs are independent copies', () => {
  it('buildLab returns a fresh object on every call', () => {
    for (const scenario of SCENARIOS) {
      const a = scenario.buildLab()
      const b = scenario.buildLab()
      expect(a).not.toBe(b)
      a.devices[0].name = 'MUTATED'
      expect(b.devices[0].name).not.toBe('MUTATED')
      expect(a.faults.every((f) => f.active)).toBe(true)
    }
  })

  it('mutating the detected issues cannot alter the lab', () => {
    const lab = getScenario('sc-mask')!.buildLab()
    const { issues } = detectIssues(lab)
    const before = snapshot(lab)
    issues.length = 0
    expect(snapshot(lab)).toBe(before)
  })
})

describe('applying detection fixes corrects the intended fault', () => {
  it('each machine-fixable scenario becomes clean and fully connected after fix', () => {
    // Scenarios whose injected fault has a machine-applicable fix.
    const fixable = ['sc-route', 'sc-vlan', 'sc-mask', 'sc-ifdown', 'sc-gateway', 'sc-intervlan', 'sc-subif', 'sc-acl', 'sc-acl-order']
    for (const id of fixable) {
      const scenario = getScenario(id)!
      const lab = scenario.buildLab()

      // The submitted diagnosis matches the injected fault.
      const fault = lab.faults[0]
      const evaluation = evaluateSubmission(scenario, lab, { deviceId: fault.deviceId, kind: fault.kind }, 0)
      expect(evaluation.correct, `${id}: diagnosing the injected fault must be correct`).toBe(true)

      // The detection engine anchors an issue on the same device+kind.
      const { issues, suite } = detectIssues(lab)
      const matching = issues.find((i) => faultMatchesIssue(fault, i))
      expect(matching, `${id}: detection must anchor the fault`).toBeDefined()
      expect(suite.some((s) => !s.result.success), `${id}: symptom must be visible`).toBe(true)

      // Restore the base configuration first (deactivate fault overlays),
      // then converge machine fixes with re-detection between steps — the
      // ScenarioRunner "Apply fix" behavior. Fixing the overlay while it is
      // active would leave a broken base config once it is deactivated.
      let fixed = { ...lab, faults: lab.faults.map((f) => ({ ...f, active: false })) }
      fixed = applyAllFixes(fixed).lab
      const after = detectIssues(fixed)
      const injectedKindRemains = after.issues.some((i) => i.kind === fault.kind && i.deviceId === fault.deviceId)
      expect(injectedKindRemains, `${id}: the fault kind must no longer be flagged`).toBe(false)
      const remainingFailures = after.suite.filter((s) => !s.result.success && s.result.failCode !== 'no-gateway')
      expect(remainingFailures, `${id}: connectivity must be restored`).toEqual([])
    }
  })

  it('wrong diagnoses never change lab state', () => {
    const scenario = getScenario('sc-gateway')!
    const lab = scenario.buildLab()
    const before = snapshot(lab)
    evaluateSubmission(scenario, lab, { deviceId: 'r1', kind: 'wrong-ip' }, 2)
    expect(snapshot(lab)).toBe(before)
  })
})

describe('imported labs keep their simulated behavior', () => {
  it('an imported office lab pings successfully and keeps faults detectable', async () => {
    const { parseLabFile, serializeLabFile } = await import('./labFile')
    const lab = buildOfficeLab()
    lab.faults = [{ id: 'f1', kind: 'wrong-gateway', deviceId: 'pc1', active: true, value: '192.168.1.99' }]
    const parsed = parseLabFile(serializeLabFile(lab))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const imported = parsed.lab
    expect(imported.id).not.toBe(lab.id) // never overwrites the original by identity

    const { issues, suite } = detectIssues(imported)
    expect(issues.some((i) => i.kind === 'wrong-gateway' && i.deviceId === 'pc1')).toBe(true)
    expect(suite.some((s) => !s.result.success)).toBe(true)

    // Fixing the gateway on the imported copy restores connectivity and does
    // not touch the source lab object that was serialized.
    const before = snapshot(lab)
    let fixed = applyFixToLab(imported, { type: 'set-gateway', deviceId: 'pc1', value: '192.168.1.1' })
    fixed = { ...fixed, faults: [] }
    expect(detectIssues(fixed).suite.every((s) => s.result.success || s.result.failCode === 'no-gateway')).toBe(true)
    expect(snapshot(lab)).toBe(before)
  })
})
