// NetDoctor scenarios: built-in troubleshooting cases built from the same
// lab templates NetLab uses, with one active fault each. Scoring and
// submission evaluation also live here.

import type { Fault, FaultKind, Lab } from './types'
import {
  buildAclLab,
  buildDhcpLab,
  buildDhcpRelayLab,
  buildInterVlanLab,
  buildMaskLab,
  buildOfficeLab,
  buildTwoRouterLab,
  buildVlanLab,
} from '../data/sampleLabs'

export type Difficulty = 'easy' | 'medium' | 'hard'

export interface Scenario {
  id: string
  title: string
  difficulty: Difficulty
  points: number
  /** The "user complaint" that opens the case. */
  brief: string
  objectives: string[]
  /** Escalating hints (3 levels). */
  hints: string[]
  /** The fault kinds that count as a correct diagnosis. */
  faultKinds: FaultKind[]
  /** Build a fresh lab for a run (with the fault injected and active). */
  buildLab: () => Lab
  /** Human solution text shown after solving. */
  solution: string
}

const fault = (f: Omit<Fault, 'active'>): Fault => ({ ...f, active: true })

export const SCENARIOS: Scenario[] = [
  {
    id: 'sc-gateway',
    title: 'Branch PC cannot reach the server',
    difficulty: 'easy',
    points: 100,
    brief:
      'A user reports that PC1 in the branch office cannot reach SRV1 (10.0.0.20). The PC was configured manually yesterday. Everything else on the LAN seems fine.',
    objectives: ['Find why PC1 cannot reach SRV1', 'Identify the affected device and the fault type'],
    hints: [
      'Ping from PC1 to SRV1 and read the failure reason carefully — which step fails?',
      'Compare PC1’s default gateway with the addresses that actually exist on its segment (R1 Gi0/0).',
      'PC1’s default gateway 192.168.1.99 does not exist; the router LAN interface is 192.168.1.1.',
    ],
    faultKinds: ['wrong-gateway'],
    buildLab: () => {
      const lab = buildOfficeLab('Scenario: Branch PC offline', 'sc-lab-gateway')
      lab.faults = [
        fault({ id: 'flt-gw', kind: 'wrong-gateway', deviceId: 'pc1', value: '192.168.1.99' }),
      ]
      return lab
    },
    solution:
      'PC1 had the default gateway 192.168.1.99, an address no device owns. ARP for the gateway failed, so every off-subnet destination (including SRV1) timed out. Fix: set the default gateway to 192.168.1.1 (R1 Gi0/0).',
  },
  {
    id: 'sc-route',
    title: 'Server subnet unreachable after maintenance',
    difficulty: 'medium',
    points: 150,
    brief:
      'During maintenance on R1 someone "cleaned up" its configuration. Since then PC1 can no longer reach SRV1 (172.16.20.20). R1 and R2 interfaces are up.',
    objectives: ['Find why traffic stops between R1 and SRV1’s subnet', 'Identify the affected device and the fault type'],
    hints: [
      'Ping PC1 → SRV1 and note WHERE the packet stops: which device reports the failure?',
      'Check the routing table evidence: which network is R1 missing a route to?',
      'R1 lost its static route to 172.16.20.0/24 via 10.0.0.2.',
    ],
    faultKinds: ['remove-route'],
    buildLab: () => {
      const lab = buildTwoRouterLab('Scenario: Route missing on R1', 'sc-lab-route')
      lab.faults = [
        fault({ id: 'flt-route', kind: 'remove-route', deviceId: 'r1', routeId: 'rt-r1-srv' }),
      ]
      return lab
    },
    solution:
      'R1 lost its static route to 172.16.20.0/24 (next hop 10.0.0.2). Traffic from PC1 reached R1, but the router had no path toward the server subnet and returned "destination unreachable". Fix: re-add the static route 172.16.20.0/24 via 10.0.0.2.',
  },
  {
    id: 'sc-vlan',
    title: 'New PC cannot reach its neighbor',
    difficulty: 'medium',
    points: 150,
    brief:
      'PC2 was moved to a different switch port this morning. Since then PC2 cannot ping PC1 (both should be in 192.168.10.0/24). The switch shows no hardware alarms.',
    objectives: ['Find why two same-subnet PCs cannot communicate', 'Identify the affected device and the fault type'],
    hints: [
      'Both PCs have correct IP settings in the same subnet, yet ARP fails — where can same-subnet isolation come from?',
      'Compare the access VLAN of the switch ports PC1 and PC2 are connected to.',
      'SW1 port Fa0/2 (PC2) is in VLAN 20, while PC1 is in VLAN 10 — VLAN isolation blocks them.',
    ],
    faultKinds: ['vlan-mismatch'],
    buildLab: () => {
      const lab = buildVlanLab('Scenario: VLAN split', 'sc-lab-vlan')
      lab.faults = [
        fault({ id: 'flt-vlan', kind: 'vlan-mismatch', deviceId: 'sw1', interfaceId: 'sw1-fa02', value: '20' }),
      ]
      return lab
    },
    solution:
      'When PC2 was moved, its switch port Fa0/2 was left in VLAN 20 instead of VLAN 10. The PCs share a subnet, but the switch never bridges frames between different VLANs, so ARP fails. Fix: set Fa0/2 back to VLAN 10 (USERS).',
  },
  {
    id: 'sc-dhcp',
    title: 'New PCs receive no IP address',
    difficulty: 'medium',
    points: 120,
    brief:
      'A new employee plugged in PC2, but it never gets an address from the DHCP server on SRV1. PC1 (an older client) still works fine.',
    objectives: ['Find why PC2 gets no DHCP lease', 'Identify the fault type'],
    hints: [
      'Check the DHCP simulation result for each client: did PC1 get a lease but PC2 did not?',
      'Look at the pool range on SRV1 and how many clients need an address.',
      'The pool only has 192.168.10.100–105, and something is consuming the whole range — PC2 finds no free address.',
    ],
    faultKinds: ['dhcp-exhausted'],
    buildLab: () => {
      const lab = buildDhcpLab('Scenario: DHCP pool exhausted', 'sc-lab-dhcp')
      lab.faults = [
        fault({ id: 'flt-dhcp', kind: 'dhcp-exhausted', deviceId: 'srv1', poolId: 'pool-srv1-lan' }),
      ]
      return lab
    },
    solution:
      'The DHCP pool on SRV1 was exhausted, so PC2 could not obtain a lease and stayed without an IP address. Fix: enlarge the pool range (or free up addresses) on SRV1.',
  },
  {
    id: 'sc-mask',
    title: 'PC1 reaches some hosts but not others',
    difficulty: 'easy',
    points: 100,
    brief:
      'PC1 can still ping PC2 (192.168.1.11) but can no longer reach PC3 (192.168.1.200). No router involved. Someone may have experimented with subnetting on PC1.',
    objectives: ['Find why PC1 cannot reach PC3', 'Identify the affected device and the fault type'],
    hints: [
      'When PC1 pings PC3, is the failure "no gateway" or "request timed out"? What does that say about PC1’s view of the subnet?',
      'Compare the subnet mask of PC1 with the masks on PC2 and PC3.',
      'PC1 uses /25 instead of /24, so addresses from .128 onward (including PC3 at .200) look remote.',
    ],
    faultKinds: ['wrong-mask'],
    buildLab: () => {
      const lab = buildMaskLab('Scenario: Wrong mask on PC1', 'sc-lab-mask')
      lab.faults = [
        fault({ id: 'flt-mask', kind: 'wrong-mask', deviceId: 'pc1', interfaceId: 'pc1-fa0', value: '192.168.1.10/25' }),
      ]
      return lab
    },
    solution:
      'PC1’s mask was changed from /24 to /25. Hosts with addresses from .128 upward (like PC3 at .200) are now outside PC1’s subnet, and with no gateway configured they are unreachable. Fix: restore the mask to 255.255.255.0 (/24).',
  },
  {
    id: 'sc-ifdown',
    title: 'PC1 is completely offline',
    difficulty: 'easy',
    points: 80,
    brief:
      'PC1 was rebooted overnight and has been offline ever since. It cannot ping anything at all — not even its default gateway.',
    objectives: ['Find why PC1 is fully offline', 'Identify the affected device and the fault type'],
    hints: [
      'Ping from PC1 to anything — does the simulation even get to send a packet?',
      'Inspect the state of PC1’s interface Fa0.',
      'PC1’s Fa0 is administratively down (shutdown) after the reboot.',
    ],
    faultKinds: ['interface-down'],
    buildLab: () => {
      const lab = buildOfficeLab('Scenario: PC1 offline', 'sc-lab-ifdown')
      lab.faults = [
        fault({ id: 'flt-ifdown', kind: 'interface-down', deviceId: 'pc1', interfaceId: 'pc1-fa0' }),
      ]
      return lab
    },
    solution:
      'PC1’s interface Fa0 was left administratively down after the reboot, so the PC could not send any frame. Fix: enable Fa0 on PC1 (no shutdown).',
  },
  {
    id: 'sc-dupip',
    title: 'Address 192.168.1.10 answers from the wrong device',
    difficulty: 'hard',
    points: 200,
    brief:
      'Users report flaky behavior: pings to 192.168.1.10 sometimes behave oddly, and connections to that address reset. A technician added PC2 to the LAN recently.',
    objectives: ['Find the address conflict', 'Identify the affected device and the fault type'],
    hints: [
      'Check every interface address on the LAN segment for duplicates.',
      'Two devices share one address — compare PC1 and PC2 configurations.',
      'PC2 was configured with PC1’s address 192.168.1.10/24 — a duplicate IP conflict.',
    ],
    faultKinds: ['duplicate-ip'],
    buildLab: () => {
      const lab = buildOfficeLab('Scenario: Duplicate IP', 'sc-lab-dupip')
      lab.devices = [
        ...lab.devices,
        {
          id: 'pc2',
          name: 'PC2',
          kind: 'pc',
          x: 60,
          y: 360,
          gatewayIp: '192.168.1.1',
          interfaces: [
            { id: 'pc2-fa0', name: 'Fa0', role: 'host', ipMode: 'static', cidr: '192.168.1.12/24', enabled: true, accessVlan: 10 },
          ],
          staticRoutes: [],
          dhcpPools: [],
        },
      ]
      lab.links = [
        ...lab.links,
        {
          id: 'lnk-pc2-sw1',
          aDeviceId: 'pc2',
          aInterfaceId: 'pc2-fa0',
          bDeviceId: 'sw1',
          bInterfaceId: 'sw1-fa03',
          enabled: true,
        },
      ]
      lab.faults = [
        fault({ id: 'flt-dupip', kind: 'duplicate-ip', deviceId: 'pc2', interfaceId: 'pc2-fa0', value: '192.168.1.10/24' }),
      ]
      return lab
    },
    solution:
      'PC2 was deployed with PC1’s address 192.168.1.10/24. Two devices answering ARP for one IP causes intermittent, misdirected traffic. Fix: give PC2 a free address in 192.168.1.0/24 (e.g. 192.168.1.12).',
  },
  {
    id: 'sc-intervlan',
    title: 'VLAN 10 cannot cross the trunk',
    difficulty: 'hard',
    points: 200,
    brief:
      'Inter-VLAN routing was just set up: two VLANs on SW1, a trunk to R1 with sub-interfaces. PC1 (VLAN 10) cannot reach PC2 (VLAN 20) or its own gateway. PC2 works fine.',
    objectives: ['Find why VLAN 10 traffic is blocked', 'Identify the affected device and the fault type'],
    hints: [
      'Ping from PC1 to anything and read the failure note about where the path is blocked.',
      'Compare the access VLAN PC1 uses with the allowed VLAN list on the trunk port of SW1.',
      'The trunk on SW1 Fa0/3 no longer carries VLAN 10, so PC1 cannot even reach its gateway.',
    ],
    faultKinds: ['trunk-vlan-missing'],
    buildLab: () => {
      const lab = buildInterVlanLab('Scenario: VLAN 10 blocked at the trunk', 'sc-lab-intervlan')
      lab.faults = [
        fault({ id: 'flt-trunk', kind: 'trunk-vlan-missing', deviceId: 'sw1', interfaceId: 'sw1-fa03', value: '10' }),
      ]
      return lab
    },
    solution:
      'VLAN 10 was removed from the allowed list of trunk SW1 Fa0/3, so frames from PC1 (VLAN 10) never reached the trunk — not even to ARP for the gateway. PC2 (VLAN 20) was unaffected because VLAN 20 is still permitted. Fix: add VLAN 10 back to the allowed list on SW1 Fa0/3.',
  },
  {
    id: 'sc-subif',
    title: 'No gateway answer in VLAN 10',
    difficulty: 'hard',
    points: 200,
    brief:
      'After a router reconfiguration, PC1 (VLAN 10) cannot reach anything outside its own subnet — every ping to the gateway times out. The trunk shows no errors and PC2 (VLAN 20) is fine.',
    objectives: ['Find why VLAN 10 has no gateway', 'Identify the affected device and the fault type'],
    hints: [
      'The gateway address 192.168.10.1 belongs to R1 — check which sub-interfaces R1 actually has.',
      'Compare the VLAN each R1 sub-interface serves with the VLAN PC1 sits in.',
      'R1 lost its Gi0/0.10 sub-interface — VLAN 10 has no router address at all.',
    ],
    faultKinds: ['missing-subinterface'],
    buildLab: () => {
      const lab = buildInterVlanLab('Scenario: VLAN 10 sub-interface missing', 'sc-lab-subif')
      lab.faults = [
        fault({ id: 'flt-subif', kind: 'missing-subinterface', deviceId: 'r1', interfaceId: 'r1-gi00', subInterfaceId: 'r1-gi00-sub10' }),
      ]
      return lab
    },
    solution:
      "R1 lost its Gi0/0.10 sub-interface, so VLAN 10 had no router address: PC1's ARP for 192.168.10.1 timed out. PC2 kept working because Gi0/0.20 (VLAN 20) was untouched. Fix: recreate sub-interface Gi0/0.10 for VLAN 10 with address 192.168.10.1/24.",
  },
  {
    id: 'sc-relay',
    title: 'Remote VLAN clients get no addresses',
    difficulty: 'hard',
    points: 200,
    brief:
      'DHCP for VLAN 10 was moved to a central server in the server subnet, relayed through R1. Since the change, PC1 never receives an address — the DHCP server itself is up and its scope is configured.',
    objectives: ['Find why relayed DHCP requests never arrive', 'Identify the affected device and the fault type'],
    hints: [
      'Check the DHCP simulation result for PC1: which step of the relayed request fails?',
      'PC1\'s request must be forwarded by the router interface that owns 192.168.10.1 — inspect its relay configuration.',
      'R1\'s Gi0/0.10 sub-interface lost its ip helper-address pointing at 10.0.0.20.',
    ],
    faultKinds: ['missing-dhcp-relay'],
    buildLab: () => {
      const lab = buildDhcpRelayLab('Scenario: DHCP relay missing', 'sc-lab-relay')
      lab.faults = [
        fault({ id: 'flt-relay', kind: 'missing-dhcp-relay', deviceId: 'r1', interfaceId: 'r1-gi00', subInterfaceId: 'r1-gi00-sub10' }),
      ]
      return lab
    },
    solution:
      'R1\'s sub-interface Gi0/0.10 lost its DHCP relay (ip helper-address 10.0.0.20). PC1\'s requests stayed inside VLAN 10 where no server exists, so no lease was ever granted. Fix: restore the relay target 10.0.0.20 on Gi0/0.10.',
  },
  {
    id: 'sc-relay-target',
    title: 'Relay points at the wrong address',
    difficulty: 'medium',
    points: 150,
    brief:
      'After an IP renumbering on the server network, PC1 stopped receiving DHCP leases through the relay. The server answers ping fine from R1 — but clients still get nothing.',
    objectives: ['Find why the relayed request gets no answer', 'Identify the affected device and the fault type'],
    hints: [
      'The relay configuration on R1 still points somewhere — check exactly where.',
      'Compare the relay target with the addresses that actually exist in the server subnet.',
      'The relay targets 10.0.0.99, an address nobody owns since the renumbering.',
    ],
    faultKinds: ['wrong-relay-target'],
    buildLab: () => {
      const lab = buildDhcpRelayLab('Scenario: Wrong relay target', 'sc-lab-relaytarget')
      lab.faults = [
        fault({ id: 'flt-relaytarget', kind: 'wrong-relay-target', deviceId: 'r1', interfaceId: 'r1-gi00', subInterfaceId: 'r1-gi00-sub10', value: '10.0.0.99' }),
      ]
      return lab
    },
    solution:
      'R1\'s relay on Gi0/0.10 still points at 10.0.0.99 — an address that no longer exists after the renumbering. The relayed request dies at the relay because nothing owns the target. Fix: point the relay at the server\'s real address, 10.0.0.20.',
  },
  {
    id: 'sc-acl',
    title: 'Server stopped answering pings',
    difficulty: 'medium',
    points: 150,
    brief:
      'PC1 can no longer ping SRV1 (203.0.113.20). The network team did not change any address, and the server itself answers other traffic. An ACL change was made on R1 recently.',
    objectives: ['Find which rule blocks the traffic', 'Identify the affected device and the fault type'],
    hints: [
      'Ping from PC1 to SRV1 and read the failure: which interface and ACL blocked the packet?',
      'Compare the matching rule with the other rules in that ACL — where does it sit in the list?',
      'A "deny icmp any any" was added at the top of SERVER-POLICY on R1 Gi0/1 (outbound), so it decides before every permit.',
    ],
    faultKinds: ['acl-blocks-traffic'],
    buildLab: () => {
      const lab = buildAclLab('Scenario: ACL denies pings', 'sc-lab-acl')
      lab.faults = [
        fault({ id: 'flt-acl', kind: 'acl-blocks-traffic', deviceId: 'r1', interfaceId: 'r1-gi01', value: 'out icmp any any' }),
      ]
      return lab
    },
    solution:
      'A "deny icmp any any" rule was placed at the top of the SERVER-POLICY ACL on R1 Gi0/1 (outbound). ACLs evaluate top-down and the first match decides, so every ping died at the router while TCP/UDP traffic still passed. Fix: remove the deny rule (or place a more specific permit above it).',
  },
  {
    id: 'sc-acl-order',
    title: 'One host blocked by a broad deny',
    difficulty: 'hard',
    points: 200,
    brief:
      'The server-subnet ACL should only block telnet, but now PC1 (192.168.10.11) cannot even ping SRV1. Other PCs reportedly still work. The ACL rules look "all present" at first glance.',
    objectives: ['Find why the permit for PC1 never applies', 'Identify the affected device and the fault type'],
    hints: [
      'The ACL evaluates rules strictly top-down — the FIRST match decides, and everything after it is ignored.',
      'Check the position of the deny rule relative to any permits for specific hosts.',
      'A broad "deny icmp 192.168.10.0/24 any" was inserted ABOVE the permit that should allow PC1.',
    ],
    faultKinds: ['acl-blocks-traffic'],
    buildLab: () => {
      const lab = buildAclLab('Scenario: Wrong rule order', 'sc-lab-aclorder')
      lab.faults = [
        fault({ id: 'flt-aclorder', kind: 'acl-blocks-traffic', deviceId: 'r1', interfaceId: 'r1-gi01', value: 'out icmp 192.168.10.0/24 any' }),
      ]
      return lab
    },
    solution:
      'A broad "deny icmp 192.168.10.0/24 any" was inserted at the top of SERVER-POLICY on R1 Gi0/1. Because ACLs use first-match-wins, that rule shadows every later permit for PC1\'s subnet. Fix: remove the broad deny (or place specific permits above it).',
  },
]

