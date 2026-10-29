# NetLab Pro

A browser-based network engineering learning platform with two integrated modules:

1. **NetLab Simulator** — build and configure virtual networks (routers, switches, PCs, servers), wire them up, configure IPv4 addressing, VLANs, static routes and DHCP, then run *simulated* pings with detailed, understandable explanations.
2. **NetDoctor Academy** — practical troubleshooting cases with injected faults, diagnostic tools, hints, scoring and completion tracking. You can also run practice diagnoses against your own NetLab topologies.

Both modules share the **same simulation engine** and the **same lab data model**: a fault injected in NetLab immediately changes simulated connectivity results and is detected by NetDoctor's diagnostic engine; fixing it changes both back.

> ⚠️ **Everything in this app is simulated.** No packet ever leaves your browser and no live network data is used anywhere. All ping results, diagnostics and monitoring panels are produced by the local simulation engine.

---

## Installation (Windows)

Requirements: **Node.js 20 or newer** (Node 24 recommended) and npm.

```powershell
cd C:\Users\Admin\Desktop\NetLab-Pro
npm install
```

## Running

```powershell
npm run dev
```

Open http://localhost:5173/ in your browser. The dev server supports hot module reload.

Production build and preview:

```powershell
npm run build      # type-checks (tsc -b) and bundles to dist/
npm run preview    # serve the production build locally
```

## Tests

```powershell
npm test           # run all unit tests once (Vitest)
npm run test:watch # watch mode
```

The suite (150+ tests) covers:

- **Subnet calculations** — IPv4 parsing/formatting, masks, network/broadcast addresses, prefix↔mask conversion, host ranges, CIDR containment, private-address classification, validation messages (`src/engine/ip.test.ts`).
- **Connectivity** — simulated pings across switches, gateways and multi-router static routing; deterministic DHCP leases (including pool-provided gateways); every failure taxonomy (no gateway, wrong gateway, interface down, missing route, VLAN isolation, DHCP exhaustion, TTL/loops, unreachable next hops) plus recovery after fixing each fault (`src/engine/ping.test.ts`).
- **Fault detection** — each of the 9 supported fault kinds is detected on the effective configuration, every built-in scenario's fault is detectable, and removing a fault clears detection and restores connectivity (`src/engine/faults.test.ts`).
- **Validation** — duplicate addresses, network/broadcast misuse, gateways, disconnected interfaces, down links, double-used interfaces, VLAN range/uplink checks, static-route errors, severity summaries (`src/engine/validate.test.ts`).
- **Undo/redo history** — undo/redo chains, redo invalidation on new edits, drag coalescing, size limits, snapshot integrity (`src/engine/history.test.ts`).
- **ACLs** — first-match-wins ordering (broad deny shadows specific permits), permit/deny behavior, protocol and destination-port matching, inbound vs outbound directions (including sub-interface egress), implicit permit for unmatched traffic, structured ACL decisions in ping results, detection anchored on the matching rule with a remove-rule fix, validation of targets/ports/protocols/duplicates, and import round-trips plus backwards compatibility (`src/engine/acl.test.ts`).
- **DHCP relay** — successful relayed leases with gateway/DNS, giaddr-based scope selection (wrong-subnet scope untouched), missing relay, wrong target (unowned / non-server), unreachable server, missing scope with generated-scope fix, pool exhaustion over relay, invalid pool gateway with set-pool-gateway fix, local-DHCP and inter-VLAN regressions, import round-trips and backwards compatibility (`src/engine/dhcpRelay.test.ts`).
- **VLAN trunking & inter-VLAN routing** — trunk-permitted and blocked segments, sub-interface routing hops, missing sub-interfaces (including wrong-VLAN and wrong-subnet variants), trunk-native-mismatch detection, create-subinterface/allow-vlan machine fixes, trunk/sub-interface validation, and import round-trips plus backwards compatibility with older lab files (`src/engine/trunk.test.ts`).
- **Import/export** — round-trips of all sample labs, every rejection path (non-JSON, wrong format, newer schema version, unknown kinds, malformed/duplicate ids, bad VLANs), and warning-level recovery (dangling links, loop links, orphans) (`src/engine/labFile.test.ts`).
- **Integration/safety regressions** — engine functions never mutate their inputs, scenario labs are independent copies, "apply fix" corrects the intended fault and restores connectivity, practice mutations can never touch the original lab (`src/engine/regression.test.ts`).
- **Persistence** — lab CRUD + reload across "page loads", no silent re-seed after deliberate deletion, safe sample restore that keeps user labs, import/replace store semantics, progress/scoring records (`src/storage/stores.test.ts`).

