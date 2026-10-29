// Lab templates used for the built-in sample labs and NetDoctor scenarios.
// Deterministic ids make tests and scenario authoring predictable.

import type { Device, DeviceKind, DhcpPool, Fault, Lab, LabLink, NetInterface, StaticRoute, Vlan } from '../engine/types'

interface IfaceSpec {
  id: string
  name: string
  role: NetInterface['role']
  cidr?: string | null
  ipMode?: NetInterface['ipMode']
  enabled?: boolean
  accessVlan?: number
  portMode?: NetInterface['portMode']
  nativeVlan?: number
  allowedVlans?: number[]
  subInterfaces?: NetInterface['subInterfaces']
  acls?: NetInterface['acls']
}

interface DeviceSpec {
  id: string
  name: string
  kind: DeviceKind
  x: number
  y: number
  gatewayIp?: string | null
  interfaces: IfaceSpec[]
  staticRoutes?: Array<{ id: string; destinationCidr: string; nextHopIp: string }>
  dhcpPools?: Array<Omit<DhcpPool, 'id'> & { id: string }>
}

function buildDevice(spec: DeviceSpec): Device {
  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    x: spec.x,
    y: spec.y,
    gatewayIp: spec.gatewayIp ?? null,
    interfaces: spec.interfaces.map((i) => ({
      id: i.id,
      name: i.name,
      role: i.role,
      ipMode: i.ipMode ?? 'static',
      cidr: i.cidr ?? null,
      enabled: i.enabled ?? true,
      accessVlan: i.accessVlan ?? 1,
      portMode: i.portMode,
      nativeVlan: i.nativeVlan,
      allowedVlans: i.allowedVlans,
      subInterfaces: i.subInterfaces,
      acls: i.acls,
    })),
    staticRoutes: (spec.staticRoutes ?? []).map<StaticRoute>((r) => ({ ...r })),
    dhcpPools: (spec.dhcpPools ?? []).map<DhcpPool>((p) => ({ ...p })),
  }
}

interface LabSpec {
  id: string
  name: string
  origin: Lab['origin']
  devices: DeviceSpec[]
  links: Array<{ id: string; a: string; b: string }>
  vlans?: Vlan[]
  faults?: Fault[]
}

function buildLab(spec: LabSpec): Lab {
  const now = new Date().toISOString()
  const links: LabLink[] = spec.links.map((l) => ({
    id: l.id,
    aDeviceId: l.a.split(':')[0],
    aInterfaceId: l.a.split(':')[1],
    bDeviceId: l.b.split(':')[0],
    bInterfaceId: l.b.split(':')[1],
    enabled: true,
  }))
  return {
    id: spec.id,
    name: spec.name,
    origin: spec.origin,
    createdAt: now,
    updatedAt: now,
    devices: spec.devices.map(buildDevice),
    links,
    vlans: spec.vlans ?? [
      { id: 1, name: 'default' },
      { id: 10, name: 'USERS' },
      { id: 20, name: 'GUESTS' },
    ],
    faults: (spec.faults ?? []).map((f) => ({ ...f, active: true })),
  }
}

