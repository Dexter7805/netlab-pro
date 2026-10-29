// Lab import/export: serialize a lab to a portable JSON envelope and parse +
// validate imported files safely. Parsing NEVER writes to storage — the UI
// decides what to do with a successfully parsed lab (e.g. confirm overwrite).

import { parseCidr, parseIpv4 } from './ip'
import { uid } from './ids'
import type { AclEntry, AclRule, Device, DeviceKind, DhcpPool, Fault, FaultKind, Lab, LabLink, NetInterface, SubInterface, Vlan } from './types'

/** Bumped when the lab file format changes in a breaking way. */
export const SUPPORTED_SCHEMA_VERSION = 1

export const FILE_FORMAT = 'netlab-pro-lab'

export interface LabFile {
  format: typeof FILE_FORMAT
  schemaVersion: number
  exportedAt: string
  lab: Lab
}

export type ParseResult =
  | { ok: true; lab: Lab; warnings: string[] }
  | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

const DEVICE_KINDS: DeviceKind[] = ['router', 'switch', 'pc', 'server']
const INTERFACE_ROLES: NetInterface['role'][] = ['routed', 'switchport', 'host']
const IP_MODES: NetInterface['ipMode'][] = ['static', 'dhcp']
const FAULT_KINDS: FaultKind[] = [
  'wrong-ip',
  'wrong-mask',
  'wrong-gateway',
  'interface-down',
  'link-down',
  'vlan-mismatch',
  'dhcp-exhausted',
  'remove-route',
  'duplicate-ip',
]

function aclTargetIsValid(target: string): boolean {
  const text = target.trim()
  if (text === '' || text === 'any') return true
  return parseCidr(text) !== null || parseIpv4(text) !== null
}

function parseAcls(raw: unknown, errors: string[], context: string): AclEntry[] {
  const out: AclEntry[] = []
  if (raw === undefined) return out
  if (!Array.isArray(raw)) {
    errors.push(`${context}: acls must be a list`)
    return out
  }
  for (const aclRaw of raw) {
    if (!isRecord(aclRaw) || !asString(aclRaw.id) || !asString(aclRaw.name)) {
      errors.push(`${context}: an ACL entry is missing id or name`)
      continue
    }
    const direction = asString(aclRaw.direction)
    if (direction !== 'in' && direction !== 'out') {
      errors.push(`${context}: ACL "${asString(aclRaw.name)!}" has invalid direction "${direction ?? ''}"`)
      continue
    }
    const rules: AclRule[] = []
    if (Array.isArray(aclRaw.rules)) {
      for (const ruleRaw of aclRaw.rules) {
        if (!isRecord(ruleRaw) || !asString(ruleRaw.id)) {
          errors.push(`${context}: ACL "${asString(aclRaw.name)!}" contains a malformed rule`)
          continue
        }
        const action = asString(ruleRaw.action)
        const protocol = asString(ruleRaw.protocol)
        if (action !== 'permit' && action !== 'deny') {
          errors.push(`${context}: ACL rule action must be "permit" or "deny" (got "${action ?? ''}")`)
          continue
        }
        if (protocol !== 'icmp' && protocol !== 'tcp' && protocol !== 'udp') {
          errors.push(`${context}: ACL rule protocol must be icmp, tcp or udp (got "${protocol ?? ''}")`)
          continue
        }
        const source = asString(ruleRaw.source) ?? 'any'
        const destination = asString(ruleRaw.destination) ?? 'any'
        for (const [field, target] of [['source', source], ['destination', destination]] as const) {
          if (!aclTargetIsValid(target)) {
            errors.push(`${context}: ACL rule ${field} "${target}" is not "any", an IPv4 address or a CIDR range`)
          }
        }
        let destPort: number | null = null
        if (ruleRaw.destPort !== undefined && ruleRaw.destPort !== null) {
          if (typeof ruleRaw.destPort !== 'number' || !Number.isInteger(ruleRaw.destPort) || ruleRaw.destPort < 1 || ruleRaw.destPort > 65535) {
            errors.push(`${context}: ACL rule destination port must be an integer between 1 and 65535`)
            continue
          }
          destPort = ruleRaw.destPort
        }
        rules.push({ id: asString(ruleRaw.id)!, action, protocol, source, destination, destPort, enabled: asBoolean(ruleRaw.enabled, true) })
      }
    } else {
      errors.push(`${context}: ACL "${asString(aclRaw.name)!}" rules must be a list`)
    }
    out.push({ id: asString(aclRaw.id)!, name: asString(aclRaw.name)!, direction, rules })
  }
  return out
}

