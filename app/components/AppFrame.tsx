import type { ReactNode } from "react";

// Thin bar above the app with its name. fill: the app gets exactly the space under the bar.
export default function AppFrame({ name, children, fill, className }: { name: string; children: ReactNode; fill?: boolean; className?: string }) {
  return (
    <div className={className} style={{ [fill ? "height" : "minHeight"]: "100dvh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <div className="app-frame-bar" style={{ height: 48, flex: "none", display: "flex", alignItems: "center", gap: 16, padding: "0 16px", borderBottom: "1px solid var(--line)", background: "rgba(255,253,249,0.9)", fontSize: 14 }}>
        <span style={{ fontFamily: "Georgia, serif", fontSize: 18 }}>{name}</span>
      </div>
      <div style={fill ? { height: "calc(100dvh - 48px)", overflow: "auto", position: "relative" } : { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>{children}</div>
    </div>
  );
}