/** Small branch office: PC1 — SW1 — R1 — SRV1. No routing config needed. */
export function buildOfficeLab(name = 'Branch Office (sample)', id = 'lab-office'): Lab {
  return buildLab({
    id,
    name,
    origin: 'sample',
    devices: [
      {
        id: 'pc1',
        name: 'PC1',
        kind: 'pc',
        x: 60,
        y: 200,
        gatewayIp: '192.168.1.1',
        interfaces: [{ id: 'pc1-fa0', name: 'Fa0', role: 'host', cidr: '192.168.1.10/24' }],
      },
      {
        id: 'sw1',
        name: 'SW1',
        kind: 'switch',
        x: 240,
        y: 200,
        interfaces: [
          { id: 'sw1-fa01', name: 'Fa0/1', role: 'switchport', accessVlan: 10 },
          { id: 'sw1-fa02', name: 'Fa0/2', role: 'switchport', accessVlan: 10 },
          { id: 'sw1-fa03', name: 'Fa0/3', role: 'switchport', accessVlan: 10 },
        ],
      },
      {
        id: 'r1',
        name: 'R1',
        kind: 'router',
        x: 420,
        y: 200,
        interfaces: [
          { id: 'r1-gi00', name: 'Gi0/0', role: 'routed', cidr: '192.168.1.1/24' },
          { id: 'r1-gi01', name: 'Gi0/1', role: 'routed', cidr: '10.0.0.1/24' },
        ],
      },
      {
        id: 'srv1',
        name: 'SRV1',
        kind: 'server',
        x: 640,
        y: 200,
        gatewayIp: '10.0.0.1',
        interfaces: [{ id: 'srv1-fa0', name: 'Fa0', role: 'host', cidr: '10.0.0.20/24' }],
      },
    ],
    links: [
      { id: 'lnk-pc1-sw1', a: 'pc1:pc1-fa0', b: 'sw1:sw1-fa01' },
      { id: 'lnk-sw1-r1', a: 'sw1:sw1-fa02', b: 'r1:r1-gi00' },
      { id: 'lnk-r1-srv1', a: 'r1:r1-gi01', b: 'srv1:srv1-fa0' },
    ],
  })
}

/** Two routers with static routes: PC1 — SW1 — R1 — R2 — SRV1. */
export function buildTwoRouterLab(name = 'Two-Router Static Routing (sample)', id = 'lab-two-router'): Lab {
  return buildLab({
    id,
    name,
    origin: 'sample',
    devices: [
      {
        id: 'pc1',
        name: 'PC1',
        kind: 'pc',
        x: 60,
        y: 200,
        gatewayIp: '192.168.1.1',
        interfaces: [{ id: 'pc1-fa0', name: 'Fa0', role: 'host', cidr: '192.168.1.10/24' }],
      },
      {
        id: 'sw1',
        name: 'SW1',
        kind: 'switch',
        x: 230,
        y: 200,
        interfaces: [
          { id: 'sw1-fa01', name: 'Fa0/1', role: 'switchport', accessVlan: 10 },
          { id: 'sw1-fa02', name: 'Fa0/2', role: 'switchport', accessVlan: 10 },
        ],
      },
      {
        id: 'r1',
        name: 'R1',
        kind: 'router',
        x: 410,
        y: 200,
        interfaces: [
          { id: 'r1-gi00', name: 'Gi0/0', role: 'routed', cidr: '192.168.1.1/24' },
          { id: 'r1-gi01', name: 'Gi0/1', role: 'routed', cidr: '10.0.0.1/24' },
        ],
        staticRoutes: [{ id: 'rt-r1-srv', destinationCidr: '172.16.20.0/24', nextHopIp: '10.0.0.2' }],
      },
      {
        id: 'r2',
        name: 'R2',
        kind: 'router',
        x: 600,
        y: 200,
        interfaces: [
          { id: 'r2-gi00', name: 'Gi0/0', role: 'routed', cidr: '10.0.0.2/24' },
          { id: 'r2-gi01', name: 'Gi0/1', role: 'routed', cidr: '172.16.20.1/24' },
        ],
        staticRoutes: [{ id: 'rt-r2-lan', destinationCidr: '192.168.1.0/24', nextHopIp: '10.0.0.1' }],
      },
      {
        id: 'srv1',
        name: 'SRV1',
        kind: 'server',
        x: 800,
        y: 200,
        gatewayIp: '172.16.20.1',
        interfaces: [{ id: 'srv1-fa0', name: 'Fa0', role: 'host', cidr: '172.16.20.20/24' }],
      },
    ],
    links: [
      { id: 'lnk-pc1-sw1', a: 'pc1:pc1-fa0', b: 'sw1:sw1-fa01' },
      { id: 'lnk-sw1-r1', a: 'sw1:sw1-fa02', b: 'r1:r1-gi00' },
      { id: 'lnk-r1-r2', a: 'r1:r1-gi01', b: 'r2:r2-gi00' },
      { id: 'lnk-r2-srv1', a: 'r2:r2-gi01', b: 'srv1:srv1-fa0' },
    ],
  })
}

