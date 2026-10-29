import { Monitor, Network, Router, Server } from 'lucide-react'
import type { DeviceKind } from '../engine/types'

const ICONS: Record<DeviceKind, typeof Router> = {
  router: Router,
  switch: Network,
  pc: Monitor,
  server: Server,
}

const COLORS: Record<DeviceKind, string> = {
  router: 'text-accent',
  switch: 'text-violet-400',
  pc: 'text-emerald-400',
  server: 'text-amber-400',
}

export function DeviceIcon({ kind, size = 18, className = '' }: { kind: DeviceKind; size?: number; className?: string }) {
  const Icon = ICONS[kind]
  return <Icon size={size} className={`${COLORS[kind]} ${className}`} aria-hidden />
}

export const KIND_LABEL: Record<DeviceKind, string> = {
  router: 'Router',
  switch: 'Switch',
  pc: 'PC',
  server: 'Server',
}
