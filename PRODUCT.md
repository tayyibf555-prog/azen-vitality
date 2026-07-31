# Product context

Drafted 2026-07-27 from the practice manager's own walkthrough call plus the build history. Correct anything wrong rather than assuming it is right.

## Register

**product** — this is an operational tool used all day by people with other jobs. Design serves the work. It is not a marketing surface and must never look like one.

## What this is

An operations platform for a UK dental group: four practices in London, roughly fifty staff, about 52,000 patients. It sits on top of Dentally (the practice management system) and is on a path toward replacing it for private work. It has no product name and must never be branded after the agency that builds it.

## Users, in order of how much their opinion decides adoption

**The practice manager.** Runs four sites single-handed with one assistant. Lives in the diary, the rota, HR, compliance and payroll. Pragmatic, fast, has done software migrations before and knows how badly they go. She is the gatekeeper: if she says no, nothing ships. She is comfortable with AI but manages people who are not.

**Dentists and hygienists.** Open the diary and a patient file, do clinical notes and charting, and want to be left alone. Some are self-employed associates. They will reject anything slower or less legible than what they have. They are not the buyer and have no obligation to like this.

**Dental nurses and receptionists.** Book, move and confirm appointments while a phone is ringing and someone is standing at the desk. Speed and glanceability beat everything. Several are quietly worried that software like this exists to replace them.

**The owner.** Wants the group off Dentally's licence fees and is enthusiastic about AI. Not a daily user.

## Anti-references

- **Our own first attempt at the diary.** A list of appointments with a time gutter and status dots. The practice manager's verdict, verbatim: "very basic", "this would drive me mad as a clinician", "if I showed this to a dentist right now they'd be like, I'm absolutely not using this." That reaction is the bar to clear.
- **Anything that reads as an AI product.** Staff anxiety about AI is real and named. Chat bubbles, sparkle icons, "magic" language and robot metaphors all cost trust here.
- **Generic SaaS dashboards.** Metric tiles, gradient accents, identical card grids. This is a clinical tool, not a growth deck.
- **Consumer calendar apps.** Google Calendar and friends solve a different problem: one person, few events. A dental diary is many columns, dense, and read at a glance from across a room.

## The reference to beat

Dentally itself. The practice manager rates it highly and says it is "really self-explanatory, really nice to use". It is not the enemy, it is the standard. Anything replacing it must be at least as legible and at least as fast, or clinicians will simply refuse.

## The house style, settled

**Copy Dentally's interface. Make it better and more modern. Do not make it minimal.**

This is the owner's standing instruction and it has been given three times, because the work keeps drifting back. Treat any drift as a defect.

What that means in practice:

- **Copy the layout, the density and the conventions.** Same panels, same positions, same notation, same information in the same place. Familiarity is the feature; a user moving across should not have to look for anything.
- **Modernise the execution, not the structure.** Better type, better spacing rhythm, better colour, cleaner edges, smoother states. Dentally's 2015 chrome is what gets improved. Its layout is what gets kept.
- **Minimalism is wrong here and is not a matter of taste.** Airy spacing, big empty margins, few elements per screen, "clean" reductions that hide information behind a click. All of it has been explicitly rejected. The owner's words on an earlier attempt: "it just looks all over the place", "we dont need to have it looking minimalstic anymore".
- **Dense is correct.** These are operational screens read all day by people with other jobs. More real information per screen is better, provided it is aligned, ordered and legible. Do not remove a figure to make a screen calmer.
- **Do not move, merge or drop panels** to improve a composition. If a panel exists in Dentally, it exists here, in the same place.

### Density is data, not chrome

The distinction that went wrong once already, so it is written down. Dense means **more information per screen**. It does not mean more decoration, more labelling, or more commentary about the information.

A count from our own dashboard against Dentally's, on the same day, same practice: ours carried 21 uppercase micro-labels, five "LIVE" tags, five caveat chips (three of them styled as amber warnings) and four inline information marks. Dentally's carried one line of grey text: "Stats updated 31/07/26 20:22". Ours held no more actual data. It simply shouted, and the owner's verdict was that ours looked worse.

So:

- **Every element must be a fact or an action.** Explanations of facts, provenance of facts, and reassurance about facts are none of those and must be quiet by default and reachable on demand.
- **Never repeat a label the eye can infer.** A "LIVE" tag on all five cells of one strip tells a reader nothing that the strip's own heading did not.
- **Warning colours are for warnings.** Amber on a caveat that is merely an explanation trains people to ignore amber, and a screen with five amber chips reads as five problems before a single figure has been read.
- **Prefer sentence case for panel headings.** A screen of letterspaced uppercase micro-caps is harder to scan, not denser.
- Honesty about data is non-negotiable and is not what this is about. Keep the reason a figure is missing or partial; attach it to that figure, quietly, rather than to a row of chips across the screen.

## Strategic principles

**Familiar beats clever.** Clinicians were trained on conventions (FDI charting, the appointment state letters, blue for NHS and orange for private). Reproduce them exactly. Inventing a better notation is a way of losing.

**Glanceable from two metres.** The diary gets read across a reception desk and over a shoulder. Density is fine, ambiguity is not.

**The busy Monday test.** Every screen is judged by whether it works when the phone is ringing, a patient is at the desk, and a dentist has called in sick. Anything needing calm to operate has failed.

**Clinical safety is not a UX concern.** A note that does not reach the person who needs it, or an appointment moved to the wrong clinician, is a patient-safety event. Correctness outranks polish, always.

**Show the work, do not hide it.** Staff distrust of automation is countered by making every automated action visible, attributable and reversible, never by making it feel magical.

## Tone

British English. Plain, calm, specific. No exclamation marks, no encouragement, no personality. Say what happened and what to do. Never use the words NHS or private in anything a patient reads, though both are correct and necessary in staff-facing screens.
