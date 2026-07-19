import { NavLink, useSearchParams } from "react-router-dom";
import { workspaceHref } from "../lib/workspace-path";

type Props = {
  workspaceId: string;
};

const tabs = [
  { suffix: "", label: "Overview", end: true, testId: "workspace-subnav-overview" },
  { suffix: "/sources", label: "Sources", end: false, testId: "workspace-subnav-sources" },
  { suffix: "/run", label: "Run", end: false, testId: "workspace-subnav-run" },
  { suffix: "/wiki", label: "Wiki", end: false, testId: "workspace-subnav-wiki" },
  { suffix: "/settings", label: "Settings", end: false, testId: "workspace-subnav-settings" },
] as const;

export function WorkspaceSubnav({ workspaceId }: Props) {
  const [searchParams] = useSearchParams();
  const rootPath = searchParams.get("rootPath");

  return (
    <nav className="subnav" aria-label="Workspace sections">
      {tabs.map((tab) => (
        <NavLink
          key={tab.label}
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
