import { useCallback, useState, type ReactNode } from "react";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
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

export function Layout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(readOpen);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    writeOpen(next);
  }, []);

  return (
    <SidebarProvider
      open={open}
      onOpenChange={handleOpenChange}
      className="h-svh overflow-hidden"
    >
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden">
        {/* Mobile: open the offcanvas Sheet (desktop uses icon collapse + footer toggle). */}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 md:hidden">
          <SidebarTrigger />
          <span className="text-sm font-medium tracking-tight">{t.app.brand}</span>
        </header>
        {/*
          Viewport-height flex chain: Provider h-svh → Inset min-h-0 flex-1 →
          this scrollport. Session compact mode uses flex-1 min-h-0 to fill;
          other pages grow and scroll here.
        */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto p-4 md:p-6 lg:p-8">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
