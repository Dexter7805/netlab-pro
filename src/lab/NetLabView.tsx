import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Cable,
  CheckCircle2,
  Copy,
  Download,
  FilePlus2,
  Info,
  Maximize2,
  Minimize2,
  Monitor,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Redo2,
  Router,
  Server,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  X,
} from 'lucide-react'
import type { DeviceKind, FaultKind, Lab } from '../engine/types'
import { summarizeValidation, validateLab } from '../engine/validate'
import type { ValidationIssue } from '../engine/validate'
import { LabHistory } from '../engine/history'
import { exportFileName, parseLabFile, serializeLabFile } from '../engine/labFile'
import {
  addDevice,
  addDhcpPool,
  addFault,
  addInterface,
  addStaticRoute,
  addSubInterface,
  connectDevices,
  deleteDevice,
  deleteDhcpPool,
  deleteInterface,
  deleteLink,
  deleteStaticRoute,
  deleteSubInterface,
  removeFault,
  setAcls,
  updateDevice,
  updateDhcpPool,
  updateFault,
  updateInterface,
  updateSubInterface,
} from '../engine/labOps'
import { useLabs } from '../state/useStores'
import { labStore } from '../storage/labStore'
import { TopologyCanvas } from './TopologyCanvas'
import { Inspector } from './Inspector'
import { PingConsole } from '../components/PingConsole'
import { FaultPanel } from '../components/FaultPanel'
import { SimNotice } from '../components/SimBadge'
import { LearnBox } from '../components/learn'

type Tab = 'device' | 'faults' | 'ping' | 'check'

const PALETTE: Array<{ kind: DeviceKind; label: string; icon: typeof Router }> = [
  { kind: 'router', label: 'Router', icon: Router },
  { kind: 'switch', label: 'Switch', icon: Network },
  { kind: 'pc', label: 'PC', icon: Monitor },
  { kind: 'server', label: 'Server', icon: Server },
]

