interface FlagSpec {
  alias?: string
  required?: boolean
}

interface ParsedArgs {
  command: string | undefined
  subcommand: string | undefined
  flags: Record<string, string>
  rest: string[]
}

/**
 * Simple arg parser for CLI flags.
 * Supports --flag value and -f value forms.
 */
export function parseArgs(
  args: string[],
  flags: Record<string, FlagSpec>
): ParsedArgs {
  const result: ParsedArgs = {
    command: undefined,
    subcommand: undefined,
    flags: {},
    rest: [],
  }

  // Build alias-to-name lookup
  const aliasMap = new Map<string, string>()
  for (const [name, spec] of Object.entries(flags)) {
    if (spec.alias) {
      aliasMap.set(spec.alias, name)
    }
  }

  let positionalIndex = 0
  let i = 0

  while (i < args.length) {
    const arg = args[i]!

    if (arg === "--help" || arg === "-h") {
      result.flags["help"] = "true"
      i++
      continue
    }

    if (arg.startsWith("--")) {
      const name = arg.slice(2)
      const value = args[i + 1]
      if (value !== undefined && !value.startsWith("-")) {
        result.flags[name] = value
        i += 2
      } else {
        result.flags[name] = "true"
        i++
      }
      continue
    }

    if (arg.startsWith("-") && arg.length === 2) {
      const alias = arg.slice(1)
      const name = aliasMap.get(alias) ?? alias
      const value = args[i + 1]
      if (value !== undefined && !value.startsWith("-")) {
        result.flags[name] = value
        i += 2
      } else {
        result.flags[name] = "true"
        i++
      }
      continue
    }

    // Positional arguments: first is command, second is subcommand
    if (positionalIndex === 0) {
      result.command = arg
    } else if (positionalIndex === 1) {
      result.subcommand = arg
    } else {
      result.rest.push(arg)
    }
    positionalIndex++
    i++
  }

  // Validate required flags
  for (const [name, spec] of Object.entries(flags)) {
    if (spec.required && !result.flags[name]) {
      throw new Error(`Missing required flag: --${name}`)
    }
  }

  return result
}

/**
 * Prints an aligned table to stdout.
 * Pads each column to the widest value.
 */
export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => {
    const colValues = rows.map((r) => (r[i] ?? "").length)
    return Math.max(h.length, ...colValues)
  })

  const header = headers.map((h, i) => h.padEnd(widths[i]!)).join("  ")
  const separator = widths.map((w) => "-".repeat(w)).join("  ")

  console.log(header)
  console.log(separator)

  for (const row of rows) {
    const line = row.map((cell, i) => (cell ?? "").padEnd(widths[i]!)).join("  ")
    console.log(line)
  }
}

/**
 * Prints a startup banner showing server info.
 */
export function printBanner(port: number, projectName: string): void {
  console.log()
  console.log("  Tangerine")
  console.log(`  Project:  ${projectName}`)
  console.log(`  API:      http://localhost:${port}`)
  console.log()
}

/**
 * Prints usage help for the CLI.
 */
export function printHelp(): void {
  console.log(`
Usage: tangerine <command> [options]

Commands:
  install            One-time setup (deps check, skill install)
  start              Start the Tangerine server
  project add        Register a project
  project list       List registered projects
  project show       Show project config details
  project remove     Remove a project
  task create        Create a task manually
  config set         Set a credential (KEY=VALUE)
  config get         Get a credential value
  config unset       Remove a credential
  config list        List all credentials (masked)

Options:
  --help, -h         Show help text

Examples:
  tangerine project add --name my-app --repo https://github.com/me/app --setup "npm install"
  tangerine project list
  tangerine start
  tangerine task create --title "Fix bug"
`)
}
