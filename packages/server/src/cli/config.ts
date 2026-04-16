function printConfigHelp(): void {
  console.log(`
Usage: tangerine config <subcommand>

Note: Secrets (API keys, auth tokens) are managed via 'tangerine secret'.
      Use 'tangerine secret --help' for details.

Subcommands:
  (none currently — config.json is managed automatically via 'tangerine project')

Examples:
  tangerine secret set TANGERINE_AUTH_TOKEN=$(openssl rand -hex 32)
  tangerine project add --name my-app --repo https://github.com/me/app
`)
}

export async function runConfig(argv: string[]): Promise<void> {
  const sub = argv[0]

  if (!sub || sub === "--help" || sub === "-h") {
    printConfigHelp()
    return
  }

  // Previously config set/get/unset/list managed .credentials — those are now
  // under 'tangerine secret'. Redirect users who try the old commands.
  if (sub === "set" || sub === "get" || sub === "unset" || sub === "list") {
    const replacement: Record<string, string> = {
      set: "tangerine secret set KEY=VALUE",
      get: "tangerine secret get KEY",
      unset: "tangerine secret delete KEY",
      list: "tangerine secret list",
    }
    console.error(`'tangerine config ${sub}' has moved. Use: ${replacement[sub]}`)
    process.exit(1)
  }

  console.error(`Unknown subcommand: ${sub}`)
  printConfigHelp()
  process.exit(1)
}
