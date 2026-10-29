// Shared data model for both NetLab Simulator and NetDoctor.
// The SAME lab model + engine drives the editor, the ping simulation,
// the fault injection and the troubleshooting detection.

export type DeviceKind = 'router' | 'switch' | 'pc' | 'server'

/**
 * How an interface participates in the simulation:
 * - routed: L3 interface on a router (has an IP).
 * - switchport: L2 access port on a switch (belongs to an access VLAN).
 * - host: end-host interface (PC / server / management interface).
 */
export type InterfaceRole = 'routed' | 'switchport' | 'host'

export type IpMode = 'static' | 'dhcp'

/** Switch port mode: access ports carry one VLAN, trunks carry a tagged list. */
export type PortMode = 'access' | 'trunk'

/**
 * Logical VLAN sub-interface on a router physical port (router-on-a-stick).
 * The parent physical interface owns the cable; each sub-interface binds it to
 * one VLAN and carries that VLAN's IPv4 address.
 */
export interface SubInterface {
  id: string
  name: string
  /** 802.1Q VLAN id served by this sub-interface. */
  vlanId: number
  /** IPv4 address/prefix for this VLAN, e.g. "192.168.10.1/24". */
  cidr: string | null
  enabled: boolean
  /** DHCP relay target (ip helper-address): the DHCP server's IP. */
  dhcpRelay?: string | null
  /** ACLs attached to this sub-interface (max one per direction, validated). */
  acls?: AclEntry[]
}

/**
 * Access Control Lists — a deliberately small, deterministic subset of real
 * ACL semantics: ordered rules on router interfaces, first match wins,
 * implicit permit for unmatched traffic, protocols icmp/tcp/udp with optional
 * destination-port matching for tcp/udp.
 */
export type AclAction = 'permit' | 'deny'
export type AclProtocol = 'icmp' | 'tcp' | 'udp'
export type AclDirection = 'in' | 'out'

export interface AclRule {
  id: string
  action: AclAction
  protocol: AclProtocol
  /** Source: "any", a plain IPv4 address (/32) or a CIDR range. */
  source: string
  /** Destination: "any", a plain IPv4 address (/32) or a CIDR range. */
  destination: string
  /** Destination port, only meaningful for tcp/udp. null = any port. */
  destPort?: number | null
  enabled: boolean
}

export interface AclEntry {
  id: string
  name: string
  direction: AclDirection
  /** Ordered rules — the FIRST matching rule decides (permit or deny). */
  rules: AclRule[]
}

export interface NetInterface {
  id: string
  name: string
  role: InterfaceRole
  ipMode: IpMode
  /** Static address in CIDR form, e.g. "192.168.1.10/24". null when unset or DHCP. */
  cidr: string | null
  /** Administrative state. false = shutdown. */
  enabled: boolean
  /** Access VLAN id, meaningful for access-mode switchports. */
  accessVlan: number
  /** Switch port mode. Older saved labs default to 'access'. */
  portMode?: PortMode
  /** Trunk ports: VLAN that carries untagged frames (default 1). */
  nativeVlan?: number
  /** Trunk ports: VLANs permitted across this trunk. Empty list = none permitted. */
  allowedVlans?: number[]
  /** Router physical ports: 802.1Q sub-interfaces (router-on-a-stick). */
  subInterfaces?: SubInterface[]
  /** DHCP relay target (ip helper-address) on routed ports. */
  dhcpRelay?: string | null
  /** ACLs attached to this routed port (max one per direction, validated). */
  acls?: AclEntry[]
}

export interface StaticRoute {
  id: string
  destinationCidr: string
  nextHopIp: string
}

export interface DhcpPool {
  id: string
  name: string
  /** Network the pool serves, e.g. "192.168.10.0/24". */
  networkCidr: string
  rangeStart: string
  rangeEnd: string
  gatewayIp: string
  /** Optional DNS server handed to clients with the lease. */
  dnsIp?: string
}

export interface Device {
  id: string
  name: string
  kind: DeviceKind
  x: number
  y: number
  interfaces: NetInterface[]
  /** Default gateway for end hosts (PC / server), dotted IP. */
  gatewayIp: string | null
  /** Static routes, routers only. */
  staticRoutes: StaticRoute[]
  /** DHCP scopes, servers only. */
  dhcpPools: DhcpPool[]
}

export interface LabLink {
  id: string
  aDeviceId: string
  aInterfaceId: string
  bDeviceId: string
  bInterfaceId: string
  /** Administrative state of the simulated cable. false = down. */
  enabled: boolean
}

export interface Vlan {
  id: number
  name: string
}

/**
 * Faults are overlays applied on top of the base configuration.
 * A fault injected in NetLab is visible to NetDoctor because both read the
 * same effective lab produced by `applyFaults`.
 */
