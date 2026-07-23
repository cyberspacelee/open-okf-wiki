import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { WikiRunRecordStatus } from "../api";
import { useI18n } from "../i18n";
import { runStatusTone } from "../lib/run-status";

type Props = {
  status: string;
  className?: string;
  "data-testid"?: string;
};

export function RunStatusBadge({ status, className, ...rest }: Props) {
  const { t } = useI18n();
  const tone = runStatusTone(status);
  const labels = t.runStatus as Record<string, string>;
  const label = status in labels ? labels[status as WikiRunRecordStatus] : status;

  const variant =
    tone === "danger"
      ? "destructive"
      : tone === "success" || tone === "running"
        ? "secondary"
        : "outline";

  return (
    <Badge
      variant={variant}
      className={cn(
        tone === "running" && "border-info/40 bg-info/10 text-info",
        tone === "success" && "border-success/40 bg-success/10 text-success",
        tone === "warning" && "border-warning/40 bg-warning/10 text-warning",
        tone === "muted" && "text-muted-foreground",
        className,
      )}
      {...rest}
    >
      {label}
    </Badge>
  );
}
