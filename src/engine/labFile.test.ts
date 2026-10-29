import { describe, expect, it } from 'vitest'
import { exportFileName, parseLabFile, serializeLabFile, SUPPORTED_SCHEMA_VERSION } from './labFile'
import type { ParseResult } from './labFile'
import { buildDhcpLab, buildOfficeLab, buildTwoRouterLab, buildVlanLab } from '../data/sampleLabs'
import type { Lab } from './types'

/** Assert a parse failure and return its error message (helps TS narrowing). */
function expectFail(result: ParseResult): string {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected the import to fail')
  return result.error
}

/** Assert a parse success and return the parsed lab + warnings. */
function expectOk(result: ParseResult): { lab: Lab; warnings: string[] } {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected the import to succeed')
  return { lab: result.lab, warnings: result.warnings }
}

const roundTrip = (lab: Lab): Lab => {
  const parsed = parseLabFile(serializeLabFile(lab))
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.lab
}

describe('lab export/import round-trip', () => {
  it('preserves devices, links, VLANs and configuration', () => {
    for (const lab of [buildOfficeLab(), buildTwoRouterLab(), buildVlanLab(), buildDhcpLab()]) {
      const imported = roundTrip(lab)
      expect(imported.name).toBe(lab.name)
      expect(imported.devices.map((d) => d.id)).toEqual(lab.devices.map((d) => d.id))
      expect(imported.links.map((l) => l.id)).toEqual(lab.links.map((l) => l.id))
      expect(imported.vlans).toEqual(lab.vlans)
      const r1 = imported.devices.find((d) => d.id === 'r1')
      expect(r1?.interfaces[0].cidr).toBe(lab.devices.find((d) => d.id === 'r1')?.interfaces[0].cidr)
      const srv1 = imported.devices.find((d) => d.id === 'srv1')
      expect(srv1?.gatewayIp).toBe(lab.devices.find((d) => d.id === 'srv1')?.gatewayIp)
    }
  })

  it('imports work after faults are injected', () => {
    const lab = buildOfficeLab()
    lab.faults = [{ id: 'f1', kind: 'wrong-gateway', deviceId: 'pc1', active: true, value: '192.168.1.99' }]
    const imported = roundTrip(lab)
    expect(imported.faults).toHaveLength(1)
    expect(imported.faults[0]).toMatchObject({ kind: 'wrong-gateway', deviceId: 'pc1', value: '192.168.1.99', active: true })
  })

  it('imports always get a fresh id and user origin', () => {
    const lab = buildOfficeLab()
    const imported = roundTrip(lab)
    expect(imported.id).not.toBe(lab.id)
    expect(imported.origin).toBe('user')
  })
})

describe('invalid imports are rejected with understandable errors', () => {
  it('rejects non-JSON files', () => {
    expect(expectFail(parseLabFile('this is { not json'))).toMatch(/not valid JSON/i)
  })

  it('rejects files that are not NetLab exports', () => {
    expect(expectFail(parseLabFile(JSON.stringify({ hello: 'world' })))).toMatch(/not exported from NetLab Pro/i)
  })

  it('rejects newer schema versions safely', () => {
    const file = JSON.parse(serializeLabFile(buildOfficeLab()))
    file.schemaVersion = SUPPORTED_SCHEMA_VERSION + 1
    expect(expectFail(parseLabFile(JSON.stringify(file)))).toMatch(/newer than the supported version/)
  })

  it('rejects missing lab section and empty names', () => {
    const noLab = { format: 'netlab-pro-lab', schemaVersion: 1 }
    expect(parseLabFile(JSON.stringify(noLab)).ok).toBe(false)
    const nameless = { format: 'netlab-pro-lab', schemaVersion: 1, lab: { name: '  ', devices: [], links: [], vlans: [], faults: [] } }
    expect(parseLabFile(JSON.stringify(nameless)).ok).toBe(false)
  })

  it('rejects unknown device kinds and malformed addresses', () => {
    const lab = buildOfficeLab() as unknown as Record<string, unknown>
    const devices = (lab.devices as Array<Record<string, unknown>>).map((d) => ({ ...d }))
    ;(devices[0] as Record<string, unknown>).kind = 'hovercraft'
    const bad = { format: 'netlab-pro-lab', schemaVersion: 1, lab: { ...lab, devices } }
    expect(expectFail(parseLabFile(JSON.stringify(bad)))).toMatch(/unknown device kind/i)

    const lab2 = buildOfficeLab() as unknown as Record<string, unknown>
    const devices2 = (lab2.devices as Array<Record<string, unknown>>).map((d) => ({ ...d }))
    const pc1 = { ...(devices2[0] as Record<string, unknown>) }
    pc1.interfaces = [{ ...(pc1.interfaces as Array<Record<string, unknown>>)[0], cidr: '999.9.9.9/24' }]
    devices2[0] = pc1
    const badCidr = { format: 'netlab-pro-lab', schemaVersion: 1, lab: { ...lab2, devices: devices2 } }
    expect(expectFail(parseLabFile(JSON.stringify(badCidr)))).toMatch(/not a valid IPv4 address\/prefix/)
  })

  it('rejects duplicate device and interface ids', () => {
    const lab = buildOfficeLab() as unknown as Record<string, unknown>
    const devices = [...(lab.devices as Array<Record<string, unknown>>)]
    const clone = JSON.parse(JSON.stringify(devices[0]))
    clone.name = 'PC1-copy'
    const bad = { format: 'netlab-pro-lab', schemaVersion: 1, lab: { ...lab, devices: [...devices, clone] } }
    expect(expectFail(parseLabFile(JSON.stringify(bad)))).toMatch(/duplicate device id/i)
  })

  it('rejects out-of-range VLANs and access VLANs', () => {
    const file = JSON.parse(serializeLabFile(buildVlanLab()))
    file.lab.vlans = [{ id: 5000, name: 'BOGUS' }]
    expect(expectFail(parseLabFile(JSON.stringify(file)))).toMatch(/between 1 and 4094/)
  })
})

