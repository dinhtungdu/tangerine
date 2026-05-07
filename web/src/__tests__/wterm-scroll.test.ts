import { describe, expect, test } from "bun:test"
import { patchWTermScrollBehavior } from "../lib/wterm-scroll"

describe("WTerm scroll patch", () => {
  test("keeps input from scrolling before terminal output arrives", () => {
    const element = document.createElement("div")
    Object.defineProperties(element, {
      scrollHeight: { configurable: true, value: 900 },
      clientHeight: { configurable: true, value: 300 },
    })
    element.scrollTop = 120

    const forwarded: string[] = []
    const instance = {
      element,
      input: { onData: (_data: string) => {} },
      onData: (data: string) => forwarded.push(data),
      write: (data: string) => forwarded.push(`write:${data}`),
    }

    patchWTermScrollBehavior(instance)
    instance.input.onData("ls")

    expect(forwarded).toEqual(["ls"])
    expect(element.scrollTop).toBe(120)
  })

  test("scrolls to the exact bottom without row rounding", () => {
    const element = document.createElement("div")
    Object.defineProperties(element, {
      scrollHeight: { configurable: true, value: 917 },
      clientHeight: { configurable: true, value: 300 },
    })

    const instance = { element }

    patchWTermScrollBehavior(instance)
    instance._scrollToBottom()

    expect(element.scrollTop).toBe(617)
    expect(instance._isScrolledToBottom()).toBe(true)
  })
})
