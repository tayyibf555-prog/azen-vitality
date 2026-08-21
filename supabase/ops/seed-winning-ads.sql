-- seed-winning-ads.sql
-- The winning-ads LIBRARY seed: the top 120 ranked competitor dental ads from a
-- completed Meta Ad Library scrape (Apify dataset rIf3BTCvDE3CgMKj8, 1739 UK
-- dental ads), deduplicated by creative and scored by src/lib/meta-ads/ingest.ts.
--
-- GENERATED FILE. Do not hand-edit: rebuild it by re-running the ingest over a fresh
-- scrape. The 1739-ad raw scrape is NOT committed; only this ranked top 120 is.
--
-- IDEMPOTENT. Upserts on (niche, dedup_key): re-running updates each entry's runtime,
-- variant count, score and creative URLs in place, never duplicating. Safe to run on
-- top of the weekly /api/meta-ads/winning-ads/ingest refresh and vice versa.
--
-- Apply AFTER migration 0088. Fable applies this (the app's role is read-only on DDL).
-- Meta CDN image URLs are signed and expire; the weekly ingest refreshes them.
-- ---------------------------------------------------------------------------

insert into winning_ads (
  niche, keyword, dedup_key, collation_id, ad_archive_id, collation_count, variant_count, page_name, page_id, title, body_text, cta_text, cta_type, link_url, display_format, publisher_platform, image_url, currency, start_date, end_date, is_active, runtime_days, categories, ad_library_url, winning_score
) values
  ('uk-dental', 'clear-aligners', 'c:24316114984661844', '24316114984661844', '1233988028173743', 9, 9, 'Banning Dental & Skin Clinique', '643263762798951', '💳 0% Finance Available – Start Today!', 'One photo is all it takes to make you rethink your smile. If you find yourself cropping, deleting, or avoiding photos altogether, we can help.

Our Invisalign packages include
✅ Smile simulation so you can preview your results
✅ Retainers and whitening when you finish
✅ Flexible finance options
✅ Lowest prices for Invisalign in the UK

Start your journey to a photo-ready smile today. Book your consultation now', 'Learn more', 'LEARN_MORE', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent-sof1-2.xx.fbcdn.net/v/t39.35426-6/503590582_2879737892205791_5718411392566003699_n.jpg?_nc_cat=111&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=vK7JdqdZI0EQ7kNvwGMsQF5&_nc_oc=Adqy672DYusg_kl1oU6HxWKb7nyVJkTDA__afBsV008N02TRS2kq4ux6vS_VlRXhw4o&_nc_zt=14&_nc_ht=scontent-sof1-2.xx&_nc_gid=hK0wnCh4-ZnHGpaVllPxrQ&_nc_ss=7f180&oh=00_AQFm8mV2EBqgLH2HzqIZUMF7h_lOJWmI78YPE2z5DDMtJw&oe=6A8E17DC', NULL, '2025-06-06T07:00:00.000Z'::timestamptz, NULL, true, 441, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1233988028173743', 100),
  ('uk-dental', 'clear-aligners', 'c:2030705461019739', '2030705461019739', '1150572320084612', 6, 11, 'Banning Dental & Skin Clinique', '643263762798951', 'LOWEST PRICE INVISALIGN IN THE UK!', 'Embarrassed by crooked teeth? 😬 It’s time to smile confidently!

At Banning Dental Group, we can help you get the straight, confident smile you deserve with Invisalign, the clear alternative to braces.

Here’s why Croydon patients are loving us:
🌟 Top 1% of Invisalign providers in Europe
🌟 Exclusive Opening Offer – Invisalign from just £2,600!
🌟 FREE Consultation + 3D Scan & X-Rays worth £180
🌟 FREE Professional Whitening, Retainers & Tooth Shaping
🌟 Prices from only £31.13 p/m – the lowest in the UK, guaranteed

Click ‘Learn More’ to book your FREE consultation today. Offer available only at Banning Dental Croydon for a limited time!', 'Learn more', 'LEARN_MORE', 'http://fb.me/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/582624881_1144818594531674_4324125878743943920_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=qQvBPoXL-Y0Q7kNvwH9m5Yo&_nc_oc=AdrrGAR5ZcSGLQlFhgmiTDSNAbD_juAW7AWDrNVc-Z595SMUZ7l3f9Viq5Hde_yKiyY&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=PA2gte5kvTy-Dg0xpQjxoA&_nc_ss=7f180&oh=00_AQFwPjmwr7tj8dh8doqkZ8P1YaB_SzdzLgIBpYH0E36cTA&oe=6A8DFD3B', NULL, '2025-11-14T08:00:00.000Z'::timestamptz, NULL, true, 280, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1150572320084612', 100),
  ('uk-dental', 'clear-aligners', 'c:1039948854388910', '1039948854388910', '1037055698567489', 6, 6, 'Banning Dental & Skin Clinique', '643263762798951', '💳 0% Finance Available – Start Today!', 'One photo is all it takes to make you rethink your smile. If you find yourself cropping, deleting, or avoiding photos altogether, we can help.

Our Invisalign packages include
✅ Smile simulation so you can preview your results
✅ Retainers and whitening when you finish
✅ Flexible finance options
✅ Lowest prices for Invisalign in the UK

Start your journey to a photo-ready smile today. Book your consultation now', 'Learn more', 'LEARN_MORE', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent-sof1-2.xx.fbcdn.net/v/t39.35426-6/504727340_1244517110740374_1300339087136518641_n.jpg?_nc_cat=107&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=qWZcl84ImtkQ7kNvwHK9OXo&_nc_oc=AdqL1HJpK4i4bU3JnUK7v_oCdK52z9lIIYRA5NVIf_WIRnIHeGwKQlJHbrZH0K_hc9I&_nc_zt=14&_nc_ht=scontent-sof1-2.xx&_nc_gid=IVzjPPczyU1mJBWz9Z0h8w&_nc_ss=7f180&oh=00_AQEfTeInWjvSzoSqSs9V--kZQZsSF_Hl6iqRwU9evxg_hQ&oe=6A8E1A69', NULL, '2025-06-06T07:00:00.000Z'::timestamptz, NULL, true, 441, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1037055698567489', 91),
  ('uk-dental', 'dental-implants', 'c:1031452991073853', '1031452991073853', '281760617483676', 4, 4, 'Royal Arsenal Dentists', '1450538395198279', 'Dental Implants', 'Dental implants have given us the opportunity to replace missing or lost teeth with a fixed, comfortable and aesthetically pleasing alternative. Dental implant therapy is considered now to be the gold standard for replacing missing teeth. ✨

Royal Arsenal Dentists brings together a top team of dentists, hygienists, and dental nursing and care staff. We have a very caring and gentle approach, with particular emphasis on making nervous patients feel at ease. 

At Royal Arsenal Dentists, we offer a free dental implants consultation to asses your dental treatment needs and create a personalised plan. We have a number of options available; more details can be found on our website. 🦷

Call 0208 317 0590 to book your free consultation or book online:
https://www.royalarsenaldentists.com/dental-implants-treatments', 'Book now', 'BOOK_TRAVEL', 'https://www.royalarsenaldentists.com/dental-implants-treatments', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/292594320_826246251677870_4652702465836073572_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=bTiZueh2CcQQ7kNvwGzyy6o&_nc_oc=AdojcIPzmV3H44Vh8dpFPGukSULLKw9roq3L-fqZ_aBvOMe1Ab8PwvQ3qZK_AFMc7dY&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=o6FehIrb9Ran89Jgowx_hg&_nc_ss=7f180&oh=00_AQGfjFa9_SIBNw4XNXElFSjUWNgiHCKeTHGSw0WlvYtA8w&oe=6A8DFC76', NULL, '2022-07-11T07:00:00.000Z'::timestamptz, NULL, true, 1502, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=281760617483676', 83),
  ('uk-dental', 'dental-implants', 'c:328147269607094', '328147269607094', '756097579681609', 4, 4, 'Nanodent Centre Turkey', '106646571910687', 'Perfect smile is a click away!', 'Never feel any pain during your dental treatment with General Anesthesia! We are a fully-fledged dental hospital.

Get your dream smile and perfect your oral health with Original Straumann Group Implants and German Quality Nanodent Exclusive Pro White®️ Zirconium Crowns on holiday comfort.

12 x Straumann Group Dental Implants ✅
24 x Nanodent Exclusive Pro White®️ Zirconium Crowns (German Quality) ✅
Fixed/Stable Temporary Teeth ✅
General Anesthesia ✅
3Shape 3D Digital Smile Design Technology ✅
Free VIP Transfer with Nanotransfer ✅
Sea-view Hotel Accommodation ✅
Two Round Trip Flights Reimbursement ✅

2D-3D Tomography, Local Anesthesia, no Additional Costs
No Agencies, no Brokers, Direct contact with our Dental Hospital

#smilemore #smilemakeover #dentalimplant #dentalcrown #dentalholiday #dentist #dentistry #dentalcare #dentalhealth', 'Get offer', 'GET_OFFER', 'http://fb.me/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent.flim33-1.fna.fbcdn.net/v/t39.35426-6/367707933_330590666252564_6285924490162266189_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&_nc_map=urlgen_bucketless&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=rFdjb3hFJesQ7kNvwGBd_1c&_nc_oc=AdobtLsYKecbvCI_P0QhlDjubH4_vwfOZOPMDpEPoYBZfwnEM2LV2dzxf4wRkEEwCRU&_nc_zt=14&_nc_ht=scontent.flim33-1.fna&_nc_gid=LwJ-qvxpFRcM9_D3tcwiNA&_nc_ss=7f180&oh=00_AQE6O3Q3wzb9MkWci6zwMCtWVbE6p8Rn413fHH8U14U0-w&oe=6A8DFE37', NULL, '2023-11-18T08:00:00.000Z'::timestamptz, NULL, true, 1007, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=756097579681609', 83),
  ('uk-dental', 'dental-implants', 'c:1118248999659536', '1118248999659536', '1803674983708982', 4, 4, 'Dental Ays Turkey', '108146671536677', 'Discover DentalAYS', 'Save up to 70% on world-class dental care with Straumann implants! 💰 Why pay more in UK when you can experience the strength and precision of the most trusted Swiss implants in Antalya? 🌴 With unbeatable prices, VIP service, and a luxurious getaway, it’s the perfect blend of quality and value. Don’t compromise on your smile—choose Straumann & DentalAYS, choose excellence. Book your consultation today!', 'Send message', 'MESSAGE_PAGE', NULL, 'IMAGE', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/469372788_1094401785230400_6785605760641098331_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=111&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=WuN_SqcjVyAQ7kNvwHDLo26&_nc_oc=AdqjWiO_VPGKuKMfxuH5sbqs5mVLpnYA4ysqnH_lTP-DwurO05Qx4GsIOATBD9YPzXc&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=bjY4F9J14x_zITSG4CZ_vg&_nc_ss=7f180&oh=00_AQEneFW5R8yzYxvmfmJOe4upLtjMw_fjdE35abp4DTwIfA&oe=6A8E25C3', NULL, '2024-12-06T08:00:00.000Z'::timestamptz, NULL, true, 623, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1803674983708982', 83),
  ('uk-dental', 'dental-implants', 'c:2876203212536129', '2876203212536129', '1124269665890375', 4, 4, 'Dental Ays Turkey', '108146671536677', 'Discover DentalAYS', 'Save up to 70% on world-class dental care with Straumann implants! 💰 Why pay more in UK when you can experience the strength and precision of the most trusted Swiss implants in Antalya? 🌴 With unbeatable prices, VIP service, and a luxurious getaway, it’s the perfect blend of quality and value. Don’t compromise on your smile—choose Straumann & DentalAYS, choose excellence. Book your consultation today!', 'Send message', 'MESSAGE_PAGE', NULL, 'IMAGE', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/469331587_934979401396591_4912421266865478901_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=qvsvg9IntDAQ7kNvwG_SoEG&_nc_oc=Adri7L1db7nYwsdyoJTDJeAPdSGEQEjGCbRkDVlmoYLz5u73FlKEFXK4QN-cR3Q436M&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=fDgAA783JccIq6044aTvAw&_nc_ss=7f180&oh=00_AQFHfzYyxzTayv9q5y4Lvw32jgDRk53YvyugNhdPIUOBJw&oe=6A8E197E', NULL, '2024-12-06T08:00:00.000Z'::timestamptz, NULL, true, 623, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1124269665890375', 83),
  ('uk-dental', 'general-dentistry', 'c:3579257362373408', '3579257362373408', '1254261732459319', 4, 4, 'Dental Ays Turkey', '108146671536677', 'Discover DentalAYS', 'Your dream smile is closer than you think! 🌟 Don’t just imagine it—take the first step towards your perfect smile with DentalAYS.

💰 Save up to 70% compared to UK prices
🚖 VIP Transfer & Hotel Included

Join the countless happy patients who’ve transformed their smiles in Antalya with our expert care and premium technology. Ready to see what’s possible? Book your consultation today and let us take care of the rest!', 'Send message', 'MESSAGE_PAGE', NULL, 'IMAGE', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/469039361_535962946082354_6529293040206668381_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=1uL5bC5CQ-0Q7kNvwHv5Uuj&_nc_oc=Adq8zg_L7N4SqA1ySP0lvmbG_rnwKl0-Jrzmkmpbg__z2L7qLY812qceb33SLvXAwFs&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=POplFPsvB-eKwGHK2yA0pg&_nc_ss=7f180&oh=00_AQE18zFghNXIi9Z1EydypU6NzYr5WUcUNuF9Ew2CmrHUdw&oe=6A8DFCD7', NULL, '2024-12-06T08:00:00.000Z'::timestamptz, NULL, true, 623, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1254261732459319', 83),
  ('uk-dental', 'dental-implants', 'c:1120466009002748', '1120466009002748', '575248485342375', 4, 4, 'Dental Ays Turkey', '108146671536677', NULL, 'Good things take time—and so does creating the perfect smile! Don’t settle for clinics that rush through your treatment or fail to give you the attention you deserve. At DentalAYS, we take the time to listen, plan, and deliver personalized care with precision.

Whether it’s Straumann implants or veneers, we believe your smile deserves patience and expertise every step of the way. Ready for a dental experience where YOU come first? Book your consultation today and let us show you the difference.', 'Send message', 'INSTAGRAM_MESSAGE', 'https://www.instagram.com/', 'IMAGE', '["INSTAGRAM"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/472192251_1267453077860350_2505558237367441860_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=104&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=4kEl0G7Xx04Q7kNvwHuQPMZ&_nc_oc=Ado_wHrqj0N_J561OcqSKMG8p7hnSEj07jp1sDdMmI8i6FijDlgIMsfQ61cexkMKRJ8&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=o6FehIrb9Ran89Jgowx_hg&_nc_ss=7f180&oh=00_AQF6sgYP7ydB9Y5mEFTSCxunPe5aMofh841WiFRclyKb2Q&oe=6A8E13C9', NULL, '2025-01-22T08:00:00.000Z'::timestamptz, NULL, true, 576, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=575248485342375', 83),
  ('uk-dental', 'veneers', 'c:4723667874399740', '4723667874399740', '771584695300645', 2, 4, 'St Vincent Smile', '170928266609810', 'Composite Bonding', 'Did you hear about composite bonding, but not sure if this treatment is for you? We''re here to help! 🌟

Composite bonding is a modern and minimally invasive technique. It involves placing a white resin material on your teeth which is then sculpted carefully to transform the shape, height, size and colour of your teeth to aesthetically transform the appearance of your teeth.

Since there is no drilling of natural tooth or tooth loss involved composite bonding is generally considered a pain free procedure, and is minimally invasive to the biology of your natural teeth.

• Minimally invasive
• No Need for an Anaesthetic
• Long-lasting Results

At St Vincent Smile, you can expect the highest standards of dental care with a warm and friendly welcome.

Our Composite Bonding packages include:

✨ Free Consultation
✨ Digital Smile Design
✨ Dental Hygiene
✨ Teeth Whitening
✨ Composite Bonding on 4, 6, 8 or 10 Teeth
✨ Night-Time Splint

For more information, call us on 0141 248 1183 or visit our website.
https://www.stvincentsmile.co.uk/composite-bonding-smile-makeover', 'Book now', 'BOOK_TRAVEL', 'https://www.stvincentsmile.co.uk/composite-bonding-smile-makeover', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-waw2-1.xx.fbcdn.net/v/t39.35426-6/519489341_1095570389138794_1996659854228268157_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=109&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=ku5MtS7kWgIQ7kNvwHG-QcA&_nc_oc=AdpEz2K6U0Ew450NZfg5KiDmD4AyHf8l9U8-bD8XpBru0fBuOizXu5nYaVqceQXUXAM&_nc_zt=14&_nc_ht=scontent-waw2-1.xx&_nc_gid=nRUk7PO33FQscFZnhYDpNQ&_nc_ss=7f289&oh=00_AQFTglD467vQdwn23akL1FtT60GPAeGtRnwLJwst5i9VKQ&oe=6A8E1F9F', NULL, '2025-07-22T07:00:00.000Z'::timestamptz, NULL, true, 395, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=771584695300645', 83),
  ('uk-dental', 'general-dentistry', 'c:800229865915215', '800229865915215', '1106094571502774', 1, 4, 'Regency House Dental Clinic', '1527628354177434', NULL, 'It’s not just about smiles in the chair, it starts at reception 💙

📍 St Albans | Cosmetic & General Dentistry', NULL, NULL, NULL, 'VIDEO', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-ord5-2.xx.fbcdn.net/v/t39.35426-6/545584104_2177387209339075_1609552393233491618_n.jpg?_nc_cat=104&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=A3C9IHs_ECMQ7kNvwGlwgxL&_nc_oc=AdpQQGHUEOd5_MMfouzrkBpPMuQT1hhBnEFEiR7p8F6kwJc1JwuVo7ioy4vtuEdiMsIwWkioI64hT9omNy4dQywB&_nc_zt=14&_nc_ht=scontent-ord5-2.xx&_nc_gid=_ReUjV2n1lyqFj7gl0jf3A&_nc_ss=7f180&oh=00_AQFow50NtO2YhJmSEMkBh0i2Qzo9nXvDgxJLIvhUlX6cog&oe=6A8E1037', NULL, '2025-09-17T07:00:00.000Z'::timestamptz, NULL, true, 338, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1106094571502774', 83),
  ('uk-dental', 'clear-aligners', 'c:1305066227466974', '1305066227466974', '1711068122908491', 2, 4, 'Wathen Road Dental Practice', '384235181624624', 'FREE Invisalign Consultation', 'Your Smile Deserves Expert Care (Without the London Price Tag)

You''ve been thinking about it for a while. Straighter teeth. More confidence in meetings, photos, everyday moments.

At Wathen Road Dental, we''re making it surprisingly straightforward for Dorking residents to invest in their smile with Invisalign - the discreet alternative to traditional braces.

What Makes Us Different:
↳ Expert consultation with 3D preview - see your transformation before you commit
↳ From £1,870 - genuinely Surrey''s most competitive pricing
↳ Complete package included - professional whitening + retainers (no hidden extras)
↳ Flexible payment options 

Trusted local practice. Proven results. Zero pressure.

Ready to transform your smile?

📆 Start with a FREE Consultation 
Step 1: Click the ''Book Now’'' button below
Step 2: Fill out the short form
Step 3: Book your free consultation

📍 Wathen Road Dental, 3-4 Wathen Rd, Dorking RH4 1JU', 'Book now', 'BOOK_TRAVEL', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent-sof1-2.xx.fbcdn.net/v/t39.35426-6/556594273_607721182424541_5516375079791982475_n.jpg?_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=63UEbukohR4Q7kNvwHt5b4T&_nc_oc=Adpqtxp2O8kRTXL18keAtZJNCWp_8UxLBmWP-e2eDKuNxU8TplbgDBKnM9zWPZCEYls&_nc_zt=14&_nc_ht=scontent-sof1-2.xx&_nc_gid=BVK37C0aSdnAQZB-UBcs5A&_nc_ss=7f180&oh=00_AQE3M98Fo1-44NAjHnoMtbmvVUV27Xw-c0ccjdEGX90WGg&oe=6A8DF457', NULL, '2025-10-05T07:00:00.000Z'::timestamptz, NULL, true, 320, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1711068122908491', 83),
  ('uk-dental', 'clear-aligners', 'c:1512046986651031', '1512046986651031', '1718022282734431', 2, 4, 'Banning Dental & Skin Clinique', '643263762798951', 'LOWEST PRICE INVISALIGN IN THE UK!', 'Embarrassed by crooked teeth? 😬 it''s time to smile confidently! 

At Banning Dental, we can help you get the straight, confident smile you deserve with Invisalign - the clear alternative to braces.

Here’s why you should choose us:

🌟 Top 1% of Invisalign providers in Europe.

🌟 Prices start at just £31.13 p/m, guaranteed to be the lowest in the UK.

🌟 Free professional whitening, retainers, and tooth shaping included.

Click ‘Learn More’ to book your free consultation now!', 'Learn more', 'LEARN_MORE', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent.fvno1-1.fna.fbcdn.net/v/t39.35426-6/564601847_1729532848435667_8425549463854637645_n.jpg?_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=V462GwAV2w8Q7kNvwEbS4ol&_nc_oc=AdokhPJOQvpVpxKlvcFQVIt1A9b7er011z_A91Jg85ihQqF0o7ISuARhOY5QUpHRNGk&_nc_zt=14&_nc_ht=scontent.fvno1-1.fna&_nc_gid=XTchfmfwDGIbQZ4t34ma4A&_nc_ss=7f289&oh=00_AQFuYQhwYdeZf8InuJvzuMx5h3CUXejq1hL7B3SIODPjCQ&oe=6A8E1211', NULL, '2025-10-14T07:00:00.000Z'::timestamptz, NULL, true, 311, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1718022282734431', 83),
  ('uk-dental', 'clear-aligners', 'p:272013949326067|b:hi cheshire! 👋 ready for your smile makeover? 🦷 get the smile of your dreams in a day at cthe dentist ✅ award-winning dentists ✅ completed 100s of smiles makeovers ✅ invisalign, whitening, bonding, ', NULL, '1245516267392766', NULL, 4, 'C The Dentist', '272013949326067', 'FREE Consultation', 'Hi Cheshire! 👋 

Ready for your smile makeover? 🦷

Get the smile of your dreams in a day at CThe Dentist

✅ Award-winning dentists
✅ Completed 100s of smiles makeovers
✅ Invisalign, whitening, bonding, veneers

Book your consultation today!

Click ‘Book Now’ below to get started.😊', 'Book now', 'BOOK_TRAVEL', 'https://get-started.yourdentaloffers.com/cthedentist/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-ord5-2.xx.fbcdn.net/v/t39.35426-6/612906988_1417798010000251_105490956650783958_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_aid=0&_nc_ohc=iGe5C9DYM_gQ7kNvwFo0rR0&_nc_oc=AdoVy6eyp_WxpMqAlRtHszqMRSryhuCbkWMND6_wHOjXxxXJ4W4xPxTwajC483QbYpKsM3DZD8tFb3ttidAVsbCK&_nc_zt=14&_nc_ht=scontent-ord5-2.xx&_nc_gid=_ReUjV2n1lyqFj7gl0jf3A&_nc_ss=7f180&oh=00_AQFRO_pUPzD7hsY3wJTaU_m6afYXrz6klklod99CkvfR-Q&oe=6A8E0C31', NULL, '2026-01-08T08:00:00.000Z'::timestamptz, NULL, true, 225, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1245516267392766', 83),
  ('uk-dental', 'dental-implants', 'c:644504969899813', '644504969899813', '3283609665194116', 1, 3, 'Cosmetic Dentist Kusadasi', '114838159875599', 'Dentist Kusadasi | Cosmetic Dentistry Dental Implants Veneers | Dentist Turkey', 'Dental Implants at Dentist Kusadasi are one of the most prefered dental treatments. Dentist Kusadasi surgeons and dentists are qualified professionals and performing hunderts of dental implant surgeries every year. We use Straumann, Zinedent, Nobel Biocare, Astra and Nucleus implants in our clinic.', 'Learn more', 'LEARN_MORE', 'http://www.dentistkusadasi.com/', 'IMAGE', '["FACEBOOK","INSTAGRAM","MESSENGER"]'::jsonb, 'https://scontent-waw2-2.xx.fbcdn.net/v/t39.35426-6/319944532_3351365948436304_8247517344491071165_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=I1yVQinVWXIQ7kNvwE-zJKa&_nc_oc=AdoHCj8F7cT7Wu-v1V632tjCnhC-YeH-VNe_aQ07yzDKylMJ9eZDkvj2A0uVH8BzsC8&_nc_zt=14&_nc_ht=scontent-waw2-2.xx&_nc_gid=nRUk7PO33FQscFZnhYDpNQ&_nc_ss=7f289&oh=00_AQFFXA3eF_Lv_v2CHcceiTP1ZA-sKNtO8Gda40dE0IcACw&oe=6A8DFB87', NULL, '2022-12-21T08:00:00.000Z'::timestamptz, NULL, true, 1339, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=3283609665194116', 79),
  ('uk-dental', 'dental-implants', 'c:1270506003582921', '1270506003582921', '128569620279601', 1, 3, 'Peninsula Dentists', '617135872060564', 'General Dentistry', 'Welcome to your local family-friendly dental clinic! Featuring state-of-the-art equipment, Peninsula Dentists brings together an experienced team of dentists, hygienists, and dental nurses. Our modern and calm environment is inviting and relaxing, and your comfort is paramount to us.

🦷 General Dentistry
✨ Dental Examination
✨ Gum Disease
✨ Dental Hygiene
✨ Root Canal Therapy
✨ White Fillings
✨ Extractions

🦷 Cosmetic Dentistry
✨ Invisalign
✨ Dental Implants
✨ Teeth Whitening
✨ Dental Veneers
✨ Dental Crowns
✨ Dental Bridges
✨ Smile Makeover

Call 0208 788 6688 to discuss your treatment and book an appointment. You can also request a booking online anytime: https://www.peninsuladentists.co.uk/contact-us', 'Book now', 'BOOK_TRAVEL', 'https://www.peninsuladentists.co.uk/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/361087273_702917498259500_1568091677568103297_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=vYhw5R8h3iwQ7kNvwEsVJVo&_nc_oc=AdpkJ04UtRSIMWFR8tLIJKOFqEX0kxv0gVNReQxwDB1N2sioJC1sraXqG_vkVn0CMsY&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=azVy6weAfI_-mmNvKAVc8w&_nc_ss=7f180&oh=00_AQFwD63waZJH1K_D3vGPBW8DoLiGKXgVauMsMkxyQrkh4w&oe=6A8E2533', NULL, '2023-07-14T07:00:00.000Z'::timestamptz, NULL, true, 1134, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=128569620279601', 79),
  ('uk-dental', 'dental-implants', 'c:1286248448660256', '1286248448660256', '2507830476051041', 1, 3, 'Peninsula Dentists', '617135872060564', 'General Dentistry', 'Welcome to your local family-friendly dental clinic! Featuring state-of-the-art equipment, Peninsula Dentists brings together an experienced team of dentists, hygienists, and dental nurses. Our modern and calm environment is inviting and relaxing, and your comfort is paramount to us.

🦷 General Dentistry
✨ Dental Examination
✨ Gum Disease
✨ Dental Hygiene
✨ Root Canal Therapy
✨ White Fillings
✨ Extractions

🦷 Cosmetic Dentistry
✨ Invisalign
✨ Dental Implants
✨ Teeth Whitening
✨ Dental Veneers
✨ Dental Crowns
✨ Dental Bridges
✨ Smile Makeover

Call 0208 788 6688 to discuss your treatment and book an appointment. You can also request a booking online anytime: https://www.peninsuladentists.co.uk/contact-us', 'Book now', 'BOOK_TRAVEL', 'https://www.peninsuladentists.co.uk/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/361094307_658306256198988_1835936943844967694_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=G5iyrXdmMq0Q7kNvwFmAkt-&_nc_oc=AdrO4gy2TxqDq3tHO5H5OpzciyyQTgGiU5-bfFnaflm_f7yRBC8MaPmWjjc3QGckXEo&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=PA2gte5kvTy-Dg0xpQjxoA&_nc_ss=7f180&oh=00_AQEZisHELDxZ-ha0QRFqZy6GxrU0vtyXlin2Lo5HEn_Dyw&oe=6A8DF32D', NULL, '2023-07-14T07:00:00.000Z'::timestamptz, NULL, true, 1134, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=2507830476051041', 79),
  ('uk-dental', 'dental-implants', 'c:1865229817205768', '1865229817205768', '794582528775336', 1, 3, 'Peninsula Dentists', '617135872060564', 'General Dentistry', 'Welcome to your local family-friendly dental clinic! Featuring state-of-the-art equipment, Peninsula Dentists brings together an experienced team of dentists, hygienists, and dental nurses. Our modern and calm environment is inviting and relaxing, and your comfort is paramount to us.

🦷 General Dentistry
✨ Dental Examination
✨ Gum Disease
✨ Dental Hygiene
✨ Root Canal Therapy
✨ White Fillings
✨ Extractions

🦷 Cosmetic Dentistry
✨ Invisalign
✨ Dental Implants
✨ Teeth Whitening
✨ Dental Veneers
✨ Dental Crowns
✨ Dental Bridges
✨ Smile Makeover

Call 0208 788 6688 to discuss your treatment and book an appointment. You can also request a booking online anytime: https://www.peninsuladentists.co.uk/contact-us', 'Book now', 'BOOK_TRAVEL', 'https://www.peninsuladentists.co.uk/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/359337049_1282671149303057_5978012910523313928_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=9CYoURKT5QAQ7kNvwEN0SgC&_nc_oc=Adq-bCqD-sGX61sPi-2roEJ_snXiBRk3p5Bx9_92yK7QFwHXxPDuSk5qoCpzxyQNlKc&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=i-HC0sAL5Ka8OwpRPHolog&_nc_ss=7f180&oh=00_AQH6GEOldBwnw47DceOPlFb8vsSA-XnApHlUBW7OeJUW0Q&oe=6A8E042B', NULL, '2023-07-14T07:00:00.000Z'::timestamptz, NULL, true, 1134, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=794582528775336', 79),
  ('uk-dental', 'dental-implants', 'c:601771522099196', '601771522099196', '287918740387624', 1, 3, 'Peninsula Dentists', '617135872060564', 'General Dentistry', 'Welcome to your local family-friendly dental clinic! Featuring state-of-the-art equipment, Peninsula Dentists brings together an experienced team of dentists, hygienists, and dental nurses. Our modern and calm environment is inviting and relaxing, and your comfort is paramount to us.

🦷 General Dentistry
✨ Dental Examination
✨ Gum Disease
✨ Dental Hygiene
✨ Root Canal Therapy
✨ White Fillings
✨ Extractions

🦷 Cosmetic Dentistry
✨ Invisalign
✨ Dental Implants
✨ Teeth Whitening
✨ Dental Veneers
✨ Dental Crowns
✨ Dental Bridges
✨ Smile Makeover

Call 0208 788 6688 to discuss your treatment and book an appointment. You can also request a booking online anytime: https://www.peninsuladentists.co.uk/contact-us', 'Book now', 'BOOK_TRAVEL', 'https://www.peninsuladentists.co.uk/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/361087652_1227316381320193_6275647894327696014_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=111&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=by4AT8q7uvwQ7kNvwGk-hld&_nc_oc=Adop2QXBmDVzvSZm_3o4_BZ78y5P-KuUy3ohDan0-i8paB1TM-HB6KnlKkOBflWdn1g&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=azVy6weAfI_-mmNvKAVc8w&_nc_ss=7f180&oh=00_AQGO6CAH5xvXzGbzMF96jcj5M_AggUWG7kdmZyPGhXGMwQ&oe=6A8E208D', NULL, '2023-07-14T07:00:00.000Z'::timestamptz, NULL, true, 1134, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=287918740387624', 79),
  ('uk-dental', 'dental-implants', 'c:665706028742554', '665706028742554', '840805887470241', 1, 3, 'Peninsula Dentists', '617135872060564', 'General Dentistry', 'Welcome to your local family-friendly dental clinic! Featuring state-of-the-art equipment, Peninsula Dentists brings together an experienced team of dentists, hygienists, and dental nurses. Our modern and calm environment is inviting and relaxing, and your comfort is paramount to us.

🦷 General Dentistry
✨ Dental Examination
✨ Gum Disease
✨ Dental Hygiene
✨ Root Canal Therapy
✨ White Fillings
✨ Extractions

🦷 Cosmetic Dentistry
✨ Invisalign
✨ Dental Implants
✨ Teeth Whitening
✨ Dental Veneers
✨ Dental Crowns
✨ Dental Bridges
✨ Smile Makeover

Call 0208 788 6688 to discuss your treatment and book an appointment. You can also request a booking online anytime: https://www.peninsuladentists.co.uk/contact-us', 'Book now', 'BOOK_TRAVEL', 'https://www.peninsuladentists.co.uk/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/359732300_1422857181838347_823387348779914710_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=i_WX9p-R6ToQ7kNvwFQFUgg&_nc_oc=AdoF3bCGgn-f8diZn2if9HC98FAkSESXG5asb1nIoBvlucR8KNRkpLdDdqVCN14aJmc&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=2W9Iy1hHaIWncynlg4vNtA&_nc_ss=7f180&oh=00_AQG3BZQp0vo3A9PBajCym027OkLMtjQoTpa0XnAh599rnQ&oe=6A8E1BA1', NULL, '2023-07-14T07:00:00.000Z'::timestamptz, NULL, true, 1134, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=840805887470241', 79),
  ('uk-dental', 'dental-implants', 'c:958805275329640', '958805275329640', '1696289274167277', 1, 3, 'Peninsula Dentists', '617135872060564', 'General Dentistry', 'Welcome to your local family-friendly dental clinic! Featuring state-of-the-art equipment, Peninsula Dentists brings together an experienced team of dentists, hygienists, and dental nurses. Our modern and calm environment is inviting and relaxing, and your comfort is paramount to us.

🦷 General Dentistry
✨ Dental Examination
✨ Gum Disease
✨ Dental Hygiene
✨ Root Canal Therapy
✨ White Fillings
✨ Extractions

🦷 Cosmetic Dentistry
✨ Invisalign
✨ Dental Implants
✨ Teeth Whitening
✨ Dental Veneers
✨ Dental Crowns
✨ Dental Bridges
✨ Smile Makeover

Call 0208 788 6688 to discuss your treatment and book an appointment. You can also request a booking online anytime: https://www.peninsuladentists.co.uk/contact-us', 'Book now', 'BOOK_TRAVEL', 'https://www.peninsuladentists.co.uk/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/359370859_282695457678696_4355660657788393966_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=9zw6bD2rJeMQ7kNvwGBU0ha&_nc_oc=Adr8qJXoA8LYGdqU1Pu9Rsq9T0CvZ7JquM-KIclRsFp6XQAuknge5_7o8hLBMfxvP-o&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=azVy6weAfI_-mmNvKAVc8w&_nc_ss=7f180&oh=00_AQHh4I9FS4JJ0CC02tAfubW6ew4QuQMe22TfcWMB-x7YhQ&oe=6A8DFFCC', NULL, '2023-07-14T07:00:00.000Z'::timestamptz, NULL, true, 1134, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1696289274167277', 79),
  ('uk-dental', 'clear-aligners', 'c:1201389298345438', '1201389298345438', '627286443642591', 3, 3, 'Clearly Orthodontics', '1584399498463009', 'Book Your FREE Consultation!', '🦷 𝐓𝐫𝐚𝐧𝐬𝐟𝐨𝐫𝐦 𝐘𝐨𝐮𝐫 𝐒𝐦𝐢𝐥𝐞 𝐰𝐢𝐭𝐡 𝐋𝐞𝐢𝐜𝐞𝐬𝐭𝐞𝐫’𝐬 𝐋𝐞𝐚𝐝𝐢𝐧𝐠 𝐎𝐫𝐭𝐡𝐨𝐝𝐨𝐧𝐭𝐢𝐜 𝐒𝐩𝐞𝐜𝐢𝐚𝐥𝐢𝐬𝐭𝐬! 😁

Looking for a confident, straighter smile? Clearly Orthodontics offers expert care with the latest in teeth-straightening technology – including Invisalign® and Angel Aligners.

👩‍⚕️✨ Led by experienced specialists Dr. Maha Aljefri and Dr. Shamalia Javaid, we tailor every treatment to suit your unique smile goals.

📍 𝐋𝐨𝐜𝐚𝐭𝐞𝐝 𝐚𝐭 𝐓𝐡𝐞 𝐎𝐥𝐝 𝐂𝐨𝐚𝐜𝐡 𝐇𝐨𝐮𝐬𝐞, 𝟏𝐀 𝐌𝐚𝐢𝐧 𝐒𝐭𝐫𝐞𝐞𝐭, 𝐇𝐮𝐦𝐛𝐞𝐫𝐬𝐭𝐨𝐧𝐞, 𝐋𝐞𝐢𝐜𝐞𝐬𝐭𝐞𝐫, 𝐋𝐄𝟓 𝟏𝐀𝐄 – we’re your local, trusted smile experts.

𝐖𝐡𝐲 𝐂𝐡𝐨𝐨𝐬𝐞 𝐂𝐥𝐞𝐚𝐫𝐥𝐲 𝐎𝐫𝐭𝐡𝐨𝐝𝐨𝐧𝐭𝐢𝐜𝐬?
🌟 Diamond Invisalign® Providers
💸 Interest-Free Payment Plans
🖥️ State-of-the-Art Digital Scanning (No messy impressions!)
📲 Remote Monitoring = Fewer Appointments
🌙 Evening Appointments Available
🅿️ Free On-Site Parking

👉 𝐁𝐨𝐨𝐤 𝐘𝐨𝐮𝐫 𝐅𝐑𝐄𝐄 𝐂𝐨𝐧𝐬𝐮𝐥𝐭𝐚𝐭𝐢𝐨𝐧 𝐓𝐨𝐝𝐚𝐲!

📩 𝐅𝐢𝐥𝐥 𝐢𝐧 𝐲𝐨𝐮𝐫 𝐝𝐞𝐭𝐚𝐢𝐥𝐬 𝐚𝐜𝐜𝐮𝐫𝐚𝐭𝐞𝐥𝐲 𝐬𝐨 𝐨𝐮𝐫 𝐟𝐫𝐢𝐞𝐧𝐝𝐥𝐲 𝐭𝐞𝐚𝐦 𝐜𝐚𝐧 𝐠𝐞𝐭 𝐢𝐧 𝐭𝐨𝐮𝐜𝐡 𝐭𝐨 𝐛𝐨𝐨𝐤 𝐲𝐨𝐮𝐫 𝐜𝐨𝐧𝐬𝐮𝐥𝐭𝐚𝐭𝐢𝐨𝐧.

✅ All information is kept strictly confidential.', 'Book now', 'BOOK_TRAVEL', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/491923690_539731805599051_7655633350179744314_n.jpg?_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=94dxpvJu6E4Q7kNvwHT4UJn&_nc_oc=AdpWhfPfYQB4gqlGDzR1qZ-rZvo4mFwtpJqCCGcLX3kFt72BedTobAsxulZmepw4ujU&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=6VGLjxSB6gdO38wcT0Fiyw&_nc_ss=7f180&oh=00_AQF8ERZMfxyBwK_wxsuAD_AIZxxSkaoS-vAojkwlAQMuNQ&oe=6A8DF40E', NULL, '2025-04-23T07:00:00.000Z'::timestamptz, NULL, true, 485, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=627286443642591', 79),
  ('uk-dental', 'clear-aligners', 'c:586867177803298', '586867177803298', '1462044808434490', 1, 3, 'Banning Dental & Skin Clinique', '643263762798951', 'LOWEST PRICE INVISALIGN IN THE UK?! 😲', 'Embarrassed by crooked teeth? 😬 LEWISHAM, it''s time to smile confidently!

At Banning Dental, we can help you get the straight, confident smile you deserve with Invisalign - the clear alternative to braces.

Here’s why you should choose us:

🌟 Top 1% of Invisalign providers in Europe.

🌟 Prices start at just £31.13 p/m, guaranteed to be the lowest in the UK.

🌟 Free professional whitening, retainers, and tooth shaping included.

Click ‘Learn More’ to book your free consultation now!', 'Learn more', 'LEARN_MORE', 'https://secure.banningdental.co.uk/lewisham-invisalign?utm_source=lewishambanning340inv&fbclid=fbclid', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER","THREADS"]'::jsonb, 'https://scontent-ord5-2.xx.fbcdn.net/v/t39.35426-6/544800991_2497791883922882_7181754147673784052_n.jpg?_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=lo9nVvoGkB8Q7kNvwH_LL1h&_nc_oc=AdogkJC_-EaZWVXqZdfDLFhoN0JjAGQeTRvWHjFr4tfJFrnpI8lXPwcBY-3pNKLGNCa6FspY2SvWT50XYvWe_foy&_nc_zt=14&_nc_ht=scontent-ord5-2.xx&_nc_gid=bqrKwzISSyPIaD2isShBAw&_nc_ss=7f180&oh=00_AQHelByw1I9hR9PyFQjQeF2fBNXqKpNdZA2eDQeyM_CcQg&oe=6A8DF8FC', NULL, '2025-09-08T07:00:00.000Z'::timestamptz, NULL, true, 347, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1462044808434490', 79),
  ('uk-dental', 'clear-aligners', 'c:1322385306594563', '1322385306594563', '2737205829966598', 1, 3, 'One80 Dental', '1420957834803877', 'Book Your Specialist Consultation Today', 'Hey Sheffield and surrounding areas! 👋

Ready for your smile makeover? 🦷

Get the smile of your dreams in a day at One80 Dental – Sheffield’s specialist dental practice.

✅ Specialist dentists with advanced expertise
✅ Hundreds of smile makeovers completed
✅ Invisalign, whitening, bonding, veneers

Book your consultation today!

Click ‘Book Now’ below to get started 😊', 'Book now', 'BOOK_TRAVEL', 'https://get-started.yourdentaloffers.com/one80dental-paid/', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER","THREADS"]'::jsonb, 'https://scontent-waw2-2.xx.fbcdn.net/v/t39.35426-6/597040419_1381911756668302_7058206989811955424_n.jpg?_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=xTMN0MuZgFIQ7kNvwGSOI69&_nc_oc=AdqfQy3JJYpAJNHf-Acm2LLwFGSjU67rCstSA9jGQNGv3J0099MhFYQ-RJB92lyo7Jk&_nc_zt=14&_nc_ht=scontent-waw2-2.xx&_nc_gid=nRUk7PO33FQscFZnhYDpNQ&_nc_ss=7f289&oh=00_AQEGTznWKaadXKDjV0ehhi-9fsiXkph7UFDfa8yzYPvkYw&oe=6A8DF7A4', NULL, '2025-12-10T08:00:00.000Z'::timestamptz, NULL, true, 254, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=2737205829966598', 79),
  ('uk-dental', 'veneers', 'c:1484528913389673', '1484528913389673', '1228448739446923', 3, 5, 'İstanbul Diş Akademisi', '244817447458901', NULL, 'Fix Your Smile in Just One Day ✨

Transform your smile with Composite Bonding at Istanbul Diş Akademisi.

🦷 Only £80 per tooth
✔ No shaving of natural teeth
✔ Same day treatment
✔ Whitening & cleaning included

🏨 Hotel & VIP transfer included
⭐ 1000+ Google reviews
📍 Istanbul, Turkey

Send us a message to learn more.', 'Get offer', 'GET_OFFER', 'http://fb.me/', 'IMAGE', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-ord5-2.xx.fbcdn.net/v/t39.35426-6/650222612_1570081534549587_5736573041440346357_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=aUYq0fzSDHgQ7kNvwGLP-aY&_nc_oc=AdoHkLBSbUJ-pOfij6dEdytKf9GkWgdLQty_lhMe3pkW00o_MygBgWNAJ7PwZJvrFJkCuBM19HjPRFouXmJPec8s&_nc_zt=14&_nc_ht=scontent-ord5-2.xx&_nc_gid=bqrKwzISSyPIaD2isShBAw&_nc_ss=7f180&oh=00_AQFzd0GWM2q1iv2bMZylQLfsm5YvkUSQAVzupWoQiuh3uQ&oe=6A8E0146', NULL, '2026-03-14T07:00:00.000Z'::timestamptz, NULL, true, 160, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1228448739446923', 79),
  ('uk-dental', 'teeth-whitening', 'c:1501844930154642', '1501844930154642', '1049073316399864', 1, 2, 'Royal Arsenal Dentists', '1450538395198279', 'Free Consultation + Teeth Whitening (worth £299)', 'Say hello to invisible braces from £37.70/month! 👋

We have a fantastic offer for our new patients consisting of a free consultation where you can see a before/after 3D simulation of your teeth and a free whitening kit worth £299 with every invisible braces treatment. Something you will 💕!', 'Book now', 'BOOK_TRAVEL', 'https://www.royalarsenaldentists.com/invisalign', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/176405932_461325205077955_8230074159118475544_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=gDsNbzI3G9UQ7kNvwFelqQE&_nc_oc=AdoHPffqdSt3AqJPdfLj-k145ojY9UPs-pJRiVb5aKeo6c94j4iJob964UDFuP4h4jo&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=PA2gte5kvTy-Dg0xpQjxoA&_nc_ss=7f180&oh=00_AQEX6EtLk0CB-brK1PcLam32qXvkmRSEptjtZm7V4Qd09w&oe=6A8E0E98', NULL, '2023-11-30T08:00:00.000Z'::timestamptz, NULL, true, 995, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1049073316399864', 74),
  ('uk-dental', 'dental-implants', 'c:281291448199188', '281291448199188', '1075737486791451', 2, 2, 'Peninsula Dentists', '617135872060564', 'Dental Implants', 'Dental implants have given us the opportunity to replace missing or lost teeth with a fixed, comfortable and aesthetically pleasing alternative. Dental implant therapy is considered now to be the gold standard for replacing missing teeth. ✨

Peninsula Dentists is an independent private dental practice offering exceptionally high standards of dental care. We are conveniently located in the heart of Greenwich Peninsula, one of London’s most exciting districts, minutes walk from the O2 Arena.

At Peninsula Dentists, we offer a free dental implants consultation to asses your dental treatment needs and create a personalised plan. We have a number of options available; more details can be found on our website. 🦷

Call 0208 788 6688 to book your free consultation or book online:
https://www.peninsuladentists.co.uk/dental-implants', 'Book now', 'BOOK_TRAVEL', 'https://www.peninsuladentists.co.uk/dental-implants', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/291336216_407244204798374_4475959400916001594_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=8p-KJxArC8sQ7kNvwEulyAw&_nc_oc=AdqZrNK533NRcMUZdIPA1Qc2jFv231-p5UUzxMUu9QtGah_XVUDmINmmN2d-BsLWsro&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=fgTYs7_KneFmqAv-gAG-9A&_nc_ss=7f180&oh=00_AQEtboldzHqBslaBtclaK29FF5lQq7czIqcpO6rkP_bEkQ&oe=6A8E0F57', NULL, '2023-11-30T08:00:00.000Z'::timestamptz, NULL, true, 995, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1075737486791451', 74),
  ('uk-dental', 'teeth-whitening', 'c:888286485318706', '888286485318706', '867650511758200', 1, 2, 'Royal Arsenal Dentists', '1450538395198279', 'Free Consultation + Teeth Whitening (worth £299)', 'Say hello to clear braces from £37.70/month! 👋

We have a fantastic offer for our new patients consisting of a free consultation where you can see a before/after 3D simulation of your teeth and a free whitening kit worth £299 with every clear braces treatment. Something you will 💕!', 'Book now', 'BOOK_TRAVEL', 'https://www.royalarsenaldentists.com/invisalign', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-sof1-2.xx.fbcdn.net/v/t39.35426-6/124398123_426732425394741_4545706993988337516_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=cx28S8AvaVUQ7kNvwHCBdrR&_nc_oc=Adp1VJYg3Xka5tO594c1oiAjzPPdux9Ij1SEWwFFGJ1YJJV7oDvSswFXrl8Iu-bRqIo&_nc_zt=14&_nc_ht=scontent-sof1-2.xx&_nc_gid=BVK37C0aSdnAQZB-UBcs5A&_nc_ss=7f180&oh=00_AQFBQI0qE0oZgpVjgFoKAko72FmcebrKcOv58rZoCGsHng&oe=6A8E0F0B', NULL, '2023-11-30T08:00:00.000Z'::timestamptz, NULL, true, 995, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=867650511758200', 74),
  ('uk-dental', 'teeth-whitening', 'c:480738767753550', '480738767753550', '1571250713806160', 2, 2, 'HeySmile', '104772415344087', 'As seen in The Sun 🗞️', 'If pearly whites are on your wishlist over the summer season, there is one teeth whitening brand that should be on your radar.

"HeySmile has emerged as a frontrunner for affordable and convenient at-home teeth-brightening solutions, with over 10,000 five-star reviews online from happy customers."', 'Shop now', 'SHOP_NOW', 'https://heysmileteeth.com/products/whitening-strips', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/448446530_1473499343272732_7285638869177174684_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=104&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=2XZSIIwUzDAQ7kNvwEqcUOg&_nc_oc=Adp2aEeeoLiniV0vBZcSAptFDxt7TBidPwPZ4RrLEVWYCq9_EK3eLmLo3pR9iatZRLE&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=pfEsMvs55dZrS8kPttQ5gA&_nc_ss=7f180&oh=00_AQG9PbSTSr32RNm4k-ib3MErFloBCThI64EGuxkD-QPNLA&oe=6A8E20F0', NULL, '2024-08-17T07:00:00.000Z'::timestamptz, NULL, true, 734, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1571250713806160', 74),
  ('uk-dental', 'clear-aligners', 'c:1057584949045011', '1057584949045011', '933593128783945', 1, 2, 'The Dental Suite', '371737239562142', 'Enjoy a Free Invisalign® Consultation + £900 Off!', 'Hey Canary Wharf & surrounding areas 👋 We’re looking to help 30 patients with our FREE Invisalign® Consultation  + £900 worth of benefits!✨ Our Latest Technology in Cosmetic dentistry is here to help you get the perfect smile with the least amount of time and discomfort!

✅ Free Invisalign® Consultation & Teeth Scan (Save £100)
✅ Free Teeth Whitening (Save £400)
✅ Free Vivera Retainers (Save £400)
✅ Straightens Teeth with No Diet Restrictions
✅ Lowest Price In London with NO Compromises

TAP "Book Now" below to secure a spot and schedule a FREE & No-Obligation Invisalign® Consultation with our specialist! ⏳Act Now! Limited spots available!', 'Book now', 'BOOK_TRAVEL', 'http://fb.me/', 'IMAGE', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-sof1-2.xx.fbcdn.net/v/t39.35426-6/458381603_413723151538147_7747070438714344335_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=0YTPfeWqgd8Q7kNvwGxtXB1&_nc_oc=AdqtoLSPZGyOVkHzm8_HvF71nqbaYEgZgAYusZRiwgRBDSEJD307Tk4HrphheGZ5dKc&_nc_zt=14&_nc_ht=scontent-sof1-2.xx&_nc_gid=BVK37C0aSdnAQZB-UBcs5A&_nc_ss=7f180&oh=00_AQE6QS1Ww9_Pg9-tBzl6rmgWgRgkEThLUaDSEzTjaUGI6Q&oe=6A8E21B3', NULL, '2024-09-05T07:00:00.000Z'::timestamptz, NULL, true, 715, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=933593128783945', 74),
  ('uk-dental', 'dental-implants', 'c:1692958562104391', '1692958562104391', '2035585590210979', 2, 2, 'Dental Ays Turkey', '108146671536677', 'Discover DentalAYS', 'Good things take time—and so does creating the perfect smile! Don’t settle for clinics that rush through your treatment or fail to give you the attention you deserve. At DentalAYS, we take the time to listen, plan, and deliver personalized care with precision.

Whether it’s Straumann implants or veneers, we believe your smile deserves patience and expertise every step of the way. Ready for a dental experience where YOU come first? Book your consultation today and let us show you the difference.', 'Send message', 'MESSAGE_PAGE', NULL, 'IMAGE', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/469289432_1262678395159490_5594970562821097206_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=107&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=2AOIgq_EifgQ7kNvwFCc4LH&_nc_oc=AdqGjeavcrsxN7YpPo1HotgziRnXVISRjwTYM15LhpqCiIERKCwIJxorFAvwTYsFsN8&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=fDgAA783JccIq6044aTvAw&_nc_ss=7f180&oh=00_AQFOvGJxFIh-B3TovZP8ZfNU2P_ecWG6DpCK5lpmQDtbFw&oe=6A8E1AF1', NULL, '2024-12-06T08:00:00.000Z'::timestamptz, NULL, true, 623, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=2035585590210979', 74),
  ('uk-dental', 'clear-aligners', 'c:3968007630081474', '3968007630081474', '605923795559443', 1, 2, 'Banning Dental & Skin Clinique', '643263762798951', 'LOWEST PRICE INVISALIGN IN THE UK?! 😲', 'Embarrassed by crooked teeth? 😬 Blackfriars, it''s time to smile confidently!

At Banning Dental, we can help you get the straight, confident smile you deserve with Invisalign - the clear alternative to braces.

Here’s why you should choose us:

🌟 Top 1% of Invisalign providers in Europe.

🌟 Prices start at just £31.13 p/m, guaranteed to be the lowest in the UK.

🌟 Free professional whitening, retainers, and tooth shaping included.

Click ‘Learn More’ to book your free consultation now!', 'Learn more', 'LEARN_MORE', 'https://secure.banningdental.co.uk/blackfriars-invisalign?utm_source=banningwblack80&fbclid=fbclid', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/481079622_1265371228380169_6526116818929377352_n.jpg?_nc_cat=111&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=4UGkFSGNyJ4Q7kNvwH9HiQ7&_nc_oc=Adre8RN1ZqJ9wAb9qPksFBcsNoNqNbxk7G99beHtKqYL8wBwFMroKfrcSwDBo06vxpo&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=ufZs90oZ_OOWa-E5wgQH_Q&_nc_ss=7f180&oh=00_AQGuBjpVd-H_ViYWKA4aqki9DpN-Zd_mRK_06f4DtTxV5g&oe=6A8E124D', NULL, '2025-03-03T08:00:00.000Z'::timestamptz, NULL, true, 536, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=605923795559443', 74),
  ('uk-dental', 'clear-aligners', 'c:649445317567358', '649445317567358', '667342818981646', 1, 2, 'Banning Dental & Skin Clinique', '643263762798951', 'LOWEST PRICE INVISALIGN IN THE UK?! 😲', 'Embarrassed by crooked teeth? 😬 Brentford, it''s time to smile confidently!

At Banning Dental, we can help you get the straight, confident smile you deserve with Invisalign - the clear alternative to braces.

Here’s why you should choose us:

🌟 Top 1% of Invisalign providers in Europe.

🌟 Prices start at just £31.13 p/m, guaranteed to be the lowest in the UK.

🌟 Free professional whitening, retainers, and tooth shaping included.

Click ‘Learn More’ to book your free consultation now!', 'Learn more', 'LEARN_MORE', 'https://secure.banningdental.co.uk/brentford-invisalign?utm_source=banningBrent82&fbclid=fbclid', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/481464117_2064400720706223_1568399150266042692_n.jpg?_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=5kZiaHTX9NkQ7kNvwG1g_-8&_nc_oc=Adp14zZKknbpakMK6VJSyVWQhmrZg566hg0w6E2Tv42MBGhSNBhOwiWTvZIDL7wuyUU&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=bi_8hr5uZuTtyIO7fc2k-A&_nc_ss=7f180&oh=00_AQGt53SoGrahdAlmG84lOlFNeXW4alc8fVnNqfXAzy-2sQ&oe=6A8E157F', NULL, '2025-03-04T08:00:00.000Z'::timestamptz, NULL, true, 535, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=667342818981646', 74),
  ('uk-dental', 'clear-aligners', 'c:955460446711119', '955460446711119', '938543298443014', 1, 2, 'Banning Dental & Skin Clinique', '643263762798951', 'LOWEST PRICE INVISALIGN IN THE UK?! 😲', 'Embarrassed by crooked teeth? 😬 Chiswick, it''s time to smile confidently!

At Banning Dental, we can help you get the straight, confident smile you deserve with Invisalign - the clear alternative to braces.

Here’s why you should choose us:

🌟 Top 1% of Invisalign providers in Europe.

🌟 Prices start at just £31.13 p/m, guaranteed to be the lowest in the UK.

🌟 Free professional whitening, retainers, and tooth shaping included.

Click ‘Learn More’ to book your free consultation now!', 'Learn more', 'LEARN_MORE', 'https://secure.banningdental.co.uk/chiswick-invisalign?utm_source=banningchis84', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/481467353_892613162842972_975271905422817268_n.jpg?_nc_cat=107&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=ocXiMmfcERcQ7kNvwEyVlim&_nc_oc=AdqeTS7oj1zbFuRUAXW8I_kLSfuX1-WfRlq7lg9VroyAHOMEmIT6EJZqrn4l7SHhO0o&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=MVZKq31O5uMqGGSVLdhHnw&_nc_ss=7f180&oh=00_AQH3g-ubVox4_Gby1cw7YFeUjPklmtoTvtPDVRKFhUMkZw&oe=6A8DF3BA', NULL, '2025-03-04T08:00:00.000Z'::timestamptz, NULL, true, 535, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=938543298443014', 74),
  ('uk-dental', 'dental-implants', 'c:2181223245609316', '2181223245609316', '1188478092667455', 2, 2, 'A and L Clinics Dental Practice', '1013877018648521', '🦷 Smile with Confidence Again 🦷', '📍 Do you live in Ipswich?
🦷 Ready for a Smile Makeover?

Our Dental Implants at A&L Clinics give you the Freedom of Fixed, Natural-Looking Teeth.  

Implant-retained dentures snap onto implants, offering better stability and comfort than traditional dentures.  

With Dr. Andrius Pocius, a dentist with 40 years of expertise, you''re in the best hands for a lasting smile.  

📍 9 Lower Brook Street, Ipswich, IP4 1AG  
☎️ 01473 287762 
📅  Book Your Consultation Today 👉 https://aandldentistclinic.com/dental-implants', 'Book now', 'BOOK_TRAVEL', 'https://aandldentistclinic.com/dental-implants?utm_source=meta&utm_medium={{placement}}&utm_campaign={{campaign.name}}', 'VIDEO', '["FACEBOOK","INSTAGRAM","MESSENGER"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/474527396_1289999595555712_6345912553837508897_n.jpg?_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=qZ5B9JCfaiUQ7kNvwETWU72&_nc_oc=Adr83kUkiTpTEk_Casmln_ksSmSI86a5zKQbxJ2N-HLxJlwGJ587WNF_d8c5y0yElLo&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=2Xvb3BMT26XOM1tSMC08iw&_nc_ss=7f180&oh=00_AQG0IB-Yks_dXCcHcfBCOys5GesY2r09daaP_tvzMTz9qw&oe=6A8E0294', NULL, '2025-03-16T07:00:00.000Z'::timestamptz, NULL, true, 523, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1188478092667455', 74),
  ('uk-dental', 'clear-aligners', 'c:1080035817276015', '1080035817276015', '1683507742285819', 1, 2, 'Birmingham Dental Excellence', '127969330405882', '🎁 FREE Clear Aligner Consultation - Save £1717!', 'Hey Birmingham! 👋 We''re thrilled to announce our biggest Clear Aligner offer yet! With amazing offers worth £1,717 in discounts & goodies! 🎉

Our clinic offers a range of straightening choices for patients, including Invisalign & Angel Clear Aligners, to suit a wide range of budgets and lifestyles.

Experience the comfort, clarity, and convenience of Clear Aligners - the revolutionary treatment that can transform your smile without interrupting your daily routine...

Don''t miss out on receiving a FREE Consultation and a 3D Smile Simulation scan (valued at £175). See firsthand how Clear Aligners can give you a brand new 😁!

But wait, there''s more! When you sign up for treatment, you''ll enjoy incredible perks throughout your treatment journey: ​

​✅ £500 OFF Clear Aligner Treatment
✅ FREE Teeth Whitening (Worth £468)
​✅ FREE Removable Retainers (Worth £500)
✅ FREE Hygiene (Worth £79)
✅ FREE Dental Examination (Worth £50)
✅ Free Tooth Contouring Worth £120

That''s a grand total of £1717 in savings! 😍

Click the ''Sign Up'' button below to secure your spot. Hurry, as spaces are limited!

*Please note this is only a provisional booking for a team member to call you and arrange a time slot for the event.', 'Sign up', 'SIGN_UP', 'https://sbwhdu2.typeform.com/to/mKUNCmVS', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/499551111_1419929352335654_689393998499218446_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=sieOPnCSLVsQ7kNvwGiuChu&_nc_oc=Ado-Waivb7PgGf9I58JYZMb6UkrXYJsqmUcYKQqBTS1Mgsf6UkclgCxlPDniiWKdqWA&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=pfEsMvs55dZrS8kPttQ5gA&_nc_ss=7f180&oh=00_AQEXyzpRzhwzhYe06I-Za9bbPDk3Rp_dM1v7kuHEP8iKLg&oe=6A8E11F9', NULL, '2025-05-23T07:00:00.000Z'::timestamptz, NULL, true, 455, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1683507742285819', 74),
  ('uk-dental', 'checkup', 'c:567984429520743', '567984429520743', '1257650565934688', 2, 2, 'Camden High Street Dental Practice', '240982842614454', '🤯 £35 Dental Exam: Limited Slots Available!', '🦷 £35 Dental Examination in Camden

🎉 Experience World Class Dental Care at Camden High Street Dental Practice.

We’re offering an exclusive £35 dental examination for a limited time only, 9 more slots left, anyone can Join us!

Why Choose Us?

✅ London''s Leading Clinic
✅ State of the Art Centre of Excellence
✅ Accredited by GDC, BDA, CQC, and FCA Regulated
✅ World-Class Dental Surgeons
✅ Over 20 Awards and Accreditations
✅ Over 300+ 5 Star Reviews

Experience world-class dental care without breaking the bank! 🐖💰

Hurry only 9 more spots are left! 🔥

📅 Act quickly to schedule your £35 dental examination.  Book your appointment now!', 'Book now', 'BOOK_TRAVEL', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/489998542_1102844025219474_7086436208691453972_n.jpg?_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=ZImHn03bkt8Q7kNvwHceK4Q&_nc_oc=AdrUzkG3-UU7k6UUNLz6f-cBU66uEdmZ_AD5fbgtaPaxwKElHfqpSmxEkgLyDnwvBqg&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=IVzjPPczyU1mJBWz9Z0h8w&_nc_ss=7f180&oh=00_AQFaFxxO6VBf0vXZWCH9sK5eSkGjoyQolNqFPaWI2WO37Q&oe=6A8E025F', NULL, '2025-06-02T07:00:00.000Z'::timestamptz, NULL, true, 445, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1257650565934688', 74),
  ('uk-dental', 'clear-aligners', 'c:1218944399891385', '1218944399891385', '1934251950749861', 1, 2, 'Crendon Dental Centre', '566172066883002', '✅ FREE Invisalign® Consultation', 'Hey Wycombe!👋 We are offering FREE Invisalign® Consultations with HUGE discounts and goodies!

Sign up below for a FREE Invisalign® Consultation and a FREE before and after Smile Scan to see what your new 😁 could look like with Invisalign® before you have even committed! 

If you decide to go ahead with treatment on the day, you''ll also get:

✅ FREE Teeth Whitening 
✅ FREE Retainers

There has never been a better time to fix your smile - Our biggest discount and freebies yet!

Click ''Sign Up'' below to book a spot. Hurry as places are limited!', 'Sign up', 'SIGN_UP', 'http://fb.me/', 'IMAGE', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/506001706_623814910017073_6414875294753903117_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=pbLO6JTmbY0Q7kNvwGWEOqj&_nc_oc=AdriqmUnp4m4r-hh33RFKJ1TOKGa4QpxGGyIe-IkaXkCCl5s72mAxsODzaIL0zQA3YU&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=2jS0fc42M86dYapP7s1V5Q&_nc_ss=7f180&oh=00_AQEsU9wivvei8sbaw20EvuYAX8uLD5AHovOIxKE3XimpaQ&oe=6A8E008D', NULL, '2025-06-12T07:00:00.000Z'::timestamptz, NULL, true, 435, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1934251950749861', 74),
  ('uk-dental', 'clear-aligners', 'c:24088060927479136', '24088060927479136', '1988813361651476', 1, 2, 'Banning Dental & Skin Clinique', '643263762798951', 'LOWEST PRICE INVISALIGN IN THE UK?! 😲', 'Embarrassed by crooked teeth? 😬 CRAWLEY, it''s time to smile confidently!

At Banning Dental, we can help you get the straight, confident smile you deserve with Invisalign - the clear alternative to braces.

Here’s why you should choose us:

🌟 Top 1% of Invisalign providers in Europe.

🌟 Prices start at just £31.13 p/m, guaranteed to be the lowest in the UK.

🌟 Free professional whitening, retainers, and tooth shaping included.

Click ‘Learn More’ to book your free consultation now!', 'Learn more', 'LEARN_MORE', 'https://secure.banningdental.co.uk/crawley-invisalign?utm_source=banningcraw334inv&fbclid=fbclid', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent.fvno1-1.fna.fbcdn.net/v/t39.35426-6/516825563_748845377609555_1917679989242528593_n.jpg?_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=ifdVXzaw6q8Q7kNvwEvkXZe&_nc_oc=Adr1hkLXjFiLhbSztj8_DC7gQrt-pzrFHs3EeW56_b6q0Nvc1NDL6qDTP_5fSEKplJ4&_nc_zt=14&_nc_ht=scontent.fvno1-1.fna&_nc_gid=XTchfmfwDGIbQZ4t34ma4A&_nc_ss=7f289&oh=00_AQGWZ5CuwOT3vLsbDhunERN3CXGZKm_QZ89oxjoW0xbH_Q&oe=6A8DFBAB', NULL, '2025-07-08T07:00:00.000Z'::timestamptz, NULL, true, 409, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1988813361651476', 74),
  ('uk-dental', 'veneers', 'c:1406833986410132', '1406833986410132', '1668221687164831', 1, 2, 'St Vincent Smile', '170928266609810', 'St Vincent Smile', 'Did you hear about composite bonding, but not sure if this treatment is for you? We''re here to help! 🌟

Composite bonding is a modern and minimally invasive technique. It involves placing a white resin material on your teeth which is then sculpted carefully to transform the shape, height, size and colour of your teeth to aesthetically transform the appearance of your teeth.

Since there is no drilling of natural tooth or tooth loss involved composite bonding is generally considered a pain free procedure, and is minimally invasive to the biology of your natural teeth.

• Minimally invasive
• No Need for an Anaesthetic
• Long-lasting Results

At St Vincent Smile, you can expect the highest standards of dental care with a warm and friendly welcome.

Our Composite Bonding packages include:

✨ Free Consultation
✨ Digital Smile Design
✨ Dental Hygiene
✨ Teeth Whitening
✨ Composite Bonding on 4, 6, 8 or 10 Teeth
✨ Night-Time Splint

For more information, call us on 0141 248 1183 or visit our website.
https://www.stvincentsmile.co.uk/composite-bonding-smile-makeover', 'Learn more', 'LEARN_MORE', 'https://www.stvincentsmile.co.uk/composite-bonding-smile-makeover', 'CAROUSEL', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent-ord5-1.xx.fbcdn.net/v/t39.35426-6/520294200_1268241228421022_1165026927473568891_n.jpg?stp=dst-jpg_s60x60_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=P6ZDmuWW_EAQ7kNvwFZ5DQ1&_nc_oc=Adpohji52083J4Dig0R6yZKGo0GSkI-JmUIhc4m86pAdxTxPx1x4HkbFfu5YTlEjUU8YrvCzl0BKUBWmsr--ssEg&_nc_zt=14&_nc_ht=scontent-ord5-1.xx&_nc_gid=bqrKwzISSyPIaD2isShBAw&_nc_ss=7f180&oh=00_AQH3mrRXCxyQ_TTPtXBG9IRGPRHwMIv48dbsFon8Nl7eNQ&oe=6A8DF6B0', NULL, '2025-07-22T07:00:00.000Z'::timestamptz, NULL, true, 395, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1668221687164831', 74),
  ('uk-dental', 'veneers', 'c:454131206579424', '454131206579424', '24206863282271101', 2, 2, 'St Vincent Smile', '170928266609810', 'Composite Bonding', 'Did you hear about composite bonding, but not sure if this treatment is for you? We''re here to help! 🌟

Composite bonding is a modern and minimally invasive technique. It involves placing a white resin material on your teeth which is then sculpted carefully to transform the shape, height, size and colour of your teeth to aesthetically transform the appearance of your teeth.

Since there is no drilling of natural tooth or tooth loss involved composite bonding is generally considered a pain free procedure, and is minimally invasive to the biology of your natural teeth.

• Minimally invasive
• No Need for an Anaesthetic
• Long-lasting Results

At St Vincent Smile, you can expect the highest standards of dental care with a warm and friendly welcome.

Our Composite Bonding packages include:

✨ Free Consultation
✨ Digital Smile Design
✨ Dental Hygiene
✨ Teeth Whitening
✨ Composite Bonding on 4, 6, 8 or 10 Teeth
✨ Night-Time Splint

For more information, call us on 0141 248 1183 or visit our website.
https://www.stvincentsmile.co.uk/composite-bonding-smile-makeover', 'Book now', 'BOOK_TRAVEL', 'https://www.stvincentsmile.co.uk/composite-bonding-smile-makeover', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-waw2-2.xx.fbcdn.net/v/t39.35426-6/520493715_755085956896700_8640213563595295433_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=QP6GZfMV76YQ7kNvwHg8wka&_nc_oc=AdoUJNE45xWWY2kEh92SYxwljMlWqeaC5CJpUWuy7FefWkEmXB1hTNcfRWoF2oe_79w&_nc_zt=14&_nc_ht=scontent-waw2-2.xx&_nc_gid=nRUk7PO33FQscFZnhYDpNQ&_nc_ss=7f289&oh=00_AQH8R187qggevZJlWQ0cu8lytws_4ADmADYVT06QVuWtUA&oe=6A8E1986', NULL, '2025-07-22T07:00:00.000Z'::timestamptz, NULL, true, 395, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=24206863282271101', 74),
  ('uk-dental', 'veneers', 'c:5013683498736469', '5013683498736469', '1550135519288545', 2, 2, 'St Vincent Smile', '170928266609810', 'Composite Bonding', 'Did you hear about composite bonding, but not sure if this treatment is for you? We''re here to help! 🌟

Composite bonding is a modern and minimally invasive technique. It involves placing a white resin material on your teeth which is then sculpted carefully to transform the shape, height, size and colour of your teeth to aesthetically transform the appearance of your teeth.

Since there is no drilling of natural tooth or tooth loss involved composite bonding is generally considered a pain free procedure, and is minimally invasive to the biology of your natural teeth.

• Minimally invasive
• No Need for an Anaesthetic
• Long-lasting Results

At St Vincent Smile, you can expect the highest standards of dental care with a warm and friendly welcome.

Our Composite Bonding packages include:

✨ Free Consultation
✨ Digital Smile Design
✨ Dental Hygiene
✨ Teeth Whitening
✨ Composite Bonding on 4, 6, 8 or 10 Teeth
✨ Night-Time Splint

For more information, call us on 0141 248 1183 or visit our website.
https://www.stvincentsmile.co.uk/composite-bonding-smile-makeover', 'Book now', 'BOOK_TRAVEL', 'https://www.stvincentsmile.co.uk/composite-bonding-smile-makeover', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-ord5-2.xx.fbcdn.net/v/t39.35426-6/521292917_1061023799489198_8515683298943106500_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=a8Jq4GwjR7cQ7kNvwGKtjZA&_nc_oc=AdqPmZ3C4zLnEa6c1LptfmmtaQNLKv6X0_cREkSGHuAFglkRJBn5u-R9_xj0C29fKkvqNu3OjO9No3KlUHDMWkxM&_nc_zt=14&_nc_ht=scontent-ord5-2.xx&_nc_gid=cYlHpVB0lkgKb8IZ9-zslQ&_nc_ss=7f180&oh=00_AQGhnney1FP9o11KqJ1269JAXP6QqimkHXGi10YePHrQDA&oe=6A8E242E', NULL, '2025-07-22T07:00:00.000Z'::timestamptz, NULL, true, 395, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1550135519288545', 74),
  ('uk-dental', 'veneers', 'c:738996074100038', '738996074100038', '1423413522228613', 2, 2, 'St Vincent Smile', '170928266609810', 'Composite Bonding', 'Did you hear about composite bonding, but not sure if this treatment is for you? We''re here to help! 🌟

Composite bonding is a modern and minimally invasive technique. It involves placing a white resin material on your teeth which is then sculpted carefully to transform the shape, height, size and colour of your teeth to aesthetically transform the appearance of your teeth.

Since there is no drilling of natural tooth or tooth loss involved composite bonding is generally considered a pain free procedure, and is minimally invasive to the biology of your natural teeth.

• Minimally invasive
• No Need for an Anaesthetic
• Long-lasting Results

At St Vincent Smile, you can expect the highest standards of dental care with a warm and friendly welcome.

Our Composite Bonding packages include:

✨ Free Consultation
✨ Digital Smile Design
✨ Dental Hygiene
✨ Teeth Whitening
✨ Composite Bonding on 4, 6, 8 or 10 Teeth
✨ Night-Time Splint

For more information, call us on 0141 248 1183 or visit our website.
https://www.stvincentsmile.co.uk/composite-bonding-smile-makeover', 'Book now', 'BOOK_TRAVEL', 'https://www.stvincentsmile.co.uk/composite-bonding-smile-makeover', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-ord5-2.xx.fbcdn.net/v/t39.35426-6/522888268_1028120579489485_2497590327337014115_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=107&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=V3xdLHng3NMQ7kNvwHGTbhe&_nc_oc=Ado0R8_Q41XJE9P9nqDJhB6pWw56AEt21tS4heP60RcGfCtqQGzocicIF8TDQj-NlC4V-8X_a5wI90Cc0dwj_gJp&_nc_zt=14&_nc_ht=scontent-ord5-2.xx&_nc_gid=cYlHpVB0lkgKb8IZ9-zslQ&_nc_ss=7f180&oh=00_AQELEB1wFeZ2x2vikvoE_Q3i-1x1ImI5P9j3FmTVGrTYDQ&oe=6A8E045F', NULL, '2025-07-22T07:00:00.000Z'::timestamptz, NULL, true, 395, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1423413522228613', 74),
  ('uk-dental', 'veneers', 'c:1057512538228154', '1057512538228154', '24270916229209538', 2, 2, 'St Vincent Smile', '170928266609810', 'Composite Bonding', 'Did you hear about composite bonding, but not sure if this treatment is for you? We''re here to help! 🌟

Composite bonding is a modern and minimally invasive technique. It involves placing a white resin material on your teeth which is then sculpted carefully to transform the shape, height, size and colour of your teeth to aesthetically transform the appearance of your teeth.

Since there is no drilling of natural tooth or tooth loss involved composite bonding is generally considered a pain free procedure, and is minimally invasive to the biology of your natural teeth.

• Minimally invasive
• No Need for an Anaesthetic
• Long-lasting Results

At St Vincent Smile, you can expect the highest standards of dental care with a warm and friendly welcome.

Our Composite Bonding packages include:

✨ Free Consultation
✨ Digital Smile Design
✨ Dental Hygiene
✨ Teeth Whitening
✨ Composite Bonding on 4, 6, 8 or 10 Teeth
✨ Night-Time Splint

For more information, call us on 0141 248 1183 or visit our website.
https://www.stvincentsmile.co.uk/composite-bonding-smile-makeover', 'Book now', 'BOOK_TRAVEL', 'https://www.stvincentsmile.co.uk/composite-bonding-smile-makeover', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-ord5-2.xx.fbcdn.net/v/t39.35426-6/523625517_778850027898833_4301378273602103899_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=FlK7rtatCmQQ7kNvwEnmcxo&_nc_oc=Adp4Z_rC9BF4fgC1zLpRE0k9oG2awWrJ4Dbd-9blLxg0vbUsONbycT0EdG_KvI-n68_E6xHI83R_JOl2bPD0mioK&_nc_zt=14&_nc_ht=scontent-ord5-2.xx&_nc_gid=cYlHpVB0lkgKb8IZ9-zslQ&_nc_ss=7f180&oh=00_AQH9AcTOp5i_Nuv3e2LkFITi4pE8TZua-OcjuMbq3h2fgw&oe=6A8E061B', NULL, '2025-07-24T07:00:00.000Z'::timestamptz, NULL, true, 393, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=24270916229209538', 74),
  ('uk-dental', 'clear-aligners', 'c:1078193653849165', '1078193653849165', '1394962368461811', 1, 2, 'Crendon Dental Centre', '566172066883002', '✅ FREE Invisalign® Consultation', 'Hey Wycombe!👋 We are offering FREE Invisalign® Consultations with HUGE discounts and goodies!

Sign up below for a FREE Invisalign® Consultation and a FREE before and after Smile Scan to see what your new 😁 could look like with Invisalign® before you have even committed! 

If you decide to go ahead with treatment on the day, you''ll also get:

✅ FREE Teeth Whitening 
✅ FREE Retainers

There has never been a better time to fix your smile - Our biggest discount and freebies yet!

Click ''Sign Up'' below to book a spot. Hurry as places are limited!', 'Sign up', 'SIGN_UP', 'http://fb.me/', 'IMAGE', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/525196302_1447604896361596_8924520988904394306_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=QthDGS7F-PcQ7kNvwGDvHtJ&_nc_oc=Adr9QTzUiT3IZDvZ5AemCH-qhdXLPOx0aEgOO8GAUNQwTsVywWVyCbI0PmZOME2A8-0&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=wf0aSC3W7Vn_Zt_YvdUdWQ&_nc_ss=7f180&oh=00_AQFMLKM4jn3oBm-ZeCD71bUiwLvIicINUdC8XT-2lL78lQ&oe=6A8DFAFF', NULL, '2025-07-28T07:00:00.000Z'::timestamptz, NULL, true, 389, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1394962368461811', 74),
  ('uk-dental', 'dental-implants', 'c:776432251561949', '776432251561949', '1694891357878443', 1, 2, 'Precision Implant Clinic', '246793988523762', 'Top-Rated Clinic - Hygiene Appointments Filling Fast.', 'Avoid costly dental problems before they start.
Our direct access hygiene treatments help protect your teeth, gums, and implants — without needing a dentist referral.

Our expert deep cleans remove hardened plaque and tartar that brushing alone can’t reach — preventing gum disease, bad breath, and expensive long-term damage.

✅ Trusted by patients across NI & ROI
📍 Banbridge clinic | Easy parking

Book your hygiene appointment today.', 'Learn more', 'LEARN_MORE', NULL, 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","THREADS"]'::jsonb, 'https://scontent.fgye13-1.fna.fbcdn.net/v/t39.35426-6/529304730_1162675285623213_2281361075361455710_n.jpg?_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=GIySSy1tmfoQ7kNvwGffp9J&_nc_oc=AdovhBGb6VxPHJDPVA1iJoHxDPJvF51j5pUrGmZUr-qygaaxj6s7-HkCXha4WP7TC08&_nc_zt=14&_nc_ht=scontent.fgye13-1.fna&_nc_gid=emrR_i901VgHVlFhkTB0Hw&_nc_ss=7f180&oh=00_AQElO1H9cj747yQAVP_DvjRiRQasKPai5ICRsO2VnZPC6w&oe=6A8E02E0', NULL, '2025-08-07T07:00:00.000Z'::timestamptz, NULL, true, 379, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1694891357878443', 74),
  ('uk-dental', 'dental-implants', 'c:2290090168090229', '2290090168090229', '1366851311728453', 1, 2, 'GalgormDental', '468942209921405', 'Register Today', 'We''re Growing to Serve You Better! 🦷

We''re delighted to be expanding our dental clinic with the addition of 2 brand-new surgeries and welcoming yet another highly experienced dentist to our wonderful team

Our highly experienced team of gentle dentists provide a wide range of dental services including:

✅ Family dentistry
✅ Dental repairs
✅ Smile makeovers
✅ Dental implants
✅ Invisalign Teeth Straightening

We are also excellent at looking after patients who are scared of the dentist 😱

Register today — we only have a limited number of new patient slots available.', 'Get in touch', 'GET_IN_TOUCH', 'http://fb.me/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent-sof1-2.xx.fbcdn.net/v/t39.35426-6/529938751_1064822662504518_7906875577275010449_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=MF97IuFcmA0Q7kNvwGwmpYS&_nc_oc=AdqOLhXZ-unRwfmNbkt9gXAd6B1f4jvIdLTjPZIpJctHN_7dCTRPTLYcL6acqC93Hmw&_nc_zt=14&_nc_ht=scontent-sof1-2.xx&_nc_gid=d7hi_UxNfqjYXerHM14xeQ&_nc_ss=7f180&oh=00_AQH2e6h9KFU4-3z_X6q0swlZBDxBZcoeJwI0PL6acABnPg&oe=6A8E14EF', NULL, '2025-08-08T07:00:00.000Z'::timestamptz, NULL, true, 378, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1366851311728453', 74),
  ('uk-dental', 'clear-aligners', 'c:1886402041918907', '1886402041918907', '629500736877783', 1, 2, 'Bhandal Dental Practice - Coventry', '779727428742486', 'Free Invisalign Consult + More! 🦷', 'Ready to achieve the confident, straight smile you''ve always dreamed of? ✨ At Bhandal Dental Practice, we believe everyone deserves to feel confident about their smile.

Clear aligners are a discreet and comfortable way to straighten your teeth, correcting issues like gaps, crowding, and misalignments without traditional braces. Imagine a smile that radiates confidence, all thanks to a virtually invisible solution! 🤩

Here’s what’s included with your clear aligner treatment:

Free Invisalign Consultation: Sit down with our expert team to discuss your smile goals and see if aligners are right for you. 🗣️

Free Scan: We use advanced technology to get a precise digital impression of your teeth.

Free Whitening: Brighten your newly aligned teeth for a truly dazzling finish. 🌟

Free Retainers: Keep your perfect smile in place for the long term. 💎

Don''t miss this incredible opportunity to transform your smile. Our friendly team in Coventry is ready to guide you every step of the way. 🤝

Take the first step towards your perfect smile. ➡️

Click "Learn More" to book your free consultation today! ⬇️', 'Learn more', 'LEARN_MORE', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/542756385_1332246305192688_3944999358621542204_n.jpg?_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=sjMXMbAidVcQ7kNvwG3G7s-&_nc_oc=AdprRiuqID3NkRt0AaXM8oe_enL9kEmsx86QerD2sf0TYS6fMwgz-fDm1fmhrwcxnqs&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=wf0aSC3W7Vn_Zt_YvdUdWQ&_nc_ss=7f180&oh=00_AQG5KWasf3GBkhQcj2ypqyPAEVCftDfBprdH6zRqDmth6Q&oe=6A8E17D1', NULL, '2025-09-01T07:00:00.000Z'::timestamptz, NULL, true, 354, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=629500736877783', 74),
  ('uk-dental', 'clear-aligners', 'c:25319274107673818', '25319274107673818', '1432780464682414', 1, 2, 'Bhandal Dental Practice - Coventry', '779727428742486', 'Free Invisalign Consult + More! 🦷', 'Ready to achieve the confident, straight smile you''ve always dreamed of? ✨ At Bhandal Dental Practice, we believe everyone deserves to feel confident about their smile.

Clear aligners are a discreet and comfortable way to straighten your teeth, correcting issues like gaps, crowding, and misalignments without traditional braces. Imagine a smile that radiates confidence, all thanks to a virtually invisible solution! 🤩

Here’s what’s included with your clear aligner treatment:

Free Invisalign Consultation: Sit down with our expert team to discuss your smile goals and see if aligners are right for you. 🗣️

Free Scan: We use advanced technology to get a precise digital impression of your teeth.

Free Whitening: Brighten your newly aligned teeth for a truly dazzling finish. 🌟

Free Retainers: Keep your perfect smile in place for the long term. 💎

Don''t miss this incredible opportunity to transform your smile. Our friendly team in Coventry is ready to guide you every step of the way. 🤝

Take the first step towards your perfect smile. ➡️

Click "Learn More" to book your free consultation today! ⬇️', 'Learn more', 'LEARN_MORE', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/541205906_802855848937871_3930295662568256800_n.jpg?_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=Q1ZLelXIXVoQ7kNvwFdUkQj&_nc_oc=Ado0W8Pyo_tS-Zw2RP6pGfxd8NzxusAv5scHXPEwWNEZpwAlWv3OyKMF7rM97lUZM6s&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=MVZKq31O5uMqGGSVLdhHnw&_nc_ss=7f180&oh=00_AQGm-2QITBUdC8NKLl8PRT1ui3KeMkNRHyq8F97V7CO4wA&oe=6A8DFB66', NULL, '2025-09-01T07:00:00.000Z'::timestamptz, NULL, true, 354, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1432780464682414', 74),
  ('uk-dental', 'crowns-bridges', 'c:3816555915154499', '3816555915154499', '764906693047157', 2, 2, 'Dental Ays Turkey', '108146671536677', NULL, 'Dentalays Dental Center ✨🪽

#dentalclinicturkey #laminateveneers #laminateveneersturkey #zirconia #uk #dentalclinic #usa', 'Send message', 'INSTAGRAM_MESSAGE', 'https://www.instagram.com/', 'VIDEO', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-sof1-2.xx.fbcdn.net/v/t39.35426-6/557279925_666581449839167_1120215064799844414_n.jpg?_nc_cat=107&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=XJuNvENTXSEQ7kNvwHH8nVo&_nc_oc=Adqfv1cXRlAA_TVlh9RXnrox0gKtBgc5oZuXGGraZd3UHAhES5fgjlnZritUU_LS0D8&_nc_zt=14&_nc_ht=scontent-sof1-2.xx&_nc_gid=hK0wnCh4-ZnHGpaVllPxrQ&_nc_ss=7f180&oh=00_AQEEFuK__nJ4-We8wSo1tyr1T9Cc92yrued2jxKg4bS_NQ&oe=6A8E2583', NULL, '2025-10-05T07:00:00.000Z'::timestamptz, NULL, true, 320, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=764906693047157', 74),
  ('uk-dental', 'dental-implants', 'c:783001751212149', '783001751212149', '833764362424246', 1, 2, 'Peacock Dental Spa', '104456218405873', NULL, 'Peacock Dental Spa
✅Affordable Membership Plans for all the family
✅Friendly team
✅Complimentary comforts
✅High tech equipment
✅Invisalign, implants, sedation, and much much more!', NULL, NULL, NULL, 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","THREADS"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/559415554_1951881525606426_4556350787947236730_n.jpg?_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=1yz7RfSHlcAQ7kNvwG6q2AL&_nc_oc=Adq0d9qqsb3W5z8KzQeAEoD9TGUx5esbn3YmZvM7oE6G5JM4aO-Lh4Z-I4y4n3FZ5oA&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=gnLyzkzN-RAaEIz0q_m-Eg&_nc_ss=7f180&oh=00_AQEYAYXzAsCJZL4dO4FT4u3yswSC9hNzFbX8MTfljNV4kA&oe=6A8E0130', NULL, '2025-10-14T07:00:00.000Z'::timestamptz, NULL, true, 311, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=833764362424246', 74),
  ('uk-dental', 'clear-aligners', 'c:1387121842828875', '1387121842828875', '1203574198249825', 1, 2, 'The Dental Barns', '157232967483452', 'Your Smile. Our Craft. Exclusive Care.', 'At The Dental Barns, every smile transformation begins with calm, comfort, and connection.

Whether you’re considering Invisalign, composite bonding, or veneers, our VIP Members enjoy continuity with the same dentist, private appointments, and a peaceful, spa-like setting designed entirely around them.

In this video, David shares why we created the VIP experience — to make every stage of your treatment feel as rewarding as the results.

🌿 Join the VIP Waitlist today and discover a dental journey built around you.', 'Sign up', 'SIGN_UP', 'https://www.thedentalbarns.co.uk/vip', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER","THREADS"]'::jsonb, 'https://scontent-waw2-2.xx.fbcdn.net/v/t39.35426-6/569021854_844485694914163_1200857411607307673_n.jpg?_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=d4u23Aljg4kQ7kNvwHTm38Z&_nc_oc=AdpLmFcDHyxFJYBJkSKE7X7nCktCm3jCJdC9xqIZT1ViSwBK9bCqV0OMeabkjX8MwBU&_nc_zt=14&_nc_ht=scontent-waw2-2.xx&_nc_gid=nRUk7PO33FQscFZnhYDpNQ&_nc_ss=7f289&oh=00_AQGm1NR9LM1Z3-o3cUl3GvKf1m1QN6n9GnXN_LMNqo9whQ&oe=6A8E0D22', NULL, '2025-10-24T07:00:00.000Z'::timestamptz, NULL, true, 301, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1203574198249825', 74),
  ('uk-dental', 'clear-aligners', 'c:1400187791536017', '1400187791536017', '1545806196590393', 1, 2, 'Banning Dental & Skin Clinique', '643263762798951', 'LOWEST PRICE INVISALIGN IN THE UK!', 'Embarrassed by crooked teeth? 😬 It’s time to smile confidently!

At Banning Dental Croydon, we can help you get the straight, confident smile you deserve with Invisalign, the clear alternative to braces.

Here’s why Croydon patients are loving us:
🌟 Top 1% of Invisalign providers in Europe
🌟 Exclusive Opening Offer – Invisalign from just £2,600!
🌟 FREE Consultation + 3D Scan & X-Rays worth £180
🌟 FREE Professional Whitening, Retainers & Tooth Shaping
🌟 Prices from only £31.13 p/m – the lowest in the UK, guaranteed

Click ‘Learn More’ to book your FREE consultation today. Offer available only at Banning Dental Croydon for a limited time!', 'Learn more', 'LEARN_MORE', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent.fvno1-1.fna.fbcdn.net/v/t39.35426-6/572237710_1170347671714623_1625350393851916970_n.jpg?_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=yayBT6dF824Q7kNvwEiaIX5&_nc_oc=AdqSvWGOU-vGsHO4KSMuyh6j7p7CH9q4loEO_XAze7qDfRIHKy83ffx0zFZVSlARDS4&_nc_zt=14&_nc_ht=scontent.fvno1-1.fna&_nc_gid=XTchfmfwDGIbQZ4t34ma4A&_nc_ss=7f289&oh=00_AQGh4chCM6kdrwxAU-H5-7ockZ-ORHSYiJ5yRyCShmZzLQ&oe=6A8E05FD', NULL, '2025-10-31T07:00:00.000Z'::timestamptz, NULL, true, 294, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1545806196590393', 74),
  ('uk-dental', 'crowns-bridges', 'c:1200364605320053', '1200364605320053', '1154180772963583', 2, 2, 'Dental Ays Turkey', '108146671536677', NULL, 'About your Smile Story ✨🪽

#dentalclinicturkey #laminateveneersturkey #uk #usa #zirconia #dentalclinic', 'Send WhatsApp message', 'WHATSAPP_MESSAGE', 'https://api.whatsapp.com/send', 'VIDEO', '["INSTAGRAM"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/572369870_1373636831019718_3593508424410242774_n.jpg?_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=HdPEOXE4jLAQ7kNvwH0_Jdg&_nc_oc=AdpGQTu7cLM-cf_nsYFAYVQR9ADXtLR-BQaMOo4aeGyH-03sqwOA95gPihJ6axKBy7w&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=Dy9tIO28iR4X5FSWAQFE1g&_nc_ss=7f180&oh=00_AQGaONeb7MPS4jGGyTrh0Vaj8tl7Ei7290tgXrylDDaKsw&oe=6A8E02CA', NULL, '2025-11-01T07:00:00.000Z'::timestamptz, NULL, true, 293, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1154180772963583', 74),
  ('uk-dental', 'hygiene', 'p:1670463919863961|b:✨ brighten your smile with confidence! ✨ new to our practice? we’re rolling out a special welcome offer: 👉 half-price new patient examinations — just £38.25, including up to 4 x-rays! our friendly te', NULL, '24916282491365726', NULL, 2, 'Hilton Dental Care', '1670463919863961', 'Hilton Dental Care', '✨ Brighten Your Smile with Confidence! ✨
New to our practice? We’re rolling out a special welcome offer:
👉 Half-price New Patient Examinations — just £38.25, including up to 4 x-rays!

Our friendly team is here to make your visit stress-free and comfortable — whether it’s your first check-up in a while or you’re looking for a new family dentist.

💙 Want to keep your smile healthy all year round?
Join our Dental Plan from just £20.50 per month, and enjoy peace of mind with:
✔️ 2 dental check-ups per year
✔️ 2 professional cleans with our hygienist
✔️ Emergency assessment included
✔️ 10% off treatment costs
✔️ Worldwide dental insurance
✔️ Up to 2 routine x-rays per year

📞 Call us today on 01283 753777 and let’s keep your smile shining!', 'Call now', 'CALL_NOW', NULL, 'IMAGE', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/574856158_1111554561061126_1027259869569111563_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=Ix2XlOnfLGoQ7kNvwE4YxNS&_nc_oc=AdpifQpZKMHeVKUNLSrqqsbRgP3fhCSVKFQ_be9-ZtUbN6ij1R4Uq8ajspiX84fIouE&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=7OnnIeB20QNp6Dfe1zBwXA&_nc_ss=7f180&oh=00_AQH3087hwPGE7lbTux3js7ZS3QuTSLAmDWPiNUPRg0U4uw&oe=6A8E0BE2', NULL, '2025-11-02T07:00:00.000Z'::timestamptz, NULL, true, 292, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=24916282491365726', 74),
  ('uk-dental', 'general-dentistry', 'c:1740391693423865', '1740391693423865', '3058538537650320', 2, 2, 'Dental Ays Turkey', '108146671536677', 'Chat With Us', 'Your dream smile is closer than you think! 🌟 Don’t just imagine it—take the first step towards your perfect smile with DentalAYS.

💰 Save up to 70% compared to UK prices
🚖 VIP Transfer & Hotel Included

Join the countless happy patients who’ve transformed their smiles in Antalya with our expert care and premium technology. Ready to see what’s possible? Book your consultation today and let us take care of the rest!', 'Send message', 'INSTAGRAM_MESSAGE', 'https://www.instagram.com/', 'IMAGE', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/471128401_1608697053178543_4549681481184191805_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=Q-DuibmEeOEQ7kNvwH4Sbrh&_nc_oc=AdrALEpW3i_zUnCc1z6w1_PPUORZMQ7qMVDq4Bp2Q_fkqzLGJdVJUeaONyzE7eI-Ihg&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=fDgAA783JccIq6044aTvAw&_nc_ss=7f180&oh=00_AQF9QHSGW1Na7JixM4MqLBLKRCLj1KlepE2cSGotWYaOCA&oe=6A8E1688', NULL, '2025-11-04T08:00:00.000Z'::timestamptz, NULL, true, 290, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=3058538537650320', 74),
  ('uk-dental', 'clear-aligners', 'c:2308510766211422', '2308510766211422', '1882567622609004', 1, 2, 'Broadway Dental Boutique', '651835294945412', 'Free Invisalign Consultation In 📍 Crawley, West Sussex, UK', 'Hello Crawley👋 Straight teeth don’t have to mean fixed braces - Invisalign® can straighten teeth in as little as 6 months and they''re discreet so no one will know you''re wearing them. 

Invisalign® is removable so you can continue to eat and drink as normal and the best part is, we''re offering FREE consultations this month!

For those who reserve spot today, here’s what you get:

✅ Free Teeth whitening (Worth £325)
✅ Free Vivera Retainers, (Worth £500)
✅ 3D scan, so no messy impressions
✅ Teeth movement can be monitored at home with your dedicated patient app

There are limited spaces available for this month, so simply click “get offer” to reserve your spot and one of our team will be in touch to book you in!😃', 'Get offer', 'GET_OFFER', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/581168921_1546326316616793_4263309520672803597_n.jpg?_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=ImH3-EKTyQAQ7kNvwHXGbU1&_nc_oc=AdpSk_vCRexEueUFAxYK8G0YFUMHtj-j5UgpiGogaA14-SuC-lRfTQ_Lv9oHsle3ycI&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=BVK37C0aSdnAQZB-UBcs5A&_nc_ss=7f180&oh=00_AQFwJcnu3H8nu6I4AleoOF3B4g-NMhnserVvCBTsdUzCrg&oe=6A8E063F', NULL, '2025-11-11T08:00:00.000Z'::timestamptz, NULL, true, 283, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1882567622609004', 74),
  ('uk-dental', 'clear-aligners', 'c:25436424549342810', '25436424549342810', '1365035218401026', 1, 2, 'Banning Dental & Skin Clinique', '643263762798951', 'LOWEST PRICE INVISALIGN IN THE UK!', 'Embarrassed by crooked teeth? 😬 It’s time to smile confidently!

At Banning Dental Croydon, we can help you get the straight, confident smile you deserve with Invisalign, the clear alternative to braces.

Here’s why Croydon patients are loving us:
🌟 Top 1% of Invisalign providers in Europe
🌟 Exclusive Opening Offer – Invisalign from just £2,600!
🌟 FREE Consultation + 3D Scan & X-Rays worth £180
🌟 FREE Professional Whitening, Retainers & Tooth Shaping
🌟 Prices from only £31.13 p/m – the lowest in the UK, guaranteed

Click ‘Learn More’ to book your FREE consultation today. Offer available only at Banning Dental Croydon for a limited time!', 'Learn more', 'LEARN_MORE', 'http://fb.me/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent-sof1-2.xx.fbcdn.net/v/t39.35426-6/581953352_1355853726237285_6300528006878108918_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=f-QnRnBxzBYQ7kNvwFdlHko&_nc_oc=AdpdcziY7v5Ynps-3egqaPZ0S5iQTxCRzBKGhoMNiItVcPm1jCs-bsOZE3WcDvUbm_I&_nc_zt=14&_nc_ht=scontent-sof1-2.xx&_nc_gid=BVK37C0aSdnAQZB-UBcs5A&_nc_ss=7f180&oh=00_AQG4VwS2s6tS_Enkxos1fK_wL8_mhs6NUpbypOD1k8KElA&oe=6A8DFDD5', NULL, '2025-11-13T08:00:00.000Z'::timestamptz, NULL, true, 281, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1365035218401026', 74),
  ('uk-dental', 'clear-aligners', 'c:716236364286228', '716236364286228', '1226038759577464', 1, 2, 'Banning Dental & Skin Clinique', '643263762798951', 'LOWEST PRICE INVISALIGN IN THE UK!', 'Embarrassed by crooked teeth? 😬 It’s time to smile confidently!

At Banning Dental Croydon, we can help you get the straight, confident smile you deserve with Invisalign, the clear alternative to braces.

Here’s why Croydon patients are loving us:
🌟 Top 1% of Invisalign providers in Europe
🌟 Exclusive Opening Offer – Invisalign from just £2,600!
🌟 FREE Consultation + 3D Scan & X-Rays worth £180
🌟 FREE Professional Whitening, Retainers & Tooth Shaping
🌟 Prices from only £31.13 p/m – the lowest in the UK, guaranteed

Click ‘Learn More’ to book your FREE consultation today. Offer available only at Banning Dental Croydon for a limited time!', 'Learn more', 'LEARN_MORE', 'http://fb.me/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent-sof1-2.xx.fbcdn.net/v/t39.35426-6/580945382_823287357225943_7035191522317467089_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=az1TmkU2aSQQ7kNvwHf21gk&_nc_oc=AdrmOpPUh5zcgo0Qh8Fvbj4OQgPUzPdnWKlWEsKK-FVNnmsoWdNCV5EiPWgZUQZsT7s&_nc_zt=14&_nc_ht=scontent-sof1-2.xx&_nc_gid=PA2gte5kvTy-Dg0xpQjxoA&_nc_ss=7f180&oh=00_AQEERqyKveMSLG8qfpdEsqoNKD_vUrHKcHdJhMmk_1KnjQ&oe=6A8DFF85', NULL, '2025-11-13T08:00:00.000Z'::timestamptz, NULL, true, 281, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1226038759577464', 74),
  ('uk-dental', 'clear-aligners', 'c:2024141641766559', '2024141641766559', '1374742640982448', 1, 2, 'Coach House Dental Practice', '2024514127842593', 'Invisalign £52 pm. Book a FREE Consultation...', 'Hi Matlock! 👋 Save £1,770 on a Teeth Straightening Makeover this Month! 🤩

Teeth Straightening (with Clear Braces) is a fantastic cosmetic dental treatment for people looking for a flawless straight white smile.

The team here at Coach House Dental have put together a fantastic package for the next 30 days!

Package Includes: 

✨ Smile Design Assessment
✨ Clear Braces with Invisalign
✨ Teeth Whitening & Stain Removal
✨ Retainers
✨ Hygiene

Usually, the price for this smile makeover is £4,570. However...

Right now, we have reduced it to £2,800! 🤩 

Saving you a huge £1,770! 😍

You can even spread the cost of treatment from as little as £52 per month!

Interested in learning more?
Book a FREE Consultation today!

📍 Coldwell St, Wirksworth, Matlock DE4 4FB
✨ Rated 5 Stars On Google

The Coach House Dental
www.thecoachhousedental.co.uk', 'Get offer', 'GET_OFFER', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/593761287_1170203001846710_1018352388087628590_n.jpg?_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=WUolNdqzezYQ7kNvwF7qKJj&_nc_oc=Ado57NLF_MUsHi0ytpALE1zhYYUxqMOZjUG4rvq9ZuvV2D9e8K7DI8qLIgEVqe7jdQw&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=UdloA4O_SUITCMD7PnlUsA&_nc_ss=7f180&oh=00_AQHTW1K2JPdk2reZaZSbABmP3L_ozlojKX1bF_K88bpQLA&oe=6A8E1DB5', NULL, '2025-12-03T08:00:00.000Z'::timestamptz, NULL, true, 261, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1374742640982448', 74),
  ('uk-dental', 'teeth-whitening', 'c:2699586337062214', '2699586337062214', '1923821931893308', 1, 2, 'Kingwwy gift', '108704998141103', 'kingwwy gift', '🔥 [3 minutes at home = 1 hour at the dentist] 🔥
🦷 No more costly and time wasting trips to the hospital to get your teeth cleaned! The ultrasonic scaler easily removes calculus, tobacco and coffee stains✨With 6 professional modes - whitening, gum care, sensitivity and more, along with 40,000 sonic vibrations per minute, the deep cleaning far exceeds manual brushing. Create a healthy and confident smile anytime, anywhere and easily at home!💎', 'Shop now', 'SHOP_NOW', 'https://kingwwy.com/products/ultrasonic-electric-teeth-cleaner-1', 'VIDEO', '["FACEBOOK","INSTAGRAM","MESSENGER","THREADS"]'::jsonb, 'https://scontent-mxp2-1.xx.fbcdn.net/v/t39.35426-6/594308937_2051222585717506_3291386943467320536_n.jpg?_nc_cat=109&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=zQgheemRknEQ7kNvwH1wIsr&_nc_oc=AdoMfoqcPTUtnPHHGncCCAoL-QRPokaIvOF1kKWze94R0CHJtJ5NvPQYRNwnmZvv7Z4&_nc_zt=14&_nc_ht=scontent-mxp2-1.xx&_nc_gid=Syry3AVOAc4vBHuehAhNEg&_nc_ss=7f289&oh=00_AQFVZ58ec_L4fwCiqhYhXFVU1tYf1j7QVUMVLqlN9zyMAg&oe=6A8E16DF', NULL, '2025-12-03T08:00:00.000Z'::timestamptz, NULL, true, 261, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1923821931893308', 74),
  ('uk-dental', 'clear-aligners', 'c:856636396833064', '856636396833064', '3790986547870382', 1, 2, 'Coach House Dental Practice', '2024514127842593', 'Invisalign £52 pm. Book a FREE Consultation...', 'Hi Matlock! 👋 Save £1,770 on a Teeth Straightening Makeover this Month! 🤩

Teeth Straightening (with Clear Braces) is a fantastic cosmetic dental treatment for people looking for a flawless straight white smile.

The team here at Coach House Dental have put together a fantastic package for the next 30 days!

Package Includes: 

✨ Smile Design Assessment
✨ Clear Braces with Invisalign
✨ Teeth Whitening & Stain Removal
✨ Retainers
✨ Hygiene

Usually, the price for this smile makeover is £4,570. However...

Right now, we have reduced it to £2,800! 🤩 

Saving you a huge £1,770! 😍

You can even spread the cost of treatment from as little as £52 per month!

Interested in learning more?
Book a FREE Consultation today!

📍 Coldwell St, Wirksworth, Matlock DE4 4FB
✨ Rated 5 Stars On Google

The Coach House Dental
www.thecoachhousedental.co.uk', 'Get offer', 'GET_OFFER', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/592127596_1954381321783377_8883329601923691865_n.jpg?_nc_cat=104&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=QYgo1tzedzYQ7kNvwGFb7-R&_nc_oc=Adr4RNn4nBMzjcfmHpeaxdnlHLJrJxSi1Lpx5nOGyRM0uyIR_87RnWy6czxj9NMyFa8&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=7OnnIeB20QNp6Dfe1zBwXA&_nc_ss=7f180&oh=00_AQGJ3fYaSGiYvCq6966-bGYh3RDqZ_dGb48IOr-AG59pMA&oe=6A8E1E12', NULL, '2025-12-03T08:00:00.000Z'::timestamptz, NULL, true, 261, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=3790986547870382', 74),
  ('uk-dental', 'clear-aligners', 'c:1173105911689826', '1173105911689826', '794627166956511', 1, 2, 'Broadway Dental Boutique', '651835294945412', 'Free Invisalign Consultation In 📍 Crawley, West Sussex, UK', 'Hello Crawley👋 Straight teeth don’t have to mean fixed braces - Invisalign® can straighten teeth in as little as 6 months and they''re discreet so no one will know you''re wearing them. 

Invisalign® is removable so you can continue to eat and drink as normal and the best part is, we''re offering FREE consultations this month!

For those who reserve spot today, here’s what you get:

✅ Free Teeth whitening (Worth £325)
✅ Free Vivera Retainers, (Worth £500)
✅ 3D scan, so no messy impressions
✅ Teeth movement can be monitored at home with your dedicated patient app

There are limited spaces available for this month, so simply click “get offer” to reserve your spot and one of our team will be in touch to book you in!😃', 'Get offer', 'GET_OFFER', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/601351144_891217090137859_1374170229664122397_n.jpg?_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=AXpI2k8_HI8Q7kNvwGTOOOQ&_nc_oc=Adpr4rYbCoFLxrAutjV12pG4BywlXTbKwdLPNuhmrHH395nIUo2ePNymTmjwhkb4wsM&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=MVZKq31O5uMqGGSVLdhHnw&_nc_ss=7f180&oh=00_AQEc9FiP1O2bjEMFuACd6caE9xTvObP35bQo7u_hLQkxoA&oe=6A8DFDCC', NULL, '2025-12-17T08:00:00.000Z'::timestamptz, NULL, true, 247, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=794627166956511', 74),
  ('uk-dental', 'clear-aligners', 'p:615970354932831|b:🦷✨ dental care made easy — for a healthier you! at ripple dental care we offer gentle, modern treatments to keep your smile bright and healthy: • teeth whitening for a confident glow • root canal tre', NULL, '1585592402788595', NULL, 2, 'Ripple Dental Edinburgh', '615970354932831', 'Dentally Portal', '🦷✨ Dental care made easy — for a healthier you!

At Ripple Dental Care we offer gentle, modern treatments to keep your smile bright and healthy:

• Teeth Whitening for a confident glow
• Root Canal Treatment to relieve pain and save your tooth
• Invisalign® clear aligners for discreet straightening
• Polishing & Stain Removal for that fresh, clean feel

🌿 Central Edinburgh clinic • Friendly team • NHS & private patients welcome

👉 Book now: rippledental.co.uk
📞 0131 563 9931 • 📍 48–50 Dundas St, EH3 6JN

#RippleDental #EdinburghDentist #HealthySmile #TeethWhitening #InvisalignEdinburgh #RootCanal #StainRemoval #NHSDentist #PrivateDentist', 'Book now', 'BOOK_TRAVEL', 'https://rippledental.portal.dental/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/612353955_913288564604066_2901854305352711232_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=KqMxmRibn00Q7kNvwGnIzcW&_nc_oc=AdogcrnXY6eD7b2Yq8S2WYgLxBNFRpAqjOt1ewWg3NhI7k2M7oPiw83GVerqSURFCdU&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=2W9Iy1hHaIWncynlg4vNtA&_nc_ss=7f180&oh=00_AQEvcyUx9H77Ss-XsxItxySbzzzgMTKJlRKVqNA0qE-pvw&oe=6A8E09BA', NULL, '2026-01-07T08:00:00.000Z'::timestamptz, NULL, true, 226, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1585592402788595', 74),
  ('uk-dental', 'general-dentistry', 'c:1331442748485710', '1331442748485710', '1236460485089484', 2, 2, 'Naturawhite Professional Laser Teeth Whitening', '100957515406', NULL, '🚀 Ready to take control of your future? Whether you’re a professional, salon owner, mobile therapist, or even a parent looking for a new income stream, this is for YOU!

🦷 Train with the UK’s No.1 provider. Train with Naturawhite. 🥇
👉 TRAIN RIGHT. TRAIN NATURAWHITE.

Here’s why people across the UK choose us:
✅ Expert-Led Training – Learn from the best in the business
✅ Ongoing Support – Before, during & after your training
✅ Fully Insurable Courses – Only with Naturawhite
✅ We Book You Clients – National booking site sends them straight to you
✅ Exclusive Rewards – Loyalty perks & product discounts
✅ Premium Equipment – Included with every package
✅ BluforsaX Gels – Game-changing results. No competition

⭐ With 5-star reviews nationwide, Naturawhite gives you the skills, tools, and clients to start earning fast.

📣 Don’t wait — your success story starts HERE.
👉 Message us today to secure your training place!', 'Send WhatsApp message', 'WHATSAPP_MESSAGE', 'https://api.whatsapp.com/send', 'IMAGE', '["INSTAGRAM"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/615124037_865210869488992_2384080570710344212_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=NhyvEHUTB7YQ7kNvwGqr_UO&_nc_oc=AdrB4l9gop1xdYwKbQt-ImIlfUHNhvHvzShpDqJcJDZ9GxAdEUiHsF8Pb_qprwWmpdY&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=ufZs90oZ_OOWa-E5wgQH_Q&_nc_ss=7f180&oh=00_AQF5z3KoKBC6668xpEqy6FaRhuyK-fMb8BppSjjbC6dgOQ&oe=6A8E046C', NULL, '2026-01-12T08:00:00.000Z'::timestamptz, NULL, true, 221, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1236460485089484', 74),
  ('uk-dental', 'teeth-whitening', 'c:772962048856713', '772962048856713', '1922285975062444', 2, 2, 'Naturawhite Professional Laser Teeth Whitening', '100957515406', NULL, '🔍 Teeth whitening Appointment searches up 45% year-on-year on Google!

What are you waiting for? Anyone can do this with Naturawhite: mums, dads, beauty therapists, aestheticians, salons, clinics… even mobile appointments! - Get Started Now

As the cold days and nights draw in, more people want the convenience of a mobile whitening service – and we’ve got you covered with our specially designed cases for our laser lights. Whether you’re setting up in your location or taking it on the road, we make it easy.

Here’s why people across the UK choose Naturawhite 👇

✅ Expert-Led Training – Learn from the UK’s No.1 provider (Anyone can do with NATURAWHITE)
✅ Unmatched Support – Before, during, and after your training
✅ Fully Insurable Courses – Only through Naturawhite
✅ We Book You Clients – Our national booking site brings them straight to you
✅ Exclusive Rewards – Loyalty perks & product discounts
✅ Next-Gen Equipment – All included, all premium
✅ BluForsaX Gels – Game-changing results. No competition

💎 Turn your passion into profit and start offering whitening results your clients will LOVE.

📥 Download our brochure here: https://www.naturawhite.com/pages/brochure-download', 'Send WhatsApp message', 'WHATSAPP_MESSAGE', 'https://api.whatsapp.com/send', 'IMAGE', '["INSTAGRAM"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/614237072_1438845591148233_3251909351474152688_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=lOoujkJJWOQQ7kNvwFFKXO0&_nc_oc=Adp5ytDZiZ-OmNa-tztHF6AjfR9pAG0QXCY3e8xltYNe0OzwEYNHvE_jnKkqLSf_dl4&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=2W9Iy1hHaIWncynlg4vNtA&_nc_ss=7f180&oh=00_AQFdoyw2eW8ofRHTrxxqd1GXUwX7vcOF-ZsTg3BXCEwafg&oe=6A8E0714', NULL, '2026-01-12T08:00:00.000Z'::timestamptz, NULL, true, 221, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1922285975062444', 74),
  ('uk-dental', 'clear-aligners', 'c:3465407880401182', '3465407880401182', '4382070195451051', 2, 2, 'Hamilton Smile Studios', '107489441692096', 'Book a Free Consultation', 'Say hello to clear braces! 👋 We have a fantastic offer for our new patients consisting of a free consultation where you can see a 3D simulation of your smile and a free whitening kit worth £300 with every clear braces treatment. Something you will absolutely 💕!

✨ Up to 50% faster treatment times ✨
With weekly aligner changes, you’re on your way to the smile you want even faster.

✨ Better fit, better comfort ✨
Aligners made from SmartTrack material are more comfortable, better fitting, and easier to put on and take off.

✨ Effective for a wide variety of cases ✨
With weekly aligner changes, you’re on your way to the smile you want even faster.

Call us on 01698 767 220 to book your free consultation or request a booking online.
https://www.hamiltonsmilestudios.co.uk/', 'Book now', 'BOOK_TRAVEL', 'https://www.hamiltonsmilestudios.co.uk/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/616084698_1400060164797205_5494692188266708566_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=BHbU4XmbG_wQ7kNvwH2shHn&_nc_oc=AdprLTRwcJoKreBI0eQP2syDDLyKPJoVAxoMNeb_gUG3S2MGnh4kuzpawOkA20l_XNs&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=IVzjPPczyU1mJBWz9Z0h8w&_nc_ss=7f180&oh=00_AQEsQJYaAE8CVI0CVcdB91IiHn2Dkrs7DzHj4S257hI5og&oe=6A8E1D08', NULL, '2026-01-14T08:00:00.000Z'::timestamptz, NULL, true, 219, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=4382070195451051', 74),
  ('uk-dental', 'dental-implants', 'c:896837665883193', '896837665883193', '2107517916453765', 2, 2, 'DentalCare One Albania', '304964006677618', 'Get VIP Dental Treatment in Albania!', 'Your dream smile is within reach!

💡 Affordable Dental Implant Packages in Albania
✅ 4 Dental Implants – Starting from just £1,499
✈️ Free VIP Transfer
🏨 Free Accommodation

Experience top-quality care at our top-rated clinic in Tirana. European-certified materials and world-class dentists ensure long-lasting results.

📞 Contact us today for your FREE consultation:
+44 7465 695213 | dentalcareone.com

📌 Don’t wait—your smile deserves the best!', 'Get offer', 'GET_OFFER', 'http://fb.me/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/617499378_1587482562598629_7617934926381787368_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=107&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=-Fp4LIVAiskQ7kNvwENemWF&_nc_oc=Adrg4ZBYJVkjVic3Jb4rtanOb-w484rQ-ljVDuV4sAScvwE66hRkg5bOt99rzSRvj2k&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=s72VItsrmj39f90hHTNeEg&_nc_ss=7f180&oh=00_AQGxSj0VpERx3qBp24CgJCb5MyuSN0sNLfU2FovpjuM18g&oe=6A8DF855', NULL, '2026-01-19T08:00:00.000Z'::timestamptz, NULL, true, 214, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=2107517916453765', 74),
  ('uk-dental', 'hygiene', 'c:1175524841052446', '1175524841052446', '2078287099615761', 1, 2, 'CertifiCure Dental Hub', '252214511317858', NULL, '🦷 Yellow teeth? Bad breath? Painful gums? Even loose or missing teeth?
Forget costly dentist visits — Marvix™ Kolirin Herbal Toothpaste is the all-in-one, dentist-approved herbal solution.
✅ In just 1 week: Whiter teeth, fresher breath, and stronger gums.
✅ In weeks: Repairs cavities, fights gum disease, and supports natural regrowth.
No surgery. No fake teeth. No outrageous bills. Just brush daily and let Marvix do the work. 
Smile brighter, feel better — fast. Shop now 👉 kireibay.com/products/marvix', 'Shop now', 'SHOP_NOW', 'http://kireibay.com/products/marvix?utm_campaign=%7B%7Bcampaign.name%7D%7D&utm_content=%7B%7Bad.name%7D%7D', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER","THREADS"]'::jsonb, 'https://scontent.fgye13-1.fna.fbcdn.net/v/t39.35426-6/618801397_1048260177498263_5281412800125060676_n.jpg?_nc_cat=109&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=8nBsc-MVyC4Q7kNvwGEHadg&_nc_oc=AdrzMDpn-TxvK6DsdX9h_NsVgA2fqdaE4vib05jfFKJ8obBDIDc7ek9YpEf1HJGOsc0&_nc_zt=14&_nc_ht=scontent.fgye13-1.fna&_nc_gid=emrR_i901VgHVlFhkTB0Hw&_nc_ss=7f180&oh=00_AQEmx5ukCgpywUpcsh6Mfwv9wAoZ3UJNfSl7VgGdS1m70A&oe=6A8E1DC1', NULL, '2026-01-26T08:00:00.000Z'::timestamptz, NULL, true, 207, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=2078287099615761', 74),
  ('uk-dental', 'dental-implants', 'c:2286764998475233', '2286764998475233', '4398093220470878', 1, 2, 'Transform Dental', '1573449912876086', 'Chat with us Now ✅', 'Thinking about improving your smile?

At Transform Dental Liverpool, we specialise in natural-looking smile makeovers using:
• Composite bonding
• Veneers & 3D veneers
• Dental implants

Start with a free consultation to explore what would work best for you — no pressure, no obligation.

📍 Liverpool
👉 Book your free consultation today', 'Send WhatsApp message', 'WHATSAPP_MESSAGE', 'https://api.whatsapp.com/send', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER","THREADS"]'::jsonb, 'https://scontent-waw2-1.xx.fbcdn.net/v/t39.35426-6/623415002_1606550627199027_4648126277455401863_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=tLmmEUsSgA8Q7kNvwHJXQZw&_nc_oc=AdqwIOjP9QjrOsLXwKzTETqNgjWZfU_gggZbuMmrUYlPsrFu7L7S626M7222AYBhkaE&_nc_zt=14&_nc_ht=scontent-waw2-1.xx&_nc_gid=nRUk7PO33FQscFZnhYDpNQ&_nc_ss=7f289&oh=00_AQEGLwtXIdhZQwyQwot1KXc6kCQBTITMXD7uE8Bg8nsW3Q&oe=6A8DFCF1', NULL, '2026-01-29T08:00:00.000Z'::timestamptz, NULL, true, 204, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=4398093220470878', 74),
  ('uk-dental', 'dental-implants', 'c:821803874221199', '821803874221199', '2512357602513306', 1, 2, 'Transform Dental', '1573449912876086', 'Chat with us Now ✅', 'Thinking about improving your smile?
At Transform Dental Wilmslow we specialise in natural-looking smile makeovers using:
• Composite bonding
• Veneers & 3D veneers
• Dental implants

Start with a free consultation to explore what would work best for you —
no pressure, no obligation.

📍 Manchester
👉 Book your free consultation today', 'Send WhatsApp message', 'WHATSAPP_MESSAGE', 'https://api.whatsapp.com/send', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER","THREADS"]'::jsonb, 'https://scontent-ord5-1.xx.fbcdn.net/v/t39.35426-6/623876560_1360012812811634_429774808783683242_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=109&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=K8NFsmVf0gcQ7kNvwGb_oGX&_nc_oc=AdrgxmcRS69phyJu8A37sUjM6Z8RwfWIm03Ex1FkIZBlKukTLQ1v78tmUMJh2dm8dw-pxTcuWaxTeXTa0xzRIrlP&_nc_zt=14&_nc_ht=scontent-ord5-1.xx&_nc_gid=cYlHpVB0lkgKb8IZ9-zslQ&_nc_ss=7f180&oh=00_AQGCmaTv7lBu5CHxY72nH4KMRkGlAN5lJOpUFeoJvkzIlw&oe=6A8E1D92', NULL, '2026-01-29T08:00:00.000Z'::timestamptz, NULL, true, 204, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=2512357602513306', 74),
  ('uk-dental', 'dental-implants', 'c:906077922000965', '906077922000965', '903598102361546', 1, 2, 'Sandown Dental & Implant Clinic', '150128098360642', NULL, 'Thinking about enhancing your smile? Here’s what to expect at Sandown Dental and Implant Clinic. 🦷

Whether you’re considering composite bonding, whitening, Invisalign, crowns, or veneers, understanding the process can help you feel confident and prepared.

Our dedicated team will guide you through every stage, making your smile journey smooth and comfortable.

Ready to take the next step? DM us to learn more! ✨', 'Send message', 'MESSAGE_PAGE', NULL, 'MULTI_IMAGES', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-ord5-2.xx.fbcdn.net/v/t39.35426-6/637767300_777437495423023_6309633564782082925_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=107&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=SQ4UmIRWaTYQ7kNvwH_g1b7&_nc_oc=Adr-jslmgjHbiRhZzQ1rq9Do_sGvVE9wca96CpOhZX-gRz3prfAxkXmHFJfLerCX8-qPaHw5SSnouPt6rMQCk5TV&_nc_zt=14&_nc_ht=scontent-ord5-2.xx&_nc_gid=cYlHpVB0lkgKb8IZ9-zslQ&_nc_ss=7f180&oh=00_AQHFdiGD5osNOIoFSoJMZnCf3TzZQaR_3TKCJ4aREGgnXQ&oe=6A8E108F', NULL, '2026-02-06T08:00:00.000Z'::timestamptz, NULL, true, 196, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=903598102361546', 74),
  ('uk-dental', 'checkup', 'c:757461957056432', '757461957056432', '1422179892934496', 1, 2, 'Dental Ays Turkey', '108146671536677', '⏱️ Get Your Quote in Just 5 Min.', '➡️ Tap "Get Quote" below for details.⬅️
𝐃𝐞𝐧𝐭𝐚𝐥 𝐜𝐚𝐫𝐞 𝐢𝐧 𝐭𝐡𝐞 𝐌𝐢𝐝𝐥𝐚𝐧𝐝𝐬 𝐡𝐚𝐬 𝐛𝐞𝐜𝐨𝐦𝐞 𝐢𝐧𝐜𝐫𝐞𝐝𝐢𝐛𝐥𝐲 𝐞𝐱𝐩𝐞𝐧𝐬𝐢𝐯𝐞. At DentalAYS Antalya, patients from Birmingham & across the Midlands 𝐬𝐚𝐯𝐞 𝐮𝐩 𝐭𝐨 𝟕𝟎% 𝐨𝐧 𝐢𝐦𝐩𝐥𝐚𝐧𝐭𝐬, 𝐯𝐞𝐧𝐞𝐞𝐫𝐬 & 𝐬𝐦𝐢𝐥𝐞 𝐦𝐚𝐤𝐞𝐨𝐯𝐞𝐫𝐬 — 𝐰𝐢𝐭𝐡𝐨𝐮𝐭 𝐜𝐨𝐦𝐩𝐫𝐨𝐦𝐢𝐬𝐢𝐧𝐠 𝐪𝐮𝐚𝐥𝐢𝐭𝐲.

✅ Award-winning dental treatments 🏆
✅ Fully planned trip to Turkey 🇹🇷
✅ 5★ hotel stays in Antalya
✅ VIP airport & clinic transfers
✅ English-speaking team

𝗪𝗮𝗶𝘁, 𝘁𝗵𝗲𝗿𝗲''𝘀 𝗺𝗼𝗿𝗲! 🎉
✅ Free Consultation
✅ Free 3D X-Ray
✅ Free Accommodation
✅ Free Transportation
✅ Free Translation', 'Get quote', 'GET_QUOTE', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/637789667_1926419444632028_8745812658528928660_n.jpg?_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=HC5fQjH-fKAQ7kNvwGkjtn8&_nc_oc=AdoqlyTSjvL6kkGFqVOHka5-kVpJmBs44PaWwtVUHteOSRZvtLFcpC14sFXzI4nvGNU&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=d7hi_UxNfqjYXerHM14xeQ&_nc_ss=7f180&oh=00_AQG75Cnrdn27NrheYy5sNJRq98PsqoZs44dPU2zhTb2xTQ&oe=6A8E0ECF', NULL, '2026-02-17T08:00:00.000Z'::timestamptz, NULL, true, 185, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1422179892934496', 74),
  ('uk-dental', 'checkup', 'c:1433004581790408', '1433004581790408', '803492235352023', 1, 2, 'Dental Ays Turkey', '108146671536677', '⏱️ Get Your Quote in Just 5 Min.', '➡️ Tap "Get Quote" below for details.⬅️
𝐃𝐞𝐧𝐭𝐚𝐥 𝐜𝐚𝐫𝐞 𝐢𝐧 𝐭𝐡𝐞 𝐒𝐨𝐮𝐭𝐡 𝐖𝐞𝐬𝐭 & 𝐖𝐚𝐥𝐞𝐬 𝐡𝐚𝐬 𝐛𝐞𝐜𝐨𝐦𝐞 𝐢𝐧𝐜𝐫𝐞𝐝𝐢𝐛𝐥𝐲 𝐞𝐱𝐩𝐞𝐧𝐬𝐢𝐯𝐞. At DentalAYS Antalya, patients from Bristol, Cardiff & across the region 𝐬𝐚𝐯𝐞 𝐮𝐩 𝐭𝐨 𝟕𝟎% 𝐨𝐧 𝐢𝐦𝐩𝐥𝐚𝐧𝐭𝐬, 𝐯𝐞𝐧𝐞𝐞𝐫𝐬 & 𝐬𝐦𝐢𝐥𝐞 𝐦𝐚𝐤𝐞𝐨𝐯𝐞𝐫𝐬 — 𝐰𝐢𝐭𝐡𝐨𝐮𝐭 𝐜𝐨𝐦𝐩𝐫𝐨𝐦𝐢𝐬𝐢𝐧𝐠 𝐪𝐮𝐚𝐥𝐢𝐭𝐲.

✅ Award-winning dental treatments 🏆
✅ Fully planned trip to Turkey 🇹🇷
✅ 5★ hotel stays in Antalya
✅ VIP airport & clinic transfers
✅ English-speaking team

𝗪𝗮𝗶𝘁, 𝘁𝗵𝗲𝗿𝗲''𝘀 𝗺𝗼𝗿𝗲! 🎉
✅ Free Consultation
✅ Free 3D X-Ray
✅ Free Accommodation
✅ Free Transportation
✅ Free Translation', 'Get quote', 'GET_QUOTE', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/634643775_1737072890599795_4953103849576739464_n.jpg?_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=nhgt5gp3vEgQ7kNvwEj7dc1&_nc_oc=Adq6qSkLIJKXWDKNUT3owrw7h5VBOVfzHHbN4Of8-7DyBNdere64CWvFh9GSfSjDwCc&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=Gl--EJOYzutuJJHwC9GzIQ&_nc_ss=7f180&oh=00_AQGmG090--MIEPVs0l-peJ-udd5rukCUdjJcT7TZyh4iXQ&oe=6A8E26AF', NULL, '2026-02-18T08:00:00.000Z'::timestamptz, NULL, true, 184, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=803492235352023', 74),
  ('uk-dental', 'clear-aligners', 'c:26417907561139651', '26417907561139651', '2040736006499413', 1, 2, 'Kingsgate Dental', '679412028844567', 'Your New Dentist!', 'Kingsgate Dental has had a makeover! Our refurbishment is officially complete, and we cannot wait to welcome you.
What is new?

Extended opening hours – we now have early morning, late night and Saturday appointments available.
A stunning, modern reception and waiting area.
Newly designed surgeries with the latest dental technology.
In-house CBCT 3D scanning for advanced diagnostics.
Whether it''s routine dental health checks, cosmetic treatments, such as smile makeovers, composite bonding, Invisalign and tooth whitening, or our popular Practice Plan designed to help manage dental costs and maintain great oral health, we have plenty to offer in our fresh, comfortable environment.

We are accepting new patients now.', 'Learn more', 'LEARN_MORE', 'https://kingsgatedental.co.uk/', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-ord5-2.xx.fbcdn.net/v/t39.35426-6/638335664_1990370935167794_6899134691470163337_n.jpg?_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=NT1z0eJqKUkQ7kNvwHwvjKw&_nc_oc=AdrTdQ2E_gyuH1eqfi3Ye_5CdsaxmrG3lQCq2hpBbDuSKQBG3ybD9v6lp3OdEfyA9ibqfHihp-15EzwN3T8NXSFx&_nc_zt=14&_nc_ht=scontent-ord5-2.xx&_nc_gid=tFH3vcZmolSLJpREEncTnw&_nc_ss=7f180&oh=00_AQFnN--YsXqzZvWJ3ReOw1TFLXrsq7cGTW6uFHUqZcWzEQ&oe=6A8DF35E', NULL, '2026-02-19T08:00:00.000Z'::timestamptz, NULL, true, 183, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=2040736006499413', 74),
  ('uk-dental', 'clear-aligners', 'c:778011548188465', '778011548188465', '2891885647684295', 1, 2, 'Kingsgate Dental', '679412028844567', 'Your New Dentist!', 'Kingsgate Dental has had a makeover! Our refurbishment is officially complete, and we cannot wait to welcome you.

What is new?

- Extended opening hours – we now have early morning, late night and Saturday appointments available.
- A stunning, modern reception and waiting area.
- Newly designed surgeries with the latest dental technology.
- In-house CBCT 3D scanning for advanced diagnostics.

Whether it''s routine dentistry to optimise and maintain your dental health, or cosmetic treatments, such as smile makeovers, composite bonding, Invisalign and tooth whitening, we have plenty to offer in our fresh, comfortable environment.

We are accepting new patients now.', 'Learn more', 'LEARN_MORE', 'https://kingsgatedental.co.uk/', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-ord5-2.xx.fbcdn.net/v/t39.35426-6/638361572_936301992256012_7321131764853634140_n.jpg?_nc_cat=104&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=yGFYXIfuhRIQ7kNvwHvRx2l&_nc_oc=AdpW-gA44bN6QotoUzp0bCxY6kIDNcEpND4hXkXLEvXwdcPaDgpeAlpDOfanrxJ9AkOk5glRJPkA00Npj2XafKkE&_nc_zt=14&_nc_ht=scontent-ord5-2.xx&_nc_gid=tFH3vcZmolSLJpREEncTnw&_nc_ss=7f180&oh=00_AQECKdQTwC69yEwQqfBQPPVayS60HGHBexa2QBVJyraAnA&oe=6A8E2529', NULL, '2026-02-19T08:00:00.000Z'::timestamptz, NULL, true, 183, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=2891885647684295', 74),
  ('uk-dental', 'dental-implants', 'c:1447270840244151', '1447270840244151', '1447700140402568', 1, 2, 'Anchor Road Dental Practice', '134238673306848', '𝐁𝐨𝐨𝐤 𝐘𝐨𝐮𝐫 𝐅𝐫𝐞𝐞 𝐂𝐨𝐧𝐬𝐮𝐥𝐭𝐚𝐭𝐢𝐨𝐧 ✅', '𝐇𝐞𝐲 𝐖𝐚𝐥𝐬𝐚𝐥𝐥! 👋

We’re offering 𝐅𝐑𝐄𝐄 𝐝𝐞𝐧𝐭𝐚𝐥 𝐢𝐦𝐩𝐥𝐚𝐧𝐭 & 𝐜𝐨𝐬𝐦𝐞𝐭𝐢𝐜 𝐜𝐨𝐧𝐬𝐮𝐥𝐭𝐚𝐭𝐢𝐨𝐧𝐬 (𝐰𝐨𝐫𝐭𝐡 £𝟏𝟎𝟎) at our clinic in Aldridge! 🦷✨

Whether you''re missing a tooth 😔, unhappy with your smile 😬, or ready for a confidence boost 😁 — we’re here to help. 💙

Dental implants are a long-lasting, natural-looking solution to replace missing teeth 🦷🔩, while our cosmetic treatments can completely transform your smile ✨😊.

Start your treatment and enjoy:

✅ FREE personalised treatment plan
✅ FREE teeth whitening (𝐰𝐨𝐫𝐭𝐡 £𝟑𝟎𝟎) with selected cosmetic treatments

From single tooth implants to full smile makeovers, our experienced team will guide you every step of the way.

⚡️ 𝐋𝐢𝐦𝐢𝐭𝐞𝐝 𝐬𝐥𝐨𝐭𝐬 — hit ‘𝐁𝐨𝐨𝐤 𝐍𝐨𝐰’ to secure yours today!', 'Book now', 'BOOK_TRAVEL', 'http://fb.me/', 'IMAGE', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-fco2-1.xx.fbcdn.net/v/t39.35426-6/641316212_1652630502844004_2705448548544101539_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=v3WS9sWfv6EQ7kNvwEbLpkn&_nc_oc=Adok1uk0GptgYK5f3iEFCnWrzTcIF5H2ivX-M7lfwk0gfyoX_Yny5kIsVTy-pso_WEY&_nc_zt=14&_nc_ht=scontent-fco2-1.xx&_nc_gid=ufZs90oZ_OOWa-E5wgQH_Q&_nc_ss=7f180&oh=00_AQHrVDBI-Hbs5h0ir8Gxzgj8AM6hKwZTKsB7M3RG8rr7fQ&oe=6A8E0CC0', NULL, '2026-02-23T08:00:00.000Z'::timestamptz, NULL, true, 179, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1447700140402568', 74),
  ('uk-dental', 'clear-aligners', 'c:26203767675924015', '26203767675924015', '1430644825257661', 2, 2, 'Whittlesey Dental', '543706532469105', 'Could Invisalign Be Right for You?', 'If you’ve been thinking about straightening your teeth, you probably have questions.

Will it work for me?
How long would it take?
What would my smile actually look like?

Many people delay Invisalign treatment simply because they’re unsure where to begin.

That’s why we’re offering a free smile scan and smile straightening consultation — so you can see what’s possible and understand your options before committing to anything.

No pressure.
No obligation.
Just clear, professional guidance from an experienced team.

If straighter teeth are something you’ve been considering, this is the easiest first step.

👉 Book your free smile scan today.', 'Learn more', 'LEARN_MORE', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent-sof1-2.xx.fbcdn.net/v/t39.35426-6/641149070_1232689349056817_6312749227163642545_n.jpg?_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=85I6lV-OjgUQ7kNvwFJKg6Z&_nc_oc=AdrTKagHS5Rc6u6bXoGB6DA9G8sMQ-x5seSbEJxD9lRUGTtvDFfs-xf7Ei_iLHrzhAA&_nc_zt=14&_nc_ht=scontent-sof1-2.xx&_nc_gid=hK0wnCh4-ZnHGpaVllPxrQ&_nc_ss=7f180&oh=00_AQH9zDVYI4VW20mo-_vpN8TlkZiRhEU_pKhVGHxWG882xw&oe=6A8E05BA', NULL, '2026-02-25T08:00:00.000Z'::timestamptz, NULL, true, 177, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1430644825257661', 73),
  ('uk-dental', 'general-dentistry', 'c:1093490507734793', '1093490507734793', '731160540764209', 1, 1, 'White Pine Dental Health', '238280679679154', 'Your Belleville Dentist!', 'Our patient David is a Local Hero here around Belleville. He serves for both the police department AND the fire department. But he told us he would rather fight fires and bad-guys than go to the dentist! That changed when David came to White Pine Dental in downtown Belleville and met Dr. Webster and our great staff. Now count David among our many happy patients!

(Photo Taken PRIOR to social Distancing and Covid)

Looking for a dentist yourself? Visit our website or give us a call for more info: www.WhitePineDentalHealth.com and 734-252-6002 to set an appointment today!', 'Contact us', 'CONTACT_US', 'http://Www.whitepinedentalhealth.com/', 'IMAGE', '["FACEBOOK"]'::jsonb, 'https://scontent.fgye13-1.fna.fbcdn.net/v/t39.35426-6/130803995_756349354974446_2482961650352351743_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=VmpQBg9hPJsQ7kNvwH0ftr_&_nc_oc=AdrtUO8A6lyXIKyQ2OpYEFhIcfSntY8Zo_wdW-H2ahS3kNkhAiXQFzfu_15bgzwUUmo&_nc_zt=14&_nc_ht=scontent.fgye13-1.fna&_nc_gid=emrR_i901VgHVlFhkTB0Hw&_nc_ss=7f180&oh=00_AQERgF_uyLeibeK_lqt5jaeCHTBZkcPD2JyOrRGPsOoHlA&oe=6A8E22A0', NULL, '2020-08-24T07:00:00.000Z'::timestamptz, NULL, true, 2188, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=731160540764209', 70),
  ('uk-dental', 'dental-implants', 'c:236797955037342', '236797955037342', '959853061547481', 1, 1, 'Daryl Robertson, DDS', '150677881643005', 'Dental Implant Special Offer', 'The Dental technology that is transforming smiles… is not what most would guess!

This revolutionary dental implant procedure is taking the dental industry by storm and truly changing lives for the better.

For a limited time, get a $1,000 off, a  Free implant consultation and x-rays.

Single dental implants start as low as $102 / mo', 'Learn more', 'LEARN_MORE', 'https://www.aboveandbeyonddental.co/dental-implants-step-1/', 'IMAGE', '["FACEBOOK","INSTAGRAM","MESSENGER"]'::jsonb, 'https://scontent-iev1-1.xx.fbcdn.net/v/t39.35426-6/251336833_931680607700581_3997059101270161076_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=CwVnExe7jWoQ7kNvwHlAFTR&_nc_oc=Ado6bRVmm8a6KiusnYWkQzkQAyVK2mCIlu8Hd2i6pHXZVK5YrGaI31cosh5PgEx8JmE&_nc_zt=14&_nc_ht=scontent-iev1-1.xx&_nc_gid=Om5hlJU8P7spBV6hNIgHIg&_nc_ss=7f289&oh=00_AQEN1bl2Vru00zr3tKAcwH063nZn-rNM9ZeJJu5CPpqnNQ&oe=6A8DF233', NULL, '2021-11-03T07:00:00.000Z'::timestamptz, NULL, true, 1752, '["CREDIT"]'::jsonb, 'https://www.facebook.com/ads/library/?id=959853061547481', 70),
  ('uk-dental', 'dental-implants', 'c:302424694824611', '302424694824611', '5078635218832842', 1, 1, 'Daryl Robertson, DDS', '150677881643005', 'Dental Implant Special Offer', 'The Dental technology that is transforming smiles… is not what most would guess!

This revolutionary dental implant procedure is taking the dental industry by storm and truly changing lives for the better.

For a limited time, get a $1,000 off, a  Free implant consultation and x-rays.

Single dental implants start as low as $102 / mo', 'Learn more', 'LEARN_MORE', 'https://www.aboveandbeyonddental.co/dental-implants-step-1/', 'IMAGE', '["FACEBOOK","INSTAGRAM","MESSENGER"]'::jsonb, 'https://scontent-iev1-1.xx.fbcdn.net/v/t39.35426-6/248540923_1122292278304918_1012604201198690467_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=Z3U4gKkBP_MQ7kNvwE9a8mc&_nc_oc=AdqQYttSc1i9HbJm_QUw5ePi7uk_ePMSWQwm6rM3mGM1HcN0L0oktT2ps2KjFykeEFY&_nc_zt=14&_nc_ht=scontent-iev1-1.xx&_nc_gid=Om5hlJU8P7spBV6hNIgHIg&_nc_ss=7f289&oh=00_AQGtS-lv9kzhyKL75D01lpjr5vyGUVOQ3jDQlHwpxyHYYA&oe=6A8DEF13', NULL, '2021-11-03T07:00:00.000Z'::timestamptz, NULL, true, 1752, '["CREDIT"]'::jsonb, 'https://www.facebook.com/ads/library/?id=5078635218832842', 70),
  ('uk-dental', 'dental-implants', 'c:226516562779042', '226516562779042', '955079588751501', 1, 1, 'Leytonstone Dental Centre', '365651263934658', 'Implantology centre', 'Implantology Centre offers implants at discount prices just from £800 . Don''t risk looking bargains abroad. Top quality and experience . Find us www.leytonstonedentalcentre.co.uk  or 0208 5588 656', 'Call now', 'CALL_NOW', NULL, 'VIDEO', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-iev1-1.xx.fbcdn.net/v/t39.35426-6/260138468_1267932207007285_2860179643071609764_n.jpg?_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=4tpIOy4bS0MQ7kNvwHO-xEE&_nc_oc=AdqU2U08_F-JJ44xchynTk7KdncGHdipcadb-DoPCmqTU3MWjROYHSMknycUqk0pvSo&_nc_zt=14&_nc_ht=scontent-iev1-1.xx&_nc_gid=Om5hlJU8P7spBV6hNIgHIg&_nc_ss=7f289&oh=00_AQGDFlejd0Zf069uC-N5wcgX0YREIjtlNeQHHm3KfhgeHw&oe=6A8DFFD2', NULL, '2021-11-26T08:00:00.000Z'::timestamptz, NULL, true, 1729, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=955079588751501', 70),
  ('uk-dental', 'teeth-whitening', 'c:1657405804635707', '1657405804635707', '1085809272013913', 1, 1, 'St Vincent Smile', '170928266609810', 'Book a Free Consultation', 'Say hello to clear braces! 👋 We have a fantastic offer for our new patients consisting of a free consultation where you can see a 3D simulation of your smile and a free whitening kit worth £300 with every clear braces treatment. Something you will absolutely 💕!

Call us on 0141 248 1183 to book your free consultation or request a booking online.', 'Book now', 'BOOK_TRAVEL', 'https://www.stvincentsmile.co.uk/invisalign', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent.fvno1-1.fna.fbcdn.net/v/t39.35426-6/278138393_389511976126202_1415881330801354561_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=ws6ztGqVhKoQ7kNvwE5aUxZ&_nc_oc=AdrV1mtZvP1LudfWLMt8-FoXUtjGIPIYIAn6jk-sm0g5jvXwQ33cU9aHci2MsglI-50&_nc_zt=14&_nc_ht=scontent.fvno1-1.fna&_nc_gid=XTchfmfwDGIbQZ4t34ma4A&_nc_ss=7f289&oh=00_AQGXx7k_DQSjhdkh-Wiugm5zM9g6pmgEitCQNoVb36D25Q&oe=6A8E1B86', NULL, '2022-04-13T07:00:00.000Z'::timestamptz, NULL, true, 1591, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1085809272013913', 70),
  ('uk-dental', 'teeth-whitening', 'c:1725316977810726', '1725316977810726', '1130349331097734', 1, 1, 'St Vincent Smile', '170928266609810', 'Book a Free Consultation', 'Say hello to clear braces! 👋 We have a fantastic offer for our new patients consisting of a free consultation where you can see a 3D simulation of your smile and a free whitening kit worth £300 with every clear braces treatment. Something you will absolutely 💕!

Call us on 0141 248 1183 to book your free consultation or request a booking online.', 'Book now', 'BOOK_TRAVEL', 'https://www.stvincentsmile.co.uk/invisalign', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/278462112_282951040704547_7577543528966242357_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=LBSbCYtWauAQ7kNvwGakdsY&_nc_oc=Adr5ul4gcMflVcDI30XQ9Vcq-N0kWa8p_yprJhouOma_KxV4sKVA8icOU95rcEOz4dw&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=PA2gte5kvTy-Dg0xpQjxoA&_nc_ss=7f180&oh=00_AQHFBRyWRr_sLkx11TZKriMr0i9Tbl8RKVUlvmf7rip7kQ&oe=6A8DF35F', NULL, '2022-04-14T07:00:00.000Z'::timestamptz, NULL, true, 1590, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1130349331097734', 70),
  ('uk-dental', 'teeth-whitening', 'c:1873914876135748', '1873914876135748', '500259598475753', 1, 1, 'St Vincent Smile', '170928266609810', 'Book a Free Consultation', 'Say hello to clear braces! 👋 We have a fantastic offer for our new patients consisting of a free consultation where you can see a 3D simulation of your smile and a free whitening kit worth £300 with every clear braces treatment. Something you will absolutely 💕!

Call us on 0141 248 1183 to book your free consultation or request a booking online.', 'Book now', 'BOOK_TRAVEL', 'https://www.stvincentsmile.co.uk/invisalign', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent.fvno1-1.fna.fbcdn.net/v/t39.35426-6/278506893_307523791348395_1907085175933504436_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=xLoO2kzLtMMQ7kNvwGKfQHO&_nc_oc=AdrJzivBJKkIC2ShlztlKWkxrkYDkVylhdgOdIAJRdWXkYaIN5B4MQ7m2EeJ84mYswQ&_nc_zt=14&_nc_ht=scontent.fvno1-1.fna&_nc_gid=XTchfmfwDGIbQZ4t34ma4A&_nc_ss=7f289&oh=00_AQG6sPdcYuWXhazQGC3Gjk9hkUccqLDJdNXw98_b0fEBBQ&oe=6A8DFB82', NULL, '2022-04-14T07:00:00.000Z'::timestamptz, NULL, true, 1590, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=500259598475753', 70),
  ('uk-dental', 'teeth-whitening', 'c:509357247309594', '509357247309594', '516350156596661', 1, 1, 'St Vincent Smile', '170928266609810', 'Book a Free Consultation', 'Say hello to clear braces! 👋 We have a fantastic offer for our new patients consisting of a free consultation where you can see a 3D simulation of your smile and a free whitening kit worth £300 with every clear braces treatment. Something you will absolutely 💕!

Call us on 0141 248 1183 to book your free consultation or request a booking online.', 'Book now', 'BOOK_TRAVEL', 'https://www.stvincentsmile.co.uk/invisalign', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent.fvno1-1.fna.fbcdn.net/v/t39.35426-6/278227646_358361319554612_6164138013950535785_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=104&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=Ebc1YKHEYDkQ7kNvwGobGV2&_nc_oc=AdrnWnyyB_brX4QV9Y1XwxSx2vLvqSs2kQaADSz03f8M6Vh2EKVbyPJsA-Pl01Bks5Y&_nc_zt=14&_nc_ht=scontent.fvno1-1.fna&_nc_gid=XTchfmfwDGIbQZ4t34ma4A&_nc_ss=7f289&oh=00_AQFW0-JpmtQ_gdUAl3_OCEfN-AkIVfGPWXwbNAfCwTw3pg&oe=6A8DF1D5', NULL, '2022-04-14T07:00:00.000Z'::timestamptz, NULL, true, 1590, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=516350156596661', 70),
  ('uk-dental', 'teeth-whitening', 'c:718123472704796', '718123472704796', '2803815153252996', 1, 1, 'St Vincent Smile', '170928266609810', 'Book a Free Consultation', 'Say hello to clear braces! 👋 We have a fantastic offer for our new patients consisting of a free consultation where you can see a 3D simulation of your smile and a free whitening kit worth £300 with every clear braces treatment. Something you will absolutely 💕!

Call us on 0141 248 1183 to book your free consultation or request a booking online.', 'Book now', 'BOOK_TRAVEL', 'https://www.stvincentsmile.co.uk/invisalign', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent.fvno1-1.fna.fbcdn.net/v/t39.35426-6/278446873_340161164764674_4125744357860363_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=111&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=RuE4TFtT1jMQ7kNvwG7Hmuh&_nc_oc=Adr7O0UUk0ktKvdu9Bc3yIuATti7DKy2Dhv0IplhlNFJqUPoy5AaEuvXtfE9kuw9vjA&_nc_zt=14&_nc_ht=scontent.fvno1-1.fna&_nc_gid=XTchfmfwDGIbQZ4t34ma4A&_nc_ss=7f289&oh=00_AQGf9UCkeuEldKkVg-aStGqj5dHfcEFMRCaIOUo0EC-2Tg&oe=6A8E106D', NULL, '2022-04-14T07:00:00.000Z'::timestamptz, NULL, true, 1590, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=2803815153252996', 70),
  ('uk-dental', 'teeth-whitening', 'c:776889093694306', '776889093694306', '5302607579802198', 1, 1, 'St Vincent Smile', '170928266609810', 'Book a Free Consultation', 'Say hello to clear braces! 👋 We have a fantastic offer for our new patients consisting of a free consultation where you can see a 3D simulation of your smile and a free whitening kit worth £300 with every clear braces treatment. Something you will absolutely 💕!

Call us on 0141 248 1183 to book your free consultation or request a booking online.', 'Book now', 'BOOK_TRAVEL', 'https://www.stvincentsmile.co.uk/invisalign', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent.fvno1-1.fna.fbcdn.net/v/t39.35426-6/278296314_406659614152948_5003486203641343293_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=okr2gfyOW8EQ7kNvwFztGzn&_nc_oc=AdqTFh2FgoYbCOMCQDwx4yugTrcdwcAsWVOyf7CRLqGTLX4QPQjchMW9RbuNI90p4hk&_nc_zt=14&_nc_ht=scontent.fvno1-1.fna&_nc_gid=XTchfmfwDGIbQZ4t34ma4A&_nc_ss=7f289&oh=00_AQGToCuSTh6no7RvVn2xuWHEXtRGorrkVRmOK6YBzQVByg&oe=6A8E104B', NULL, '2022-04-14T07:00:00.000Z'::timestamptz, NULL, true, 1590, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=5302607579802198', 70),
  ('uk-dental', 'dental-implants', 'c:408541734647860', '408541734647860', '1104889700061493', 1, 1, 'Liberty Family Dentistry', '352524611648', 'Free Dental Implant Consultations', 'Dental implants provide a long-term solution to replacing a single missing tooth or multiple missing teeth. Get a free consultation today!', 'Contact us', 'CONTACT_US', 'https://www.libertyfamilydentistry.com/services/dental-implants', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-iev1-1.xx.fbcdn.net/v/t39.35426-6/283740089_3291983604368202_3031998665206435175_n.jpg?_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=Y1-Hwexd3SsQ7kNvwGS5bwg&_nc_oc=AdpqE7z0lvgCKknllD0zF5CWOlekJcuWa4SJKT4a3xt0bIh2MU8Arf_nEUiBuNH8uyo&_nc_zt=14&_nc_ht=scontent-iev1-1.xx&_nc_gid=Om5hlJU8P7spBV6hNIgHIg&_nc_ss=7f289&oh=00_AQH1ArLQsy2d9VV2qV67eH7HzCm5qjL-ebGEbSCy-ownSQ&oe=6A8E12D8', NULL, '2022-05-23T07:00:00.000Z'::timestamptz, NULL, true, 1551, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1104889700061493', 70),
  ('uk-dental', 'dental-implants', 'c:1185521628874813', '1185521628874813', '818858322854419', 1, 1, 'Thurmaston Dental Practice', '150160231778655', 'Dental Hygiene', 'Regular hygiene appointments to clean and polish your teeth are the cornerstones of any great smile and foundations of oral health.

Dental hygiene is a vital part of keeping your mouth, teeth and gums healthy. Regular home and practice-based oral care can reduce the risk of tooth decay, cavities and gum disease as well as maintain a radiant smile.

At Thurmaston Dental, Facial & Implants, we think that prevention is better than cure, and periodic in-practice care is a great way to look after our patient’s teeth. Regular hygienist appointments can keep your teeth and gums healthy as well as enhance your smile. 

Book your dental hygiene appointment today by calling 0116 2602 515 during our opening hours, or request an appointment online.', 'Book now', 'BOOK_TRAVEL', 'https://thurmastondental.co.uk/treatment/dental-hygiene/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/290551647_554871159346441_8980755176415933873_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=sg2mm8o_E98Q7kNvwGranuC&_nc_oc=AdqgYFwkBMczGKXU7arEt3Q0UpbMZDPcuE7ZPE4f5jm4bjV5VjTg7EQWEarIjutFwMg&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=EQCkvJeRluYC8slB5C7Cxw&_nc_ss=7f180&oh=00_AQGvb-eiAii3ZJ8pglt_PTvse_ro8hln7gt7zpRmJvQ9LQ&oe=6A8E04AC', NULL, '2022-06-27T07:00:00.000Z'::timestamptz, NULL, true, 1516, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=818858322854419', 70),
  ('uk-dental', 'dental-implants', 'c:1402134883625842', '1402134883625842', '392656786190968', 1, 1, 'Thurmaston Dental Practice', '150160231778655', 'Dental Hygiene', 'Enjoy your time out with your friends and smile with confidence! Regular hygiene appointments to clean and polish your teeth are the cornerstones of any great smile and foundations of oral health.

Dental hygiene is a vital part of keeping your mouth, teeth and gums healthy. Regular home and practice-based oral care can reduce the risk of tooth decay, cavities and gum disease as well as maintain a radiant smile.

At Thurmaston Dental, Facial & Implants, we think that prevention is better than cure, and periodic in-practice care is a great way to look after our patient’s teeth. Regular hygienist appointments can keep your teeth and gums healthy as well as enhance your smile. 

Book your dental hygiene appointment today by calling 0116 2602 515 during our opening hours, or request an appointment online.', 'Book now', 'BOOK_TRAVEL', 'https://thurmastondental.co.uk/treatment/dental-hygiene/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/289317830_716311559625322_2787503026932960958_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=IDMeZeDJ_w0Q7kNvwHHNfzK&_nc_oc=AdpudNpRLoE8m5VCuRWooOEvcHfzXhkNw6qozBQzQxG6hmIUwuVfbOKTxMYYFOnVdZw&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=tCfyvt1nyMyDQTQwR8LQTA&_nc_ss=7f180&oh=00_AQHkbDZUdvQ0UaG6jH15XiKae9jhVydjcoTlKc36vEucsA&oe=6A8E10D6', NULL, '2022-06-27T07:00:00.000Z'::timestamptz, NULL, true, 1516, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=392656786190968', 70),
  ('uk-dental', 'dental-implants', 'c:566380851507384', '566380851507384', '3309054286036250', 1, 1, 'Thurmaston Dental Practice', '150160231778655', NULL, 'Regular hygiene appointments to clean and polish your teeth are the cornerstones of any great smile and foundations of oral health.

Dental hygiene is a vital part of keeping your mouth, teeth and gums healthy. Regular home and practice-based oral care can reduce the risk of tooth decay, cavities and gum disease as well as maintain a radiant smile.

At Thurmaston Dental, Facial & Implants, we think that prevention is better than cure, and periodic in-practice care is a great way to look after our patient’s teeth. Regular hygienist appointments can keep your teeth and gums healthy as well as enhance your smile. 

Book your dental hygiene appointment today by calling 0116 2602 515 during our opening hours, or request an appointment online.', NULL, NULL, NULL, NULL, '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/290328440_2862170400745666_7165897720262692836_n.jpg?stp=dst-jpg_s60x60_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=QKmItDqBk0oQ7kNvwFmXnNB&_nc_oc=Adp9gUFtJjg03L4AE4t3-svb2b4IprF885vtqFdJZD-8Mf6yutYMGnwmOCeXNcxXYLA&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=tCfyvt1nyMyDQTQwR8LQTA&_nc_ss=7f180&oh=00_AQGz5yj8uyb_wPAtk9TjDHnI1n6W5rTlc0caOLDCvRQrHg&oe=6A8DFD02', NULL, '2022-06-27T07:00:00.000Z'::timestamptz, NULL, true, 1516, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=3309054286036250', 70),
  ('uk-dental', 'dental-implants', 'c:591754962513924', '591754962513924', '1122139078343343', 1, 1, 'Thurmaston Dental Practice', '150160231778655', 'Dental Hygiene', 'Regular hygiene appointments to clean and polish your teeth are the cornerstones of any great smile and foundations of oral health.

Dental hygiene is a vital part of keeping your mouth, teeth and gums healthy. Regular home and practice-based oral care can reduce the risk of tooth decay, cavities and gum disease as well as maintain a radiant smile.

At Thurmaston Dental, Facial & Implants, we think that prevention is better than cure, and periodic in-practice care is a great way to look after our patient’s teeth. Regular hygienist appointments can keep your teeth and gums healthy as well as enhance your smile. 

Book your dental hygiene appointment today by calling 0116 2602 515 during our opening hours, or request an appointment online.', 'Book now', 'BOOK_TRAVEL', 'https://thurmastondental.co.uk/treatment/dental-hygiene/', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/290675238_395526592607524_1609349854200619508_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=9Hg0UOxVA6UQ7kNvwE4PHkc&_nc_oc=AdoiVZtg3GyLYGL3q-oiwhEaegARZ3PBbrskfEFj7i240OFC457GXQLvNvMdQpoCcns&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=s72VItsrmj39f90hHTNeEg&_nc_ss=7f180&oh=00_AQFsxrTqfWZX6zJ3nd-QSia44XaWXarYyvBpXT6bs5EiHw&oe=6A8E186F', NULL, '2022-06-27T07:00:00.000Z'::timestamptz, NULL, true, 1516, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1122139078343343', 70),
  ('uk-dental', 'dental-implants', 'c:745866819984247', '745866819984247', '422543323106709', 1, 1, 'Thurmaston Dental Practice', '150160231778655', NULL, 'Regular hygiene appointments to clean and polish your teeth are the cornerstones of any great smile and foundations of oral health.

Dental hygiene is a vital part of keeping your mouth, teeth and gums healthy. Regular home and practice-based oral care can reduce the risk of tooth decay, cavities and gum disease as well as maintain a radiant smile.

At Thurmaston Dental, Facial & Implants, we think that prevention is better than cure, and periodic in-practice care is a great way to look after our patient’s teeth. Regular hygienist appointments can keep your teeth and gums healthy as well as enhance your smile. 

Book your dental hygiene appointment today by calling 0116 2602 515 during our opening hours, or request an appointment online.', NULL, NULL, NULL, NULL, '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/290579392_1170465260473465_6639657890527647844_n.jpg?stp=dst-jpg_s60x60_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=Nu5K4KHwc0UQ7kNvwHSGMLc&_nc_oc=AdpeYwEWnHJLb5lFumjWxcciiO-M0ExfpnYCwu0RcBXJg6iGF14P89XaoIDrZpMLoiE&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=fDgAA783JccIq6044aTvAw&_nc_ss=7f180&oh=00_AQGl0y5bQimud2j-0k7CEbnTO-u15mNwktc-4bv0aR85xg&oe=6A8E18BE', NULL, '2022-06-27T07:00:00.000Z'::timestamptz, NULL, true, 1516, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=422543323106709', 70),
  ('uk-dental', 'dental-implants', 'c:1752314025146186', '1752314025146186', '569477441497033', 1, 1, 'Royal Arsenal Dentists', '1450538395198279', 'Dental Implants', 'Dental implants have given us the opportunity to replace missing or lost teeth with a fixed, comfortable and aesthetically pleasing alternative. Dental implant therapy is considered now to be the gold standard for replacing missing teeth. ✨

Royal Arsenal Dentists brings together
a top team of dentists, hygienists, and dental nursing and care staff. We have a very caring and gentle approach, with particular emphasis on making nervous patients feel at ease. 

At Royal Arsenal Dentists, we offer a free dental implants consultation to asses your dental treatment needs and create a personalised plan. We have a number of options available; more details can be found on our website. 🦷

Call 0208 317 0590 to book your free consultation or book online:
https://www.royalarsenaldentists.com/dental-implants-treatments', 'Book now', 'BOOK_TRAVEL', 'https://www.royalarsenaldentists.com/dental-implants-treatments', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-iev1-1.xx.fbcdn.net/v/t39.35426-6/293416340_328639102685012_4355589004297587859_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=QFA492Q5bzQQ7kNvwEUy1W7&_nc_oc=Adp3iTvgtxBQI0-n6V762v6lR8ytZePQK0kIZnWnk0yqcFHh-mDpw0cO1J4eykI8Avw&_nc_zt=14&_nc_ht=scontent-iev1-1.xx&_nc_gid=Om5hlJU8P7spBV6hNIgHIg&_nc_ss=7f289&oh=00_AQFViz5KeH4ySb43UXM3gPCuGU_CwHcL8TIf3cNGNz_QjQ&oe=6A8E06E9', NULL, '2022-07-11T07:00:00.000Z'::timestamptz, NULL, true, 1502, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=569477441497033', 70),
  ('uk-dental', 'dental-implants', 'c:3280155592257439', '3280155592257439', '719866002642451', 1, 1, 'Royal Arsenal Dentists', '1450538395198279', 'Dental Implants', 'Dental implants have given us the opportunity to replace missing or lost teeth with a fixed, comfortable and aesthetically pleasing alternative. Dental implant therapy is considered now to be the gold standard for replacing missing teeth. ✨

Royal Arsenal Dentists brings together
a top team of dentists, hygienists, and dental nursing and care staff. We have a very caring and gentle approach, with particular emphasis on making nervous patients feel at ease. 

At Royal Arsenal Dentists, we offer a free dental implants consultation to asses your dental treatment needs and create a personalised plan. We have a number of options available; more details can be found on our website. 🦷

Call 0208 317 0590 to book your free consultation or book online:
https://www.royalarsenaldentists.com/dental-implants-treatments', 'Book now', 'BOOK_TRAVEL', 'https://www.royalarsenaldentists.com/dental-implants-treatments', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent.flim38-1.fna.fbcdn.net/v/t39.35426-6/292059336_925192871773670_3033898444635381287_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=109&_nc_map=urlgen_bucketless&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=cNUQtaGBGoYQ7kNvwFhHrOo&_nc_oc=AdqWWTw-td0qERK6_m6QXERE5ukciqIOiGns7p-Al1aUmvyNo8xEdTueDecAX661yAA&_nc_zt=14&_nc_ht=scontent.flim38-1.fna&_nc_gid=rfuKqO9u-LekmGwjm2ljRw&_nc_ss=7f180&oh=00_AQHl8UWC731TsjonSDPNnV7A_8YROlEuB-YRUMZnNe_n0A&oe=6A8E04EF', NULL, '2022-07-11T07:00:00.000Z'::timestamptz, NULL, true, 1502, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=719866002642451', 70),
  ('uk-dental', 'dental-implants', 'c:3512233375672808', '3512233375672808', '460325028791394', 1, 1, 'Royal Arsenal Dentists', '1450538395198279', 'Dental Implants', 'Dental implants have given us the opportunity to replace missing or lost teeth with a fixed, comfortable and aesthetically pleasing alternative. Dental implant therapy is considered now to be the gold standard for replacing missing teeth. ✨

Royal Arsenal Dentists brings together
a top team of dentists, hygienists, and dental nursing and care staff. We have a very caring and gentle approach, with particular emphasis on making nervous patients feel at ease. 

At Royal Arsenal Dentists, we offer a free dental implants consultation to asses your dental treatment needs and create a personalised plan. We have a number of options available; more details can be found on our website. 🦷

Call 0208 317 0590 to book your free consultation or book online:
https://www.royalarsenaldentists.com/dental-implants-treatments', 'Book now', 'BOOK_TRAVEL', 'https://www.royalarsenaldentists.com/dental-implants-treatments', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-iev1-1.xx.fbcdn.net/v/t39.35426-6/293191283_753790102706935_6765317994396075405_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=107&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=O8diaK7izyIQ7kNvwEcrw_j&_nc_oc=AdoOYlBMoO_M5bZ7orYKsT2LH19H_LoGiQwJQPsdV6v0Tg5AaVbekZw65Y_5Jd1fOBM&_nc_zt=14&_nc_ht=scontent-iev1-1.xx&_nc_gid=Om5hlJU8P7spBV6hNIgHIg&_nc_ss=7f289&oh=00_AQF4O1Fl36nKPGKFAJLL7PzqN4Ed3_Ho8FfKugaIIMyTdQ&oe=6A8E0B9F', NULL, '2022-07-11T07:00:00.000Z'::timestamptz, NULL, true, 1502, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=460325028791394', 70),
  ('uk-dental', 'dental-implants', 'c:735745864403961', '735745864403961', '742086293603006', 1, 1, 'Royal Arsenal Dentists', '1450538395198279', 'Dental Implants', 'Dental implants have given us the opportunity to replace missing or lost teeth with a fixed, comfortable and aesthetically pleasing alternative. Dental implant therapy is considered now to be the gold standard for replacing missing teeth. ✨

Royal Arsenal Dentists brings together a top team of dentists, hygienists, and dental nursing and care staff. We have a very caring and gentle approach, with particular emphasis on making nervous patients feel at ease. 

At Royal Arsenal Dentists, we offer a free dental implants consultation to asses your dental treatment needs and create a personalised plan. We have a number of options available; more details can be found on our website. 🦷

Call 0208 317 0590 to book your free consultation or book online:
https://www.royalarsenaldentists.com/dental-implants-treatments', 'Learn more', 'LEARN_MORE', 'https://www.royalarsenaldentists.com/dental-implants-treatments', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/293213264_802895431122238_6692709727081129029_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=NkLXTgV5tZkQ7kNvwF6TnYU&_nc_oc=Adq6uTeZSxQFb1Kl6A0NEAK5_-z9wGb5wIdkbHKTfO8bYNUazBNGOOlYXKdjvo0J1Hg&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=o6FehIrb9Ran89Jgowx_hg&_nc_ss=7f180&oh=00_AQHKhDMNdc0DowJxAVrY2WAjEfSzs5nTDenJB3CD1Xdpqw&oe=6A8DFDE7', NULL, '2022-07-11T07:00:00.000Z'::timestamptz, NULL, true, 1502, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=742086293603006', 70),
  ('uk-dental', 'dental-implants', 'c:753745535768604', '753745535768604', '441327174517835', 1, 1, 'Royal Arsenal Dentists', '1450538395198279', 'Dental Implants', 'Dental implants have given us the opportunity to replace missing or lost teeth with a fixed, comfortable and aesthetically pleasing alternative. Dental implant therapy is considered now to be the gold standard for replacing missing teeth. ✨

Royal Arsenal Dentists brings together
a top team of dentists, hygienists, and dental nursing and care staff. We have a very caring and gentle approach, with particular emphasis on making nervous patients feel at ease. 

At Royal Arsenal Dentists, we offer a free dental implants consultation to asses your dental treatment needs and create a personalised plan. We have a number of options available; more details can be found on our website. 🦷

Call 0208 317 0590 to book your free consultation or book online:
https://www.royalarsenaldentists.com/dental-implants-treatments', 'Book now', 'BOOK_TRAVEL', 'https://www.royalarsenaldentists.com/dental-implants-treatments', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent.flim38-1.fna.fbcdn.net/v/t39.35426-6/292725831_1503995910036849_4223737608223363912_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=100&_nc_map=urlgen_bucketless&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=8mMN4HY5CrsQ7kNvwFXK835&_nc_oc=Adr4rw-O-QoYlHbpAk_bYQ2xA2_kPxr3QI22Be6X5cPMyTVccPftxAlE7w8lUbJtTOI&_nc_zt=14&_nc_ht=scontent.flim38-1.fna&_nc_gid=rfuKqO9u-LekmGwjm2ljRw&_nc_ss=7f180&oh=00_AQH8p_kAc2-q3tROgEoTrJneaGVSWF_CfgvxoVtUNP78Hg&oe=6A8E210C', NULL, '2022-07-11T07:00:00.000Z'::timestamptz, NULL, true, 1502, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=441327174517835', 70),
  ('uk-dental', 'dental-implants', 'c:775393227147909', '775393227147909', '1087051445236991', 1, 1, 'Royal Arsenal Dentists', '1450538395198279', 'Dental Implants', 'Dental implants have given us the opportunity to replace missing or lost teeth with a fixed, comfortable and aesthetically pleasing alternative. Dental implant therapy is considered now to be the gold standard for replacing missing teeth. ✨

Royal Arsenal Dentists brings together
a top team of dentists, hygienists, and dental nursing and care staff. We have a very caring and gentle approach, with particular emphasis on making nervous patients feel at ease. 

At Royal Arsenal Dentists, we offer a free dental implants consultation to asses your dental treatment needs and create a personalised plan. We have a number of options available; more details can be found on our website. 🦷

Call 0208 317 0590 to book your free consultation or book online:
https://www.royalarsenaldentists.com/dental-implants-treatments', 'Book now', 'BOOK_TRAVEL', 'https://www.royalarsenaldentists.com/dental-implants-treatments', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent.flim38-1.fna.fbcdn.net/v/t39.35426-6/293187515_615087476482675_3619084780234174227_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=107&_nc_map=urlgen_bucketless&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=mO6m8OUxPaoQ7kNvwEWx11N&_nc_oc=Adpip1EWTqP9QJ3LARFYxFm2Ghz3FTz0Jo1nf6d9BDVMCQH8mBMD1Zaos1_XeppXnEs&_nc_zt=14&_nc_ht=scontent.flim38-1.fna&_nc_gid=rfuKqO9u-LekmGwjm2ljRw&_nc_ss=7f180&oh=00_AQH8mY7o_6AbJ_VZ-mXr3aKDhbx-jc6j6krwiCmREs5uoA&oe=6A8DFB2E', NULL, '2022-07-11T07:00:00.000Z'::timestamptz, NULL, true, 1502, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1087051445236991', 70),
  ('uk-dental', 'general-dentistry', 'c:712020013749089', '712020013749089', '1221535355142707', 1, 1, 'Dr Priscila Kolbe - Dentist', '1758156131139546', NULL, 'Dentistas Brasileiros em Londres - Time Dra Priscila Kolbe 
Todas as especialidades odontológicas disponíveis. WhatsApp 07984397750 WhatsApp link https://bit.ly/2U91jyO', 'Learn more', 'LEARN_MORE', 'https://bit.ly/2U91jyO', 'VIDEO', '["INSTAGRAM"]'::jsonb, 'https://scontent.fgye13-1.fna.fbcdn.net/v/t39.35426-6/326112698_569610334800819_6032640520345839619_n.jpg?_nc_cat=107&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=2wqpw-Xp6YYQ7kNvwE8nD0c&_nc_oc=Adp3t8ga0RP2O4JlWIIBoFQTwxMIIbaAqmfgYetyOposvE_fusE3mO3XcUMzpKY7NNQ&_nc_zt=14&_nc_ht=scontent.fgye13-1.fna&_nc_gid=emrR_i901VgHVlFhkTB0Hw&_nc_ss=7f180&oh=00_AQGUVbMWFlnZoWhL3HKcAknR5k-ERySnbcYmhXeIufsYxA&oe=6A8E2488', NULL, '2023-01-31T08:00:00.000Z'::timestamptz, NULL, true, 1298, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1221535355142707', 70),
  ('uk-dental', 'clear-aligners', 'c:219942594110041', '219942594110041', '813173340484433', 1, 1, 'The Cosmetic Dental Gallery', '474576106422141', NULL, 'Welcome to The Cosmetic Dental Gallery Battersea 🤩

Excited to finally show you a snapshot of our brand new location in Battersea! 

Our full team of specialists are available across both of our Battersea and Greenwich locations. We look forward to providing the same high quality level of service that we have become known for at the new location!

We are grateful to all of our patients who have been part of our journey and look forward to growing The Cosmetic Dental Gallery family ☺️

#cosmeticdentistry #londondentist #porcelainveneers #dentalimplants #batterseapark  #batterseapowerstation #invisalign', 'Learn more', 'LEARN_MORE', 'https://linktr.ee/thecosmeticdentalgallery', 'VIDEO', '["FACEBOOK","INSTAGRAM"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/344853475_777710203679917_7936407781699863148_n.jpg?_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=pICZmbYn3SAQ7kNvwEYzObu&_nc_oc=Adr9q_pxyjalmBzW355HMD1dM-x0A8k-f79DQZet7Hf7y3i1Z2WqlgZnGtw9lKuJeJ4&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=hK0wnCh4-ZnHGpaVllPxrQ&_nc_ss=7f180&oh=00_AQG1QnAp5mBZ5cq_RR4iZkcVO3gYpVtILRi2B_Ym_9pz4A&oe=6A8E09D2', NULL, '2023-05-01T07:00:00.000Z'::timestamptz, NULL, true, 1208, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=813173340484433', 70),
  ('uk-dental', 'clear-aligners', 'c:1315433822511620', '1315433822511620', '596081245878482', 1, 1, 'Putney Hill Dental Practice', '78343603574', 'Putney Hill Dental Practice', 'Transform your smile with our Invisalign experts', 'Book now', 'BOOK_TRAVEL', 'https://www.putneyhilldentalpractice.co.uk/', 'VIDEO', '["FACEBOOK","INSTAGRAM","MESSENGER"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/331009974_847310909698354_847888215483230983_n.jpg?_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=PLhpwC49EEoQ7kNvwFGrpva&_nc_oc=AdozTtJx85AQhhzAS-6PP5gP7JpYn5QnJW4JHS4PwWLwrTKIhd4IJesd6y7DqzHN9ew&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=wf0aSC3W7Vn_Zt_YvdUdWQ&_nc_ss=7f180&oh=00_AQH0e99m4qNjeAk8r1sdxF4lQ-QJUhXJQHWS0jZnZXdzlQ&oe=6A8DF068', NULL, '2023-10-11T07:00:00.000Z'::timestamptz, NULL, true, 1045, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=596081245878482', 70),
  ('uk-dental', 'dental-implants', 'c:1093948688288891', '1093948688288891', '725273589100762', 1, 1, 'Peninsula Dentists', '617135872060564', 'Dental Implants', 'Dental implants have given us the opportunity to replace missing or lost teeth with a fixed, comfortable and aesthetically pleasing alternative. Dental implant therapy is considered now to be the gold standard for replacing missing teeth. ✨

Peninsula Dentists is an independent private dental practice offering exceptionally high standards of dental care. We are conveniently located in the heart of Greenwich Peninsula, one of London’s most exciting districts, minutes walk from the O2 Arena.

At Peninsula Dentists, we offer a free dental implants consultation to asses your dental treatment needs and create a personalised plan. We have a number of options available; more details can be found on our website. 🦷

Call 0208 788 6688 to book your free consultation or book online:
https://www.peninsuladentists.co.uk/dental-implants', 'Book now', 'BOOK_TRAVEL', 'https://www.peninsuladentists.co.uk/dental-implants', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent.flim38-1.fna.fbcdn.net/v/t39.35426-6/293226390_467925415069047_1530694928072250940_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&_nc_map=urlgen_bucketless&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=6dLFliPNU_oQ7kNvwGzqEVz&_nc_oc=AdqZfQu0-RpUU77MIJG_IAIBiVUExMf58i3u9-bk-j5bU7hvXmjiBOCTqVcXxEsELyQ&_nc_zt=14&_nc_ht=scontent.flim38-1.fna&_nc_gid=rfuKqO9u-LekmGwjm2ljRw&_nc_ss=7f180&oh=00_AQGhwr3SV9pMNk-pc1Xsfh_Kmf-x5TEtpHhm9Rz3gM2HNA&oe=6A8E0B05', NULL, '2023-11-30T08:00:00.000Z'::timestamptz, NULL, true, 995, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=725273589100762', 70),
  ('uk-dental', 'dental-implants', 'c:2019101931787974', '2019101931787974', '1158313078479884', 1, 1, 'Peninsula Dentists', '617135872060564', 'Dental Implants', 'Dental implants have given us the opportunity to replace missing or lost teeth with a fixed, comfortable and aesthetically pleasing alternative. Dental implant therapy is considered now to be the gold standard for replacing missing teeth. ✨

Peninsula Dentists is an independent private dental practice offering exceptionally high standards of dental care. We are conveniently located in the heart of Greenwich Peninsula, one of London’s most exciting districts, minutes walk from the O2 Arena.

At Peninsula Dentists, we offer a free dental implants consultation to asses your dental treatment needs and create a personalised plan. We have a number of options available; more details can be found on our website. 🦷

Call 0208 788 6688 to book your free consultation or book online:
https://www.peninsuladentists.co.uk/dental-implants', 'Book now', 'BOOK_TRAVEL', 'https://www.peninsuladentists.co.uk/dental-implants', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/293131513_393362942648136_452030507565050842_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=ElJY7mA6v5wQ7kNvwEkqEtm&_nc_oc=AdqPBr8OospYZ5Hn4d1runHTIVxlUWl9rfbw29ecIa9QQyj4Fl9_wl2JsyYtsYWBsIE&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=p2O8NERZO-1BPD76kiUpVA&_nc_ss=7f180&oh=00_AQEU1CKZ9d-a72atE2sqY-gub6vMJQLH_BfZLWO6oIYW9g&oe=6A8E1D1F', NULL, '2023-11-30T08:00:00.000Z'::timestamptz, NULL, true, 995, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1158313078479884', 70),
  ('uk-dental', 'dental-implants', 'c:232188509892812', '232188509892812', '3599371770350803', 1, 1, 'Peninsula Dentists', '617135872060564', 'Dental Implants', 'Dental implants have given us the opportunity to replace missing or lost teeth with a fixed, comfortable and aesthetically pleasing alternative. Dental implant therapy is considered now to be the gold standard for replacing missing teeth. ✨

Peninsula Dentists is an independent private dental practice offering exceptionally high standards of dental care. We are conveniently located in the heart of Greenwich Peninsula, one of London’s most exciting districts, minutes walk from the O2 Arena.

At Peninsula Dentists, we offer a free dental implants consultation to asses your dental treatment needs and create a personalised plan. We have a number of options available; more details can be found on our website. 🦷

Call 0208 788 6688 to book your free consultation or book online:
https://www.peninsuladentists.co.uk/dental-implants', 'Book now', 'BOOK_TRAVEL', 'https://www.peninsuladentists.co.uk/dental-implants', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/293137023_606907027383404_7223661809986927465_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=TCPxb8pjwfQQ7kNvwEol9yK&_nc_oc=AdoF70QHptNMKq012-5cF8Iy1QQroKvA5MrgUzY74zPRYYsR9pdbewonbMViywseD_s&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=Dy9tIO28iR4X5FSWAQFE1g&_nc_ss=7f180&oh=00_AQF9jp9FO5gpFYCN8cK9XfkJVRMgyIUkFky8gjeSWEyCKQ&oe=6A8DFC31', NULL, '2023-11-30T08:00:00.000Z'::timestamptz, NULL, true, 995, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=3599371770350803', 70),
  ('uk-dental', 'dental-implants', 'c:250238967806691', '250238967806691', '883522312990062', 1, 1, 'Peninsula Dentists', '617135872060564', 'Dental Implants', 'Dental implants have given us the opportunity to replace missing or lost teeth with a fixed, comfortable and aesthetically pleasing alternative. Dental implant therapy is considered now to be the gold standard for replacing missing teeth. ✨

Peninsula Dentists is an independent private dental practice offering exceptionally high standards of dental care. We are conveniently located in the heart of Greenwich Peninsula, one of London’s most exciting districts, minutes walk from the O2 Arena.

At Peninsula Dentists, we offer a free dental implants consultation to asses your dental treatment needs and create a personalised plan. We have a number of options available; more details can be found on our website. 🦷

Call 0208 788 6688 to book your free consultation or book online:
https://www.peninsuladentists.co.uk/dental-implants', 'Book now', 'BOOK_TRAVEL', 'https://www.peninsuladentists.co.uk/dental-implants', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/293036616_723814035369266_6493908997719142420_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=tFLHSometNkQ7kNvwHkIBuS&_nc_oc=AdqFbrOiQqgcDfL51MHpwerQafTbKiroMWYdtE5u9FRDvf5a3-voY6Txu6YMDFrTeFg&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=2Xvb3BMT26XOM1tSMC08iw&_nc_ss=7f180&oh=00_AQEZCf-yUjxdhut0UaYrOFcpOnkak3Fe8ucpVeaDnABHNw&oe=6A8E0FEF', NULL, '2023-11-30T08:00:00.000Z'::timestamptz, NULL, true, 995, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=883522312990062', 70),
  ('uk-dental', 'dental-implants', 'c:269758985680930', '269758985680930', '1107374960161527', 1, 1, 'Peninsula Dentists', '617135872060564', 'Dental Implants', 'Dental implants have given us the opportunity to replace missing or lost teeth with a fixed, comfortable and aesthetically pleasing alternative. Dental implant therapy is considered now to be the gold standard for replacing missing teeth. ✨

Peninsula Dentists is an independent private dental practice offering exceptionally high standards of dental care. We are conveniently located in the heart of Greenwich Peninsula, one of London’s most exciting districts, minutes walk from the O2 Arena.

At Peninsula Dentists, we offer a free dental implants consultation to asses your dental treatment needs and create a personalised plan. We have a number of options available; more details can be found on our website. 🦷

Call 0208 788 6688 to book your free consultation or book online:
https://www.peninsuladentists.co.uk/dental-implants', 'Book now', 'BOOK_TRAVEL', 'https://www.peninsuladentists.co.uk/dental-implants', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/292552573_1426563424472193_4065501372435121328_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=111&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=HzIsXujLRL4Q7kNvwFa_rYB&_nc_oc=AdrRD9ag-8RbRwjRXtmmxPlN5iO9f_DSvFnS74Auk2ZxLzu4-ExkZGfdTKtEWiVQaaA&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=Dy9tIO28iR4X5FSWAQFE1g&_nc_ss=7f180&oh=00_AQHxw2gL2X_n68UPY5szpZqFTF_TOk-06IoQzDy_NTxHXA&oe=6A8DF79A', NULL, '2023-11-30T08:00:00.000Z'::timestamptz, NULL, true, 995, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1107374960161527', 70),
  ('uk-dental', 'dental-implants', 'c:659698389582157', '659698389582157', '1000764471222908', 1, 1, 'Peninsula Dentists', '617135872060564', 'Dental Implants', 'Dental implants have given us the opportunity to replace missing or lost teeth with a fixed, comfortable and aesthetically pleasing alternative. Dental implant therapy is considered now to be the gold standard for replacing missing teeth. ✨

Peninsula Dentists is an independent private dental practice offering exceptionally high standards of dental care. We are conveniently located in the heart of Greenwich Peninsula, one of London’s most exciting districts, minutes walk from the O2 Arena.

At Peninsula Dentists, we offer a free dental implants consultation to asses your dental treatment needs and create a personalised plan. We have a number of options available; more details can be found on our website. 🦷

Call 0208 788 6688 to book your free consultation or book online:
https://www.peninsuladentists.co.uk/dental-implants', 'Book now', 'BOOK_TRAVEL', 'https://www.peninsuladentists.co.uk/dental-implants', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/293173326_1263863847754800_6673545526288869037_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=104&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=CG-wamoQjfwQ7kNvwGmzQZN&_nc_oc=AdpUnfStN5FtBO5seYl6gl6klEecoRoQWofMJ8i7XTcb5YiDsiOtMRdVEbXclGS3-tE&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=EQCkvJeRluYC8slB5C7Cxw&_nc_ss=7f180&oh=00_AQERzL2EdtzEYjSU07aVm5kcKbtL0IR9KrssfYmY3DwNCQ&oe=6A8E0BAF', NULL, '2023-11-30T08:00:00.000Z'::timestamptz, NULL, true, 995, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1000764471222908', 70),
  ('uk-dental', 'dental-implants', 'c:7783510478342164', '7783510478342164', '665467608785156', 1, 1, 'Peninsula Dentists', '617135872060564', 'Dental Implants', 'Dental implants have given us the opportunity to replace missing or lost teeth with a fixed, comfortable and aesthetically pleasing alternative. Dental implant therapy is considered now to be the gold standard for replacing missing teeth. ✨

Peninsula Dentists is an independent private dental practice offering exceptionally high standards of dental care. We are conveniently located in the heart of Greenwich Peninsula, one of London’s most exciting districts, minutes walk from the O2 Arena.

At Peninsula Dentists, we offer a free dental implants consultation to asses your dental treatment needs and create a personalised plan. We have a number of options available; more details can be found on our website. 🦷

Call 0208 788 6688 to book your free consultation or book online:
https://www.peninsuladentists.co.uk/dental-implants', 'Book now', 'BOOK_TRAVEL', 'https://www.peninsuladentists.co.uk/dental-implants', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent.fros8-1.fna.fbcdn.net/v/t39.35426-6/293277312_786943992684092_7629631564854205657_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=107&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=Jh4KyQDQBNkQ7kNvwF11UZi&_nc_oc=Adp3AEhVN2jq9Hsy2lQqXDsQJAgqhGViFKGCPH2xudwlX8t_Gx0MTYvPg-I1AnTNxOc&_nc_zt=14&_nc_ht=scontent.fros8-1.fna&_nc_gid=Dy9tIO28iR4X5FSWAQFE1g&_nc_ss=7f180&oh=00_AQEFkcJimR6-krZgyMWz6lkpOwRTsB7rZ-SHM7fXufvb5w&oe=6A8E19C2', NULL, '2023-11-30T08:00:00.000Z'::timestamptz, NULL, true, 995, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=665467608785156', 70),
  ('uk-dental', 'dental-implants', 'c:694983636018755', '694983636018755', '1182555519402659', 1, 1, 'Bethcar Dental Practice', '182147401993840', 'Replace missing teeth permanently', 'Helping people in Ebbw Vale eat, chew and smile again with confidence

Join us for a FREE Dental Implant Consultation

How good does this sound? People with implants can:

✔️ Choose what they want again from the menu at their favourite restaurant
✔️ Stop finishing last every meal time 
✔️ Restore the strength of their bite
✔️ Enjoy a natural smile

Find out whether dental implants could help and get a free consultation with our treatment co-ordinator - get a smile scan, treatment options and monthly payment options.

Start by telling us how we can help you below', 'Book now', 'BOOK_TRAVEL', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent.flim28-1.fna.fbcdn.net/v/t39.35426-6/436418036_2178116122532475_827622545977297555_n.jpg?_nc_cat=104&_nc_map=urlgen_bucketless&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=C73ATmojCPkQ7kNvwHa0yXf&_nc_oc=AdqGffazXurhHooS-thDlTth-MNmceWt7F6gCbOznDM7IMGXZB16gUbgb-odi9JK0Zw&_nc_zt=14&_nc_ht=scontent.flim28-1.fna&_nc_gid=LwJ-qvxpFRcM9_D3tcwiNA&_nc_ss=7f180&oh=00_AQHPS3a5Mx899KhQ6rKKU5LIlOydyRzWF8j6nqXQgCBPAA&oe=6A8E095A', NULL, '2024-05-07T07:00:00.000Z'::timestamptz, NULL, true, 836, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1182555519402659', 70),
  ('uk-dental', 'dental-implants', 'c:8351120048245419', '8351120048245419', '3818970271692681', 1, 1, 'Solihull Dental Centre & Implant Clinic', '382671035206133', NULL, 'Here at Solihull Dental Centre & Implant Clinic we will be having an open day for patients interested in dental implants soon. 

Dental implants can be a great way to replace missing teeth and restore smiles. 

Keep an eye on our social media for more information soon...

#dentalimplanttreatment #dentalimplants #solihull', 'Learn more', 'LEARN_MORE', 'http://www.solihulldentalcentre.co.uk/', 'IMAGE', '["INSTAGRAM"]'::jsonb, 'https://scontent.flim28-1.fna.fbcdn.net/v/t39.35426-6/449363382_511288084555043_8765715383967695083_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=111&_nc_map=urlgen_bucketless&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=ZxYIjXS6JjIQ7kNvwFALAvN&_nc_oc=Adql8OXN_hLA6AJ8hQC-_A08qdfQiWvWZkowuZLP29flFFk-KomJjqeFF4jurYGgkE4&_nc_zt=14&_nc_ht=scontent.flim28-1.fna&_nc_gid=LwJ-qvxpFRcM9_D3tcwiNA&_nc_ss=7f180&oh=00_AQH6zfUvyqH1CVER_pr8TFRMsReDaXXGAA0t34J94SKqJg&oe=6A8E01A3', NULL, '2024-06-27T07:00:00.000Z'::timestamptz, NULL, true, 785, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=3818970271692681', 70),
  ('uk-dental', 'clear-aligners', 'c:457452140325513', '457452140325513', '1920864728366243', 1, 1, 'Pure Dental Aesthetic Clinic - Dr Parveen Dehal', '100979502354916', NULL, 'Are you travelling a lot between Dubai and London?
Are you looking for a high-quality dentist?

If the answer is YES, then Dr Parveen could well be the dentist for you! He is a highly commended Cosmetic Dentist based in both London and Dubai 🌍

________________________

🤳DM for your Pure New Smile
📍London 🇬🇧 Dubai 🇦🇪
_________________________

💳 0% finance available 
_________________________

🗓 Evening & Weekend Appointments 
_________________________________

#dentist #dentistdubai #londondentist #instadentist #dentistdubaiveneers #invisaligndubai #invisalignlondon #invisalign #invisalignsmile #teethwhitening #invisaligndoctor #dentist #dubaidentist #dubaidentistry #compositebondinglondon #compositeveneers #veneers #naturalsmile #perfectsmile', 'Send message', 'INSTAGRAM_MESSAGE', 'http://instagram.com/drparvdehal', 'VIDEO', '["INSTAGRAM"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/449447116_2752207681623868_1176415435879049023_n.jpg?_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=08PXyKC0278Q7kNvwGtrOom&_nc_oc=Adokyf7rXsZWmWU3NOlTwng3Xwg9sX2uSy5hvaDxTEenedBHScsKK9rARVrxLPzSIjI&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=zCfx1dDK0SF9hZPrG9A9TA&_nc_ss=7f180&oh=00_AQEq25EVM-9j0Jq-QzEZ_Xg5vAwkhZbsrh4G3N5hvFHFhQ&oe=6A8E0E4F', NULL, '2024-06-30T07:00:00.000Z'::timestamptz, NULL, true, 782, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1920864728366243', 70),
  ('uk-dental', 'general-dentistry', 'c:3793985007510094', '3793985007510094', '423226436757927', 1, 1, 'OG Dental Clinic Turkey by Dr.OG', '290961891805083', 'OG Dental Clinic - Award Winning Dental Clinic', 'OG Dental Clinic was founded by Dr. OG who has 30+ years of experiences. We have 10 dental units within more than 80 staff with 1000m2 medical facility. 

Our patient Carlene visited us from Scotland and we made OG smile for her. Let''s here her whole story now! 

If you are interested, take your free online consultation 
+49 178 3233900', 'Get quote', 'GET_QUOTE', 'https://ozanguner.eu/prices/', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent.flju2-3.fna.fbcdn.net/v/t39.35426-6/454480334_2373838956295718_803355754604097633_n.jpg?_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=MCtLcWXYdoIQ7kNvwG__Hlm&_nc_oc=Ado01gAuXm2ewcMsJbpMppUVDyNYazamnk7xPJ2JVSxqq4WISxbkrCURWkTEm41ehCQ&_nc_zt=14&_nc_ht=scontent.flju2-3.fna&_nc_gid=DOPf2uIPcoQFjP_LrhN-rg&_nc_ss=7f289&oh=00_AQGPX2zL0FS7eOugK0DLDhLOUU05uUDfEmA8lTLjKQ6xFQ&oe=6A8DFE54', NULL, '2024-08-08T07:00:00.000Z'::timestamptz, NULL, true, 743, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=423226436757927', 70),
  ('uk-dental', 'clear-aligners', 'c:1577645826434369', '1577645826434369', '8167850606594924', 1, 1, 'Loughborough Orthodontic and Implant Clinic', '209400749742127', 'Book Your Free Consultation Today!', '🌟 Get a Free Consultation at Loughborough Orthodontics! 🌟

Transform your smile with our expert team and a variety of braces options, including Invisalign and lingual braces.

👨‍⚕️ Meet Dr. Gosal and our award-winning team with over 15 years of experience.

⚠️ Limited Time Offer - Book Your Free Consultation Today!', 'Book now', 'BOOK_TRAVEL', 'https://www.loughboroughorthodontics.co.uk/treatments/invisalign/invisalign/?utm_source=facebook&utm_medium=ad&utm_campaign=free_consult', 'IMAGE', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent-sof1-2.xx.fbcdn.net/v/t39.35426-6/455312646_1721249198413173_8755087345248012919_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=109&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=KNsupdkGDC8Q7kNvwFkc57s&_nc_oc=AdrtIM9u-qeWtdG_ZoM-N19T_xIISAqaV7ogwHKki5Rcxzr69UM4WVCw6fRE7KPDv20&_nc_zt=14&_nc_ht=scontent-sof1-2.xx&_nc_gid=zCfx1dDK0SF9hZPrG9A9TA&_nc_ss=7f180&oh=00_AQF4juoXUBroPs2lVw3hOz2MmwEoAxY4MHeGilYxNxAgRg&oe=6A8E24D0', NULL, '2024-08-14T07:00:00.000Z'::timestamptz, NULL, true, 737, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=8167850606594924', 70),
  ('uk-dental', 'teeth-whitening', 'c:264953142700193', '264953142700193', '1684545458961008', 1, 1, 'HeySmile', '104772415344087', 'UK''s #1 teeth whitening strips', 'Incredible teeth whitening results from our best-selling strips 🦷', 'Shop now', 'SHOP_NOW', 'https://heysmileteeth.com/products/whitening-strips', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK","MESSENGER"]'::jsonb, 'https://scontent.fmdq6-1.fna.fbcdn.net/v/t39.35426-6/435720693_443981278092861_1870219430628246765_n.jpg?_nc_cat=107&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=zMgmL3-nrwAQ7kNvwHYp9Vw&_nc_oc=AdqtQpEyGyRoAcd_iifgggXQifo7M8NAX-E647Grw0rzQCSKgcTjYGaBOPoPcKXAmcI&_nc_zt=14&_nc_ht=scontent.fmdq6-1.fna&_nc_gid=ngoDskApBw3OCz4ttP54OA&_nc_ss=7f180&oh=00_AQF1643OLaHFH_Z1v15E1WGKcx9l5XzExbRFQWwpOQUq2w&oe=6A8E16CC', NULL, '2024-08-17T07:00:00.000Z'::timestamptz, NULL, true, 734, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1684545458961008', 70),
  ('uk-dental', 'general-dentistry', 'c:3666711006911825', '3666711006911825', '8010257845689680', 1, 1, 'The Seapoint Clinic', '83627051915', 'The Seapoint Clinic', 'At The Seapoint Clinic, whatever your dental needs we have you covered, with our two convenient Dublin locations.', 'Send message', 'MESSAGE_PAGE', NULL, 'IMAGE', '["FACEBOOK","INSTAGRAM","MESSENGER"]'::jsonb, 'https://scontent-ord5-1.xx.fbcdn.net/v/t39.35426-6/456908561_3831846897058708_2052194320074452059_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=109&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=M3SaQ5ywnP4Q7kNvwGM60Jj&_nc_oc=AdqmxNNOIfCwJYsaRANxoi8eUVexlNvq0iU6eHrsQn6ExdjQedOYOX_9iRldJIez8hnz8ptQaUPnGJE5_cdIq_Wz&_nc_zt=14&_nc_ht=scontent-ord5-1.xx&_nc_gid=cYlHpVB0lkgKb8IZ9-zslQ&_nc_ss=7f180&oh=00_AQFj0SW9WDu6o4-YfcHsGmP-kjpBeQYl0WFs2Qwo3iqCYA&oe=6A8E041B', NULL, '2024-08-27T07:00:00.000Z'::timestamptz, NULL, true, 724, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=8010257845689680', 70),
  ('uk-dental', 'clear-aligners', 'c:850172434702720', '850172434702720', '3002656429872061', 1, 1, 'Dentudio Dentists', '291189588024730', 'Straighten Your Smile with Advanced Invisalign Technology', 'At Dentudio Dentists, we combine cutting-edge technology with personalized care to bring you the best in teeth straightening solutions. Invisalign clear aligners are nearly invisible and tailored just for you, offering a more comfortable and convenient alternative to traditional braces. Ready to transform your smile? Book your Invisalign consultation today!

🦷 www.dentudio.com
📞 604-370-1450
📍 5555 Gilbert Rd. #145, Richmond, BC', 'Learn more', 'LEARN_MORE', 'https://www.dentudio.com/invisalign', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent-sof1-1.xx.fbcdn.net/v/t39.35426-6/463756005_569329425826685_3924089670093525354_n.jpg?_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=l5tQPyY2logQ7kNvwF7jHTT&_nc_oc=AdqdrE2lOtmN2uCZdea3sJy8GVYgJY_udJvB0lj517M61dmGh9h8dQA_Ed1nGSnbY4c&_nc_zt=14&_nc_ht=scontent-sof1-1.xx&_nc_gid=JSDwr_I8skxMawj6IQij7A&_nc_ss=7f180&oh=00_AQFHDqc-NdoC1yXfoNQbWfN6xnfddUCZmLKB6KCyOMFouQ&oe=6A8E0FF2', NULL, '2024-10-18T07:00:00.000Z'::timestamptz, NULL, true, 672, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=3002656429872061', 70),
  ('uk-dental', 'veneers', 'c:1604344423802734', '1604344423802734', '27606871388927544', 1, 1, 'Brilliant Dental Care by Ruth Morris', '1374383919538509', 'Book Your FREE Smile Design Appointment Now', 'Looking for a Dentist in Talbot Green? 🦷
Here at Brilliant Dental we are offering FREE consultations for a limited time 🤫

Get all of your questions answered and find out how to create the perfect smile ✅

👉What is composite bonding?
👉Understand the process
👉Get a feel for the price
👉Discover the best treatment for you

Click Book Now to schedule your FREE appointment 🤯', 'Book now', 'BOOK_TRAVEL', 'http://fb.me/', 'VIDEO', '["FACEBOOK","INSTAGRAM","AUDIENCE_NETWORK"]'::jsonb, 'https://scontent-waw2-2.xx.fbcdn.net/v/t39.35426-6/466736650_572093881863157_1540246561503155865_n.jpg?_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=GE-wa0JdUGQQ7kNvwGFHkyT&_nc_oc=AdqAhTsfiIQVkFdRkZgW8q8i0vxyYDGvcUMxWyfa_GcUMmr4kslBypBFOUEDD_PjQcM&_nc_zt=14&_nc_ht=scontent-waw2-2.xx&_nc_gid=nRUk7PO33FQscFZnhYDpNQ&_nc_ss=7f289&oh=00_AQHhtfeq1NhAcO75qcH5lpM1hNISXHcClMBx3A2nuknx-Q&oe=6A8E0819', NULL, '2024-11-14T08:00:00.000Z'::timestamptz, NULL, true, 645, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=27606871388927544', 70),
  ('uk-dental', 'general-dentistry', 'c:3902495446670865', '3902495446670865', '1985383431985014', 1, 1, 'Toothbeary', '378554822679483', 'Toothbeary', 'Toothbeary is an award-winning private children’s dentist based in Richmond, Twickenham designed to appeal to youngsters of all ages with a fun, welcoming atmosphere, lots of colour & child-friendly benches.', 'Learn more', 'LEARN_MORE', 'https://www.toothbeary.co.uk/', 'VIDEO', '["FACEBOOK","INSTAGRAM","MESSENGER"]'::jsonb, 'https://scontent.fgye13-1.fna.fbcdn.net/v/t39.35426-6/477921651_999923988861164_7058355521669473788_n.jpg?_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=_6DJm7FuEXEQ7kNvwG0Du6k&_nc_oc=Ado3a0UKjMO-Kgva9J66TsYeD9HXO6SnEjh51L99VIr2EM8xYBrR0CzUpqaCvmneF9E&_nc_zt=14&_nc_ht=scontent.fgye13-1.fna&_nc_gid=emrR_i901VgHVlFhkTB0Hw&_nc_ss=7f180&oh=00_AQGi7YfykdFCZ7YZ80t4Ejmgktkzv9FN-1vy2IALyP1gNw&oe=6A8DFE35', NULL, '2025-02-13T08:00:00.000Z'::timestamptz, NULL, true, 554, '["UNKNOWN"]'::jsonb, 'https://www.facebook.com/ads/library/?id=1985383431985014', 70)
on conflict (niche, dedup_key) do update set
  keyword = excluded.keyword,
  collation_id = excluded.collation_id,
  ad_archive_id = excluded.ad_archive_id,
  collation_count = excluded.collation_count,
  variant_count = excluded.variant_count,
  page_name = excluded.page_name,
  page_id = excluded.page_id,
  title = excluded.title,
  body_text = excluded.body_text,
  cta_text = excluded.cta_text,
  cta_type = excluded.cta_type,
  link_url = excluded.link_url,
  display_format = excluded.display_format,
  publisher_platform = excluded.publisher_platform,
  image_url = excluded.image_url,
  currency = excluded.currency,
  start_date = excluded.start_date,
  end_date = excluded.end_date,
  is_active = excluded.is_active,
  runtime_days = excluded.runtime_days,
  categories = excluded.categories,
  ad_library_url = excluded.ad_library_url,
  winning_score = excluded.winning_score,
  updated_at = now();
