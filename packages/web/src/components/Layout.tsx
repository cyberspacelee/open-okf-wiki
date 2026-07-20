import { useCallback, useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { FolderKanban, PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useI18n, type Locale } from "../i18n";

const STORAGE_KEY = "okf-wiki.sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function Layout({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  const [collapsed, setCollapsed] = useState(false);

  const nav = [
    {
      to: "/workspaces",
      label: t.nav.workspaces,
      end: false,
      icon: FolderKanban,
      testId: "nav-workspaces",
    },
    {
      to: "/settings",
      label: t.nav.settings,
      end: true,
      icon: Settings,
      testId: "nav-settings",
    },
  ] as const;

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

  function cycleLocale() {
    const next: Locale = locale === "en" ? "zh" : "en";
    setLocale(next);
  }

  return (
    <div className={cn("app-shell", collapsed && "sidebar-collapsed")}>
      <aside
        className={cn("sidebar", collapsed && "is-collapsed")}
        aria-label={t.app.sidebarAria}
        data-collapsed={collapsed ? "true" : "false"}
        data-testid="app-sidebar"
      >
        <div className={cn("brand", collapsed && "brand-collapsed")}>
          <strong className="text-sm tracking-tight">{t.app.brand}</strong>
          {!collapsed ? (
            <span className="text-xs text-muted-foreground">{t.app.operator}</span>
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
                {!collapsed ? (
                  <span>{item.label}</span>
                ) : (
                  <span className="sr-only">{item.label}</span>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className={cn("sidebar-bottom", collapsed && "sidebar-bottom-collapsed")}>
          <Button
            type="button"
            variant="outline"
            size={collapsed ? "icon-sm" : "sm"}
            onClick={cycleLocale}
            aria-label={t.locale.switchTo}
            title={`${t.locale.label}: ${locale === "en" ? t.locale.en : t.locale.zh}`}
            data-testid="locale-switch"
            className={cn(!collapsed && "w-full justify-start gap-2")}
          >
            <span className="text-xs font-medium tabular-nums">
              {locale === "en" ? "EN" : "中"}
            </span>
            {!collapsed ? (
              <span className="truncate">
                {locale === "en" ? t.locale.en : t.locale.zh}
              </span>
            ) : null}
          </Button>
          {!collapsed ? (
            <p className="sidebar-foot">{t.app.sidebarFoot}</p>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size={collapsed ? "icon-sm" : "sm"}
            onClick={toggle}
            aria-label={collapsed ? t.app.expandSidebar : t.app.collapseSidebar}
            aria-expanded={!collapsed}
            title={
              collapsed
                ? `${t.app.expandSidebar} (Ctrl+B)`
                : `${t.app.collapseSidebar} (Ctrl+B)`
            }
            data-testid="sidebar-toggle"
            className={cn("sidebar-toggle", !collapsed && "w-full justify-start gap-2")}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            {!collapsed ? <span>{t.app.collapse}</span> : null}
          </Button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
