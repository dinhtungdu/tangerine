import { useTheme } from "../hooks/useTheme"
import { SunIcon, MoonIcon, MonitorIcon } from "../components/ThemeIcons"

const themeOptions = [
  { value: "light" as const, label: "Light", icon: SunIcon },
  { value: "dark" as const, label: "Dark", icon: MoonIcon },
  { value: "system" as const, label: "System", icon: MonitorIcon },
]

export function SettingsPage() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="flex flex-col gap-6">
          {/* Title — desktop only */}
          <div className="hidden flex-col gap-1 md:flex">
            <h1 className="text-2xl font-semibold text-fg">Settings</h1>
            <p className="text-sm text-fg-muted">Dashboard preferences</p>
          </div>

          {/* Appearance section */}
          <section className="rounded-lg border border-edge bg-surface-card p-4 md:p-5">
            <h2 className="text-sub font-semibold text-fg">Appearance</h2>
            <p className="mt-1 text-sm text-fg-muted">Choose how the dashboard looks</p>

            <div className="mt-4 flex gap-3">
              {themeOptions.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => setTheme(value)}
                  className={`flex flex-1 flex-col items-center gap-2 rounded-lg border p-4 transition ${
                    theme === value
                      ? "border-accent bg-accent/5 text-accent"
                      : "border-edge text-fg-muted hover:border-fg-faint hover:text-fg"
                  }`}
                >
                  <Icon />
                  <span className="text-sm font-medium">{label}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
