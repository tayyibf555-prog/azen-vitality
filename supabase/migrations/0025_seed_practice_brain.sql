-- 0025_seed_practice_brain.sql
-- Seeds rich MOCK practice-knowledge into knowledge_node for the Vitality pilot so the
-- owner co-pilot has real content to answer from. All rows are tagged created_by = 'seed'
-- so this migration is idempotent: re-running deletes the prior seed and re-inserts.
--
-- Practice: Vitality Dental. Three sites: City Centre, Riverside, Northgate.
-- British English throughout. No NHS vs private framing. No dash characters.

-- Idempotency. First detach any NON-seed (user-created) knowledge that was filed
-- under a seed branch, so removing the old seed never deletes real user content and
-- never trips the parent_id FK (on delete restrict). Those items become top-level
-- (still active and searchable); only the seed folders are replaced.
update knowledge_node set parent_id = null
where client_id = 'vitality' and created_by <> 'seed'
  and parent_id in (
    select id from knowledge_node
    where client_id = 'vitality' and created_by = 'seed' and kind = 'branch'
  );

-- Now remove the prior seed: items (children) before branches (parents).
delete from knowledge_node where client_id = 'vitality' and created_by = 'seed' and kind = 'item';
delete from knowledge_node where client_id = 'vitality' and created_by = 'seed' and kind = 'branch';

-- Branches (folders). Fixed uuids so items can reference them as parent_id.
insert into knowledge_node (id, client_id, site_id, parent_id, kind, title, body, raw_input, tier, tags, source, source_ref, classification, status, created_by) values
  ('00000000-0000-0000-0000-0000000000b1', 'vitality', null, null, 'branch', 'Pricing',               null, null, 1, ARRAY['pricing','fees','cost'],                'manual_note', null, null, 'active', 'seed'),
  ('00000000-0000-0000-0000-0000000000b2', 'vitality', null, null, 'branch', 'Services',              null, null, 1, ARRAY['services','treatments'],               'manual_note', null, null, 'active', 'seed'),
  ('00000000-0000-0000-0000-0000000000b3', 'vitality', null, null, 'branch', 'Opening hours and contact', null, null, 1, ARRAY['hours','contact','location'],     'manual_note', null, null, 'active', 'seed'),
  ('00000000-0000-0000-0000-0000000000b4', 'vitality', null, null, 'branch', 'Finance and payment',   null, null, 2, ARRAY['finance','payment','commercial'],     'manual_note', null, null, 'active', 'seed'),
  ('00000000-0000-0000-0000-0000000000b5', 'vitality', null, null, 'branch', 'Membership plan',       null, null, 1, ARRAY['membership','plan','subscription'],   'manual_note', null, null, 'active', 'seed'),
  ('00000000-0000-0000-0000-0000000000b6', 'vitality', null, null, 'branch', 'Policies',              null, null, 1, ARRAY['policies','rules'],                   'manual_note', null, null, 'active', 'seed'),
  ('00000000-0000-0000-0000-0000000000b7', 'vitality', null, null, 'branch', 'Scripts and SOPs',      null, null, 1, ARRAY['scripts','sop','reception'],          'manual_note', null, null, 'active', 'seed'),
  ('00000000-0000-0000-0000-0000000000b8', 'vitality', null, null, 'branch', 'Team and roles',        null, null, 1, ARRAY['team','roles','staff'],               'manual_note', null, null, 'active', 'seed');

-- Items. gen_random_uuid() ids, parent_id points at the relevant branch above.

