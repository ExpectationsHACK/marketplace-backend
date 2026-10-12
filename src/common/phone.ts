/** Normalises a phone number to "+" followed by digits, e.g. "+234 802 314 8890" -> "+2348023148890". */
export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  return `+${digits}`;
}

/** At least 9 digits after normalising, enough for any country code + subscriber number we serve. */
export function isPlausiblePhone(input: string): boolean {
  return input.replace(/\D/g, '').length >= 9 && input.replace(/\D/g, '').length <= 15;
}
