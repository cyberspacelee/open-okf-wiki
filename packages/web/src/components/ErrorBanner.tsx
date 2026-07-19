import type { ApiError } from "../api";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type Props = {
  error: unknown;
  onDismiss?: () => void;
};

export function formatError(error: unknown): string {
  if (!error) {
    return "Unknown error";
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
  if (!error) {
    return null;
  }

  const message = formatError(error);
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as ApiError).status
      : undefined;

  return (
    <Alert variant="destructive" data-testid="error-banner">
      <div>
        <AlertTitle>Request failed{status ? ` (${status})` : ""}</AlertTitle>
        <AlertDescription>
          <p className="whitespace-pre-wrap break-words">{message}</p>
        </AlertDescription>
      </div>
      {onDismiss ? (
        <AlertAction>
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