function parseInterface(raw: unknown, errors: string[], context: string): NetInterface | null {
  if (!isRecord(raw)) {
    errors.push(`${context}: interface entry is not an object`)
    return null
  }
  const id = asString(raw.id)
  const name = asString(raw.name)
  if (!id || !name) {
    errors.push(`${context}: interface is missing id or name`)
    return null
  }
  const role = asString(raw.role) as NetInterface['role']
  if (!INTERFACE_ROLES.includes(role)) {
    errors.push(`${context} (${name}): unknown interface role "${asString(raw.role) ?? ''}"`)
    return null
  }
  const ipMode = asString(raw.ipMode) as NetInterface['ipMode']
  if (!IP_MODES.includes(ipMode)) {
    errors.push(`${context} (${name}): unknown address mode "${asString(raw.ipMode) ?? ''}"`)
    return null
  }
  let cidr: string | null = null
  if (typeof raw.cidr === 'string' && raw.cidr.trim() !== '') {
    if (!parseCidr(raw.cidr)) {
      errors.push(`${context} (${name}): "${raw.cidr}" is not a valid IPv4 address/prefix`)
      return null
    }
    cidr = raw.cidr
  }
  const accessVlan = asNumber(raw.accessVlan, 1)
  if (!Number.isInteger(accessVlan) || accessVlan < 1 || accessVlan > 4094) {
    errors.push(`${context} (${name}): access VLAN must be an integer between 1 and 4094`)
    return null
  }

  // Trunk configuration (optional — older files without it stay access-mode).
  const portMode = asString(raw.portMode) === 'trunk' ? 'trunk' : 'access'
  const nativeVlan = raw.nativeVlan === undefined ? 1 : asNumber(raw.nativeVlan, -1)
  if (!Number.isInteger(nativeVlan) || nativeVlan < 1 || nativeVlan > 4094) {
    errors.push(`${context} (${name}): native VLAN must be an integer between 1 and 4094`)
    return null
  }
  const allowedVlans: number[] = []
  if (raw.allowedVlans !== undefined) {
    if (!Array.isArray(raw.allowedVlans)) {
      errors.push(`${context} (${name}): allowedVlans must be a list of VLAN ids`)
      return null
    }
    for (const vlan of raw.allowedVlans) {
      if (typeof vlan !== 'number' || !Number.isInteger(vlan) || vlan < 1 || vlan > 4094) {
        errors.push(`${context} (${name}): allowed VLAN ${String(vlan)} is not an integer between 1 and 4094`)
        return null
      }
      allowedVlans.push(vlan)
    }
  }

  // Router VLAN sub-interfaces (optional).
  const subInterfaces: SubInterface[] = []
  if (raw.subInterfaces !== undefined) {
    if (!Array.isArray(raw.subInterfaces)) {
      errors.push(`${context} (${name}): subInterfaces must be a list`)
      return null
    }
    for (const subRaw of raw.subInterfaces) {
      if (!isRecord(subRaw) || !asString(subRaw.id) || !asString(subRaw.name)) {
        errors.push(`${context} (${name}): a sub-interface entry is missing id or name`)
        return null
      }
      const vlanId = asNumber(subRaw.vlanId, -1)
      if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) {
        errors.push(`${context} (${name}) sub-interface ${asString(subRaw.name)!}: VLAN id must be an integer between 1 and 4094`)
        return null
      }
      let subCidr: string | null = null
      if (typeof subRaw.cidr === 'string' && subRaw.cidr.trim() !== '') {
        if (!parseCidr(subRaw.cidr)) {
          errors.push(`${context} (${name}) sub-interface ${asString(subRaw.name)!}: '${subRaw.cidr}' is not a valid IPv4 address/prefix`)
          return null
        }
        subCidr = subRaw.cidr
      }
      let subRelay: string | null = null
      if (typeof subRaw.dhcpRelay === 'string' && subRaw.dhcpRelay.trim() !== '') {
        if (parseIpv4(subRaw.dhcpRelay) === null) {
          errors.push(`${context} (${name}) sub-interface ${asString(subRaw.name)!}: DHCP relay target "${subRaw.dhcpRelay}" is not a valid IPv4 address`)
          return null
        }
        subRelay = subRaw.dhcpRelay
      }
      const subAcls = parseAcls(subRaw.acls, errors, `${context} (${name}) sub-interface ${asString(subRaw.name)!}`)
      subInterfaces.push({ id: asString(subRaw.id)!, name: asString(subRaw.name)!, vlanId, cidr: subCidr, enabled: asBoolean(subRaw.enabled, true), dhcpRelay: subRelay, ...(subAcls.length > 0 ? { acls: subAcls } : {}) })
    }
  }

  // DHCP relay target (optional).
  let dhcpRelay: string | null = null
  if (typeof raw.dhcpRelay === 'string' && raw.dhcpRelay.trim() !== '') {
    if (parseIpv4(raw.dhcpRelay) === null) {
      errors.push(`${context} (${name}): DHCP relay target "${raw.dhcpRelay}" is not a valid IPv4 address`)
      return null
    }
    dhcpRelay = raw.dhcpRelay
  }

  const acls = parseAcls(raw.acls, errors, `${context} (${name})`)

  return {
    id,
    name,
    role,
    ipMode,
    cidr,
    enabled: asBoolean(raw.enabled, true),
    accessVlan,
    portMode,
    nativeVlan,
    allowedVlans,
    ...(subInterfaces.length > 0 || role === 'routed' ? { subInterfaces } : {}),
    ...(role === 'routed' ? { dhcpRelay } : {}),
    ...(acls.length > 0 ? { acls } : {}),
  }
}

