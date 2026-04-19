export type PaneId = "chat" | "diff" | "terminal" | "activity"

export interface ResponsivePaneState {
  visiblePanes: Set<PaneId>
  mobilePane: PaneId
  desktopSyncPane: PaneId | null
}

export function toggleDesktopVisiblePanes(
  visiblePanes: ReadonlySet<PaneId>,
  pane: PaneId,
  fallbackPane: PaneId | null = "chat",
): Set<PaneId> {
  const next = new Set(visiblePanes)
  if (next.has(pane)) next.delete(pane)
  else next.add(pane)
  if (next.size === 0 && fallbackPane) next.add(fallbackPane)
  return next
}

export function getResponsiveVisiblePanes(visiblePanes: ReadonlySet<PaneId>, syncPane: PaneId | null): Set<PaneId> {
  const next = new Set(visiblePanes)
  if (syncPane) next.add(syncPane)
  return next
}

export function selectMobilePane(state: ResponsivePaneState, pane: PaneId): ResponsivePaneState {
  return {
    ...state,
    mobilePane: pane,
    desktopSyncPane: pane,
  }
}

export function toggleMobilePaneActionState(state: ResponsivePaneState, pane: PaneId): ResponsivePaneState {
  return {
    visiblePanes: toggleDesktopVisiblePanes(state.visiblePanes, pane),
    mobilePane: pane,
    desktopSyncPane: pane,
  }
}

export function toggleDesktopPaneState(state: ResponsivePaneState, pane: PaneId): ResponsivePaneState {
  const base = pane === state.desktopSyncPane
    ? getResponsiveVisiblePanes(state.visiblePanes, state.desktopSyncPane)
    : state.visiblePanes

  const fallbackPane = pane !== state.desktopSyncPane && state.desktopSyncPane
    ? state.desktopSyncPane
    : "chat"

  return {
    visiblePanes: toggleDesktopVisiblePanes(base, pane, fallbackPane),
    mobilePane: state.mobilePane,
    desktopSyncPane: pane === state.desktopSyncPane ? null : state.desktopSyncPane,
  }
}

export function removePaneCapability(state: ResponsivePaneState, pane: PaneId, fallback: PaneId = "chat"): ResponsivePaneState {
  const nextVisiblePanes = new Set(state.visiblePanes)
  nextVisiblePanes.delete(pane)
  if (nextVisiblePanes.size === 0) nextVisiblePanes.add(fallback)

  return {
    visiblePanes: nextVisiblePanes,
    mobilePane: state.mobilePane === pane ? fallback : state.mobilePane,
    desktopSyncPane: state.desktopSyncPane === pane ? null : state.desktopSyncPane,
  }
}
