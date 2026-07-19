import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Separator } from "@/components/ui/separator";

const nav = [
  { to: "/workspaces", label: "Workspaces", end: false },
  { to: "/settings", label: "Settings", end: true },
] as const;

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary">
        <div className="brand">
          <strong className="text-sm tracking-tight">okf-wiki</strong>
          <span className="text-xs text-muted-foreground">Operator</span>
        </div>
        <Separator />
        <nav className="nav">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
              data-testid={item.to === "/workspaces" ? "nav-workspaces" : "nav-settings"}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <p className="sidebar-foot">
          Local Web operator UI. Secrets stay in process/user environment variables.
        </p>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