function parseDevice(raw: unknown, errors: string[]): Device | null {
  if (!isRecord(raw)) {
    errors.push('A device entry is not an object')
    return null
  }
  const id = asString(raw.id)
  const name = asString(raw.name)
  const kind = asString(raw.kind) as DeviceKind
  if (!id || !name) {
    errors.push('A device is missing its id or name')
    return null
  }
  if (!DEVICE_KINDS.includes(kind)) {
    errors.push(`${name}: unknown device kind "${asString(raw.kind) ?? ''}"`)
    return null
  }
  const interfaces: NetInterface[] = []
  if (Array.isArray(raw.interfaces)) {
    for (const ifaceRaw of raw.interfaces) {
      const iface = parseInterface(ifaceRaw, errors, name)
      if (iface) interfaces.push(iface)
    }
  } else {
    errors.push(`${name}: interfaces must be a list`)
  }
  const staticRoutes = Array.isArray(raw.staticRoutes) ? raw.staticRoutes : []
  const dhcpPools: DhcpPool[] = []
  if (Array.isArray(raw.dhcpPools)) {
    for (const poolRaw of raw.dhcpPools) {
      if (!isRecord(poolRaw) || !asString(poolRaw.id) || !asString(poolRaw.name)) {
        errors.push(`${name}: a DHCP pool entry is malformed`)
        continue
      }
      let dnsIp: string | undefined
      if (typeof poolRaw.dnsIp === 'string' && poolRaw.dnsIp.trim() !== '') {
        if (parseIpv4(poolRaw.dnsIp) === null) {
          errors.push(`${name}: DHCP pool "${asString(poolRaw.name)!}" has an invalid DNS server address "${poolRaw.dnsIp}"`)
          continue
        }
        dnsIp = poolRaw.dnsIp
      }
      dhcpPools.push({
        id: asString(poolRaw.id)!,
        name: asString(poolRaw.name)!,
        networkCidr: asString(poolRaw.networkCidr) ?? '',
        rangeStart: asString(poolRaw.rangeStart) ?? '',
        rangeEnd: asString(poolRaw.rangeEnd) ?? '',
        gatewayIp: asString(poolRaw.gatewayIp) ?? '',
        ...(dnsIp ? { dnsIp } : {}),
      })
    }
  }
  return {
    id,
    name,
    kind,
    x: asNumber(raw.x, 0),
    y: asNumber(raw.y, 0),
    interfaces,
    gatewayIp: asString(raw.gatewayIp),
    staticRoutes: staticRoutes
      .filter((r): r is Record<string, unknown> => isRecord(r) && !!asString(r.id))
      .map((r) => ({
        id: asString(r.id)!,
        destinationCidr: asString(r.destinationCidr) ?? '',
        nextHopIp: asString(r.nextHopIp) ?? '',
      })),
    dhcpPools,
  }
}