## Features

### NetLab Simulator
- Interactive topology canvas (React Flow): add, drag, connect and delete routers, switches, PCs and servers.
- Per-device inspector: rename, interfaces (name, static/DHCP, IPv4 + prefix with live validation, up/down), access VLANs on switch ports, default gateways, static routes and DHCP pools.
- VLAN-aware L2 simulation: switches only bridge ports that share the access VLAN.
- **VLAN trunking (802.1Q) and inter-VLAN routing**: switch ports can be access or trunk ports; trunks carry an allowed-VLAN list and a native VLAN, and forward only permitted VLANs. Routers support router-on-a-stick with VLAN sub-interfaces (`Gi0/0.10` etc., each bound to one VLAN with its own IPv4 address). Inter-VLAN traffic flows only when the trunk, sub-interfaces, addressing and endpoint gateways are all configured correctly. The ping hop list names the sub-interface and VLAN used.
- **Trunking diagnostics**: NetLab validation flags empty allowed lists, out-of-range VLAN ids, trunk pairs with no common VLAN, native-VLAN mismatches and duplicate sub-interface bindings. NetDoctor detects and anchors three fault kinds — *VLAN missing from trunk allowed list*, *trunk native-VLAN mismatch* and *missing router sub-interface* (including sub-interfaces on the wrong VLAN or the wrong subnet) — with machine-applicable fixes (allow a VLAN on the trunk, create a missing sub-interface with the right address).
- **DHCP relay diagnostics**: NetLab validation flags invalid relay targets, self-pointing relays, pools with unusable gateways and invalid DNS entries. NetDoctor detects *missing DHCP relay configuration* (with a safe fix when exactly one DHCP server exists), *wrong relay target*, *unreachable DHCP server*, *missing DHCP scope for the relayed subnet* (with a fix that generates the correct scope) and *pool exhaustion* — relayed or local.
- **ACLs (access control lists)**: ordered permit/deny rules on routed interfaces and router sub-interfaces, for protocols `icmp`, `tcp` and `udp` with optional destination-port matching for tcp/udp, against `any`, plain IPv4 addresses (/32) or CIDR ranges. First match wins; unmatched traffic is **implicitly permitted** (documented default). Inbound ACLs evaluate on the router's physical ingress port; outbound ACLs on the exact egress interface (sub-interface or physical). The ping console can send simulated icmp/tcp/udp probes with a destination port, and every result names the deciding rule (ACL, position, action, addresses, port, interface, direction). The ping hop list shows where the packet was blocked.
- **ACL diagnostics**: NetLab validation flags invalid addresses/ranges, unsupported protocols, invalid ports, ports on icmp rules, duplicate direction entries and duplicate rule ids, and ACLs on non-routed interfaces. NetDoctor detects *ACL blocks required traffic* from observed probe failures — anchored on the interface and matching rule, with a machine fix that removes the offending deny rule.
- Router simulation: connected routes + longest-prefix static routing, next-hop resolution, TTL and loop handling.
- Deterministic DHCP: server pools hand out leases in a reproducible order and propagate the pool gateway to clients (plus optional DNS server information per pool).
- **DHCP relay (ip helper-address)**: routed interfaces and VLAN sub-interfaces can forward DHCP requests to a remote server. The relayed request carries the relay agent's address (giaddr), the server picks only the scope whose network matches it (never an address from the wrong subnet), and the lease includes address, prefix, gateway and optional DNS. Failures are deterministic and explained: relay missing, relay target unowned or not a DHCP server, server unreachable through routing, no matching scope, or exhausted pool.
- Simulated ping console with hop-by-hop trace, structured failure codes and human explanations.
- Fault injection: 9 fault kinds (wrong IP / mask / gateway, interface down, link down, VLAN mismatch, DHCP pool exhausted, removed static route, duplicate IP) with enable/disable toggles.
- Lab management: create, rename, duplicate, delete; seven sample labs seeded on first run (including an inter-VLAN routing lab with two VLANs, a trunk and a router-on-a-stick, a DHCP relay lab whose client leases from a server in another subnet, and an ACL lab where pings succeed while tcp/23 to the server is denied); everything persists in `localStorage` (`netlab-pro.labs.v1`).
- **Undo/redo** for every lab edit (devices, links, configuration, faults) with Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) shortcuts; continuous device drags collapse into a single undo step; undo/redo always persists through the same save path as ordinary edits.
- **Import/export**: download a lab as a versioned `.netlab.json` file and import it back. Importing validates the file (JSON structure, schema version, device kinds, address prefixes, VLAN ranges, id uniqueness) with understandable error messages, drops cross-references that point at missing objects with warnings, and always creates a NEW lab — an existing lab is never overwritten without explicitly choosing to replace it.
- **Validation panel** (the "Check" tab): confirmed faults vs. warnings vs. hints — duplicate IPv4 addresses, network/broadcast addresses used as host or gateway addresses, invalid masks and prefixes, missing or invalid gateways, disconnected interfaces, down links, double-used interfaces, out-of-range access VLANs, mismatched switch-to-switch uplinks, invalid static routes and next hops, duplicate device names.
- **Learning mode** (toggle in the sidebar): beginner-friendly explanations for IP addressing and masks, network/broadcast addresses, default gateways, switches vs. routers, VLANs and access ports, DHCP/DNS, static routes and routing tables, how trunks and 802.1Q tagging work, what router sub-interfaces and inter-VLAN routing are, what ACLs are, why rule order and permit/deny semantics matter, how inbound/outbound directions differ, and how to read ping results and validation findings — shown contextually inside the relevant screens.

