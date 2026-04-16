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
            <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
            <p className="text-sm text-muted-foreground">Dashboard preferences</p>
          </div>

          {/* Appearance section */}
          <section className="rounded-lg border border-border bg-card p-4 md:p-5">
            <h2 className="text-sub font-semibold text-foreground">Appearance</h2>
            <p className="mt-1 text-sm text-muted-foreground">Choose how the dashboard looks</p>

            <div className="mt-4 flex gap-3">
              {themeOptions.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => setTheme(value)}
                  className={`flex flex-1 flex-col items-center gap-2 rounded-lg border p-4 outline-none transition focus-visible:ring-1 focus-visible:ring-ring/50 ${
                    theme === value
                      ? "border-accent bg-accent/5 text-accent"
                      : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground"
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