function parseVlans(raw: unknown, errors: string[]): Vlan[] {
  if (!Array.isArray(raw)) {
    errors.push('VLAN list must be an array')
    return []
  }
  const vlans: Vlan[] = []
  for (const v of raw) {
    if (!isRecord(v) || typeof v.id !== 'number' || !Number.isInteger(v.id) || v.id < 1 || v.id > 4094) {
      errors.push('A VLAN entry needs a numeric id between 1 and 4094')
      continue
    }
    vlans.push({ id: v.id, name: asString(v.name) ?? `VLAN${v.id}` })
  }
  return vlans
}

function parseFaults(raw: unknown, errors: string[], warnings: string[]): Fault[] {
  if (!Array.isArray(raw)) return []
  const faults: Fault[] = []
  for (const f of raw) {
    if (!isRecord(f) || !asString(f.id) || !asString(f.deviceId)) {
      errors.push('A fault entry is malformed (missing id or deviceId)')
      continue
    }
    const kind = asString(f.kind) as FaultKind
    if (!FAULT_KINDS.includes(kind)) {
      // Faults from a newer app version must not block the import.
      warnings.push(`Skipped a fault of unknown type "${asString(f.kind) ?? ''}"`)
      continue
    }
    faults.push({
      id: asString(f.id)!,
      kind,
      active: asBoolean(f.active, true),
      deviceId: asString(f.deviceId)!,
      interfaceId: asString(f.interfaceId) ?? undefined,
      linkId: asString(f.linkId) ?? undefined,
      routeId: asString(f.routeId) ?? undefined,
      poolId: asString(f.poolId) ?? undefined,
      value: asString(f.value) ?? undefined,
      note: asString(f.note) ?? undefined,
    })
  }
  return faults
}

/**
 * Parse the text of an exported lab file. Returns a fully re-validated lab or
 * an understandable error. Cross-references (links, faults) that point to
 * missing objects are dropped with a warning instead of failing the import.
 */
