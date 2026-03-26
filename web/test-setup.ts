import { Window } from "happy-dom"

const win = new Window({ url: "http://localhost" })

const globals = ["document", "window", "navigator", "HTMLElement", "Element", "Node", "Text",
  "DocumentFragment", "Event", "CustomEvent", "MutationObserver", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout",
  "SyntaxError", "TypeError", "RangeError", "localStorage", "sessionStorage"] as const

for (const key of globals) {
  if (key in win) {
    Object.defineProperty(globalThis, key, {
      value: (win as unknown as Record<string, unknown>)[key],
      writable: true,
      configurable: true,
    })
  }
}
