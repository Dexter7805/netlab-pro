// Beginner learning mode: short, friendly explanations attached to the
// screens where the concepts actually appear. Gated behind a toggle so
// experienced users are not distracted.

import { useState } from 'react'
import { BookOpen, GraduationCap } from 'lucide-react'
import { useLearningMode } from '../state/useLearningMode'

export type LearnTopic =
  | 'ip-and-mask'
  | 'network-and-broadcast'
  | 'default-gateway'
  | 'switch-vs-router'
  | 'vlan-access'
  | 'trunk-ports'
  | 'vlan-tagging'
  | 'router-subinterfaces'
  | 'inter-vlan-routing'
  | 'dhcp'
  | 'dhcp-relay'
  | 'acl-basics'
  | 'acl-rule-order'
  | 'acl-directions'
  | 'static-routes'
  | 'ping-results'
  | 'faults'
  | 'validation'

const CONTENT: Record<LearnTopic, { title: string; body: string }> = {
  'ip-and-mask': {
    title: 'IPv4 address & subnet mask',
    body: 'An IPv4 address (like 192.168.1.10) identifies one device on a network. The subnet mask (/24 = 255.255.255.0) says which part of the address is the shared network and which part is the device itself. Two devices can talk directly only if their addresses share the same network part.',
  },
  'network-and-broadcast': {
    title: 'Network & broadcast address',
    body: 'In every subnet the first address (e.g. 192.168.1.0) names the network itself and the last (192.168.1.255) is the broadcast address used to reach all hosts at once. Neither may be assigned to a device — the app flags both as configuration errors.',
  },
  'default-gateway': {
    title: 'Default gateway',
    body: 'The gateway is the "exit door" of a subnet: the router interface a device sends traffic to when the destination is outside its own network. It must be an address that really exists on the same cable/switch — otherwise every off-subnet ping times out.',
  },
  'switch-vs-router': {
    title: 'Switch vs. router',
    body: 'A switch forwards frames inside one network (layer 2) based on MAC addresses. A router connects different networks (layer 3) and forwards packets between them. PCs plug into switches; switches plug into routers.',
  },
  'vlan-access': {
    title: 'VLANs & access ports',
    body: 'A VLAN splits one physical switch into several isolated virtual switches. Every access port belongs to exactly one VLAN (a number like 10 or 20). Ports in different VLANs cannot exchange frames even when the IP settings look identical — a very common lab fault.',
  },
  'trunk-ports': {
    title: 'Trunk ports & allowed VLANs',
    body: 'A trunk port connects switches to each other (or to a router) and carries MANY VLANs over one cable. Its allowed-VLAN list says which VLANs may cross; a VLAN missing from the list is silently blocked. Access ports (PCs, servers) always carry exactly one VLAN.',
  },
  'vlan-tagging': {
    title: 'VLAN tagging (802.1Q)',
    body: 'On a trunk, every frame is tagged with a small header (802.1Q) carrying its VLAN number, so the receiving switch knows which VLAN it belongs to. The native VLAN is the exception: its frames travel untagged. Both ends of a trunk must agree on the native VLAN, or untagged traffic lands in the wrong VLAN.',
  },
  'router-subinterfaces': {
    title: 'Router sub-interfaces',
    body: 'A router can serve several VLANs through ONE physical port by using sub-interfaces (Gi0/0.10, Gi0/0.20 …). Each sub-interface binds the port to one VLAN (encapsulation dot1Q) and carries the gateway address for that VLAN. Without a sub-interface for a VLAN, that VLAN has no gateway at all.',
  },
  'inter-vlan-routing': {
    title: 'Inter-VLAN routing',
    body: 'Hosts in different VLANs can only talk through a router: PC1 (VLAN 10) sends to its gateway, the router routes to VLAN 20, and delivers via the trunk. For this to work, the trunk must permit both VLANs, the router needs a sub-interface per VLAN, and each PC needs the right gateway. A failure anywhere in that chain breaks the path.',
  },
  dhcp: {
    title: 'DHCP (and DNS)',
    body: 'DHCP hands out IP settings automatically: a server keeps a pool of addresses and leases one to each client, together with the gateway. DNS (not simulated here) would translate names like example.com into IP addresses. If a client gets no lease, it has no address at all and cannot communicate.',
  },
  'dhcp-relay': {
    title: 'DHCP relay (ip helper-address)',
    body: 'A DHCP request is a broadcast and never crosses a router by itself. DHCP relay fixes that: the router interface serving the client\'s subnet forwards the request to a configured server address (the helper), tagging it with its own address (giaddr). The server picks the scope whose network matches giaddr — so a relayed client always gets an address for ITS subnet, never the server\'s.',
  },
  'acl-basics': {
    title: 'Access Control Lists (ACLs)',
    body: 'An ACL is an ordered list of rules attached to a router interface. Each rule says "permit" or "deny" for a kind of packet (protocol, source, destination, optional port). The router checks every packet against the list top-down: the FIRST rule that matches decides. If no rule matches, the packet is permitted (implicit permit — the default used in this simulation).',
  },
  'acl-rule-order': {
    title: 'Rule order matters',
    body: 'Because the first match wins, a broad deny at the top hides every permit below it. The classic mistake is writing "deny 192.168.10.0/24" above "permit host 192.168.10.11" — the specific permit is never reached. Order rules from most specific to most general.',
  },
  'acl-directions': {
    title: 'Inbound vs outbound',
    body: 'ACLs are directional. Inbound (in) filters packets arriving ON an interface; outbound (out) filters packets LEAVING through it. The same rule placed "in" on one interface behaves differently from "out" on another. In this simulation, inbound ACLs evaluate on the physical ingress port of a router, outbound ACLs on the exact egress interface (sub-interface or physical).',
  },
  'static-routes': {
    title: 'Static routes & routing tables',
    body: 'A router only forwards packets for networks it knows. Connected networks are learned automatically; everything else needs a static route: "network X/Y is reachable via next-hop Z", where Z is a neighboring router on a directly connected subnet. A missing route makes the router answer "destination unreachable".',
  },
  'ping-results': {
    title: 'Reading ping results',
    body: 'A successful reply proves the whole round trip works. Failures tell you where it broke: "no gateway / network unreachable" = the source does not know where to send it; "request timed out" = the packet was sent but no answer came back (wrong subnet, VLAN isolation, or the target is down); "destination unreachable" = a router says it cannot forward further. Follow the hop list: the last hop before the failure is usually the culprit.',
  },
  faults: {
    title: 'Fault lab',
    body: 'Faults are intentional configuration mistakes layered on top of the lab (bad IP, wrong mask, shut interface, VLAN mismatch …). They let you practice troubleshooting: ping results, validation and NetDoctor all react to them exactly as they would to a real typo.',
  },
  validation: {
    title: 'Validation vs. diagnosis',
    body: 'Validation checks the configuration on paper: duplicate addresses, invalid masks, missing gateways, broken links, VLAN or route mistakes. Confirmed faults are marked as errors, "probably wrong" as warnings, and hints as info. NetDoctor goes one step further and tests actual connectivity.',
  },
}