export function parseLabFile(text: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'The file is not valid JSON. Check that you picked the right file and that it was not truncated.' }
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: 'The file does not contain a NetLab Pro lab (expected a JSON object).' }
  }
  if (parsed.format !== FILE_FORMAT) {
    return { ok: false, error: 'This file was not exported from NetLab Pro (missing "format: netlab-pro-lab").' }
  }
  const version = parsed.schemaVersion
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { ok: false, error: 'The file has no valid schema version number.' }
  }
  if (version > SUPPORTED_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `This lab uses schema version ${version}, which is newer than the supported version ${SUPPORTED_SCHEMA_VERSION}. Update NetLab Pro and try again.`,
    }
  }
  if (version < 1) {
    return { ok: false, error: `Unsupported schema version ${version}.` }
  }
  if (!isRecord(parsed.lab)) {
    return { ok: false, error: 'The file is missing the "lab" section.' }
  }

  const errors: string[] = []
  const warnings: string[] = []
  const labRaw = parsed.lab
  const name = asString(labRaw.name)
  if (!name || !name.trim()) {
    return { ok: false, error: 'The lab has no name.' }
  }

  const devices: Device[] = []
  if (Array.isArray(labRaw.devices)) {
    for (const d of labRaw.devices) {
      const device = parseDevice(d, errors)
      if (device) devices.push(device)
    }
  } else {
    errors.push('"devices" must be a list')
  }

  // Duplicate device ids make the lab ambiguous — reject.
  const deviceIds = new Set<string>()
  for (const device of devices) {
    if (deviceIds.has(device.id)) {
      errors.push(`Duplicate device id "${device.id}" (${device.name})`)
    }
    deviceIds.add(device.id)
  }
  const seenIfaceIds = new Set<string>()
  for (const device of devices) {
    for (const iface of device.interfaces) {
      const key = `${device.id}/${iface.id}`
      if (seenIfaceIds.has(key)) {
        errors.push(`Duplicate interface id "${iface.id}" on ${device.name}`)
      }
      seenIfaceIds.add(key)
    }
  }
  if (devices.length === 0) {
    warnings.push('The imported lab contains no devices.')
  }

  // Links: only keep those whose endpoints exist.
  const links: LabLink[] = []
  if (Array.isArray(labRaw.links)) {
    for (const l of labRaw.links) {
      if (!isRecord(l) || !asString(l.id)) {
        errors.push('A link entry is malformed')
        continue
      }
      const link: LabLink = {
        id: asString(l.id)!,
        aDeviceId: asString(l.aDeviceId) ?? '',
        aInterfaceId: asString(l.aInterfaceId) ?? '',
        bDeviceId: asString(l.bDeviceId) ?? '',
        bInterfaceId: asString(l.bInterfaceId) ?? '',
        enabled: asBoolean(l.enabled, true),
      }
      const aOk = devices.some((d) => d.id === link.aDeviceId && d.interfaces.some((i) => i.id === link.aInterfaceId))
      const bOk = devices.some((d) => d.id === link.bDeviceId && d.interfaces.some((i) => i.id === link.bInterfaceId))
      if (!aOk || !bOk) {
        warnings.push(`Dropped a link that references a missing device or interface (${link.aDeviceId} ↔ ${link.bDeviceId}).`)
        continue
      }
      if (link.aDeviceId === link.bDeviceId) {
        warnings.push('Dropped a link that loops back to the same device.')
        continue
      }
      links.push(link)
    }
  } else {
    errors.push('"links" must be a list')
  }

  // One cable per interface.
  const usedInterfaces = new Set<string>()
  const dedupedLinks: LabLink[] = []
  for (const link of links) {
    const keyA = `${link.aDeviceId}/${link.aInterfaceId}`
    const keyB = `${link.bDeviceId}/${link.bInterfaceId}`
    if (usedInterfaces.has(keyA) || usedInterfaces.has(keyB)) {
      warnings.push('Dropped a link whose interface is already used by another link.')
      continue
    }
    usedInterfaces.add(keyA)
    usedInterfaces.add(keyB)
    dedupedLinks.push(link)
  }

  const faults = parseFaults(labRaw.faults, errors, warnings)
  // Drop faults pointing at devices that no longer exist.
  const keptFaults = faults.filter((f) => {
    if (devices.some((d) => d.id === f.deviceId)) return true
    warnings.push('Dropped a fault that references a missing device.')
    return false
  })

  const vlans = parseVlans(labRaw.vlans, errors)

  if (errors.length > 0) {
    return { ok: false, error: errors.slice(0, 4).join(' ') + (errors.length > 4 ? ` (+${errors.length - 4} more problems)` : '') }
  }

  const lab: Lab = {
    id: uid('lab'),
    name: name.trim(),
    origin: 'user',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    devices,
    links: dedupedLinks,
    vlans,
    faults: keptFaults,
  }
  // Always import as a NEW lab with a fresh id — never overwrite on parse.
  return { ok: true, lab, warnings }
}

/** Serialize a lab into the portable envelope. */
export function serializeLabFile(lab: Lab): string {
  const file: LabFile = {
    format: FILE_FORMAT,
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    lab,
  }
  return JSON.stringify(file, null, 2)
}

/** Suggested file name for an export. */
export function exportFileName(lab: Lab): string {
  const safe = lab.name.replace(/[^a-z0-9-_ ]/gi, '').trim().replace(/\s+/g, '-') || 'lab'
  return `${safe}.netlab.json`
}

/** Parse an IPv4 gatekeeping helper re-exported for tests. */
export const isValidIpv4 = (text: string) => parseIpv4(text) !== null
