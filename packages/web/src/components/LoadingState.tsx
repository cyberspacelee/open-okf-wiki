export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="py-4 text-sm text-muted-foreground" role="status" aria-live="polite">
      {label}
    </div>
  );
}