-- 1. Pricing (branch b1)
insert into knowledge_node (id, client_id, site_id, parent_id, kind, title, body, raw_input, tier, tags, source, source_ref, classification, status, created_by) values
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b1', 'item', 'New patient exam and check-up prices',
    'A new patient exam is £95 and includes a full assessment and any standard x-rays needed. A routine check-up for existing patients is £65. A hygiene visit is £75.',
    null, 1, ARRAY['exam','check-up','hygiene','new patient','price'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b1', 'item', 'Emergency appointment price',
    'An emergency appointment is £85 and covers an assessment plus immediate pain relief where needed. Any further treatment is quoted separately on the day.',
    null, 1, ARRAY['emergency','urgent','pain','price'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b1', 'item', 'Invisalign pricing',
    'Invisalign clear aligners range from £2,500 to £4,500 depending on the complexity of the case. The exact figure is confirmed at a consultation once the treatment plan is agreed.',
    null, 2, ARRAY['invisalign','aligners','orthodontics','price','consultation'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b1', 'item', 'Dental implant pricing',
    'A single dental implant starts from £2,400. Multiple implants and implant bridges are quoted after a consultation and any imaging required.',
    null, 2, ARRAY['implant','implants','price','consultation'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b1', 'item', 'Veneer pricing',
    'Composite veneers are £250 per tooth and porcelain veneers are £550 per tooth. The choice depends on the look the patient wants and how long they would like it to last.',
    null, 2, ARRAY['veneers','composite','porcelain','cosmetic','price'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b1', 'item', 'Teeth whitening pricing',
    'A home whitening kit is £350 and an in-surgery whitening treatment is £450. The home kit includes custom trays and gel with guidance from the team.',
    null, 1, ARRAY['whitening','teeth whitening','cosmetic','price'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b1', 'item', 'Root canal and filling pricing',
    'Root canal treatment ranges from £350 to £650 depending on the tooth and number of canals. A white filling ranges from £140 to £240 depending on size.',
    null, 1, ARRAY['root canal','endodontics','filling','white filling','price'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b1', 'item', 'Crown and extraction pricing',
    'A crown is £650. An extraction ranges from £120 to £180 depending on how straightforward the tooth is to remove.',
    null, 1, ARRAY['crown','extraction','price'], 'manual_note', null, null, 'active', 'seed');

-- 2. Services (branch b2)
insert into knowledge_node (id, client_id, site_id, parent_id, kind, title, body, raw_input, tier, tags, source, source_ref, classification, status, created_by) values
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b2', 'item', 'General and preventive dentistry',
    'We provide routine examinations, hygiene visits, fillings, crowns, extractions and root canal treatment. The focus is on keeping teeth healthy and catching problems early.',
    null, 1, ARRAY['general','preventive','check-up','hygiene','fillings'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b2', 'item', 'Invisalign clear aligners',
    'We offer Invisalign to straighten teeth with clear, removable aligners. Treatment starts with a consultation to assess suitability and map out the expected result.',
    null, 1, ARRAY['invisalign','aligners','orthodontics','straightening'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b2', 'item', 'Dental implants',
    'We place dental implants to replace missing teeth, including single tooth implants and implant supported bridges. Treatment is planned around the patient''s bone and gum health.',
    null, 1, ARRAY['implants','missing teeth','restorative'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b2', 'item', 'Veneers and smile makeovers',
    'We offer composite and porcelain veneers as part of smile makeovers. A consultation covers the desired look, tooth shade and a preview of the planned result where suitable.',
    null, 1, ARRAY['veneers','smile makeover','cosmetic'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b2', 'item', 'Teeth whitening',
    'We provide professional teeth whitening with a take home kit or an in-surgery treatment. Both options are supervised by the dental team for a safe, even result.',
    null, 1, ARRAY['whitening','cosmetic','brightening'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b2', 'item', 'Hygiene and gum health',
    'Our hygienists provide scaling, polishing and tailored advice to keep gums healthy. Regular hygiene visits help prevent gum disease and keep treatment costs down over time.',
    null, 1, ARRAY['hygiene','gum health','periodontal','cleaning'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b2', 'item', 'Emergency dentistry',
    'We keep emergency slots for pain, swelling, broken teeth and lost fillings or crowns. Patients in pain should phone the practice early in the day to be seen as quickly as possible.',
    null, 1, ARRAY['emergency','urgent','pain','broken tooth'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b2', 'item', 'Nervous patient care',
    'We welcome nervous and anxious patients and take extra time to explain each step. Longer appointments and a calm, unhurried approach are available on request.',
    null, 1, ARRAY['nervous','anxious','phobia','gentle'], 'manual_note', null, null, 'active', 'seed');

-- 3. Opening hours and contact (branch b3)
insert into knowledge_node (id, client_id, site_id, parent_id, kind, title, body, raw_input, tier, tags, source, source_ref, classification, status, created_by) values
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b3', 'item', 'Opening hours',
    'All three sites are open Monday to Friday from 09:00 to 17:30 and Saturday from 09:00 to 13:00. We are closed on Sundays. The same hours apply at City Centre, Riverside and Northgate.',
    null, 1, ARRAY['opening hours','times','saturday','closed sunday'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b3', 'item', 'Our three sites',
    'Vitality Dental has three sites: City Centre, Riverside and Northgate. Patients can usually be seen at whichever site is most convenient, subject to availability.',
    null, 1, ARRAY['sites','locations','city centre','riverside','northgate'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b3', 'item', 'How to reach each site',
    'Each site has its own reception line during opening hours, and the main practice email is monitored throughout the day. Reception can transfer a caller to another site if needed.',
    null, 1, ARRAY['contact','phone','email','reception'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b3', 'item', 'Out of hours and emergency guidance',
    'Outside opening hours, patients in severe pain should leave a message on the practice line and call back when we reopen for the earliest emergency slot. For a serious facial swelling or difficulty breathing or swallowing, advise the patient to seek urgent medical help.',
    null, 1, ARRAY['out of hours','emergency','after hours','urgent'], 'manual_note', null, null, 'active', 'seed');

-- 4. Finance and payment (branch b4)
insert into knowledge_node (id, client_id, site_id, parent_id, kind, title, body, raw_input, tier, tags, source, source_ref, classification, status, created_by) values
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b4', 'item', '0 percent finance',
    'We offer 0 percent interest finance over 12 months on treatment over £500. This spreads the cost with no extra charge and is arranged before treatment begins.',
    null, 2, ARRAY['finance','0 percent','interest free','12 months','payment plan'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b4', 'item', 'Longer payment plans',
    'For larger treatment we also offer longer interest-bearing plans over 24 to 48 months. The monthly figure and total cost are confirmed in writing before the patient signs up.',
    null, 2, ARRAY['finance','payment plan','24 months','48 months','interest'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b4', 'item', 'Deposits for larger treatment',
    'A deposit of 20 percent is taken to secure larger treatment and book the clinical time. The deposit comes off the total balance due.',
    null, 2, ARRAY['deposit','finance','booking','larger treatment'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b4', 'item', 'Accepted payment methods',
    'We accept all major debit and credit cards and bank transfer. Payment is usually taken on the day of treatment unless a finance plan is in place.',
    null, 2, ARRAY['payment','cards','bank transfer','methods'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b4', 'item', 'Refunds policy',
    'Where a refund is due, for example a deposit on treatment that has not started, it is processed back to the original payment method. Refund requests are reviewed by the practice manager.',
    null, 2, ARRAY['refund','deposit','policy','finance'], 'manual_note', null, null, 'active', 'seed');

-- 5. Membership plan (branch b5)
insert into knowledge_node (id, client_id, site_id, parent_id, kind, title, body, raw_input, tier, tags, source, source_ref, classification, status, created_by) values
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b5', 'item', 'Membership plan overview',
    'Our membership plan is around £20.95 per month. It includes 2 check-ups and 2 hygiene visits a year, plus 10 percent off most treatments and worldwide dental trauma cover.',
    null, 1, ARRAY['membership','plan','monthly','check-up','hygiene','discount'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b5', 'item', 'What the membership plan saves',
    'For patients who attend regularly, the plan usually works out cheaper than paying for each check-up and hygiene visit separately, and the 10 percent treatment discount adds further value. The team can run the numbers for a patient on request.',
    null, 1, ARRAY['membership','savings','value','discount'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b5', 'item', 'Joining the membership plan',
    'Patients can join the plan at reception or during an appointment. It is paid by monthly direct debit and can be set up the same day.',
    null, 1, ARRAY['membership','join','direct debit','sign up'], 'manual_note', null, null, 'active', 'seed');

-- 6. Policies (branch b6)
insert into knowledge_node (id, client_id, site_id, parent_id, kind, title, body, raw_input, tier, tags, source, source_ref, classification, status, created_by) values
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b6', 'item', 'Cancellation policy',
    'We ask for 48 hours notice to change or cancel an appointment. With less notice a missed-appointment fee of £30 may apply, as the time has been reserved for that patient.',
    null, 1, ARRAY['cancellation','notice','missed appointment','fee','policy'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b6', 'item', 'New patient deposit',
    'A small deposit may be taken to secure a new patient appointment. It comes off the cost of the visit and protects clinical time that would otherwise go unused.',
    null, 1, ARRAY['new patient','deposit','booking','policy'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b6', 'item', 'Running late policy',
    'We allow a grace period of 10 minutes for patients who are running late. Beyond that the appointment may need to be shortened or rebooked so the day stays on schedule for everyone.',
    null, 1, ARRAY['late','grace period','policy','appointment'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b6', 'item', 'Complaints procedure',
    'Complaints should be raised with the practice manager, who acknowledges them within 3 working days and aims to resolve them promptly and fairly. Patients are kept informed throughout.',
    null, 2, ARRAY['complaints','procedure','practice manager','policy'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b6', 'item', 'Data and GDPR in brief',
    'We handle patient data in line with GDPR and only use it to provide care and run the practice. Records are kept secure and are not shared without a lawful reason or the patient''s consent.',
    null, 2, ARRAY['gdpr','data','privacy','policy'], 'manual_note', null, null, 'active', 'seed');

-- 7. Scripts and SOPs (branch b7)
insert into knowledge_node (id, client_id, site_id, parent_id, kind, title, body, raw_input, tier, tags, source, source_ref, classification, status, created_by) values
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b7', 'item', 'Price enquiry call script',
    'When a caller asks the price of a treatment, lead with value and the benefit, give a clear starting figure, then invite them to book a consultation so we can confirm the exact plan. Never just quote a number and end the call. For example: explain what is included, mention finance options, and offer the next available consultation.',
    null, 1, ARRAY['script','price enquiry','phone','reception','sop','consultation'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b7', 'item', 'Rebooking a no-show',
    'When a patient misses an appointment, contact them the same day in a friendly tone, check they are alright, and offer the next suitable slot. Note the missed visit on the record and mention the cancellation policy gently if it keeps happening.',
    null, 1, ARRAY['no-show','rebooking','sop','reception','script'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b7', 'item', 'New patient welcome message',
    'Welcome new patients warmly, confirm the date, time and site, and tell them roughly how long the first visit takes. Let them know they can arrive a few minutes early to complete a short medical history form.',
    null, 1, ARRAY['new patient','welcome','script','sop','onboarding'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b7', 'item', 'Recall due reminder tone',
    'Recall reminders should be warm and helpful, not pushy. Remind the patient that a check-up is due, explain it keeps small problems from becoming big ones, and make it easy to book in one reply or call.',
    null, 1, ARRAY['recall','reminder','tone','script','sop'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b7', 'item', 'How to take a deposit',
    'Explain why a deposit is needed (to reserve clinical time), confirm the amount, take payment by card or bank transfer, and record it against the booking so it comes off the final balance. Send the patient a short confirmation once it is done.',
    null, 1, ARRAY['deposit','sop','payment','booking','reception'], 'manual_note', null, null, 'active', 'seed');

-- 8. Team and roles (branch b8)
insert into knowledge_node (id, client_id, site_id, parent_id, kind, title, body, raw_input, tier, tags, source, source_ref, classification, status, created_by) values
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b8', 'item', 'Principal dentist',
    'The principal dentist leads the clinical team, oversees standards of care and handles more complex treatment such as implants and full smile makeovers. They also support and mentor the associate dentists.',
    null, 1, ARRAY['principal','dentist','clinical','team','roles'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b8', 'item', 'Associate dentists',
    'The associate dentists provide day to day general and cosmetic dentistry across the three sites, including check-ups, fillings, crowns and Invisalign. They refer complex cases to the principal dentist where appropriate.',
    null, 1, ARRAY['associate','dentist','clinical','team','roles'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b8', 'item', 'Hygienists',
    'The hygienists carry out cleaning, scaling and gum health treatment and give patients practical advice on looking after their teeth at home. They work closely with the dentists on gum health plans.',
    null, 1, ARRAY['hygienist','gum health','cleaning','team','roles'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b8', 'item', 'Treatment coordinator',
    'The treatment coordinator guides patients through larger treatment plans, explains the options, costs and finance, and keeps things moving between appointments. They are the main point of contact for patients considering treatment such as Invisalign or implants.',
    null, 1, ARRAY['treatment coordinator','plans','finance','team','roles'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b8', 'item', 'Practice manager',
    'The practice manager runs the day to day operation, handles complaints and refunds, manages the team and makes sure the practice meets its standards. Admin and policy questions usually come to them.',
    null, 1, ARRAY['practice manager','admin','operations','team','roles'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b8', 'item', 'Reception team',
    'The reception team handles bookings, phone and email enquiries, deposits and the first welcome for every patient. They direct clinical questions to the right dentist or to the treatment coordinator.',
    null, 1, ARRAY['reception','bookings','admin','team','roles'], 'manual_note', null, null, 'active', 'seed'),
  (gen_random_uuid(), 'vitality', null, '00000000-0000-0000-0000-0000000000b8', 'item', 'Who handles what',
    'Clinical care sits with the dentists and hygienists, larger treatment plans and finance with the treatment coordinator, and admin, complaints and policy with the practice manager. Reception is the first point of contact and routes everything to the right person.',
    null, 1, ARRAY['responsibilities','who handles','clinical','admin','team','roles'], 'manual_note', null, null, 'active', 'seed');
