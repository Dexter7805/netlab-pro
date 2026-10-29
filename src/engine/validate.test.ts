import { describe, expect, it } from 'vitest'
import { summarizeValidation, validateLab } from './validate'
import { buildOfficeLab, buildTwoRouterLab, buildVlanLab } from '../data/sampleLabs'
import type { Lab } from './types'

const messagesOf = (lab: Lab, severity?: 'error' | 'warning' | 'info') =>
  validateLab(lab)
    .filter((i) => !severity || i.severity === severity)
    .map((i) => i.message)

describe('validateLab on healthy labs', () => {
  it('sample labs produce no errors (only expected infos)', () => {
    for (const lab of [buildOfficeLab(), buildTwoRouterLab(), buildVlanLab()]) {
      expect(messagesOf(lab, 'error')).toEqual([])
    }
  })
})

describe('duplicate and invalid addresses', () => {
  it('flags duplicate IPv4 addresses as errors', () => {
    const lab = buildOfficeLab()
    lab.devices.find((d) => d.id === 'srv1')!.interfaces[0].cidr = '192.168.1.10/24'
    expect(messagesOf(lab, 'error').join(' ')).toMatch(/Duplicate IP 192\.168\.1\.10/)
  })

  it('flags network and broadcast addresses used as host addresses', () => {
    const lab = buildOfficeLab()
    lab.devices.find((d) => d.id === 'pc1')!.interfaces[0].cidr = '192.168.1.0/24'
    expect(messagesOf(lab, 'error').join(' ')).toMatch(/network address/)
  })

  it('flags malformed addresses', () => {
    const lab = buildOfficeLab()
    lab.devices.find((d) => d.id === 'r1')!.interfaces[0].cidr = '192.168.1.999/24'
    expect(messagesOf(lab, 'error').join(' ')).toMatch(/not a valid/)
  })
})

describe('gateways', () => {
  it('flags gateways outside the host subnets', () => {
    const lab = buildOfficeLab()
    lab.devices.find((d) => d.id === 'pc1')!.gatewayIp = '10.9.9.9'
    expect(messagesOf(lab, 'warning').join(' ')).toMatch(/not inside any of its interface subnets/)
  })

  it('flags gateways that are network or broadcast addresses', () => {
    const lab = buildOfficeLab()
    lab.devices.find((d) => d.id === 'pc1')!.gatewayIp = '192.168.1.255'
    expect(messagesOf(lab, 'error').join(' ')).toMatch(/network or broadcast address/)
  })

  it('reports missing gateways as info, not error', () => {
    const lab = buildOfficeLab()
    lab.devices.find((d) => d.id === 'pc1')!.gatewayIp = null
    expect(messagesOf(lab, 'info').join(' ')).toMatch(/no default gateway/)
  })
})

describe('connectivity wiring', () => {
  it('reports disconnected interfaces as info', () => {
    const lab = buildOfficeLab()
    const sw1 = lab.devices.find((d) => d.id === 'sw1')!
    sw1.interfaces.push({ id: 'sw1-fa09', name: 'Fa0/9', role: 'switchport', ipMode: 'static', cidr: null, enabled: true, accessVlan: 10 })
    expect(messagesOf(lab, 'info').join(' ')).toMatch(/SW1 Fa0\/9 is not connected to anything/)
  })

  it('reports links referencing missing endpoints as errors', () => {
    const lab = buildOfficeLab()
    lab.links = [...lab.links, { id: 'lnk-broken', aDeviceId: 'ghost', aInterfaceId: 'x', bDeviceId: 'pc1', bInterfaceId: 'pc1-fa0', enabled: true }]
    expect(messagesOf(lab, 'error').join(' ')).toMatch(/missing device or interface/)
  })

  it('reports down links as warnings', () => {
    const lab = buildOfficeLab()
    lab.links.find((l) => l.id === 'lnk-r1-srv1')!.enabled = false
    expect(messagesOf(lab, 'warning').join(' ')).toMatch(/administratively down/)
  })

  it('flags double-used interfaces', () => {
    const lab = buildOfficeLab()
    // SW1 already has an unused Fa0/3 — two links on the same switch port.
    lab.links = [
      ...lab.links,
      { id: 'lnk-x', aDeviceId: 'sw1', aInterfaceId: 'sw1-fa03', bDeviceId: 'srv1', bInterfaceId: 'srv1-fa0', enabled: true },
    ]
    // srv1-fa0 is already used by lnk-r1-srv1 — both links must be flagged.
    const msgs = messagesOf(lab, 'error').join(' ')
    expect(msgs).toMatch(/used by more than one link/)
  })
})

