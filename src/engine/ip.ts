// IPv4 / subnet math shared by validation, the ping engine and NetDoctor.

export interface Cidr {
  ip: number
  prefix: number
}

export function parseIpv4(text: string): number | null {
  const parts = text.trim().split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8) | octet
  }
  return value >>> 0
}

export function formatIpv4(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

export function parseCidr(text: string): Cidr | null {
  const trimmed = text.trim()
  const slash = trimmed.lastIndexOf('/')
  if (slash === -1) return null
  const ip = parseIpv4(trimmed.slice(0, slash))
  const prefixText = trimmed.slice(slash + 1)
  if (ip === null || !/^\d{1,2}$/.test(prefixText)) return null
  const prefix = Number(prefixText)
  if (prefix < 0 || prefix > 32) return null
  return { ip, prefix }
}

export function formatCidr(cidr: Cidr): string {
  return `${formatIpv4(cidr.ip)}/${cidr.prefix}`
}

export function maskOf(prefix: number): number {
  if (prefix === 0) return 0
  return (0xffffffff << (32 - prefix)) >>> 0
}

export function prefixFromMask(mask: number): number | null {
  // Mask must be contiguous.
  const inv = (~mask) >>> 0
  const invPlusOne = (inv + 1) >>> 0
  if ((inv & invPlusOne) !== 0) return null
  let prefix = 0
  let m = mask
  while (m & 0x80000000) {
    prefix++
    m = (m << 1) >>> 0
  }
  return prefix
}

export function prefixFromMaskText(maskText: string): number | null {
  const mask = parseIpv4(maskText)
  if (mask === null) return null
  return prefixFromMask(mask)
}

export function maskTextOf(prefix: number): string {
  return formatIpv4(maskOf(prefix))
}

export function networkOf(cidr: Cidr): number {
  return (cidr.ip & maskOf(cidr.prefix)) >>> 0
}

export function broadcastOf(cidr: Cidr): number {
  return (networkOf(cidr) | (~maskOf(cidr.prefix) >>> 0)) >>> 0
}

export function hostCount(prefix: number): number {
  if (prefix >= 31) return prefix === 31 ? 2 : 1
  return Math.pow(2, 32 - prefix) - 2
}

export function isSameSubnet(aIp: number, bIp: number, prefix: number): boolean {
  const mask = maskOf(prefix)
  return ((aIp & mask) >>> 0) === ((bIp & mask) >>> 0)
}

export function cidrContainsIp(cidrText: string, ipText: string): boolean {
  const cidr = parseCidr(cidrText)
  const ip = parseIpv4(ipText)
  if (!cidr || ip === null) return false
  return isSameSubnet(cidr.ip, ip, cidr.prefix)
}

export function isNetworkAddress(cidr: Cidr): boolean {
  return cidr.prefix < 31 && cidr.ip === networkOf(cidr)
}

export function isBroadcastAddress(cidr: Cidr): boolean {
  return cidr.prefix < 31 && cidr.ip === broadcastOf(cidr)
}

export function isPrivateIp(ip: number): boolean {
  const a = (ip >>> 24) & 255
  const b = (ip >>> 16) & 255
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

export function ipClassLabel(ip: number): string {
  if (isPrivateIp(ip)) return 'private'
  return 'public'
}

/** Human-readable error for a dotted IPv4 string, or null when valid. */
export function validateIpv4Text(text: string): string | null {
  if (!text.trim()) return 'IP address is empty'
  if (parseIpv4(text) === null) return `"${text}" is not a valid IPv4 address (expected a.b.c.d with octets 0-255)`
  return null
}

/**
 * Human-readable error for a host CIDR string, or null when valid.
 * Rejects network/broadcast addresses being used as host addresses.
 */
export function validateHostCidrText(text: string): string | null {
  const cidr = parseCidr(text)
  if (!cidr) {
    return `"${text}" is not a valid address/prefix (expected e.g. 192.168.1.10/24)`
  }
  if (isNetworkAddress(cidr)) {
    return `"${text}" is the network address of ${formatIpv4(networkOf(cidr))}/${cidr.prefix} and cannot be assigned to an interface`
  }
  if (isBroadcastAddress(cidr)) {
    return `"${text}" is the broadcast address of ${formatIpv4(networkOf(cidr))}/${cidr.prefix} and cannot be assigned to an interface`
  }
  return null
}

/** Simple dotted-quad validation with friendly message. */
export function validateMaskText(text: string): string | null {
  const err = validateIpv4Text(text)
  if (err) return err
  const mask = parseIpv4(text)!
  if (prefixFromMask(mask) === null) {
    return `"${text}" is not a contiguous subnet mask`
  }
  return null
}

/** First usable host address of a subnet, as text. */
export function firstHostText(prefix: number, networkIp: number): string {
  // /31 and /32 have no reserved network/broadcast address.
  return formatIpv4(prefix >= 31 ? networkIp : (networkIp + 1) >>> 0)
}

/** Last usable host address of a subnet, as text. */
export function lastHostText(prefix: number, networkIp: number): string {
  return formatIpv4((broadcastOf({ ip: networkIp, prefix }) - 1) >>> 0)
}

/** Human description of a CIDR: "192.168.1.0/24 (254 usable hosts)". */
export function describeCidr(cidrText: string): string {
  const parsed = parseCidr(cidrText)
  if (!parsed) return cidrText
  const net = networkOf(parsed)
  return `${formatIpv4(net)}/${parsed.prefix} (mask ${maskTextOf(parsed.prefix)}, ${hostCount(parsed.prefix)} usable hosts)`
}
