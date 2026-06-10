import { useState } from "react";
import { getTheme, setTheme, type Theme } from "./theme";
import { IconMoon, IconSun } from "./icons";

/** Top-bar button that flips the console between day and night themes. */
export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(getTheme());

  function toggle() {
    const next: Theme = theme === "day" ? "night" : "day";
    setTheme(next);
    setThemeState(next);
  }

  return (
    <button
      className="btn sm icon-btn"
      onClick={toggle}
      title="Toggle day / night mode"
      aria-label="Toggle day / night mode"
    >
      {theme === "day" ? <IconMoon size={14} /> : <IconSun size={14} />}
      <span className="topbar-btn-label">{theme === "day" ? "Night" : "Day"}</span>
    </button>
  );
}
