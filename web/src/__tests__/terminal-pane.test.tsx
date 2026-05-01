import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import React from "react"
import { TerminalPane } from "../components/TerminalPane"
import { TuiPane } from "../components/TuiPane"

mock.module("@wterm/react", () => ({
  Terminal: React.forwardRef((props: Record<string, unknown>, _ref: unknown) =>
    React.createElement("div", { "data-testid": "wterm-terminal", className: props.className as string | undefined })
  ),
  useTerminal: () => ({
    ref: { current: null },
    write: () => {},
    resize: () => {},
    focus: () => {},
  }),
}))

afterEach(() => {
  cleanup()
})

function closestWithClass(element: HTMLElement, className: string): HTMLElement | null {
  let current = element.parentElement
  while (current) {
    if (current.className.split(/\s+/).includes(className)) return current
    current = current.parentElement
  }
  return null
}

describe("terminal panes", () => {
  test("renders the shell terminal inside a padded rounded surface", () => {
    render(<TerminalPane taskId="task-1" />)

    const terminal = screen.getByTestId("wterm-terminal")
    expect(closestWithClass(terminal, "p-3")).not.toBeNull()
    expect(closestWithClass(terminal, "min-w-0")).not.toBeNull()
    expect(closestWithClass(terminal, "rounded-lg")).not.toBeNull()
  })

  test("renders the agent TUI inside a padded rounded surface", () => {
    render(<TuiPane taskId="task-1" />)

    const terminal = screen.getByTestId("wterm-terminal")
    expect(closestWithClass(terminal, "p-3")).not.toBeNull()
    expect(closestWithClass(terminal, "min-w-0")).not.toBeNull()
    expect(closestWithClass(terminal, "rounded-lg")).not.toBeNull()
  })
})
