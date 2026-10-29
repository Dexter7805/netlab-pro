import { useCallback, useEffect, useMemo } from 'react'
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  MarkerType,
} from '@xyflow/react'
import type { Connection, Edge, EdgeMouseHandler, NodeMouseHandler, NodeTypes, OnNodeDrag } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { DeviceNode } from './DeviceNode'
import type { DeviceNodeData } from './DeviceNode'
import type { Device, Lab } from '../engine/types'

const nodeTypes: NodeTypes = { device: DeviceNode }

export interface TopologyCanvasProps {
  lab: Lab
  readOnly?: boolean
  highlightedDeviceIds?: string[]
  onDeviceSelected?: (deviceId: string) => void
  onDeviceMoved?: (deviceId: string, x: number, y: number) => void
  onConnectInterfaces?: (aDeviceId: string, aIfaceId: string, bDeviceId: string, bIfaceId: string) => void
  onDeleteDevice?: (deviceId: string) => void
  onDeleteLink?: (linkId: string) => void
  warningCounts?: Record<string, number>
  activeFaultCounts?: Record<string, number>
}

function deviceToDeviceNode(device: Device, data: Omit<DeviceNodeData, 'device'>) {
  return {
    id: device.id,
    type: 'device',
    position: { x: device.x, y: device.y },
    data: { ...data, device } as DeviceNodeData,
  }
}

export function TopologyCanvas({
  lab,
  readOnly = false,
  highlightedDeviceIds = [],
  onDeviceSelected,
  onDeviceMoved,
  onConnectInterfaces,
  onDeleteDevice,
  onDeleteLink,
  warningCounts = {},
  activeFaultCounts = {},
}: TopologyCanvasProps) {
  const baseData = useMemo(
    () => ({ highlighted: false, readOnly, warningCount: 0, activeFaultCount: 0 }),
    [readOnly],
  )

  const initialNodes = useMemo(
    () =>
      lab.devices.map((device) =>
        deviceToDeviceNode(device, {
          ...baseData,
          warningCount: warningCounts[device.id] ?? 0,
          activeFaultCount: activeFaultCounts[device.id] ?? 0,
          highlighted: highlightedDeviceIds.includes(device.id),
        }),
      ),
    // Recompute when any visual input changes.
    [lab, baseData, warningCounts, activeFaultCounts, highlightedDeviceIds],
  )

  const initialEdges = useMemo(
    () =>
      lab.links.map((link) => {
        const down = !link.enabled
        return {
          id: link.id,
          source: link.aDeviceId,
          sourceHandle: link.aInterfaceId,
          target: link.bDeviceId,
          targetHandle: link.bInterfaceId,
          className: down ? 'path-down' : undefined,
          markerEnd: { type: MarkerType.ArrowClosed as const, width: 14, height: 14, color: down ? '#f87171' : '#3b5278' },
        } satisfies Edge
      }),
    [lab],
  )

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  useEffect(() => {
    setNodes(initialNodes)
  }, [initialNodes, setNodes])
  useEffect(() => {
    setEdges(initialEdges)
  }, [initialEdges, setEdges])

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!readOnly && connection.source && connection.target && connection.sourceHandle && connection.targetHandle) {
        onConnectInterfaces?.(connection.source, connection.sourceHandle, connection.target, connection.targetHandle)
      }
    },
    [onConnectInterfaces, readOnly],
  )

  const handleNodeDragStop: OnNodeDrag = useCallback(
    (_, node) => {
      if (!readOnly) onDeviceMoved?.(node.id, Math.round(node.position.x), Math.round(node.position.y))
    },
    [onDeviceMoved, readOnly],
  )

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_, node) => onDeviceSelected?.(node.id),
    [onDeviceSelected],
  )

  const handleEdgeDoubleClick: EdgeMouseHandler = useCallback(
    (_, edge) => {
      if (!readOnly) onDeleteLink?.(edge.id)
    },
    [onDeleteLink, readOnly],
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      connectionMode={ConnectionMode.Loose}
      onConnect={handleConnect}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      elementsSelectable
      edgesFocusable={!readOnly}
      onNodeDragStop={handleNodeDragStop}
      onNodeClick={handleNodeClick}
      onEdgeDoubleClick={handleEdgeDoubleClick}
      onNodesDelete={(deleted) => {
        if (!readOnly) deleted.forEach((n) => onDeleteDevice?.(n.id))
      }}
      onEdgesDelete={(deleted) => {
        if (!readOnly) deleted.forEach((e) => onDeleteLink?.(e.id))
      }}
      deleteKeyCode={readOnly ? null : 'Delete'}
      fitView
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="#1e2a44" />
      <Controls showInteractive={false} position="bottom-right" />
      {!readOnly && <MiniMap pannable zoomable nodeColor="#243b5c" maskColor="rgba(7, 11, 20, 0.75)" />}
    </ReactFlow>
  )
}
