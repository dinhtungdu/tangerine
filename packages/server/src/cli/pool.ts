import { Effect } from "effect"
import { getDb } from "../db/index.ts"
import { createProvider } from "../vm/providers/index.ts"
import { ProjectVmManager } from "../vm/project-vm.ts"
import { createLogger } from "../logger.ts"
import { printTable } from "./helpers.ts"

const log = createLogger("cli:pool")

export async function runPool(argv: string[]): Promise<void> {
  const subcommand = argv[0]

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(`
Usage: tangerine pool <subcommand>

Subcommands:
  status     Show project VMs
  reconcile  Reconcile VM state with provider
`)
    process.exit(0)
  }

  switch (subcommand) {
    case "status":
      await showStatus()
      break
    case "reconcile":
      await runReconcile()
      break
    default:
      console.error(`Unknown pool subcommand: ${subcommand}`)
      process.exit(1)
  }
}

function createVmManager(): ProjectVmManager {
  const db = getDb()
  const providerType = process.platform === "darwin" ? "lima" : "incus"
  const provider = createProvider(providerType as "lima" | "incus")
  return new ProjectVmManager(db, {
    provider,
    providerName: providerType,
    region: "local",
    plan: "4cpu-8gb-20gb",
  })
}

async function showStatus(): Promise<void> {
  const vmManager = createVmManager()
  const vms = await Effect.runPromise(vmManager.listVms())

  if (vms.length === 0) {
    console.log("\nNo active VMs")
    return
  }

  console.log(`\nProject VMs: ${vms.length}`)
  console.log()

  printTable(
    ["ID", "STATUS", "IP", "PROJECT", "PROVIDER", "CREATED"],
    vms.map((vm) => [
      vm.id.slice(0, 20),
      vm.status,
      vm.ip ?? "-",
      vm.project_id,
      vm.provider,
      vm.created_at,
    ])
  )
}

async function runReconcile(): Promise<void> {
  const vmManager = createVmManager()

  console.log("Reconciling VM state with provider...")
  const { alive, dead } = await Effect.runPromise(vmManager.reconcileOnStartup())

  console.log()
  console.log(`Alive: ${alive}`)
  console.log(`Dead:  ${dead}`)

  log.info("VM reconciled via CLI", { alive, dead })
}
