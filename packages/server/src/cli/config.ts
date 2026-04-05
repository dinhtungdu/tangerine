import {
  ALLOWED_CREDENTIAL_KEYS,
  readCredentialsFile,
  writeCredentialsFile,
  unsetCredential,
  type CredentialKey,
} from "../config"

function mask(value: string): string {
  if (value.length <= 4) return "****"
  return value.slice(0, 4) + "***"
}

function printConfigHelp(): void {
  console.log(`
Usage: tangerine config <subcommand>

Subcommands:
  set KEY=VALUE   Set a credential
  get KEY         Get a credential value
  unset KEY       Remove a credential
  list            List all credentials (masked)

Allowed keys:
  ${ALLOWED_CREDENTIAL_KEYS.join(", ")}

Examples:
  tangerine config set ANTHROPIC_API_KEY=sk-ant-...
  tangerine config get ANTHROPIC_API_KEY
  tangerine config unset ANTHROPIC_API_KEY
  tangerine config list
`)
}

export async function runConfig(argv: string[]): Promise<void> {
  const sub = argv[0]

  if (!sub || sub === "--help" || sub === "-h") {
    printConfigHelp()
    return
  }

  switch (sub) {
    case "set": {
      const pair = argv[1]
      if (!pair || !pair.includes("=")) {
        console.error("Usage: tangerine config set KEY=VALUE")
        process.exit(1)
      }
      const eqIndex = pair.indexOf("=")
      const key = pair.slice(0, eqIndex)
      const value = pair.slice(eqIndex + 1)

      if (!ALLOWED_CREDENTIAL_KEYS.includes(key as CredentialKey)) {
        console.error(`Unknown key: ${key}`)
        console.error(`Allowed: ${ALLOWED_CREDENTIAL_KEYS.join(", ")}`)
        process.exit(1)
      }
      if (!value) {
        console.error("Value cannot be empty. Use 'tangerine config unset' to remove.")
        process.exit(1)
      }

      writeCredentialsFile({ [key]: value })
      console.log(`Set ${key}=${mask(value)}`)
      break
    }

    case "get": {
      const key = argv[1]
      if (!key) {
        console.error("Usage: tangerine config get KEY")
        process.exit(1)
      }
      if (!ALLOWED_CREDENTIAL_KEYS.includes(key as CredentialKey)) {
        console.error(`Unknown key: ${key}`)
        process.exit(1)
      }
      const creds = readCredentialsFile()
      const val = creds[key as CredentialKey]
      if (val) {
        console.log(val)
      } else {
        console.log("(not set)")
      }
      break
    }

    case "unset": {
      const key = argv[1]
      if (!key) {
        console.error("Usage: tangerine config unset KEY")
        process.exit(1)
      }
      if (!ALLOWED_CREDENTIAL_KEYS.includes(key as CredentialKey)) {
        console.error(`Unknown key: ${key}`)
        process.exit(1)
      }
      const removed = unsetCredential(key as CredentialKey)
      if (removed) {
        console.log(`Unset ${key}`)
      } else {
        console.log(`${key} was not set`)
      }
      break
    }

    case "list": {
      const creds = readCredentialsFile()
      for (const key of ALLOWED_CREDENTIAL_KEYS) {
        const val = creds[key]
        console.log(`  ${key.padEnd(24)} ${val ? mask(val) : "(not set)"}`)
      }
      break
    }

    default:
      console.error(`Unknown subcommand: ${sub}`)
      printConfigHelp()
      process.exit(1)
  }
}
