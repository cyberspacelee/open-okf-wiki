import { NavLink, useLocation, useSearchParams } from "react-router-dom";
import { useI18n } from "../i18n";
import { agentWorkspaceHref, workspaceHref } from "../lib/workspace-path";

type Props = {
  workspaceId: string;
};

type Tab =
  | {
      kind: "agent";
      label: string;
      testId: string;
    }
  | {
      kind: "path";
      suffix: string;
      label: string;
      end: boolean;
      testId: string;
    };

export function WorkspaceSubnav({ workspaceId }: Props) {
  const { t } = useI18n();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const rootPath = searchParams.get("rootPath");
  // Agent Workspace is the only `/w/*` surface in this app.
  const onAgent = location.pathname.startsWith("/w/");

  const tabs: Tab[] = [
    {
      kind: "agent",
      label: t.subnav.agent,
      testId: "workspace-subnav-agent",
    },
    {
      kind: "path",
      suffix: "/sources",
      label: t.subnav.sources,
      end: false,
      testId: "workspace-subnav-sources",
    },
    {
      kind: "path",
      suffix: "/wiki",
      label: t.subnav.wiki,
      end: false,
      testId: "workspace-subnav-wiki",
    },
    {
      kind: "path",
      suffix: "/run",
      label: t.subnav.runs,
      end: false,
      testId: "workspace-subnav-run",
    },
    {
      kind: "path",
      suffix: "/settings",
      label: t.subnav.settings,
      end: false,
      testId: "workspace-subnav-settings",
    },
  ];

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
