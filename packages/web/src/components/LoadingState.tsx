import { useI18n } from "../i18n";

export function LoadingState({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="py-4 text-sm text-muted-foreground" role="status" aria-live="polite">
      {label ?? t.loading.default}
    </div>
  );
}
