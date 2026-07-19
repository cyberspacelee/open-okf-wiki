import { useCallback, useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { FolderKanban, PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "okf-wiki.sidebar-collapsed";

const nav = [
  { to: "/workspaces", label: "Workspaces", end: false, icon: FolderKanban, testId: "nav-workspaces" },
  { to: "/settings", label: "Settings", end: true, icon: Settings, testId: "nav-settings" },
] as const;

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function Layout({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(readCollapsed());
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // ignore quota / private mode
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        // Avoid stealing when typing in inputs.
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
          return;
        }
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    <div className={cn("app-shell", collapsed && "sidebar-collapsed")}>
      <aside
        className={cn("sidebar", collapsed && "is-collapsed")}
        aria-label="Primary"
        data-collapsed={collapsed ? "true" : "false"}
        data-testid="app-sidebar"
      >
        <div className={cn("brand", collapsed && "brand-collapsed")}>
          <strong className="text-sm tracking-tight">okf-wiki</strong>
          {!collapsed ? (
            <span className="text-xs text-muted-foreground">Operator</span>
          ) : null}
        </div>
        <Separator />
        <nav className="nav">
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn("nav-link", isActive && "active", collapsed && "nav-link-collapsed")
                }
                data-testid={item.testId}
                title={item.label}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {!collapsed ? <span>{item.label}</span> : (
                  <span className="sr-only">{item.label}</span>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className={cn("sidebar-bottom", collapsed && "sidebar-bottom-collapsed")}>
          {!collapsed ? (
            <p className="sidebar-foot">
              Local Web operator UI. Provider secrets stay on this machine, not in workspace.json.
            </p>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size={collapsed ? "icon-sm" : "sm"}
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)"}
            data-testid="sidebar-toggle"
            className={cn("sidebar-toggle", !collapsed && "w-full justify-start gap-2")}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            {!collapsed ? <span>Collapse</span> : null}
          </Button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