describe('recoverable problems are downgraded to warnings', () => {
  it('drops dangling links with a warning instead of failing', () => {
    const file = JSON.parse(serializeLabFile(buildOfficeLab()))
    file.lab.links = [...file.lab.links, { id: 'lnk-ghost', aDeviceId: 'ghost', aInterfaceId: 'nope', bDeviceId: 'pc1', bInterfaceId: 'pc1-fa0', enabled: true }]
    const { lab, warnings } = expectOk(parseLabFile(JSON.stringify(file)))
    expect(lab.links.some((l) => l.id === 'lnk-ghost')).toBe(false)
    expect(warnings.join(' ')).toMatch(/missing device or interface/)
  })

  it('drops same-device loops and double-used interfaces with warnings', () => {
    const file = JSON.parse(serializeLabFile(buildOfficeLab()))
    file.lab.links = [
      { id: 'l1', aDeviceId: 'pc1', aInterfaceId: 'pc1-fa0', bDeviceId: 'sw1', bInterfaceId: 'sw1-fa01', enabled: true },
      { id: 'l2', aDeviceId: 'pc1', aInterfaceId: 'pc1-fa0', bDeviceId: 'sw1', bInterfaceId: 'sw1-fa02', enabled: true },
      { id: 'l3', aDeviceId: 'pc1', aInterfaceId: 'pc1-fa0', bDeviceId: 'pc1', bInterfaceId: 'pc1-fa0', enabled: true },
    ]
    const { lab, warnings } = expectOk(parseLabFile(JSON.stringify(file)))
    expect(lab.links).toHaveLength(1)
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  })

  it('drops faults referencing missing devices and unknown fault kinds', () => {
    const file = JSON.parse(serializeLabFile(buildOfficeLab()))
    file.lab.faults = [
      { id: 'f1', kind: 'wrong-gateway', deviceId: 'ghost-device', active: true },
      { id: 'f2', kind: 'hyperjump', deviceId: 'pc1', active: true },
    ]
    const { lab, warnings } = expectOk(parseLabFile(JSON.stringify(file)))
    expect(lab.faults).toHaveLength(0)
    expect(warnings.join(' ')).toMatch(/missing device/i)
    expect(warnings.join(' ')).toMatch(/unknown type/i)
  })

  it('warns when the lab contains no devices', () => {
    const file = JSON.parse(serializeLabFile(buildOfficeLab()))
    file.lab.devices = []
    file.lab.links = []
    const { warnings } = expectOk(parseLabFile(JSON.stringify(file)))
    expect(warnings.join(' ')).toMatch(/no devices/i)
  })
})

describe('export helpers', () => {
  it('produces a stable envelope with format and version', () => {
    const text = serializeLabFile(buildOfficeLab())
    const parsed = JSON.parse(text)
    expect(parsed.format).toBe('netlab-pro-lab')
    expect(parsed.schemaVersion).toBe(1)
    expect(typeof parsed.exportedAt).toBe('string')
  })

  it('suggests a safe file name', () => {
    const lab = buildOfficeLab('My Lab: v2 / final?')
    expect(exportFileName(lab)).toBe('My-Lab-v2-final.netlab.json')
  })
})
