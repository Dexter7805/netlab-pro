import { describe, expect, it } from 'vitest'
import {
  broadcastOf,
  cidrContainsIp,
  firstHostText,
  formatIpv4,
  hostCount,
  isBroadcastAddress,
  isNetworkAddress,
  isPrivateIp,
  isSameSubnet,
  lastHostText,
  maskOf,
  maskTextOf,
  networkOf,
  parseCidr,
  parseIpv4,
  prefixFromMask,
  prefixFromMaskText,
  validateHostCidrText,
  validateIpv4Text,
  validateMaskText,
} from './ip'

describe('parseIpv4', () => {
  it('parses valid dotted quads', () => {
    expect(parseIpv4('192.168.1.1')).toBe(0xc0a80101)
    expect(parseIpv4('0.0.0.0')).toBe(0)
    expect(parseIpv4('255.255.255.255')).toBe(0xffffffff)
  })
  it('rejects invalid input', () => {
    expect(parseIpv4('256.1.1.1')).toBeNull()
    expect(parseIpv4('1.2.3')).toBeNull()
    expect(parseIpv4('a.b.c.d')).toBeNull()
    expect(parseIpv4('1.2.3.4.5')).toBeNull()
    expect(parseIpv4('')).toBeNull()
  })
  it('round-trips through formatIpv4', () => {
    expect(formatIpv4(parseIpv4('10.200.3.44')!)).toBe('10.200.3.44')
  })
})

describe('subnet math', () => {
  it('computes masks and networks', () => {
    expect(maskOf(24)).toBe(0xffffff00)
    expect(maskTextOf(24)).toBe('255.255.255.0')
    expect(maskTextOf(8)).toBe('255.0.0.0')
    const cidr = parseCidr('192.168.1.130/25')!
    expect(networkOf(cidr)).toBe(parseIpv4('192.168.1.128'))
    expect(broadcastOf(cidr)).toBe(parseIpv4('192.168.1.255'))
  })
  it('computes usable host counts', () => {
    expect(hostCount(24)).toBe(254)
    expect(hostCount(30)).toBe(2)
    expect(hostCount(31)).toBe(2)
    expect(hostCount(32)).toBe(1)
  })
  it('derives prefixes from masks', () => {
    expect(prefixFromMask(maskOf(24))).toBe(24)
    expect(prefixFromMaskText('255.255.0.0')).toBe(16)
    expect(prefixFromMaskText('255.0.255.0')).toBeNull() // non-contiguous
  })
  it('checks subnet membership', () => {
    expect(isSameSubnet(parseIpv4('192.168.1.10')!, parseIpv4('192.168.1.200')!, 24)).toBe(true)
    expect(isSameSubnet(parseIpv4('192.168.1.10')!, parseIpv4('192.168.2.10')!, 24)).toBe(false)
    expect(isSameSubnet(parseIpv4('192.168.1.10')!, parseIpv4('192.168.1.200')!, 25)).toBe(false)
  })
  it('detects network and broadcast addresses', () => {
    expect(isNetworkAddress(parseCidr('192.168.1.0/24')!)).toBe(true)
    expect(isNetworkAddress(parseCidr('192.168.1.1/24')!)).toBe(false)
    expect(isBroadcastAddress(parseCidr('192.168.1.255/24')!)).toBe(true)
    expect(isBroadcastAddress(parseCidr('192.168.1.254/24')!)).toBe(false)
  })
  it('computes first and last usable hosts', () => {
    expect(firstHostText(24, parseIpv4('192.168.1.0')!)).toBe('192.168.1.1')
    expect(lastHostText(24, parseIpv4('192.168.1.0')!)).toBe('192.168.1.254')
  })
  it('checks CIDR containment', () => {
    expect(cidrContainsIp('192.168.1.0/24', '192.168.1.77')).toBe(true)
    expect(cidrContainsIp('192.168.1.0/24', '10.0.0.1')).toBe(false)
  })
  it('classifies private addresses', () => {
    expect(isPrivateIp(parseIpv4('10.0.0.1')!)).toBe(true)
    expect(isPrivateIp(parseIpv4('172.16.5.4')!)).toBe(true)
    expect(isPrivateIp(parseIpv4('172.32.5.4')!)).toBe(false)
    expect(isPrivateIp(parseIpv4('192.168.0.1')!)).toBe(true)
    expect(isPrivateIp(parseIpv4('8.8.8.8')!)).toBe(false)
  })
})

describe('validation messages', () => {
  it('validates IPv4 text', () => {
    expect(validateIpv4Text('192.168.1.1')).toBeNull()
    expect(validateIpv4Text('not-an-ip')).toMatch(/not a valid IPv4/)
    expect(validateIpv4Text('')).toMatch(/empty/)
  })
  it('validates host CIDRs', () => {
    expect(validateHostCidrText('192.168.1.10/24')).toBeNull()
    expect(validateHostCidrText('192.168.1.0/24')).toMatch(/network address/)
    expect(validateHostCidrText('192.168.1.255/24')).toMatch(/broadcast/)
    expect(validateHostCidrText('192.168.1.10')).toMatch(/address\/prefix/)
    expect(validateHostCidrText('192.168.1.10/33')).toMatch(/address\/prefix/)
  })
  it('validates masks', () => {
    expect(validateMaskText('255.255.255.0')).toBeNull()
    expect(validateMaskText('255.0.255.0')).toMatch(/contiguous/)
    expect(validateMaskText('abc')).toMatch(/valid IPv4/)
  })
})