### NetDoctor Academy
- 7 built-in cases (easy → hard): wrong gateway, missing static route, VLAN mismatch, DHCP pool exhaustion, wrong subnet mask, interface shutdown, duplicate IP conflict.
- Case runner with: trouble-ticket brief, read-only topology, simulated ping tool, per-device CLI-style config viewer, host-to-host connectivity matrix.
- Diagnosis submission (device + fault type) with scoring: each revealed hint costs 20 % of the points (floor 40 %). Wrong diagnoses give feedback; the correct solution explains the root cause and offers a one-click **Apply fix** — after which the connectivity matrix re-runs and turns green.
- Completion tracking and best scores per case, persisted in `localStorage` (`netlab-pro.progress.v1`).
- **Practice on your own labs**: pick any saved lab, inject faults, and run a diagnosis against it (scored for the session; built-in case completion tracking is not affected).

### Integration guarantees
- `applyFaults()` produces the *effective* configuration used by ping, validation and detection alike — NetLab faults are inherently visible to NetDoctor.
- Detection works from observable state (config consistency checks + a full host-to-host ping suite), not by reading fault metadata, so injected faults are found the same way real misconfigurations would be.
- Detection reports include evidence, explanation, suggested fix and (where safe) a machine-applicable fix action.
- "Apply fix" restores the base configuration first (deactivates fault overlays), then applies machine fixes with re-detection between steps — so a fix can never leave a broken base configuration behind, and the connectivity matrix re-runs against the repaired lab.
- Practice runs operate on a deep clone of the selected lab; the original lab and the built-in completion records cannot be modified by a practice session (covered by regression tests).