export function getScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id)
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface Submission {
  deviceId: string
  interfaceId?: string
  kind: FaultKind | 'no-fault'
}

export interface EvaluationResult {
  correct: boolean
  /** Faults that matched the submission. */
  matched: Fault[]
  /** Score awarded (0 when incorrect). */
  score: number
  feedback: string
}

/** Each hint costs 20% of the points; never below 40%. */
export function computeScore(points: number, hintsUsed: number): number {
  const penalty = points * 0.2 * hintsUsed
  return Math.max(Math.round(points * 0.4), Math.round(points - penalty))
}

/** Grade a diagnosis submission against the active faults of a scenario lab. */
export function evaluateSubmission(scenario: Scenario, lab: Lab, submission: Submission, hintsUsed: number): EvaluationResult {
  const active = lab.faults.filter((f) => f.active)
  if (submission.kind === 'no-fault') {
    if (active.length === 0) {
      return {
        correct: true,
        matched: [],
        score: computeScore(scenario.points, hintsUsed),
        feedback: 'Correct — the configuration is actually fine.',
      }
    }
    return {
      correct: false,
      matched: [],
      score: 0,
      feedback: `Not quite: the evidence shows a real misconfiguration. ${active.length} fault(s) are active.`,
    }
  }
  const matched = active.filter((f) => {
    if (f.kind !== submission.kind) return false
    if (f.deviceId !== submission.deviceId) return false
    if (submission.interfaceId && f.interfaceId && submission.interfaceId !== f.interfaceId) return false
    return true
  })
  if (matched.length > 0) {
    return {
      correct: true,
      matched,
      score: computeScore(scenario.points, hintsUsed),
      feedback: `Correct diagnosis: ${matched.map(describeFaultMatch).join('; ')}.`,
    }
  }
  const deviceHint = active.some((f) => f.deviceId === submission.deviceId)
    ? 'Right device, wrong fault type — look at the failure evidence again.'
    : 'That device is not where the fault lives. Follow the ping evidence hop by hop.'
  return { correct: false, matched: [], score: 0, feedback: deviceHint }
}

