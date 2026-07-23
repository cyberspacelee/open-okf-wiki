import { type ReactNode, useCallback, useState } from "react";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useI18n } from "../i18n";
import { AppSidebar } from "./app-sidebar";

/** localStorage: "1" = collapsed (closed), "0" / missing = expanded (open). */
const STORAGE_KEY = "okf-wiki.sidebar-collapsed";

function readOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "1";
  } catch {
    return true;
  }
}

function writeOpen(open: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, open ? "0" : "1");
  } catch {
    // ignore quota / private mode
  }
}

export function Layout({
  children,
  immersive = false,
}: {
  children: ReactNode;
  /** Agent workspace: no outer page padding; full-height flex chain. */
  immersive?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(readOpen);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    writeOpen(next);
  }, []);

  return (
    <SidebarProvider open={open} onOpenChange={handleOpenChange} className="h-svh overflow-hidden">
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 md:hidden">
          <SidebarTrigger />
          <span className="text-sm font-medium tracking-tight">{t.app.brand}</span>
        </header>
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
            immersive ? "gap-0 p-0" : "gap-5 overflow-y-auto p-4 md:p-6 lg:p-8",
          )}
        >
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
