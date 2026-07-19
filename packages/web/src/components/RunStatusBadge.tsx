import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { runStatusLabel, runStatusTone } from "../lib/run-status";

type Props = {
  status: string;
  className?: string;
  "data-testid"?: string;
};

export function RunStatusBadge({ status, className, ...rest }: Props) {
  const tone = runStatusTone(status);
  const label = runStatusLabel(status);

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
        tone === "running" && "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
        tone === "success" &&
          "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "warning" &&
          "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
        tone === "muted" && "text-muted-foreground",
        className,
      )}
      {...rest}
    >
      {label}
    </Badge>
  );
}
