// USP (Unique Selling Point) domain types. A USP is one short, patient-safe
// statement of what makes the practice stand out, configured by the owner and
// woven into the AI agents' conversion messaging. Practice-wide (client-scoped).

export type UspCategory = "finance" | "convenience" | "expertise" | "comfort" | "other";

export const USP_CATEGORIES: UspCategory[] = [
  "finance",
  "convenience",
  "expertise",
  "comfort",
  "other",
];

export interface Usp {
  id: string;
  clientId: string;
  text: string;
  category: UspCategory | null;
  priority: number; // higher is mentioned first
  active: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
