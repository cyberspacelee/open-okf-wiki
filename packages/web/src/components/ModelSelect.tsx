import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ModelProfilePublic } from "../api";
import { useI18n } from "../i18n";

type Props = {
  models: ModelProfilePublic[];
  value: string;
  onChange: (profileId: string) => void;
  defaultModelProfileId?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  "data-testid"?: string;
  /** Show empty option for optional selection. */
  allowEmpty?: boolean;
  emptyLabel?: string;
};

function modelLabel(
  m: ModelProfilePublic,
  defaultModelProfileId: string | undefined,
  defaultSuffix: string,
): string {
  const suffix = defaultModelProfileId === m.id ? ` ${defaultSuffix}` : "";
  return `${m.name}${suffix} - ${m.modelId}`;
}

export function ModelSelect({
  models,
  value,
  onChange,
  defaultModelProfileId,
  id = "model-profile",
  required,
  disabled,
  "data-testid": testId = "model-profile-select",
  allowEmpty,
  emptyLabel,
}: Props) {
  const { t } = useI18n();
  const placeholder = emptyLabel ?? t.modelSelect.selectPlaceholder;

  const items = useMemo(
    () =>
      models.map((m) => ({
        value: m.id,
        label: modelLabel(m, defaultModelProfileId, t.modelSelect.defaultSuffix),
      })),
    [models, defaultModelProfileId, t.modelSelect.defaultSuffix],
  );

  if (models.length === 0) {
    return (
      <Field data-testid="model-select-empty">
        <FieldLabel htmlFor={id}>{t.modelSelect.label}</FieldLabel>
        <FieldDescription>
          {t.modelSelect.emptyBefore}
          <Link to="/settings" className="inline-link ml-0">
            {t.modelSelect.emptyLink}
          </Link>
          {t.modelSelect.emptyAfter}
        </FieldDescription>
      </Field>
    );
  }

  return (
    <Field>
      <FieldLabel htmlFor={id}>{t.modelSelect.label}</FieldLabel>
      <Select
        value={value || null}
        onValueChange={(next) => {
          if (typeof next === "string") {
            onChange(next);
          } else if (allowEmpty && next == null) {
            onChange("");
          }
        }}
        items={items}
        disabled={disabled}
      >
        <SelectTrigger
          id={id}
          className="w-full max-w-md"
          data-testid={testId}
          aria-required={required || undefined}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {models.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {modelLabel(m, defaultModelProfileId, t.modelSelect.defaultSuffix)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>
        {t.modelSelect.hintBefore}
        <Link to="/settings">{t.modelSelect.hintLink}</Link>
        {t.modelSelect.hintAfter}
      </FieldDescription>
    </Field>
  );
}