export function NetLabView({ labId, onLabCreated }: { labId: string | null; onLabCreated: (id: string) => void }) {
  const { labs } = useLabs()
  const lab: Lab | null = labs.find((l) => l.id === labId) ?? labs[0] ?? null
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('device')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [highlighted, setHighlighted] = useState<string[]>([])
  const [connectError, setConnectError] = useState<string | null>(null)
  const [importNotice, setImportNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  // Workspace layout (UI only — lab data always lives in the store).
  const [labSidebarOpen, setLabSidebarOpen] = useState(true)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [focusMode, setFocusMode] = useState(false)
  const [focusInspector, setFocusInspector] = useState(false)
  const historyRef = useRef(new LabHistory())
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [, forceRender] = useState(0)

  const issues = useMemo(() => (lab ? validateLab(lab) : []), [lab])
  const summary = useMemo(() => summarizeValidation(issues), [issues])

  // History is per lab: switching labs drops the undo stack.
  const currentLabId = lab?.id ?? null
  useEffect(() => {
    historyRef.current.clear()
    forceRender((n) => n + 1)
  }, [currentLabId])

  const warningCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const issue of issues) {
      if (!issue.deviceId) continue
      counts[issue.deviceId] = (counts[issue.deviceId] ?? 0) + 1
    }
    return counts
  }, [issues])

  const activeFaultCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    if (!lab) return counts
    for (const fault of lab.faults) {
      if (!fault.active) continue
      counts[fault.deviceId] = (counts[fault.deviceId] ?? 0) + 1
    }
    return counts
  }, [lab])

  const selectedDevice = lab?.devices.find((d) => d.id === selectedDeviceId) ?? null

  // Focus mode hides both side panels; normal mode honors the two toggles.
  // Panels stay MOUNTED (hidden with CSS) so tool state and selection survive.
  const showLabSidebar = labSidebarOpen && !focusMode
  const showInspector = inspectorOpen && !focusMode
  const gridColsClass =
    showLabSidebar && showInspector
      ? 'xl:grid-cols-[240px_minmax(0,1fr)_340px]'
      : showLabSidebar
        ? 'xl:grid-cols-[240px_minmax(0,1fr)]'
        : showInspector
          ? 'xl:grid-cols-[minmax(0,1fr)_340px]'
          : 'xl:grid-cols-[minmax(0,1fr)]'

  const exitFocus = () => {
    setFocusMode(false)
    setFocusInspector(false)
  }

  // All labOps helpers are pure: they take a lab and return the updated lab.
  // The previous state is pushed onto the undo history before it is replaced,
  // and the result goes through the same labStore.save path as every other
  // edit — so undo/redo can never desync from the persisted state.
  const change = (mutator: (lab: Lab) => Lab, mergeKey?: string) => {
    if (!lab) return
    historyRef.current.record(lab, mergeKey)
    labStore.save(mutator(structuredClone(lab)))
    forceRender((n) => n + 1)
  }

  const applyHistory = (next: Lab | null) => {
    if (!next) return
    labStore.save(next)
    forceRender((n) => n + 1)
  }

  const undo = () => applyHistory(historyRef.current.undo(lab!))
  const redo = () => applyHistory(historyRef.current.redo(lab!))

  // Keyboard shortcuts: Ctrl+Z undo, Ctrl+Y or Ctrl+Shift+Z redo. Skipped
  // while typing in a form field so text editing keeps its native behavior.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !lab) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        if (historyRef.current.canUndo) undo()
      } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
        e.preventDefault()
        if (historyRef.current.canRedo) redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lab?.id, lab])

  // Escape exits focus mode.
  useEffect(() => {
    if (!focusMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFocusMode(false)
        setFocusInspector(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusMode])

  const exportLab = () => {
    if (!lab) return
    const blob = new Blob([serializeLabFile(lab)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = exportFileName(lab)
    a.click()
    URL.revokeObjectURL(url)
    setImportNotice({ kind: 'ok', text: `Exported "${lab.name}" as ${exportFileName(lab)}.` })
  }

  const handleImportFile = async (file: File) => {
    const text = await file.text()
    const result = parseLabFile(text)
    if (!result.ok) {
      setImportNotice({ kind: 'error', text: `Import failed: ${result.error}` })
      return
    }
    const nameConflict = labs.some((l) => l.name.toLowerCase() === result.lab.name.toLowerCase())
    const confirmed =
      !nameConflict ||
      window.confirm(
        `A lab named "${result.lab.name}" already exists. Import anyway as a separate copy? (Your existing lab will not be modified.)`,
      )
    if (!confirmed) {
      setImportNotice({ kind: 'error', text: 'Import cancelled.' })
      return
    }
    const stored = labStore.importLab(result.lab)
    onLabCreated(stored.id)
    const warningText = result.warnings.length > 0 ? ` Warnings: ${result.warnings.join(' ')}` : ''
    setImportNotice({ kind: 'ok', text: `Imported "${stored.name}" as a new lab.${warningText}` })
  }

  const handleConnect = (aDeviceId: string, aIfaceId: string, bDeviceId: string, bIfaceId: string) => {
    change((draft) => {
      const res = connectDevices(draft, aDeviceId, aIfaceId, bDeviceId, bIfaceId)
      if (res.error) setConnectError(res.error)
      return res.lab
    })
  }

  if (!lab) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-slate-400">No labs yet. Create your first lab to start building topologies.</p>
        <button type="button" className="btn-primary" onClick={() => onLabCreated(labStore.create('New Lab').id)}>
          <FilePlus2 size={15} aria-hidden /> Create a lab
        </button>
      </div>
    )
  }

  return (
    <div className={`grid h-full min-h-0 grid-cols-1 grid-rows-[auto_1fr] ${gridColsClass} xl:grid-rows-1`}>
      {/* Lab management column (collapsible; stays mounted so local state survives) */}
      <aside className={`flex min-h-0 flex-col border-b border-edge bg-panel-2 xl:border-b-0 xl:border-r ${showLabSidebar ? '' : 'hidden'}`}>
        <div className="flex items-center justify-between gap-2 px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <ToolbarIcon
              label="Hide lab sidebar"
              icon={PanelLeftClose}
              onClick={() => setLabSidebarOpen(false)}
            />
            <h2 className="text-sm font-semibold text-slate-200">Labs</h2>
          </div>
          <button
            type="button"
            className="btn-chip"
            onClick={() => onLabCreated(labStore.create('New Lab').id)}
            title="Create a new empty lab"
          >
            <FilePlus2 size={13} aria-hidden /> New
          </button>
        </div>
        {importNotice && (
          <div
            className={`mx-3 mb-2 rounded-lg border px-2.5 py-2 text-xs ${
              importNotice.kind === 'ok'
                ? 'border-emerald-800/60 bg-emerald-950/30 text-emerald-200'
                : 'border-red-900/60 bg-red-950/40 text-red-300'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <span>{importNotice.text}</span>
              <button type="button" className="shrink-0 opacity-70 hover:opacity-100" onClick={() => setImportNotice(null)}>
                ✕
              </button>
            </div>
          </div>
        )}
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {labs.map((l) => (
            <li key={l.id}>
              <div
                className={`group flex items-center gap-1 rounded-lg border px-2.5 py-2 text-sm ${
                  l.id === lab.id ? 'border-accent/60 bg-accent/10' : 'border-transparent hover:border-edge hover:bg-panel'
                }`}
              >
                {renaming === l.id ? (
                  <input
                    autoFocus
                    className="input py-1 text-xs"
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onBlur={() => {
                      if (renameText.trim()) labStore.rename(l.id, renameText.trim())
                      setRenaming(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        if (renameText.trim()) labStore.rename(l.id, renameText.trim())
                        setRenaming(null)
                      }
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left"
                      onClick={() => {
                        onLabCreated(l.id)
                        setSelectedDeviceId(null)
                        setHighlighted([])
                      }}
                    >
                      <span className="block truncate font-medium text-slate-200">{l.name}</span>
                      <span className="text-[10px] text-slate-500">
                        {l.devices.length} devices · {l.links.length} links
                        {l.faults.length > 0 ? ` · ${l.faults.filter((f) => f.active).length} faults` : ''}
                        {l.origin === 'sample' ? ' · sample' : ''}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="rounded p-1 text-slate-600 opacity-0 transition group-hover:opacity-100 hover:text-accent"
                      title="Rename lab"
                      onClick={() => {
                        setRenaming(l.id)
                        setRenameText(l.name)
                      }}
                    >
                      <Pencil size={12} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="rounded p-1 text-slate-600 opacity-0 transition group-hover:opacity-100 hover:text-accent"
                      title="Duplicate lab"
                      onClick={() => labStore.duplicate(l.id)}
                    >
                      <Copy size={12} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="rounded p-1 text-slate-600 opacity-0 transition group-hover:opacity-100 hover:text-red-400"
                      title="Delete lab"
                      onClick={() => {
                        if (window.confirm(`Delete lab "${l.name}"? This cannot be undone.`)) labStore.delete(l.id)
                      }}
                    >
                      <Trash2 size={12} aria-hidden />
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
        <div className="space-y-2 border-t border-edge p-3">
          <SimNotice>Saving, loading and editing happen in your browser via localStorage.</SimNotice>
          <button
            type="button"
            className="btn-ghost w-full text-xs"
            onClick={() => {
              if (window.confirm('Restore the built-in sample labs? Your own labs are kept — only the samples are reset to their pristine templates.')) labStore.resetToSamples()
            }}
          >
            Restore sample labs
          </button>
        </div>
      </aside>

      {/* Canvas column */}
      <main className="relative flex min-h-0 min-w-0 flex-col">
        <div
          className="flex flex-wrap items-center gap-1.5 border-b border-edge bg-panel-2 px-2 py-1.5"
          role="toolbar"
          aria-label="Topology workspace"
        >
          {/* Workspace / view controls */}
          <div className="flex items-center gap-1" role="group" aria-label="Workspace view">
            {focusMode ? (
              <button
                type="button"
                className="btn-chip border-accent/60 bg-accent/10 text-accent"
                onClick={exitFocus}
                title="Exit focus mode (Esc)"
                aria-label="Exit focus mode"
              >
                <Minimize2 size={14} aria-hidden /> <span className="hidden md:inline">Exit focus</span>
              </button>
            ) : (
              <>
                <ToolbarIcon
                  label={labSidebarOpen ? 'Hide lab sidebar' : 'Show lab sidebar'}
                  icon={labSidebarOpen ? PanelLeftClose : PanelLeftOpen}
                  onClick={() => setLabSidebarOpen((v) => !v)}
                />
                <ToolbarIcon
                  label={inspectorOpen ? 'Hide tools panel' : 'Show tools panel'}
                  icon={inspectorOpen ? PanelRightClose : PanelRightOpen}
                  onClick={() => setInspectorOpen((v) => !v)}
                />
                <ToolbarIcon
                  label="Focus mode: maximize the topology canvas"
                  icon={Maximize2}
                  onClick={() => setFocusMode(true)}
                />
              </>
            )}
          </div>
          <ToolbarDivider />
          {/* Lab / file actions */}
          <div className="flex items-center gap-1" role="group" aria-label="Lab file actions">
            <button
              type="button"
              className="btn-chip"
              onClick={() => onLabCreated(labStore.create('New Lab').id)}
              title="Create a new empty lab"
              aria-label="Create a new empty lab"
            >
              <FilePlus2 size={14} aria-hidden /> <span className="hidden lg:inline">New</span>
            </button>
            <button
              type="button"
              className="btn-chip"
              onClick={() => fileInputRef.current?.click()}
              title="Import a lab from a JSON file"
              aria-label="Import a lab from a JSON file"
            >
              <Upload size={14} aria-hidden /> <span className="hidden lg:inline">Import</span>
            </button>
            <button
              type="button"
              className="btn-chip"
              onClick={exportLab}
              title="Export the open lab as a JSON file"
              aria-label="Export the open lab as a JSON file"
            >
              <Download size={14} aria-hidden /> <span className="hidden lg:inline">Export</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void handleImportFile(file)
              }}
            />
          </div>
          <ToolbarDivider />
          {/* Device creation */}
          <div className="flex items-center gap-1" role="group" aria-label="Add device">
            {PALETTE.map(({ kind, label, icon: Icon }) => (
              <button
                key={kind}
                type="button"
                className="btn-chip"
                onClick={() =>
                  change((draft) => {
                    const x = 120 + Math.round(Math.random() * 320)
                    const y = 100 + Math.round(Math.random() * 220)
                    return addDevice(draft, kind, x, y)
                  })
                }
                title={`Add a ${label.toLowerCase()}`}
                aria-label={`Add a ${label.toLowerCase()}`}
              >
                <Icon size={14} aria-hidden /> <span className="hidden lg:inline">{label}</span>
              </button>
            ))}
          </div>
          <ToolbarDivider />
          {/* History */}
          <div className="flex items-center gap-1" role="group" aria-label="Undo and redo">
            <button
              type="button"
              className="btn-chip"
              onClick={undo}
              disabled={!historyRef.current.canUndo}
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
            >
              <Undo2 size={14} aria-hidden /> <span className="hidden md:inline">Undo</span>
            </button>
            <button
              type="button"
              className="btn-chip"
              onClick={redo}
              disabled={!historyRef.current.canRedo}
              title="Redo (Ctrl+Y)"
              aria-label="Redo"
            >
              <Redo2 size={14} aria-hidden /> <span className="hidden md:inline">Redo</span>
            </button>
          </div>
          {!focusMode && (
            <span className="ml-auto hidden max-w-xs truncate text-[11px] text-slate-600 2xl:block">
              Drag interface dots together to cable devices · double-click a cable to remove it
            </span>
          )}
        </div>
        {connectError && (
          <div className="flex items-center justify-between border-b border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs text-red-300">
            {connectError}
            <button type="button" className="text-red-400 hover:text-red-200" onClick={() => setConnectError(null)}>
              dismiss
            </button>
          </div>
        )}
        <div className="min-h-[380px] flex-1">
          <TopologyCanvas
            lab={lab}
            highlightedDeviceIds={highlighted}
            onDeviceSelected={(id) => {
              setSelectedDeviceId(id)
              setTab('device')
              if (focusMode) setFocusInspector(true)
            }}
            onDeviceMoved={(id, x, y) => change((draft) => updateDevice(draft, id, { x, y }), `move:${id}`)}
            onConnectInterfaces={handleConnect}
            onDeleteDevice={(id) => {
              change((draft) => deleteDevice(draft, id))
              if (selectedDeviceId === id) setSelectedDeviceId(null)
            }}
            onDeleteLink={(id) => change((draft) => deleteLink(draft, id))}
            warningCounts={warningCounts}
            activeFaultCounts={activeFaultCounts}
          />
        </div>
      </main>

      {/* Inspector column (collapsible; stays mounted so tool state survives) */}
      <aside
        className={`flex min-h-0 flex-col border-t border-edge bg-panel xl:border-l xl:border-t-0 ${
          showInspector ? '' : 'hidden'
        }`}
      >
        <div className="flex border-b border-edge bg-panel-2">
          {(
            [
              ['device', 'Device'],
              ['check', `Check${summary.errors > 0 ? ` (${summary.errors})` : ''}`],
              ['faults', `Faults${lab.faults.length ? ` (${lab.faults.length})` : ''}`],
              ['ping', 'Ping'],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button key={key} type="button" className={`tab ${tab === key ? 'tab-active' : ''}`} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Panels stay mounted so tool state (ping results, fault form) survives tab switches. */}
          <div className={tab === 'device' ? '' : 'hidden'}>
            <Inspector
              lab={lab}
              device={selectedDevice}
              issues={issues}
              onChangeDevice={(patch) => change((draft) => updateDevice(draft, selectedDevice!.id, patch))}
              onChangeInterface={(interfaceId, patch) =>
                change((draft) => updateInterface(draft, selectedDevice!.id, interfaceId, patch as never))
              }
              onAddInterface={() => change((draft) => addInterface(draft, selectedDevice!.id))}
              onDeleteInterface={(interfaceId) => change((draft) => deleteInterface(draft, selectedDevice!.id, interfaceId))}
              onAddStaticRoute={(destinationCidr, nextHopIp) =>
                change((draft) => addStaticRoute(draft, selectedDevice!.id, { destinationCidr, nextHopIp }))
              }
              onDeleteStaticRoute={(routeId) => change((draft) => deleteStaticRoute(draft, selectedDevice!.id, routeId))}
              onAddDhcpPool={() =>
                change((draft) => {
                  const device = draft.devices.find((d) => d.id === selectedDevice!.id)
                  if (!device) return draft
                  const i = device.dhcpPools.length
                  return addDhcpPool(draft, selectedDevice!.id, {
                    name: `POOL${i + 1}`,
                    networkCidr: `192.168.${40 + i}.0/24`,
                    rangeStart: `192.168.${40 + i}.100`,
                    rangeEnd: `192.168.${40 + i}.110`,
                    gatewayIp: `192.168.${40 + i}.1`,
                    dnsIp: '',
                  })
                })
              }
              onChangeDhcpPool={(poolId, patch) => change((draft) => updateDhcpPool(draft, selectedDevice!.id, poolId, patch as never))}
              onDeleteDhcpPool={(poolId) => change((draft) => deleteDhcpPool(draft, selectedDevice!.id, poolId))}
              onAddSubInterface={(interfaceId, vlanId) => change((draft) => addSubInterface(draft, selectedDevice!.id, interfaceId, vlanId))}
              onChangeSubInterface={(interfaceId, subInterfaceId, patch) =>
                change((draft) => updateSubInterface(draft, selectedDevice!.id, interfaceId, subInterfaceId, patch as never))
              }
              onDeleteSubInterface={(interfaceId, subInterfaceId) =>
                change((draft) => deleteSubInterface(draft, selectedDevice!.id, interfaceId, subInterfaceId))
              }
              onChangeAcls={(interfaceId, subInterfaceId, acls) =>
                change((draft) => setAcls(draft, selectedDevice!.id, interfaceId, subInterfaceId, acls))
              }
              onDeleteDevice={() => {
                if (selectedDevice && window.confirm(`Delete device "${selectedDevice.name}" and its links?`)) {
                  change((draft) => deleteDevice(draft, selectedDevice.id))
                  setSelectedDeviceId(null)
                }
              }}
              onClose={() => setSelectedDeviceId(null)}
            />
          </div>
          <div className={tab === 'check' ? 'space-y-3 p-4' : 'hidden'}>
            <LearnBox topic="validation" />
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={`badge border ${summary.errors > 0 ? 'border-red-800 bg-red-950/40 text-red-300' : 'border-emerald-800 bg-emerald-950/40 text-emerald-300'}`}>
                <ShieldAlert size={11} aria-hidden /> {summary.errors} confirmed fault{summary.errors === 1 ? '' : 's'}
              </span>
              <span className="badge border border-amber-800 bg-amber-950/40 text-amber-300">
                <TriangleAlert size={11} aria-hidden /> {summary.warnings} warning{summary.warnings === 1 ? '' : 's'}
              </span>
              <span className="badge border border-edge bg-panel text-slate-400">
                <Info size={11} aria-hidden /> {summary.infos} hint{summary.infos === 1 ? '' : 's'}
              </span>
            </div>
            {issues.length === 0 && (
              <p className="flex items-center gap-2 text-sm text-emerald-300">
                <CheckCircle2 size={15} aria-hidden /> No configuration problems found.
              </p>
            )}
            <ul className="space-y-1.5">
              {issues.map((issue, index) => (
                <ValidationRow key={index} issue={issue} onSelect={() => {
                  if (issue.deviceId) {
                    setSelectedDeviceId(issue.deviceId)
                    setTab('device')
                  }
                }} />
              ))}
            </ul>
          </div>
          <div className={tab === 'faults' ? 'space-y-4 p-4' : 'hidden'}>
            <SimNotice label="Fault lab">Faults are overlays on the base configuration. Ping results and NetDoctor detection reflect them immediately.</SimNotice>
            <LearnBox topic="faults" />
            <FaultPanel
              lab={lab}
              onAdd={(draft) => change((d) => addFault(d, draft as { kind: FaultKind; deviceId: string }))}
              onToggle={(faultId, active) => change((d) => updateFault(d, faultId, { active }))}
              onRemove={(faultId) => change((d) => removeFault(d, faultId))}
            />
          </div>
          <div className={tab === 'ping' ? 'p-4' : 'hidden'}>
            <PingConsole lab={lab} onHighlight={setHighlighted} initialSourceId={selectedDeviceId ?? undefined} />
          </div>
        </div>
      </aside>

      {/* Focus mode: tools panel as an overlay above the canvas */}
      {focusMode && focusInspector && (
        <div className="absolute inset-y-0 right-0 z-20 flex w-[340px] max-w-[90%] flex-col border-l border-edge bg-panel shadow-2xl">
          <div className="flex items-center justify-between border-b border-edge px-3 py-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Simulation tools</span>
            <button
              type="button"
              className="btn-chip px-2"
              onClick={() => setFocusInspector(false)}
              aria-label="Close tools panel"
              title="Close tools panel"
            >
              <X size={13} aria-hidden />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex border-b border-edge bg-panel-2">
              {(
                [
                  ['device', 'Device'],
                  ['check', `Check${summary.errors > 0 ? ` (${summary.errors})` : ''}`],
                  ['faults', `Faults${lab.faults.length ? ` (${lab.faults.length})` : ''}`],
                  ['ping', 'Ping'],
                ] as Array<[Tab, string]>
              ).map(([key, label]) => (
                <button key={key} type="button" className={`tab ${tab === key ? 'tab-active' : ''}`} onClick={() => setTab(key)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <PingConsole lab={lab} onHighlight={setHighlighted} initialSourceId={selectedDeviceId ?? undefined} />
              {selectedDevice && (
                <p className="px-4 pb-3 pt-2 text-[11px] text-slate-500">
                  Selected: <span className="font-semibold text-slate-300">{selectedDevice.name}</span> — full editing tools are
                  available after exiting focus mode.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Compact icon-only toolbar button with accessible label and tooltip. */
function ToolbarIcon({ label, icon: Icon, onClick }: { label: string; icon: typeof Cable; onClick: () => void }) {
  return (
    <button type="button" className="btn-chip px-2" onClick={onClick} title={label} aria-label={label}>
      <Icon size={14} aria-hidden />
    </button>
  )
}

function ToolbarDivider() {
  return <span className="mx-0.5 h-5 w-px shrink-0 self-center bg-edge" aria-hidden />
}

function ValidationRow({ issue, onSelect }: { issue: ValidationIssue; onSelect: () => void }) {
  const style =
    issue.severity === 'error'
      ? 'border-red-900/60 bg-red-950/25'
      : issue.severity === 'warning'
        ? 'border-amber-900/60 bg-amber-950/20'
        : 'border-edge bg-panel-2'
  const Icon = issue.severity === 'error' ? ShieldAlert : issue.severity === 'warning' ? TriangleAlert : Info
  const iconColor =
    issue.severity === 'error' ? 'text-red-400' : issue.severity === 'warning' ? 'text-amber-400' : 'text-slate-500'
  return (
    <li>
      <button
        type="button"
        className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition hover:border-accent/50 ${style}`}
        onClick={onSelect}
        title={issue.deviceId ? 'Show this device in the inspector' : undefined}
      >
        <Icon size={13} className={`mt-0.5 shrink-0 ${iconColor}`} aria-hidden />
        <span className="text-slate-300">{issue.message}</span>
      </button>
    </li>
  )
}
