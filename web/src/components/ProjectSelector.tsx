import type { ProjectConfig } from "@tangerine/shared"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select"

interface ProjectSelectorProps {
  projects: ProjectConfig[]
  value: string
  onChange: (value: string) => void
  /** Show an "All Projects" option with empty-string value */
  allowAll?: boolean
  /** Hide archived projects (default: true) */
  hideArchived?: boolean
  /** Props forwarded to SelectTrigger */
  size?: "sm" | "default"
  className?: string
  /** Content placed before the value text inside the trigger */
  icon?: React.ReactNode
  "aria-label"?: string
  /** Alignment props for the dropdown */
  side?: "top" | "bottom"
  align?: "start" | "center" | "end"
}

export function ProjectSelector({
  projects,
  value,
  onChange,
  allowAll = false,
  hideArchived = true,
  size,
  className,
  icon,
  "aria-label": ariaLabel,
  side,
  align,
}: ProjectSelectorProps) {
  const filtered = hideArchived ? projects.filter((p) => !p.archived) : projects

  return (
    <Select value={value} onValueChange={(v) => { if (v != null) onChange(v) }}>
      <SelectTrigger size={size} className={className} aria-label={ariaLabel}>
        {icon}
        <SelectValue placeholder={allowAll ? "All Projects" : "Select project"} />
      </SelectTrigger>
      <SelectContent side={side} align={align} alignItemWithTrigger={false} className="min-w-[160px]">
        <SelectGroup>
          {allowAll && (
            <SelectItem value="">All Projects</SelectItem>
          )}
          {filtered.map((p) => (
            <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
