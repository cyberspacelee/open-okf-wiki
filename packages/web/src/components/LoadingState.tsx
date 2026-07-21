import { useI18n } from "../i18n";
import { Skeleton } from "@/components/ui/skeleton";

export function LoadingState({ label }: { label?: string }) {
  const { t } = useI18n();
  const text = label ?? t.loading.default;
  return (
    <div
      className="flex flex-col gap-3 py-4"
      role="status"
      aria-live="polite"
      aria-label={text}
    >
      <Skeleton className="h-4 w-40 max-w-full" />
      <Skeleton className="h-4 w-64 max-w-full" />
      <Skeleton className="h-4 w-52 max-w-full" />
      <span className="sr-only">{text}</span>
    </div>
  );
}