/** Two PCs on one switch in the same subnet (VLAN 10). */
export function buildVlanLab(name = 'VLAN Access Lab (sample)', id = 'lab-vlan'): Lab {
  return buildLab({
    id,
    name,
    origin: 'sample',
    devices: [
      {
        id: 'pc1',
        name: 'PC1',
        kind: 'pc',
        x: 120,
        y: 160,
        interfaces: [{ id: 'pc1-fa0', name: 'Fa0', role: 'host', cidr: '192.168.10.11/24' }],
      },
      {
        id: 'pc2',
        name: 'PC2',
        kind: 'pc',
        x: 120,
        y: 320,
        interfaces: [{ id: 'pc2-fa0', name: 'Fa0', role: 'host', cidr: '192.168.10.12/24' }],
      },
      {
        id: 'sw1',
        name: 'SW1',
        kind: 'switch',
        x: 360,
        y: 240,
        interfaces: [
          { id: 'sw1-fa01', name: 'Fa0/1', role: 'switchport', accessVlan: 10 },
          { id: 'sw1-fa02', name: 'Fa0/2', role: 'switchport', accessVlan: 10 },
          { id: 'sw1-fa03', name: 'Fa0/3', role: 'switchport', accessVlan: 20 },
        ],
      },
      {
        id: 'srv1',
        name: 'SRV1',
        kind: 'server',
        x: 600,
        y: 240,
        interfaces: [{ id: 'srv1-fa0', name: 'Fa0', role: 'host', cidr: '192.168.20.20/24' }],
      },
    ],
    links: [
      { id: 'lnk-pc1-sw1', a: 'pc1:pc1-fa0', b: 'sw1:sw1-fa01' },
      { id: 'lnk-pc2-sw1', a: 'pc2:pc2-fa0', b: 'sw1:sw1-fa02' },
      { id: 'lnk-srv1-sw1', a: 'srv1:srv1-fa0', b: 'sw1:sw1-fa03' },
    ],
    vlans: [
      { id: 1, name: 'default' },
      { id: 10, name: 'USERS' },
      { id: 20, name: 'SERVERS' },
    ],
  })
}

/** DHCP server with a small pool serving two PC clients; R1 is the pool gateway. */
export function buildDhcpLab(name = 'DHCP Lab (sample)', id = 'lab-dhcp'): Lab {
  return buildLab({
    id,
    name,
    origin: 'sample',
    devices: [
      {
        id: 'pc1',
        name: 'PC1',
        kind: 'pc',
        x: 100,
        y: 160,
        interfaces: [{ id: 'pc1-fa0', name: 'Fa0', role: 'host', ipMode: 'dhcp', cidr: null }],
      },
      {
        id: 'pc2',
        name: 'PC2',
        kind: 'pc',
        x: 100,
        y: 320,
        interfaces: [{ id: 'pc2-fa0', name: 'Fa0', role: 'host', ipMode: 'dhcp', cidr: null }],
      },
      {
        id: 'sw1',
        name: 'SW1',
        kind: 'switch',
        x: 320,
        y: 240,
        interfaces: [
          { id: 'sw1-fa01', name: 'Fa0/1', role: 'switchport', accessVlan: 10 },
          { id: 'sw1-fa02', name: 'Fa0/2', role: 'switchport', accessVlan: 10 },
          { id: 'sw1-fa03', name: 'Fa0/3', role: 'switchport', accessVlan: 10 },
          { id: 'sw1-fa04', name: 'Fa0/4', role: 'switchport', accessVlan: 10 },
        ],
      },
      {
        id: 'srv1',
        name: 'SRV1',
        kind: 'server',
        x: 560,
        y: 240,
        interfaces: [{ id: 'srv1-fa0', name: 'Fa0', role: 'host', cidr: '192.168.10.1/24' }],
        dhcpPools: [
          {
            id: 'pool-srv1-lan',
            name: 'LAN-POOL',
            networkCidr: '192.168.10.0/24',
            rangeStart: '192.168.10.100',
            rangeEnd: '192.168.10.105',
            gatewayIp: '192.168.10.254',
          },
        ],
      },
      {
        id: 'r1',
        name: 'R1',
        kind: 'router',
        x: 320,
        y: 60,
        interfaces: [{ id: 'r1-gi00', name: 'Gi0/0', role: 'routed', cidr: '192.168.10.254/24' }],
      },
    ],
    links: [
      { id: 'lnk-pc1-sw1', a: 'pc1:pc1-fa0', b: 'sw1:sw1-fa01' },
      { id: 'lnk-pc2-sw1', a: 'pc2:pc2-fa0', b: 'sw1:sw1-fa02' },
      { id: 'lnk-srv1-sw1', a: 'srv1:srv1-fa0', b: 'sw1:sw1-fa03' },
      { id: 'lnk-r1-sw1', a: 'r1:r1-gi00', b: 'sw1:sw1-fa04' },
    ],
  })
}

