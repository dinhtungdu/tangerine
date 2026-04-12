import { GitBranch } from "lucide-react"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"

interface BranchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  "aria-label"?: string
}

export function BranchInput({ value, onChange, placeholder = "Branch (optional)", className, "aria-label": ariaLabel }: BranchInputProps) {
  return (
    <InputGroup className={className}>
      <InputGroupAddon>
        <GitBranch className="size-3.5" />
      </InputGroupAddon>
      <InputGroupInput
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
    </InputGroup>
  )
}
