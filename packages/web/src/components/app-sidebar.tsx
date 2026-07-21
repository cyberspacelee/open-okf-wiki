import type { ComponentProps } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { FolderKanban, PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useI18n, type Locale } from "../i18n";

function navIsActive(pathname: string, to: string, end: boolean): boolean {
  if (end) return pathname === to;
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function AppSidebar(props: ComponentProps<typeof Sidebar>) {
  const { t, locale, setLocale } = useI18n();
  const location = useLocation();
  const { state, toggleSidebar, isMobile } = useSidebar();
  const collapsed = state === "collapsed" && !isMobile;

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

  function cycleLocale() {
    const next: Locale = locale === "en" ? "zh" : "en";
    setLocale(next);
  }

  return (
    <Sidebar
      collapsible="icon"
      aria-label={t.app.sidebarAria}
      data-testid="app-sidebar"
      data-collapsed={collapsed ? "true" : "false"}
      {...props}
    >
      <SidebarHeader>
        <div
          className={cn(
            "flex min-w-0 flex-col gap-0.5 px-2 py-1.5",
            collapsed && "items-center px-0 text-center",
          )}
        >
          <strong className="text-sm tracking-tight">{t.app.brand}</strong>
          {!collapsed ? (
            <span className="text-xs text-muted-foreground">{t.app.operator}</span>
          ) : null}
        </div>
      </SidebarHeader>

      <SidebarSeparator />

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {nav.map((item) => {
                const Icon = item.icon;
                const isActive = navIsActive(location.pathname, item.to, item.end);
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      isActive={isActive}
                      tooltip={item.label}
                      render={
                        <NavLink
                          to={item.to}
                          end={item.end}
                          data-testid={item.testId}
                        />
                      }
                    >
                      <Icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
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
          <p className="px-2 text-xs leading-relaxed text-muted-foreground">
            {t.app.sidebarFoot}
          </p>
        ) : null}

        <Button
          type="button"
          variant="ghost"
          size={collapsed ? "icon-sm" : "sm"}
          onClick={toggleSidebar}
          aria-label={collapsed ? t.app.expandSidebar : t.app.collapseSidebar}
          aria-expanded={!collapsed}
          title={
            collapsed
              ? `${t.app.expandSidebar} (Ctrl+B)`
              : `${t.app.collapseSidebar} (Ctrl+B)`
          }
          data-testid="sidebar-toggle"
          className={cn(
            "text-muted-foreground hover:text-sidebar-foreground",
            !collapsed && "w-full justify-start gap-2",
          )}
        >
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          {!collapsed ? <span>{t.app.collapse}</span> : null}
        </Button>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
