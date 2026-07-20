import { NavLink, useSearchParams } from "react-router-dom";
import { useI18n } from "../i18n";
import { workspaceHref } from "../lib/workspace-path";

type Props = {
  workspaceId: string;
};

export function WorkspaceSubnav({ workspaceId }: Props) {
  const { t } = useI18n();
  const [searchParams] = useSearchParams();
  const rootPath = searchParams.get("rootPath");

  const tabs = [
    { suffix: "", label: t.subnav.overview, end: true, testId: "workspace-subnav-overview" },
    {
      suffix: "/sources",
      label: t.subnav.sources,
      end: false,
      testId: "workspace-subnav-sources",
    },
    {
      suffix: "/session",
      label: t.subnav.session,
      end: false,
      testId: "workspace-subnav-session",
    },
    { suffix: "/run", label: t.subnav.runs, end: false, testId: "workspace-subnav-run" },
    { suffix: "/wiki", label: t.subnav.wiki, end: false, testId: "workspace-subnav-wiki" },
    {
      suffix: "/settings",
      label: t.subnav.settings,
      end: false,
      testId: "workspace-subnav-settings",
    },
  ] as const;

  return (
    <nav className="subnav" aria-label={t.subnav.aria}>
      {tabs.map((tab) => (
        <NavLink
          key={tab.testId}
          to={workspaceHref(workspaceId, tab.suffix, rootPath)}
          end={tab.end}
          className={({ isActive }) => (isActive ? "subnav-link active" : "subnav-link")}
          data-testid={tab.testId}
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
