# Questions for Dentally — draft for Vitality to send

**This must go from Vitality, not from us.** A four-site paying Henry Schein One customer asking
about their own data gets an authoritative answer; a software vendor asking gets months of silence
(their public partner form has documented complaints of exactly that). Send it through the in-app
Support chat or to the practice's account manager.

**Framing, which matters more than the wording.** This is *clinical charting assistance for an
existing customer*. Their T&Cs prohibit using the Services to build a competing product, so the
long-term intention to replace Dentally must not appear anywhere in this thread — not as a hint,
not as context, not "eventually". Ask only what is needed to make the current tooling work.

Send from a practice email address, signed by the practice manager or a principal.

---

## The email

> **Subject:** API question — treatment plan items, and some undocumented endpoints
>
> Hello,
>
> We're a four-site practice running Dentally across all our locations. We work with a software
> partner who has built internal tooling on top of the Dentally API — currently for recall,
> reactivation and appointment management, and now a clinical chart view so our dentists can see a
> patient's charted treatment without switching screens mid-appointment.
>
> Four questions have come up that we can't answer from the public documentation at
> developer.dentally.co, and we'd rather ask than guess.
>
> **1. Is `PUT` / `PATCH /v1/treatment_plan_items/{id}` a supported endpoint?**
>
> The docs list every charting resource as read-only, but that route appears to be mounted. On
> `api.dentally.co`, `PUT` and `PATCH` to `/v1/treatment_plan_items/{id}` return **403**, while
> `DELETE` on the identical path returns **404** — and `PUT` on `/v1/treatments/{id}`,
> `/v1/treatment_plans/{id}`, `/v1/treatment_categories/{id}` and
> `/v1/treatment_appointments/{id}` all return **404**. That pattern suggests an update action
> exists on plan items specifically.
>
> If it is supported: which fields does it accept (`teeth`, `surfaces`, `notes`, `completed`?),
> and under which scope? If it isn't intended for customer use, we'd like to know that plainly so
> we don't build anything near it.
>
> **2. What are `/v1/notes`, `/v1/patient_documents` and `/v1/medical_histories`?**
>
> None appear in the public documentation, but all three respond. `/v1/notes` answers on `GET`,
> `POST`, `PUT`, `PATCH` and `DELETE`. Are these available to us, and is there documentation we
> haven't found?
>
> **3. What does the `correspondence` scope cover?**
>
> It's present on our API key today (`x-oauth-scopes`) but isn't in the scope table in your docs.
> We'd like to understand what it grants before relying on it — particularly whether it allows
> filing documents against a patient record.
>
> **4. Does NexGen change any of the above?**
>
> We understand a new partner API is launching. Should we be planning against it instead, and what
> is the route for our software partner to get sandbox access?
>
> More generally: we'd rather build on documented, supported endpoints than on anything we've
> merely found to respond. If any of the above is off-limits, please just say so and we'll stay
> away from it.
>
> Many thanks,
> [name]
> [role], Vitality Dental

---

## What each answer changes for us

| Answer | Consequence |
|---|---|
| `PUT treatment_plan_items` **supported** | We can push status changes (e.g. completing planned treatment) back to Dentally. Still no *create*, so charting cannot originate here. |
| `PUT treatment_plan_items` **not for customers** | Settled. The chart stays a read-only mirror and we stop looking at that route. Cheaper to know now. |
| `/v1/notes` **POST works and is allowed** | Bigger than the above — it is a **create**. A treatment summary could be filed as a real note rather than squeezed into `appointment.notes`. |
| `correspondence` **allows document upload** | A rendered chart PDF could be filed against the patient record, which sidesteps structured charting entirely. |
| NexGen **is the path** | Whatever we build on the current key needs migrating anyway; better to know before we build more. |

## Do not do, whatever the answer

- **Do not write to any undocumented endpoint without written confirmation.** Building the legal
  clinical record on a route the vendor has not acknowledged is a CQC Regulation 17 governance
  problem the moment it silently stops working.
- **Do not drive Dentally's own UI with stored clinician credentials.** It breaches their terms,
  and any robot-authored clinical entry breaks GDC Standard 4.1.4 (the treating clinician's name
  must be on the record) and the DSP Toolkit's no-shared-logins expectation. No commercial
  agreement with Dentally cures the second one.

---

# Separate, and more urgent: the write-back promise

Per [[blerta-call-requirements]], two integration promises were made that aren't true. If **charting
write-back** was one of them, it needs correcting now, in writing.

The fact to convey, without hedging:

> Dentally's API has **no create route for any charting resource**. `POST` returns 404 on
> `/v1/treatment_plan_items`, on `/v1/treatment_plans`, and on every nested form. This means a
> dentist cannot chart in our platform and have it appear in Dentally. It is not a scheduling
> problem or a thing we haven't got to — the door does not exist on their side.
>
> What we *can* do, and have built: mirror Dentally's chart into our platform so it's visible
> without switching systems, and write a treatment summary to the appointment notes, which is
> supported and which Dentally users see.
>
> What charting in our platform would require is a **dated cutover** where charting moves once,
> cleanly, and Dentally becomes read-only for it — not two systems both holding clinical records.
> That's a decision for the practice, not a switch we should flip quietly.

Say it while it costs a conversation. At go-live it costs the account.
