// After-hours capture domain types.
//
// The module logs missed phone calls and inbound messages that land while a
// site is closed, then hands staff a worklist to follow up. Channels reuse the
// messaging vocabulary plus "call" for the Twilio Voice webhook.

export type CaptureChannel = "call" | "sms" | "whatsapp";

// new        -> just captured, awaiting a human
// followed_up -> staff have reached back out
// booked     -> turned into an appointment
// closed     -> dealt with / no action needed
export type CaptureStatus = "new" | "followed_up" | "booked" | "closed";

export interface AfterHoursCapture {
  id: string;
  siteId: string;
  fromNumber: string;
  dentallyPatientId: string | null;
  patientName: string;          // resolved name, or "Unknown <last4>"
  channel: CaptureChannel;
  body: string | null;          // message text; null for a call
  capturedAt: string;           // ISO
  status: CaptureStatus;
  followUpSent: boolean;
}