export function describeFaultMatch(f: Fault): string {
  switch (f.kind) {
    case 'wrong-gateway':
      return `wrong default gateway (${f.value ?? '?'})`
    case 'wrong-ip':
      return `wrong IP address (${f.value ?? '?'})`
    case 'wrong-mask':
      return `wrong subnet mask (${f.value ?? '?'})`
    case 'interface-down':
      return 'interface administratively down'
    case 'link-down':
      return 'link down'
    case 'vlan-mismatch':
      return `VLAN mismatch (VLAN ${f.value ?? '?'})`
    case 'dhcp-exhausted':
      return 'DHCP pool exhausted'
    case 'remove-route':
      return 'missing static route'
    case 'duplicate-ip':
      return `duplicate IP (${f.value ?? '?'})`
    case 'trunk-vlan-missing':
      return `VLAN ${f.value ?? '?'} missing from trunk allowed list`
    case 'trunk-native-mismatch':
      return `native VLAN mismatch (VLAN ${f.value ?? '?'})`
    case 'missing-subinterface':
      return 'missing router sub-interface'
    case 'missing-dhcp-relay':
      return 'missing DHCP relay configuration'
    case 'wrong-relay-target':
      return `wrong DHCP relay target (${f.value ?? '?'})`
    case 'missing-dhcp-scope':
      return 'missing DHCP scope for the relayed subnet'
    case 'acl-blocks-traffic':
      return 'ACL rule blocks required traffic'
    default:
      return f.kind
  }
}

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
}
