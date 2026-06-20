/**
 * Mock patient database for outreach testing. These are not real patients and
 * carry no clinical data. Every phone number is the single test handset so the
 * outreach systems can be exercised end to end without contacting anyone real.
 *
 * Statuses are deliberately mixed between no-shows and abandoned inquiries, the
 * two cohorts the coordinator and reactivation systems chase first.
 */

export type PatientStatus = "no_show" | "abandoned_inquiry";

export interface PatientRecord {
  id: string;
  name: string;
  /** The treatment the patient wanted. */
  treatment: string;
  status: PatientStatus;
  phone: string;
  /** A real site id from clients.ts. */
  siteId: string;
  /** ISO date of the last contact attempt. */
  lastContactAt: string;
}

/** The single test handset. Every record points here on purpose. */
const TEST_PHONE = "+447403097379";

export const PATIENTS: PatientRecord[] = [
  {
    id: "p-1",
    name: "Eleanor Whitfield",
    treatment: "Invisalign",
    status: "no_show",
    phone: TEST_PHONE,
    siteId: "site-cc",
    lastContactAt: "2026-06-17T14:20:00Z",
  },
  {
    id: "p-2",
    name: "Callum Fitzgerald",
    treatment: "Dental implant",
    status: "abandoned_inquiry",
    phone: TEST_PHONE,
    siteId: "site-rv",
    lastContactAt: "2026-06-15T09:05:00Z",
  },
  {
    id: "p-3",
    name: "Priya Raghunathan",
    treatment: "Porcelain veneers",
    status: "no_show",
    phone: TEST_PHONE,
    siteId: "site-ng",
    lastContactAt: "2026-06-18T11:40:00Z",
  },
  {
    id: "p-4",
    name: "Marcus Beaumont",
    treatment: "Teeth whitening",
    status: "abandoned_inquiry",
    phone: TEST_PHONE,
    siteId: "site-cc",
    lastContactAt: "2026-06-13T16:30:00Z",
  },
  {
    id: "p-5",
    name: "Sophie Allardyce",
    treatment: "Composite bonding",
    status: "no_show",
    phone: TEST_PHONE,
    siteId: "site-rv",
    lastContactAt: "2026-06-16T08:50:00Z",
  },
];
