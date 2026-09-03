/**
 * The IT contact's FORM shape — the thing the page hands the workspace.
 *
 * A plain module, imported by both the server view and the "use client"
 * workspace, for the reason `rsc-value-import.test.ts` pins: a value defined in
 * a client module and imported by a server file becomes a client-reference proxy
 * and crashes at render, while tsc, vitest and the build all stay green.
 *
 * Strings rather than `string | null`, because this is what a form holds: an
 * empty input is "", and the repository is the thing that turns "" back into
 * null on the way to the database.
 */
export interface ContactForm {
  name: string;
  company: string;
  phone: string;
  email: string;
  hours: string;
  notes: string;
}