describe('VLAN configuration', () => {
  it('flags out-of-range access VLANs', () => {
    const lab = buildVlanLab()
    lab.devices.find((d) => d.id === 'sw1')!.interfaces[0].accessVlan = 5000
    expect(messagesOf(lab, 'error').join(' ')).toMatch(/between 1 and 4094/)
  })

  it('flags switch-to-switch uplinks with mismatched VLANs', () => {
    const lab = buildVlanLab()
    // Cable SW1 Fa0/3 (VLAN 20) to a second switch port in VLAN 10.
    lab.devices = [
      ...lab.devices,
      {
        id: 'sw2', name: 'SW2', kind: 'switch', x: 800, y: 240, gatewayIp: null,
        interfaces: [{ id: 'sw2-fa01', name: 'Fa0/1', role: 'switchport', ipMode: 'static', cidr: null, enabled: true, accessVlan: 10 }],
        staticRoutes: [], dhcpPools: [],
      },
    ]
    lab.links = [...lab.links, { id: 'lnk-uplink', aDeviceId: 'sw1', aInterfaceId: 'sw1-fa03', bDeviceId: 'sw2', bInterfaceId: 'sw2-fa01', enabled: true }]
    expect(messagesOf(lab, 'warning').join(' ')).toMatch(/different VLANs on each end/)
  })
})

describe('static routes', () => {
  it('flags invalid prefixes and next hops', () => {
    const lab = buildTwoRouterLab()
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    r1.staticRoutes = [{ id: 'r', destinationCidr: 'not-a-prefix', nextHopIp: '10.0.0.2' }]
    expect(messagesOf(lab, 'error').join(' ')).toMatch(/not a valid prefix/)

    r1.staticRoutes = [{ id: 'r', destinationCidr: '172.16.20.0/24', nextHopIp: 'nope' }]
    expect(messagesOf(lab, 'error').join(' ')).toMatch(/invalid next hop/)
  })

  it('flags next hops that are not on a connected subnet', () => {
    const lab = buildTwoRouterLab()
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    r1.staticRoutes = [{ id: 'r', destinationCidr: '172.16.20.0/24', nextHopIp: '172.99.99.1' }]
    expect(messagesOf(lab, 'warning').join(' ')).toMatch(/not on a connected subnet/)
  })

  it('accepts the healthy two-router configuration', () => {
    expect(messagesOf(buildTwoRouterLab(), 'error')).toEqual([])
  })
})

describe('summarizeValidation', () => {
  it('counts severities', () => {
    const summary = summarizeValidation(validateLab(buildOfficeLab()))
    expect(summary.errors).toBe(0)
    expect(summary.total).toBe(summary.errors + summary.warnings + summary.infos)
  })
})

describe('audit regression: duplicate IPs involving sub-interfaces', () => {
  it('flags a sub-interface IP that collides with another device address', () => {
    const lab = buildOfficeLab()
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    const gi00 = r1.interfaces.find((i) => i.id === 'r1-gi00')!
    gi00.subInterfaces = [
      { id: 'sub-dup', name: 'Gi0/0.99', vlanId: 99, cidr: '10.0.0.20/24', enabled: true },
    ]
    const messages = validateLab(lab).map((i) => i.message).join(' | ')
    expect(messages).toMatch(/Duplicate IP 10\.0\.0\.20.*R1 \(Gi0\/0\.99\).*SRV1/)
  })

  it('flags two sub-interfaces on different routers sharing one address', () => {
    const lab = buildTwoRouterLab()
    const r1 = lab.devices.find((d) => d.id === 'r1')!
    const r2 = lab.devices.find((d) => d.id === 'r2')!
    const addr = '10.99.99.1/24'
    r1.interfaces.find((i) => i.id === 'r1-gi00')!.subInterfaces = [
      { id: 's1', name: 'Gi0/0.50', vlanId: 50, cidr: addr, enabled: true },
    ]
    r2.interfaces.find((i) => i.id === 'r2-gi00')!.subInterfaces = [
      { id: 's2', name: 'Gi0/0.50', vlanId: 50, cidr: addr, enabled: true },
    ]
    const messages = validateLab(lab).map((i) => i.message).join(' | ')
    expect(messages).toMatch(/Duplicate IP 10\.99\.99\.1/)
  })
})