export type FaultKind =
  | 'wrong-ip'
  | 'wrong-mask'
  | 'wrong-gateway'
  | 'interface-down'
  | 'link-down'
  | 'vlan-mismatch'
  | 'dhcp-exhausted'
  | 'remove-route'
  | 'duplicate-ip'
  | 'trunk-vlan-missing'
  | 'trunk-native-mismatch'
  | 'missing-subinterface'
  | 'missing-dhcp-relay'
  | 'wrong-relay-target'
  | 'missing-dhcp-scope'
  | 'acl-blocks-traffic'

export interface Fault {
  id: string
  kind: FaultKind
  active: boolean
  deviceId: string
  interfaceId?: string
  linkId?: string
  routeId?: string
  poolId?: string
  /** Sub-interface targeted by missing-subinterface faults. */
  subInterfaceId?: string
  /** Replacement value: IP/CIDR for wrong-ip|wrong-mask|wrong-gateway|duplicate-ip, VLAN id for vlan-mismatch and trunk faults. */
  value?: string
  note?: string
}

export type LabOrigin = 'sample' | 'user' | 'scenario'

export interface Lab {
  id: string
  name: string
  origin: LabOrigin
  createdAt: string
  updatedAt: string
  devices: Device[]
  links: LabLink[]
  vlans: Vlan[]
  faults: Fault[]
}

// ---------------------------------------------------------------------------
// Engine result types
// ---------------------------------------------------------------------------

export type PingFailCode =
  | 'invalid-target'
  | 'no-source-ip'
  | 'no-source-interface'
  | 'source-interface-down'
  | 'no-gateway'
  | 'gateway-unreachable'
  | 'gateway-not-a-router'
  | 'on-link-arp-fail'
  | 'destination-unreachable'
  | 'no-route'
  | 'next-hop-unreachable'
  | 'ttl-exceeded'
  | 'network-unreachable'
  | 'acl-denied'

export interface PingHop {
  deviceName: string
  interfaceName: string | null
  detail: string
  rttMs: number | null
}

/** Structured record of the ACL rule that decided a packet's fate. */
export interface AclHit {
  deviceId: string
  deviceName: string
  interfaceId: string
  interfaceName: string
  subInterfaceId?: string
  subInterfaceName?: string
  aclId: string
  aclName: string
  direction: AclDirection
  ruleId: string
  ruleIndex: number
  action: AclAction
  protocol: AclProtocol
  source: string
  destination: string
  destPort?: number | null
}

export interface PingResult {
  success: boolean
  sourceDeviceId: string
  sourceDeviceName: string
  sourceInterfaceName: string | null
  sourceIp: string | null
  targetIp: string
  hops: PingHop[]
  failCode?: PingFailCode
  /** Human-readable explanation of the outcome (simulation, never live data). */
  explanation: string
  suggestion?: string
  /** Device names along the path, for UI highlighting. */
  pathDeviceIds: string[]
  /** Set when an ACL rule permitted or denied the packet. */
  aclHit?: AclHit
}

export type IssueKind = FaultKind | 'config-warning' | 'missing-ip' | 'unreachable-server'

export interface DetectedIssue {
  id: string
  kind: IssueKind
  severity: 'critical' | 'warning' | 'info'
  deviceId: string
  interfaceId?: string
  subInterfaceId?: string
  linkId?: string
  poolId?: string
  routeId?: string
  title: string
  evidence: string
  explanation: string
  suggestedFix: string
  /** Machine-applicable fix, used by NetDoctor's "apply fix" action. */
  fix?: FixAction
}

export type FixAction =
  | { type: 'set-cidr'; deviceId: string; interfaceId: string; value: string }
  | { type: 'set-gateway'; deviceId: string; value: string | null }
  | { type: 'enable-interface'; deviceId: string; interfaceId: string }
  | { type: 'enable-link'; linkId: string }
  | { type: 'set-vlan'; deviceId: string; interfaceId: string; value: number }
  | { type: 'restore-route'; deviceId: string; route: { destinationCidr: string; nextHopIp: string } }
  | { type: 'dhcp-reconfigure' }
  | { type: 'allow-vlan'; deviceId: string; interfaceId: string; value: number }
  | {
      type: 'create-subinterface'
      deviceId: string
      interfaceId: string
      vlanId: number
      cidr: string
      name: string
    }
  | { type: 'set-relay'; deviceId: string; interfaceId: string; subInterfaceId?: string; value: string }
  | {
      type: 'create-dhcp-pool'
      deviceId: string
      pool: { name: string; networkCidr: string; rangeStart: string; rangeEnd: string; gatewayIp: string; dnsIp?: string }
    }
  | { type: 'set-pool-gateway'; deviceId: string; poolId: string; value: string }
  | {
      type: 'remove-acl-rule'
      deviceId: string
      interfaceId: string
      subInterfaceId?: string
      aclId: string
      ruleId: string
    }

/** A fully-resolved connectivity test suite result, used by NetDoctor triage. */
export interface ConnectivityProbe {
  sourceDeviceId: string
  targetDeviceId: string
  result: PingResult
}
