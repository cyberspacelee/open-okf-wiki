import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import App from "./App.tsx";
import { I18nProvider } from "./i18n";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <I18nProvider>
        <TooltipProvider>
          <App />
          <Toaster />
        </TooltipProvider>
      </I18nProvider>
    </BrowserRouter>
  </StrictMode>,
);