/** Mask lab: three PCs in 192.168.1.0/24 on one switch (no router). */
export function buildMaskLab(name = 'Subnetting Lab (sample)', id = 'lab-mask'): Lab {
  return buildLab({
    id,
    name,
    origin: 'sample',
    devices: [
      {
        id: 'pc1',
        name: 'PC1',
        kind: 'pc',
        x: 100,
        y: 120,
        interfaces: [{ id: 'pc1-fa0', name: 'Fa0', role: 'host', cidr: '192.168.1.10/24' }],
      },
      {
        id: 'pc2',
        name: 'PC2',
        kind: 'pc',
        x: 100,
        y: 280,
        interfaces: [{ id: 'pc2-fa0', name: 'Fa0', role: 'host', cidr: '192.168.1.11/24' }],
      },
      {
        id: 'pc3',
        name: 'PC3',
        kind: 'pc',
        x: 100,
        y: 440,
        interfaces: [{ id: 'pc3-fa0', name: 'Fa0', role: 'host', cidr: '192.168.1.200/24' }],
      },
      {
        id: 'sw1',
        name: 'SW1',
        kind: 'switch',
        x: 360,
        y: 280,
        interfaces: [
          { id: 'sw1-fa01', name: 'Fa0/1', role: 'switchport', accessVlan: 10 },
          { id: 'sw1-fa02', name: 'Fa0/2', role: 'switchport', accessVlan: 10 },
          { id: 'sw1-fa03', name: 'Fa0/3', role: 'switchport', accessVlan: 10 },
        ],
      },
    ],
    links: [
      { id: 'lnk-pc1-sw1', a: 'pc1:pc1-fa0', b: 'sw1:sw1-fa01' },
      { id: 'lnk-pc2-sw1', a: 'pc2:pc2-fa0', b: 'sw1:sw1-fa02' },
      { id: 'lnk-pc3-sw1', a: 'pc3:pc3-fa0', b: 'sw1:sw1-fa03' },
    ],
  })
}


