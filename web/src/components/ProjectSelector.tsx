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
  size?: "sm" | "default"
  className?: string
  "aria-label"?: string
}

export function ProjectSelector({
  projects,
  value,
  onChange,
  allowAll = false,
  hideArchived = true,
  size,
  className,
  "aria-label": ariaLabel,
}: ProjectSelectorProps) {
  const filtered = hideArchived ? projects.filter((p) => !p.archived) : projects

  return (
    <Select value={value} onValueChange={(v) => { if (v != null) onChange(v) }}>
      <SelectTrigger size={size} className={className} aria-label={ariaLabel}>
        <SelectValue placeholder={allowAll ? "All Projects" : "Select project"} />
      </SelectTrigger>
      <SelectContent>
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
