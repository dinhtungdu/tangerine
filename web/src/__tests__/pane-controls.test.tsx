import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { PaneToggle } from "../components/PaneControls"

afterEach(() => {
  cleanup()
})

describe("PaneToggle", () => {
  test("routes desktop and mobile clicks to their own handlers", () => {
    const onDesktopClick = mock(() => {})
    const onMobileClick = mock(() => {})

    render(
      <PaneToggle
        desktopActive={false}
        mobileActive={false}
        onDesktopClick={onDesktopClick}
        onMobileClick={onMobileClick}
        label="Terminal"
      >
        <span>icon</span>
      </PaneToggle>,
    )

    const [desktopButton, mobileButton] = screen.getAllByRole("button", { name: "Terminal" })

    fireEvent.click(desktopButton)
    expect(onDesktopClick).toHaveBeenCalledTimes(1)
    expect(onMobileClick).toHaveBeenCalledTimes(0)

    fireEvent.click(mobileButton)
    expect(onDesktopClick).toHaveBeenCalledTimes(1)
    expect(onMobileClick).toHaveBeenCalledTimes(1)
  })
})
