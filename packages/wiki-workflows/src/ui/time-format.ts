const LOCAL_DATE_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

export function formatLocalDateTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? LOCAL_DATE_TIME.format(timestamp) : value;
}
