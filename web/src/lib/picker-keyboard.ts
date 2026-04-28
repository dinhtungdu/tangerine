export type PickerKeyAction =
  | { action: "none" }
  | { action: "close" }
  | { action: "select"; selectedIndex: number }

export function resolvePickerKey(key: string, selectedIndex: number, itemCount: number): PickerKeyAction {
  if (key === "Escape") return { action: "close" }
  if (itemCount <= 0) return { action: "none" }
  if (key === "ArrowDown") return { action: "select", selectedIndex: Math.min(selectedIndex + 1, itemCount - 1) }
  if (key === "ArrowUp") return { action: "select", selectedIndex: Math.max(selectedIndex - 1, 0) }
  return { action: "none" }
}
