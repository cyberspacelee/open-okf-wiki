import { BookOpenIcon, BotIcon, FolderGit2Icon, ListTodoIcon, SettingsIcon } from "lucide-react";
import { NavLink, useLocation, useSearchParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useI18n } from "../i18n";
import { agentWorkspaceHref, workspaceHref } from "../lib/workspace-path";

type Props = {
  workspaceId: string;
  /** Slim icon rail for immersive agent chrome. */
  compact?: boolean;
};

type Tab =
  | {
      kind: "agent";
      label: string;
      testId: string;
      icon: typeof BotIcon;
    }
  | {
      kind: "path";
      suffix: string;
      label: string;
      end: boolean;
      testId: string;
      icon: typeof BotIcon;
    };

export function WorkspaceSubnav({ workspaceId, compact = false }: Props) {
  const { t } = useI18n();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const rootPath = searchParams.get("rootPath");
  const onAgent = location.pathname.startsWith("/w/");

  const tabs: Tab[] = [
    {
      kind: "agent",
      label: t.subnav.agent,
      testId: "workspace-subnav-agent",
      icon: BotIcon,
    },
    {
      kind: "path",
      suffix: "/sources",
      label: t.subnav.sources,
      end: false,
      testId: "workspace-subnav-sources",
      icon: FolderGit2Icon,
    },
    {
      kind: "path",
      suffix: "/wiki",
      label: t.subnav.wiki,
      end: false,
      testId: "workspace-subnav-wiki",
      icon: BookOpenIcon,
    },
    {
      kind: "path",
      suffix: "/run",
      label: t.subnav.runs,
      end: false,
      testId: "workspace-subnav-run",
      icon: ListTodoIcon,
    },
    {
      kind: "path",
      suffix: "/settings",
      label: t.subnav.settings,
      end: false,
      testId: "workspace-subnav-settings",
      icon: SettingsIcon,
    },
  ];

  if (compact) {
    return (
      <nav
        className="flex shrink-0 items-center gap-0.5"
        aria-label={t.subnav.aria}
        data-testid="workspace-subnav"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          if (tab.kind === "agent") {
            return (
              <NavLink
                key={tab.testId}
                to={agentWorkspaceHref(workspaceId, rootPath)}
                title={tab.label}
                className={cn(
                  "inline-flex size-8 items-center justify-center rounded-md text-muted-foreground no-underline hover:bg-muted hover:text-foreground",
                  onAgent && "bg-muted text-foreground",
                )}
                data-testid={tab.testId}
                end
              >
                <Icon className="size-3.5" />
                <span className="sr-only">{tab.label}</span>
              </NavLink>
            );
          }
          return (
            <NavLink
              key={tab.testId}
              to={workspaceHref(workspaceId, tab.suffix, rootPath)}
              end={tab.end}
              title={tab.label}
              className={({ isActive }) =>
                cn(
                  "inline-flex size-8 items-center justify-center rounded-md text-muted-foreground no-underline hover:bg-muted hover:text-foreground",
                  isActive && !onAgent && "bg-muted text-foreground",
                )
              }
              data-testid={tab.testId}
            >
              <Icon className="size-3.5" />
              <span className="sr-only">{tab.label}</span>
            </NavLink>
          );
        })}
      </nav>
    );
  }

  return (
    <nav className="subnav" aria-label={t.subnav.aria} data-testid="workspace-subnav">
      {tabs.map((tab) => {
        if (tab.kind === "agent") {
          return (
            <NavLink
              key={tab.testId}
              to={agentWorkspaceHref(workspaceId, rootPath)}
              className={() => (onAgent ? "subnav-link active" : "subnav-link")}
              data-testid={tab.testId}
              end
            >
              {tab.label}
            </NavLink>
          );
        }
        return (
          <NavLink
            key={tab.testId}
            to={workspaceHref(workspaceId, tab.suffix, rootPath)}
            end={tab.end}
            className={({ isActive }) =>
              isActive && !onAgent ? "subnav-link active" : "subnav-link"
            }
            data-testid={tab.testId}
          >
            {tab.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
