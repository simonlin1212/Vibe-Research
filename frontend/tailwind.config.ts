import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
        success: "hsl(var(--success))",
        danger: "hsl(var(--danger))",
        warning: "hsl(var(--warning))",
        info: "hsl(var(--info))",
      },
      fontFamily: {
        sans: ["Microsoft YaHei", "PingFang SC", "Geist", "system-ui", "sans-serif"],
        mono: ["Consolas", "Microsoft YaHei", "ui-monospace", "monospace"],
      },
      borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 4px)", sm: "calc(var(--radius) - 8px)" },
      boxShadow: {
        // Tinted to navy base; avoid pure-black blobs and neon outer glow.
        glass: "0 12px 28px hsl(222 47% 4% / .42), inset 0 1px 0 hsl(0 0% 100% / .06)",
        // Was a soft orange bloom; keep only a hairline ring for selected/active chrome.
        glow: "0 0 0 1px hsl(var(--primary) / .28)",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
} satisfies Config;
