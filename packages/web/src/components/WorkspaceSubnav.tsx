import { NavLink } from "react-router-dom";

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
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;

  return (
    <nav className="subnav" aria-label="Workspace sections">
      {tabs.map((tab) => (
        <NavLink
          key={tab.label}
          to={`${base}${tab.suffix}`}
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
