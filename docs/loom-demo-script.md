# Loom demo script, Vitality Dental platform

A talking script for the client walkthrough video. Runtime if you follow the timings: roughly 9 to 10 minutes. Everything in it is live production unless the screen says Sample.

---

## 1. Before you press record (5 minutes of prep)

### Switch ON in Operations Controls (owner login, Operations Controls panel)

| Switch | Why |
|---|---|
| **Smile Assessment** | So the public funnel runs the full adaptive AI questions and sends the instant text. Off, it collapses to one question. |
| **Online Booking** | So the booking calendar accepts the final Confirm. Off, it shows slots but refuses at the last step, which looks broken. |
| **Booking Agent** | So the AI replies when you text back. This is the two-way conversation demo. |
| **Speed to Lead** | So the Leads section appears in the sidebar and your test lead shows up in it. |

Leave **everything else OFF** (Recall, Reactivation, No-show Defence, Treatment Coordinator, Reviews, After-hours, Rota, WhatsApp). You will show their dashboards, which work with the systems off; the switches themselves are part of the story.

### Rules while recording

- **Use your own mobile number in every form.** The texts are real now. Never type a client's or third party's number.
- To guarantee the instant SMS from the assessment, answer with high intent: "As soon as possible", "I'm ready to go ahead and pay for it", "Ready to book a consultation now".
- **The booking calendar writes real appointments into the practice's live Dentally diary.** If you complete a booking on camera, use your own name and number, and tell me afterwards so I delete the test appointment and patient record.
- In the Inbox and Co-pilot, do not press Send or type "confirm" against a real patient. The preview step is safe to show.
- Stay inside the practice dashboard. Do not open the /agency console on camera (it carries our own branding, not the practice's).
- The revenue and marketing band on the Home page is labelled Sample data. Say so out loud when it is on screen; the stat row above it is live.

### After recording

- Flip the four demo switches back OFF until the owner gives the word.
- Tell me about any test booking you made so I can remove it from the diary.
- Send me the staff phone number for handover alerts so I can switch those on.

---

## 2. The script

### Cold open (30 seconds)

> "This is the operations platform we've built for the practice group. It sits on top of Dentally, it's live right now on your real data, all fifty one thousand patients across N15 Vitality Dental, N17 Dental and Romford Road, and its job is simple: patients who should be in the chair, get into the chair, without your front desk chasing them."

Key points: it is not a mock-up, it is deployed and connected; Dentally stays the system of record, this layer reads it live and only ever writes a booking when a patient confirms one.

### Login and Home (60 seconds)

Log in as the owner. You land on Home.

> "One front door. The top row is live from Dentally right now: today's appointments, who still needs confirming, what's outstanding. The diary on the right is this morning's actual book."

- Point at the **site switcher**: the whole dashboard scopes to whichever practice you pick; N15 is the default because it goes live first.
- Scroll to the owner band. Say clearly: "The revenue and lead figures in this band are sample data until the marketing sources are connected, and the platform labels them as such. Everything above is live."
- Mention the Daily Brief: every morning it writes the owner a plain-English summary of what happened and what needs attention.

### Operations Controls, the keys to the car (45 seconds)

Open the Operations Controls panel.

> "Every automated system in this platform has its own switch, and they're all in your hands. Nothing texts a patient until you turn that system on. If you ever want everything to stop, you flip it off and it stops. We've also built it so that if anything ever fails internally, it fails switched off, never switched on."

Flip ON, on camera: Smile Assessment, Online Booking, Booking Agent, Speed to Lead. Say: "Turning a switch on arms the system; the AI acts on its next scheduled run rather than the very second you click, so there are never surprise blasts."

### The Smile Assessment funnel (90 seconds)

Open the public page (narrow browser window or phone frame): the assessment link.

> "This is what a patient coming from your website, Instagram or an ad sees. It's not a static form, it's an adaptive quiz: an AI picks each next question based on the previous answer, so an implants enquiry and a whitening enquiry get different journeys. It takes about thirty seconds and it fits on one phone screen with no scrolling."

- Answer the questions on camera with high intent. Point out the region question: "It asks England or Scotland, and later the booking assistant works out which practice suits them; we never make a new patient pick between practice names they don't know."
- Enter **your own** name and mobile, submit.
- Hold up your phone: **the text arrives within seconds.** "That's the platform texting the lead back instantly, written by the AI around what they said they wanted. Speed to lead is the single biggest factor in converting an enquiry, and this makes it seconds, twenty four hours a day."
- Mention: every campaign gets its own link or a one-line embed for the website, and every lead is tagged with where it came from.

### Leads (45 seconds)

Back in the dashboard, open Leads.

> "Here's the lead I just created, top of the list, scored out of a hundred for how ready they are to book. Qualified leads in one tab, near misses and not-qualified in the others, and every one shows the campaign or page it came from, so you know which marketing is actually paying."

### The two-way booking agent (90 seconds)

Reply to the SMS on your phone: something like "Yes I'd like to book, what do you have this week?"

> "Now watch the conversation side. The assistant that texted them isn't a template robot. It holds a real conversation: it knows what they told the assessment, it can answer what a treatment involves and roughly what it costs, and it checks the actual diary for open slots."

- Show the reply arriving, ask it for times, let it offer real slots. You can stop before confirming a booking, or confirm and have me clean up after.
- Then the trust part, said plainly:

> "And it knows its limits. The moment anything clinical comes up, a complaint, or someone asks for a person, it stops, tells the patient the team will be in touch, and flags the conversation for staff. There's also a hard safety filter on every single message: clinical advice or the wrong wording physically cannot reach a patient. And when it hands over, the practice gets an SMS alert on the spot."

- Show the Conversations view with the thread and the "Needs a human" counter.

### Online booking (60 seconds)

Open the public booking page.

> "Patients can also book directly. This calendar is reading your live Dentally availability right now, these are real open slots for real clinicians. A patient picks a time, leaves their details, and the appointment is created straight in the diary. The link the assessment sends out already points at the right practice."

Either complete it with your own details (and tell me after) or stop at the final confirm.

### Patients (30 seconds)

Open Patients.

> "The full live patient base. Search reaches everyone, including archived records, and the counts are exact per practice. Staff can also keep practice notes on a patient here, typed or dictated, without touching the clinical record in Dentally."

### The lifecycle engines (90 seconds)

Walk the four dashboards, systems still off, and narrate what each will do when switched on.

- **Recall**: "Every patient due or overdue their check-up, worked automatically: a friendly text, a reminder, a final nudge, spread over weeks. The moment they reply or book, it stops. It's throttled to a sensible daily volume so patients never feel spammed."
- **Reactivation**: "Patients who quietly lapsed. We only ever contact people whose last visit was between nine and twelve months ago, never older than a year, that's a hard rule in the system, and it's capped at twenty five contacts a day so it ramps gently."
- **No-show Defence**: "Every upcoming appointment gets confirmation nudges, the riskiest get extra attention, and if someone cancels, the system offers that slot to the waitlist automatically."
- **Treatment Coordinator**: "Patients with unfinished treatment plans. Small values are followed up automatically; anything high value is drafted for your team to approve before it goes anywhere."

### Around the clock (30 seconds)

> "Out of hours, a missed call doesn't die in voicemail: the caller gets a text back within seconds and the same assistant picks the conversation up. Everything that happens overnight is on the After-hours worklist in the morning."

Mention Reviews (asks happy patients for a Google review at the right moment) and Rota (staff get their shifts by text) as one-liners.

### Co-pilot (45 seconds)

Open Co-pilot, ask something real: "How many appointments do we have tomorrow at N15?" or "Draft a message to a patient about their hygiene visit."

> "This is the owner's assistant. It can answer questions across the whole practice and draft patient messages, but nothing it writes is sent until a human explicitly confirms it."

Show the preview, do not confirm.

### Decision support (30 seconds)

Flash Compliance (CQC readiness, audits, training matrix), Meta Ads (campaign builder with compliant ad copy), Reports.

> "And the supporting cast: compliance tracking for CQC, a Meta ads workshop that writes regulator-safe ad copy, and monthly reports."

### Close (45 seconds)

> "So that's the platform: live on your data today, every system built, tested and switched off, waiting for you. Go-live is us turning these switches on together, one system at a time, watching each one for a day before the next. Patients can opt out with one word and it's honoured everywhere, every message respects your rules, and you hold the off switch for all of it. When you're ready, we flip the first one."

---

## 3. One-glance recap

**ON for the demo:** Smile Assessment, Online Booking, Booking Agent, Speed to Lead.
**OFF for the demo:** everything else.
**Your number only. No /agency on screen. Don't press Send in Inbox or confirm in Co-pilot. Tell me about any test booking so I can delete it. Flip the four back off after recording.**
