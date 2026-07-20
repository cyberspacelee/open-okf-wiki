import type { ApiError } from "../api";
import { useI18n } from "../i18n";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type Props = {
  error: unknown;
  onDismiss?: () => void;
};

export function formatError(error: unknown, unknownLabel = "Unknown error"): string {
  if (!error) {
    return unknownLabel;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function ErrorBanner({ error, onDismiss }: Props) {
  const { t } = useI18n();
  if (!error) {
    return null;
  }

  const message = formatError(error, t.errorBanner.unknown);
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as ApiError).status
      : undefined;

  return (
    <Alert variant="destructive" data-testid="error-banner">
      <div>
        <AlertTitle>
          {t.errorBanner.title}
          {status ? ` (${status})` : ""}
        </AlertTitle>
        <AlertDescription>
          <p className="whitespace-pre-wrap break-words">{message}</p>
        </AlertDescription>
      </div>
      {onDismiss ? (
        <AlertAction>
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            {t.errorBanner.dismiss}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