/** Inline explainer shown only when learning mode is enabled. */
export function LearnBox({ topic }: { topic: LearnTopic }) {
  const { enabled } = useLearningMode()
  const [open, setOpen] = useState(false)
  if (!enabled) return null
  const content = CONTENT[topic]
  return (
    <div className="rounded-lg border border-sky-900/50 bg-sky-950/30 text-xs">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left font-medium text-sky-300"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <GraduationCap size={13} className="shrink-0" aria-hidden />
        <span className="flex-1">What is this? {content.title}</span>
        <span className="text-sky-500">{open ? '−' : '+'}</span>
      </button>
      {open && <p className="border-t border-sky-900/40 px-2.5 py-2 leading-relaxed text-sky-100/80">{content.body}</p>}
    </div>
  )
}

/** Sidebar toggle for learning mode. */
export function LearningModeToggle() {
  const { enabled, setEnabled } = useLearningMode()
  return (
    <button
      type="button"
      onClick={() => setEnabled(!enabled)}
      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition ${
        enabled ? 'bg-sky-500/15 text-sky-300' : 'text-slate-500 hover:bg-panel hover:text-slate-300'
      }`}
      title="Show beginner explanations throughout the app"
      aria-pressed={enabled}
    >
      <BookOpen size={14} aria-hidden />
      <span className="hidden md:inline">{enabled ? 'Learning mode: ON' : 'Learning mode: off'}</span>
    </button>
  )
}
