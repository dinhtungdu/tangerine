import { describe, test, expect } from "bun:test"
import { readdir } from "fs/promises"
import { join } from "path"

const WEB_SRC = join(import.meta.dir, "..")

async function getAllFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries
    .filter((e) => e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx")))
    .map((e) => join(e.parentPath ?? dir, e.name))
}

describe("architecture", () => {
  test("no dedicated mobile files or directories", async () => {
    const files = await getAllFiles(WEB_SRC)
    const mobileFiles = files.filter((f) => {
      const name = f.split("/").pop()!
      return name.startsWith("Mobile") || f.includes("/mobile/")
    })
    expect(mobileFiles).toEqual([])
  })

  test("no components defined inside page files", async () => {
    const pagesDir = join(WEB_SRC, "pages")
    const files = await getAllFiles(pagesDir)
    const violations: string[] = []

    for (const file of files) {
      const content = await Bun.file(file).text()
      const relativePath = file.replace(WEB_SRC + "/", "")

      // Find all function component definitions (function Foo( or const Foo =)
      // that are NOT the main export
      const funcComponents = content.matchAll(/^(?:export\s+)?function\s+([A-Z]\w+)\s*\(/gm)
      const arrowComponents = content.matchAll(/^(?:export\s+)?const\s+([A-Z]\w+)\s*=\s*(?:\([^)]*\)|[^=])*=>\s*[{(]/gm)

      const allComponents: string[] = []
      for (const match of funcComponents) allComponents.push(match[1])
      for (const match of arrowComponents) allComponents.push(match[1])

      // The file's main export is fine — any OTHER component is a violation
      const mainExports = content.matchAll(/^export\s+(?:default\s+)?function\s+([A-Z]\w+)/gm)
      const exportedNames = new Set<string>()
      for (const match of mainExports) exportedNames.add(match[1])

      const inlineComponents = allComponents.filter((name) => !exportedNames.has(name))
      if (inlineComponents.length > 0) {
        violations.push(`${relativePath}: inline components [${inlineComponents.join(", ")}] — move to separate file or module level in a component file`)
      }
    }

    expect(violations).toEqual([])
  })

  test("no JS-based viewport detection", async () => {
    const files = await getAllFiles(WEB_SRC)
    const violations: string[] = []

    for (const file of files) {
      // Skip test files and theme hook (uses matchMedia for prefers-color-scheme, not viewport)
      if (file.includes("__tests__")) continue
      if (file.endsWith("useTheme.ts")) continue

      const content = await Bun.file(file).text()
      const relativePath = file.replace(WEB_SRC + "/", "")

      const patterns = [
        { regex: /useMobile/g, label: "useMobile hook" },
        { regex: /useBreakpoint/g, label: "useBreakpoint hook" },
        { regex: /window\.innerWidth/g, label: "window.innerWidth" },
        { regex: /matchMedia/g, label: "matchMedia" },
      ]

      for (const { regex, label } of patterns) {
        if (regex.test(content)) {
          violations.push(`${relativePath}: uses ${label} — use Tailwind responsive classes instead`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  test("cron feature is absent from web code", async () => {
    const files = await getAllFiles(WEB_SRC)
    const violations: string[] = []

    for (const file of files) {
      if (file.includes("__tests__")) continue
      const content = await Bun.file(file).text()
      const relativePath = file.replace(WEB_SRC + "/", "")
      const patterns = [
        { regex: /CronsPage|CronList|CronRow|CronForm/g, label: "cron UI" },
        { regex: /\/api\/crons/g, label: "cron API client" },
        { regex: /navigate\.crons/g, label: "cron action" },
        { regex: /formatCronExpression/g, label: "cron formatter" },
      ]

      for (const { regex, label } of patterns) {
        if (regex.test(content)) violations.push(`${relativePath}: uses ${label}`)
      }
    }

    expect(violations).toEqual([])
  })
})