## Project structure

```
src/
  engine/        # Simulation core (no React): ip, topology, dhcp, routing,
                 # ping, effective (fault overlay), faults (detection),
                 # scenarios, labOps, validate + unit tests
  storage/       # localStorage-backed lab store and progress store
  state/         # React bindings (useSyncExternalStore)
  data/          # Sample lab templates
  components/    # Shared UI (ping console, fault panel, icons, banners)
  lab/           # NetLab module (canvas, device node, inspector, view)
  doctor/        # NetDoctor module (scenario list, runner)
  Dashboard.tsx  # Overview page
  App.tsx        # App shell with sidebar navigation
```

Simulation logic is fully separated from the UI: the engine modules import nothing from React and are tested headlessly with Vitest.

## Roadmap — advanced networking (NOT yet implemented)

The features below are planned but **not simulated today**. Nothing in the current
app pretends to support them. Each entry sketches the work required on top of the
existing architecture (engine in `src/engine/`, UI reads only engine results).

### 1. VLAN trunking (802.1Q) and inter-VLAN routing — **IMPLEMENTED (Phase 2A)**
Switch ports have an access/trunk mode with allowed-VLAN lists and native VLAN; the L2 walk is VLAN-aware; routers support VLAN sub-interfaces (router-on-a-stick) that contribute connected routes; detection covers trunk and missing-sub-interface faults; two sample NetDoctor scenarios and the "Inter-VLAN Routing" sample lab ship with it. Remaining gaps for a future pass: switch SVIs, DHCP across trunks, and multi-switch tag-transformation paths.

### 2. ACLs and firewall rules — **IMPLEMENTED (Phase 2C)**
Ordered permit/deny rules on routed interfaces and sub-interfaces with icmp/tcp/udp and destination-port matching; first-match-wins with implicit permit (documented); ingress evaluation on the physical port, egress on the exact egress interface; structured ACL decisions in ping results; NetDoctor detection with remove-rule fixes. Remaining gaps for a future pass: named/numbered ACL object sharing across interfaces, established/return-traffic handling (the reply path is assumed symmetric and not re-filtered), extended matching (source ports, fragments, TTL), and time ranges.

### 3. NAT / PAT
- Data model: NAT pools and overload rules per router (inside/outside interface roles, static mappings).
- Engine: ping currently matches the destination device by literal IP; NAT needs a translation table consulted during forwarding plus reverse translation for replies — this changes `ownerOfIp` and the on-link delivery path in `ping.ts`/`dhcp.ts`.
- UI: NAT configuration panel; NetDoctor scenarios ("host behind NAT unreachable from outside", "pool exhausted").
- Tests: static NAT, dynamic pool allocation, PAT port reuse, reply translation.

### 4. DHCP relay — **IMPLEMENTED (Phase 2B)**
`dhcpRelay` targets on routed interfaces and VLAN sub-interfaces; `resolveDhcp` falls back to the relay path when no local server shares the client's segment: giaddr-based scope selection, simulated reachability from the relay agent to the server, deterministic allocation, gateway and optional DNS in the lease. Detection covers missing relay, wrong target, unreachable server, missing scope and exhausted pools with safe machine fixes. Remaining gaps: relay across multiple hops (relay-to-relay), DHCP broadcast handling on the server side, and lease renewal/expiry timelines.

### 5. OSPF dynamic routing
- Data model: per-router OSPF process (router id, areas, per-interface network statements).
- Engine: a new `protocols/ospf.ts` running deterministic SPF over the router graph, merging learned routes into `buildRoutingTable` with administrative distance 110; neighbors discovered over each interface's L2 segment. Convergence must complete before pings run (or be memoized per effective lab).
- UI: OSPF panel (enable per interface, area assignment, neighbor table); NetDoctor scenarios ("area mismatch - no adjacency", "missing network statement", "passive interface mistake").
- Tests: adjacency formation, route propagation across 3+ routers, cost-based path selection, reconvergence after a link failure.