/** Inter-VLAN routing lab: two VLANs, a trunk and a router-on-a-stick. */
export function buildInterVlanLab(name = 'Inter-VLAN Routing (sample)', id = 'lab-intervlan'): Lab {
  return buildLab({
    id,
    name,
    origin: 'sample',
    devices: [
      {
        id: 'pc1',
        name: 'PC1',
        kind: 'pc',
        x: 80,
        y: 140,
        gatewayIp: '192.168.10.1',
        interfaces: [{ id: 'pc1-fa0', name: 'Fa0', role: 'host', cidr: '192.168.10.11/24' }],
      },
      {
        id: 'pc2',
        name: 'PC2',
        kind: 'pc',
        x: 80,
        y: 340,
        gatewayIp: '192.168.20.1',
        interfaces: [{ id: 'pc2-fa0', name: 'Fa0', role: 'host', cidr: '192.168.20.12/24' }],
      },
      {
        id: 'sw1',
        name: 'SW1',
        kind: 'switch',
        x: 340,
        y: 240,
        interfaces: [
          { id: 'sw1-fa01', name: 'Fa0/1', role: 'switchport', accessVlan: 10, portMode: 'access' },
          { id: 'sw1-fa02', name: 'Fa0/2', role: 'switchport', accessVlan: 20, portMode: 'access' },
          {
            id: 'sw1-fa03',
            name: 'Fa0/3',
            role: 'switchport',
            accessVlan: 1,
            portMode: 'trunk',
            nativeVlan: 1,
            allowedVlans: [10, 20],
          },
        ],
      },
      {
        id: 'r1',
        name: 'R1',
        kind: 'router',
        x: 620,
        y: 240,
        interfaces: [
          {
            id: 'r1-gi00',
            name: 'Gi0/0',
            role: 'routed',
            cidr: null,
            subInterfaces: [
              { id: 'r1-gi00-sub10', name: 'Gi0/0.10', vlanId: 10, cidr: '192.168.10.1/24', enabled: true },
              { id: 'r1-gi00-sub20', name: 'Gi0/0.20', vlanId: 20, cidr: '192.168.20.1/24', enabled: true },
            ],
          },
        ],
      },
    ],
    links: [
      { id: 'lnk-pc1-sw1', a: 'pc1:pc1-fa0', b: 'sw1:sw1-fa01' },
      { id: 'lnk-pc2-sw1', a: 'pc2:pc2-fa0', b: 'sw1:sw1-fa02' },
      { id: 'lnk-sw1-r1', a: 'sw1:sw1-fa03', b: 'r1:r1-gi00' },
    ],
  })
}


/** DHCP relay lab: a DHCP client behind a router-on-a-stick trunk, server in another subnet. */
export function buildDhcpRelayLab(name = 'DHCP Relay (sample)', id = 'lab-dhcprelay'): Lab {
  return buildLab({
    id,
    name,
    origin: 'sample',
    devices: [
      {
        id: 'pc1',
        name: 'PC1',
        kind: 'pc',
        x: 80,
        y: 200,
        interfaces: [{ id: 'pc1-fa0', name: 'Fa0', role: 'host', ipMode: 'dhcp', cidr: null }],
      },
      {
        id: 'sw1',
        name: 'SW1',
        kind: 'switch',
        x: 300,
        y: 200,
        interfaces: [
          { id: 'sw1-fa01', name: 'Fa0/1', role: 'switchport', accessVlan: 10, portMode: 'access' },
          { id: 'sw1-fa02', name: 'Fa0/2', role: 'switchport', accessVlan: 10, portMode: 'access' },
          {
            id: 'sw1-fa03',
            name: 'Fa0/3',
            role: 'switchport',
            accessVlan: 1,
            portMode: 'trunk',
            nativeVlan: 1,
            allowedVlans: [10],
          },
        ],
      },
      {
        id: 'r1',
        name: 'R1',
        kind: 'router',
        x: 560,
        y: 200,
        interfaces: [
          {
            id: 'r1-gi00',
            name: 'Gi0/0',
            role: 'routed',
            cidr: null,
            subInterfaces: [
              {
                id: 'r1-gi00-sub10',
                name: 'Gi0/0.10',
                vlanId: 10,
                cidr: '192.168.10.1/24',
                enabled: true,
                dhcpRelay: '10.0.0.20',
              },
            ],
          },
          { id: 'r1-gi01', name: 'Gi0/1', role: 'routed', cidr: '10.0.0.1/24' },
        ],
      },
      {
        id: 'srv1',
        name: 'SRV1',
        kind: 'server',
        x: 820,
        y: 200,
        gatewayIp: '10.0.0.1',
        interfaces: [{ id: 'srv1-fa0', name: 'Fa0', role: 'host', cidr: '10.0.0.20/24' }],
        dhcpPools: [
          {
            id: 'pool-srv1-remote',
            name: 'VLAN10-SCOPE',
            networkCidr: '192.168.10.0/24',
            rangeStart: '192.168.10.100',
            rangeEnd: '192.168.10.105',
            gatewayIp: '192.168.10.1',
            dnsIp: '10.0.0.20',
          },
        ],
      },
    ],
    links: [
      { id: 'lnk-pc1-sw1', a: 'pc1:pc1-fa0', b: 'sw1:sw1-fa01' },
      { id: 'lnk-sw1-r1', a: 'sw1:sw1-fa03', b: 'r1:r1-gi00' },
      { id: 'lnk-r1-srv1', a: 'r1:r1-gi01', b: 'srv1:srv1-fa0' },
    ],
  })
}


