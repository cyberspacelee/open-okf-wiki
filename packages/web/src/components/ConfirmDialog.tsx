import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Body copy under the title (AlertDialogDescription). */
  description?: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  onConfirm: () => void | Promise<void>;
  /** Destructive confirm styling. Defaults to true. */
  destructive?: boolean;
  confirmDisabled?: boolean;
  /**
   * Stable e2e anchor on the visible dialog surface (AlertDialogContent).
   * Keep the same testid when swapping Card → AlertDialog, e.g.
   * `workspace-delete-dialog`.
   */
  "data-testid"?: string;
  /** Stable e2e anchor on the confirm button, e.g. `workspace-delete-confirm`. */
  confirmTestId?: string;
  /** Optional secondary checkbox (delete-meta pattern). */
  metaChecked?: boolean;
  onMetaCheckedChange?: (checked: boolean) => void;
  metaLabel?: ReactNode;
  /** Stable e2e anchor on the meta checkbox, e.g. `workspace-delete-meta`. */
  metaTestId?: string;
};

/**
 * Thin AlertDialog wrapper for destructive / confirm flows.
 * Used by workspace/model/source/session delete paths; preserves stable e2e testids.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  destructive = true,
  confirmDisabled = false,
  "data-testid": dataTestId,
  confirmTestId,
  metaChecked,
  onMetaCheckedChange,
  metaLabel,
  metaTestId,
}: ConfirmDialogProps) {
  const showMeta = metaLabel != null && onMetaCheckedChange != null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid={dataTestId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description != null ? (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>

        {showMeta ? (
          <label className="flex items-start gap-2 text-sm leading-snug">
            <Checkbox
              checked={metaChecked ?? false}
              onCheckedChange={(checked) => onMetaCheckedChange(checked === true)}
              data-testid={metaTestId}
              className="mt-0.5"
            />
            <span>{metaLabel}</span>
          </label>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={confirmDisabled}
            data-testid={confirmTestId}
            onClick={() => {
              // Invoke first so parent handlers can read controlled state
              // (e.g. metaChecked) before onOpenChange clears it.
              void onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