### 6. IPv6 support
- Data model: interfaces gain a list of IPv6 addresses (e.g. `2001:db8::/64`) plus link-local addresses; devices gain SLAAC/DHCPv6 flags.
- Engine: a parallel address module (`ip6.ts`), ICMPv6 neighbor discovery replaces ARP (needs a multicast model on L2 segments), and the ping walk becomes address-family aware. The largest single item - it touches nearly every engine module - so it should follow the sub-interface work from item 1.
- UI: dual-stack address editors, ping tool with address-family selection.
- Tests: address parsing/compression, NDP resolution, dual-stack routing.

Suggested order for the remaining items: 3 -> 5 -> 6 (IPv6 last because it touches everything).

## Current limitations

- IPv4 only (no IPv6 or NAT). VLAN trunking, inter-VLAN routing, DHCP relay and ACLs ARE simulated; see the roadmap for what remains.
- ACL limitations: a didactic subset of real ACL semantics — no established-session/return-traffic filtering (the reply path of a successful ping is assumed symmetric and is not re-filtered by ACLs), no source-port or fragment matching, no named ACL objects shared across interfaces, and no logging. Not a Cisco IOS ACL emulation.
- DHCP limitations: leases are instantaneous and deterministic (no DISCOVER/OFFER/REQUEST/ACK timelines, no renewal or expiry), DNS information is recorded but not used by any simulated name resolution, relay reachability is evaluated with a static-address view of the network, and relay-to-relay chaining is not modeled.
- Trunk limitations: DHCP does not cross trunks (pools serve only their local resolved segment), switches have no SVIs and cannot originate pings, and there is no spanning tree — Layer-2 loops are not detected or broken.
- This is a didactic simulation, not a Cisco IOS emulation: no real packet encoding, no per-frame tag rewriting beyond VLAN membership, and CLI-style output is illustrative only.
- Static routing and router-on-a-stick inter-VLAN routing only — no OSPF/RIP/BGP; routes must be configured manually.
- One default gateway per host (not per interface); routers use connected + static routes only.
- The reply path of a successful ping is assumed to mirror the forward path.
- Ping RTTs are cosmetic (derived from hop count), not a queuing model.
- DHCP is deterministic and instantaneous; there is no lease renewal/expiry timeline.
- No import/export of lab files (labs live in localStorage only) and no undo/redo history.

## Backup, Git & GitHub

The project is a local Git repository. The working state is committed and tagged `working-v1`.

Push it to GitHub (one-time setup):

```powershell
# Option A — with the GitHub CLI (after `gh auth login`):
gh repo create netlab-pro --private --source . --push

# Option B — manually: create an empty repo on github.com, then:
git remote add origin https://github.com/<your-username>/netlab-pro.git
git push -u origin main --tags
```

Everyday workflow — **commit before every change session**, so you always have a point to return to:

```powershell
git add -A
git commit -m "describe what you changed"
git push            # after the remote is set up
```

Restore options (from newest to most drastic):

```powershell
git restore .                 # discard all UNCOMMITTED changes, keep history
git log --oneline             # list saved versions (commits)
git checkout <commit-hash> -- src   # restore only the src/ folder from an old commit
git reset --hard <commit-hash>      # move the WHOLE project back to an old commit
git reset --hard working-v1         # ...using the tagged known-good version
```

Warning: `git reset --hard` discards uncommitted changes permanently — commit (or stash) first. Note that Git backs up **code only**: labs you saved in the browser live in localStorage, so export important labs to `.netlab.json` files (NetLab → Export) as an extra backup.

## Tech stack

React 19 · TypeScript · Vite · @xyflow/react (topology canvas) · Tailwind CSS v4 · lucide-react (icons) · Vitest (tests) · localStorage (persistence)