/** ACL lab: a router policy permits pings but blocks telnet (tcp/23) to the server. */
export function buildAclLab(name = 'ACL Policy (sample)', id = 'lab-acl'): Lab {
  return buildLab({
    id,
    name,
    origin: 'sample',
    devices: [
      {
        id: 'pc1',
        name: 'PC1',
        kind: 'pc',
        x: 80,
        y: 200,
        gatewayIp: '192.168.10.1',
        interfaces: [{ id: 'pc1-fa0', name: 'Fa0', role: 'host', cidr: '192.168.10.11/24' }],
      },
      {
        id: 'sw1',
        name: 'SW1',
        kind: 'switch',
        x: 300,
        y: 200,
        interfaces: [
          { id: 'sw1-fa01', name: 'Fa0/1', role: 'switchport', accessVlan: 10, portMode: 'access' },
          { id: 'sw1-fa02', name: 'Fa0/2', role: 'switchport', accessVlan: 10, portMode: 'access' },
          {
            id: 'sw1-fa03',
            name: 'Fa0/3',
            role: 'switchport',
            accessVlan: 1,
            portMode: 'trunk',
            nativeVlan: 1,
            allowedVlans: [10],
          },
        ],
      },
      {
        id: 'r1',
        name: 'R1',
        kind: 'router',
        x: 560,
        y: 200,
        interfaces: [
          {
            id: 'r1-gi00',
            name: 'Gi0/0',
            role: 'routed',
            cidr: null,
            subInterfaces: [
              { id: 'r1-gi00-sub10', name: 'Gi0/0.10', vlanId: 10, cidr: '192.168.10.1/24', enabled: true },
            ],
          },
          {
            id: 'r1-gi01',
            name: 'Gi0/1',
            role: 'routed',
            cidr: '203.0.113.1/24',
            acls: [
              {
                id: 'acl-server-policy',
                name: 'SERVER-POLICY',
                direction: 'out',
                rules: [
                  { id: 'rule-telnet', action: 'deny', protocol: 'tcp', source: 'any', destination: '203.0.113.20', destPort: 23, enabled: true },
                  { id: 'rule-icmp', action: 'permit', protocol: 'icmp', source: 'any', destination: 'any', destPort: null, enabled: true },
                  { id: 'rule-tcp', action: 'permit', protocol: 'tcp', source: 'any', destination: 'any', destPort: null, enabled: true },
                  { id: 'rule-udp', action: 'permit', protocol: 'udp', source: 'any', destination: 'any', destPort: null, enabled: true },
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'srv1',
        name: 'SRV1',
        kind: 'server',
        x: 820,
        y: 200,
        gatewayIp: '203.0.113.1',
        interfaces: [{ id: 'srv1-fa0', name: 'Fa0', role: 'host', cidr: '203.0.113.20/24' }],
      },
    ],
    links: [
      { id: 'lnk-pc1-sw1', a: 'pc1:pc1-fa0', b: 'sw1:sw1-fa01' },
      { id: 'lnk-sw1-r1', a: 'sw1:sw1-fa03', b: 'r1:r1-gi00' },
      { id: 'lnk-r1-srv1', a: 'r1:r1-gi01', b: 'srv1:srv1-fa0' },
    ],
  })
}

/** Fresh copies for the store (so edits never touch the templates). */
export function createSampleLabs(): Lab[] {
  return [buildOfficeLab(), buildTwoRouterLab(), buildVlanLab(), buildDhcpLab(), buildInterVlanLab(), buildDhcpRelayLab(), buildAclLab()]
}
