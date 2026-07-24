// Ported CSS for the bespoke Vitality Dental Invisalign landing page.
//
// This is the hand-authored design's stylesheet, transplanted verbatim from the
// source template EXCEPT that every selector is scoped under the single root
// wrapper class `.vd-landing`, and the CSS custom properties (which the source set
// on :root) are set on `.vd-landing` itself. Scoping this way is deliberate: the
// public /go page renders inside the app shell, and this design is a full re-skin
// (its own reset, its own `header`/`section`/`footer` element styles). Prefixing
// guarantees none of it can leak into or collide with the app's global styles, and
// nothing from the app leaks in (the reset re-establishes the design's baseline).
//
// Injected once as an inline <style> at the top of the wrapper (see the component).
// The blocks the compliance edit removed from the design (the reviews wall, the
// clinician quote, the placeholder star ratings, the dev preview flag) have their
// now-unused rules omitted; a few form-interaction rules the embedded consultation
// form needs (channel selector, consent row, error + success states) are added at
// the end, in the same prefixed style.

export const VITALITY_INVISALIGN_CSS = `
.vd-landing{
  --navy:#0b2049; --chrome-from:#082249; --chrome-mid:#0f3670; --chrome-to:#16559a;
  --blue:#16559a; --blue-deep:#1a648f; --blue-light:#5bc4f7; --blue-royal:#16559a;
  --frame:#c3d7ef; --blue-soft:#eef4fb; --blue-chip:#dce9fb;
  --light:#f2f7fd; --panel:#ffffff; --panel-2:#f7fafe;
  --tx:#16233f; --tx-soft:#53607c; --tx-faint:#8b96ad;
  --line:#e2e9f4;
  --tx-on:#eaf1fb; --tx-on-soft:#a9c1e2; --line-d:rgba(255,255,255,.11);
  --r:16px;
  box-sizing:border-box;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:var(--navy);color:var(--tx);line-height:1.6;-webkit-font-smoothing:antialiased;
}
.vd-landing *{box-sizing:border-box;margin:0;padding:0}
.vd-landing img{max-width:100%;display:block}
.vd-landing .wrap{max-width:1180px;margin:0 auto;padding:0 30px}
.vd-landing .eyebrow{font-size:12px;letter-spacing:.2em;text-transform:uppercase;font-weight:700;color:var(--blue-deep)}
.vd-landing h1,.vd-landing h2,.vd-landing h3{letter-spacing:-.02em;text-wrap:balance;font-weight:800}
.vd-landing .btn-blue{display:inline-block;background:var(--blue);color:#fff;font-weight:700;font-size:15px;padding:15px 26px;border-radius:12px;border:0;cursor:pointer;letter-spacing:.01em;box-shadow:0 8px 22px rgba(22,85,154,.28);text-decoration:none;text-align:center}
.vd-landing .btn-blue.block{display:block;width:100%;text-align:center}
.vd-landing .btn-blue[disabled]{opacity:.6;cursor:not-allowed}
.vd-landing section{scroll-margin-top:80px}

/* header */
.vd-landing header{position:sticky;top:0;z-index:30;background:rgba(255,255,255,.92);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.vd-landing header .wrap{display:flex;align-items:center;justify-content:space-between;height:74px;gap:20px}
.vd-landing .brand{display:flex;align-items:center;gap:11px}
.vd-landing .brand img{height:40px;width:40px;object-fit:contain}
.vd-landing .brand b{color:var(--navy);font-size:16px;letter-spacing:.02em}
.vd-landing .brand span{display:block;font-size:9px;letter-spacing:.3em;color:var(--blue);font-weight:700;margin-top:1px}
.vd-landing .locs{color:var(--tx-soft);font-size:13.5px;font-weight:500;display:flex;align-items:center;gap:8px}
.vd-landing .locs .pin{color:var(--blue)}
.vd-landing header .btn-blue{padding:12px 22px;font-size:14px}
@media(max-width:900px){.vd-landing .locs{display:none}}

/* hero */
.vd-landing .hero{background:linear-gradient(160deg,var(--chrome-from),var(--chrome-mid) 58%,var(--chrome-to));padding:74px 0 90px;position:relative;overflow:hidden}
.vd-landing .hero .glow{position:absolute;top:-15%;right:-8%;width:62%;height:90%;background:radial-gradient(circle,rgba(91,196,247,.20),transparent 62%);pointer-events:none}
.vd-landing .hero .grid{position:relative;display:grid;grid-template-columns:1fr 440px;gap:64px;align-items:center}
.vd-landing .hero .eyebrow{color:var(--blue-light)}
.vd-landing .hero h1{color:#fff;font-size:56px;line-height:1.04;margin:22px 0 0}
.vd-landing .hero h1 .acc{color:var(--blue-light)}
.vd-landing .hero .lede{color:var(--tx-on-soft);font-size:18px;line-height:1.6;margin-top:22px;max-width:46ch}
.vd-landing .pills{display:flex;flex-wrap:wrap;gap:12px;margin-top:30px}
.vd-landing .pill{display:inline-flex;align-items:center;gap:9px;border:1px solid var(--line-d);background:rgba(255,255,255,.05);color:var(--tx-on);font-size:14px;font-weight:600;padding:11px 18px;border-radius:999px}
.vd-landing .pill .ck{color:var(--blue-light);font-weight:800}
.vd-landing .trust{display:flex;gap:44px;margin-top:44px;padding-top:30px;border-top:1px solid var(--line-d)}
.vd-landing .trust b{display:block;color:#fff;font-size:30px;font-weight:800;letter-spacing:-.02em}
.vd-landing .trust span{display:block;color:var(--tx-on-soft);font-size:11px;letter-spacing:.13em;text-transform:uppercase;font-weight:700;margin-top:4px}
.vd-landing .form{background:#fff;border-radius:20px;padding:34px 32px;box-shadow:0 30px 80px rgba(4,16,44,.5)}
.vd-landing .form .fe{font-size:11.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--blue);font-weight:800}
.vd-landing .form h3{color:var(--navy);font-size:25px;line-height:1.12;margin:9px 0 6px}
.vd-landing .form p{color:var(--tx-soft);font-size:14px}
.vd-landing .form p b{color:var(--blue);font-weight:800}
.vd-landing .form .field{width:100%;border:1px solid var(--line);background:var(--panel-2);border-radius:11px;padding:14px 15px;font-size:14.5px;color:var(--tx);margin-top:12px;font-family:inherit}
.vd-landing .form .field::placeholder{color:var(--tx-faint)}
.vd-landing .form .btn-blue{margin-top:15px}
.vd-landing .form .fine{text-align:center;font-size:11.5px;color:var(--tx-faint);margin-top:13px;line-height:1.4}
@media(max-width:940px){.vd-landing .hero .grid{grid-template-columns:1fr;gap:40px}.vd-landing .hero h1{font-size:40px}}

/* light sections */
.vd-landing .lt{background:var(--light);color:var(--tx);padding:84px 0}
.vd-landing .lt.alt{background:var(--panel)}
.vd-landing .sec-head{max-width:760px}
.vd-landing .sec-head.center{margin:0 auto;text-align:center}
.vd-landing .sec-head h2{font-size:40px;line-height:1.1;margin-top:12px;color:var(--navy)}
.vd-landing .sec-head p{color:var(--tx-soft);font-size:16px;margin-top:14px}
.vd-landing .split-head{display:grid;grid-template-columns:1fr 340px;gap:40px;align-items:end}
.vd-landing .split-head h2{font-size:40px;line-height:1.1;margin-top:12px;color:var(--navy)}
.vd-landing .split-head p{color:var(--tx-soft);font-size:15.5px}
@media(max-width:820px){.vd-landing .split-head{grid-template-columns:1fr;gap:16px}.vd-landing .sec-head h2{font-size:30px}.vd-landing .split-head h2{font-size:30px}}

.vd-landing .stories{display:grid;grid-template-columns:repeat(3,1fr);gap:26px;margin-top:44px}
.vd-landing .story .ph{aspect-ratio:3/4;border-radius:16px;background:linear-gradient(160deg,#e7eefb,#d3e1f6);position:relative;overflow:hidden;display:grid;place-items:center}
.vd-landing .story .ph .tag{position:absolute;left:16px;bottom:16px;background:var(--blue);color:#fff;font-size:11px;font-weight:800;letter-spacing:.06em;padding:5px 12px;border-radius:999px;text-transform:uppercase;z-index:2}
.vd-landing .story .ph img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 30%}
.vd-landing .story .ph.has-photo{border:none;background:#0b2049}
@media(max-width:820px){.vd-landing .stories{grid-template-columns:1fr}}

.vd-landing .cards6{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:44px}
.vd-landing .pcard{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:26px}
.vd-landing .lt.alt .pcard{background:var(--light)}
.vd-landing .pcard .ic{width:46px;height:46px;border-radius:12px;background:var(--blue-soft);display:grid;place-items:center;color:var(--blue);margin-bottom:16px}
.vd-landing .pcard .ic svg{width:23px;height:23px;display:block}
.vd-landing .pcard h4{font-size:18px;color:var(--navy);margin-bottom:7px}
.vd-landing .pcard p{color:var(--tx-soft);font-size:14px}
.vd-landing .banner{margin-top:34px;background:linear-gradient(150deg,var(--chrome-from),var(--chrome-to));color:#fff;border-radius:16px;padding:34px 40px;text-align:center;font-size:21px;font-weight:700;line-height:1.4}
.vd-landing .banner .acc{color:var(--blue-light)}
@media(max-width:820px){.vd-landing .cards6{grid-template-columns:1fr}}

.vd-landing .tpanel{background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:38px;margin-top:34px;display:grid;grid-template-columns:1fr 320px;gap:36px}
.vd-landing .tpanel h3{font-size:24px;color:var(--navy);margin-bottom:14px}
.vd-landing .tpanel p{color:var(--tx-soft);font-size:15px;line-height:1.7}
.vd-landing .facts{background:linear-gradient(160deg,var(--chrome-from),var(--chrome-mid));border-radius:16px;padding:26px}
.vd-landing .facts .fe{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--blue-light);font-weight:800}
.vd-landing .facts ul{list-style:none;margin-top:14px}
.vd-landing .facts li{display:flex;gap:11px;align-items:flex-start;color:var(--tx-on);font-size:14.5px;font-weight:600;padding:9px 0;border-top:1px solid var(--line-d)}
.vd-landing .facts li:first-of-type{border-top:0}
.vd-landing .facts li .ck{color:var(--blue-light);font-weight:800}
.vd-landing .steps{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;margin-top:40px}
.vd-landing .step{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:26px}
.vd-landing .step .n{font-size:34px;font-weight:800;color:var(--blue-chip);letter-spacing:-.03em}
.vd-landing .step h4{font-size:16.5px;color:var(--navy);margin:6px 0 8px}
.vd-landing .step p{color:var(--tx-soft);font-size:13.5px}
@media(max-width:900px){.vd-landing .tpanel{grid-template-columns:1fr}.vd-landing .steps{grid-template-columns:1fr 1fr}}

.vd-landing .conds{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:44px}
.vd-landing .cond{background:var(--panel);border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 8px 26px rgba(11,32,73,.05)}
.vd-landing .cond .img{background:#eef3fb}
.vd-landing .cond .img img{width:100%;aspect-ratio:4/3;object-fit:cover}
.vd-landing .cond .bd{padding:22px 24px 26px}
.vd-landing .cond h4{font-size:19px;color:var(--navy);margin-bottom:8px}
.vd-landing .cond p{color:var(--tx-soft);font-size:14px;line-height:1.6}
@media(max-width:820px){.vd-landing .conds{grid-template-columns:1fr}}

.vd-landing .dk{background:var(--navy);color:#fff;padding:84px 0}
.vd-landing .dk .sec-head h2{color:#fff}
.vd-landing .dk .sec-head p{color:var(--tx-on-soft)}
.vd-landing .dk .eyebrow{color:var(--blue-light)}
.vd-landing .ba{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:44px}
.vd-landing .bacard{background:#12294d;border-radius:16px;overflow:hidden}
.vd-landing .bacard .baimg{width:100%;aspect-ratio:1/1;object-fit:cover;display:block;background:#0a1c38}
.vd-landing .bacard .cap{padding:18px 20px}
.vd-landing .bacard .cap b{color:#fff;font-size:15px;display:block;margin-bottom:4px}
.vd-landing .bacard .cap span{color:var(--tx-on-soft);font-size:13px}
.vd-landing .disc{text-align:center;color:#7186a8;font-size:12.5px;margin-top:26px}
@media(max-width:820px){.vd-landing .ba{grid-template-columns:1fr}}

.vd-landing .price{display:grid;grid-template-columns:1fr 1fr;gap:26px;margin-top:44px}
.vd-landing .pcard-dark{background:linear-gradient(160deg,var(--chrome-from),var(--chrome-mid));border-radius:20px;padding:38px;color:#fff}
.vd-landing .pcard-dark .fe{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--blue-light);font-weight:800}
.vd-landing .pcard-dark .big{font-size:52px;font-weight:800;color:var(--blue-light);letter-spacing:-.03em;margin:10px 0 2px}
.vd-landing .pcard-dark .chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line-d);color:var(--tx-on);font-size:12.5px;font-weight:700;padding:6px 13px;border-radius:999px;margin-top:8px}
.vd-landing .pcard-dark .fin{margin-top:22px;padding-top:20px;border-top:1px solid var(--line-d);color:var(--tx-on-soft);font-size:14px;line-height:1.55}
.vd-landing .pcard-dark .fin b{color:#fff}
.vd-landing .pcard-dark .btn-blue{margin-top:22px;background:#fff;color:var(--blue);box-shadow:none}
.vd-landing .pcard-dark .fine{text-align:center;color:#7f97bd;font-size:11.5px;margin-top:12px}
.vd-landing .getcard{background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:34px}
.vd-landing .getcard .fe{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--blue);font-weight:800;margin-bottom:6px}
.vd-landing .getrow{display:flex;gap:14px;padding:16px 0;border-bottom:1px solid var(--line)}
.vd-landing .getrow:last-child{border-bottom:0}
.vd-landing .getrow .ck{width:22px;height:22px;border-radius:50%;background:var(--blue-soft);color:var(--blue);display:grid;place-items:center;font-size:12px;font-weight:800;flex:0 0 auto}
.vd-landing .getrow b{color:var(--navy);font-size:15px;display:block}
.vd-landing .getrow span{color:var(--tx-soft);font-size:13.5px}
@media(max-width:820px){.vd-landing .price{grid-template-columns:1fr}}

.vd-landing footer{background:#081a3a;color:var(--tx-on-soft);padding:40px 0;font-size:13px;border-top:1px solid var(--line-d)}
.vd-landing footer .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:14px}
.vd-landing footer b{color:#fff}
.vd-landing footer .compliance{flex-basis:100%;color:#7186a8;font-size:12px;margin-top:6px}

/* embedded consultation form (added: not in the source's static markup) */
.vd-landing #consultation{scroll-margin-top:90px}
.vd-landing .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.vd-landing .form .clab{display:block;font-size:11.5px;font-weight:800;letter-spacing:.04em;color:var(--tx-soft);text-transform:uppercase;margin-top:16px}
.vd-landing .form textarea.field{min-height:84px;resize:vertical}
.vd-landing .channels{display:flex;gap:8px;margin-top:9px}
.vd-landing .channel{flex:1;position:relative;display:flex;align-items:center;justify-content:center;text-align:center;border:1px solid var(--line);background:var(--panel-2);border-radius:11px;padding:11px 6px;font-size:13.5px;font-weight:700;color:var(--tx-soft);cursor:pointer}
.vd-landing .channel input{position:absolute;opacity:0;width:100%;height:100%;left:0;top:0;margin:0;cursor:pointer}
.vd-landing .channel:has(input:checked){border-color:var(--blue);background:var(--blue-soft);color:var(--blue)}
.vd-landing .consent{display:flex;gap:9px;align-items:flex-start;margin-top:16px;font-size:12.5px;line-height:1.4;color:var(--tx-soft)}
.vd-landing .consent input{margin-top:2px;flex:0 0 auto;width:16px;height:16px;accent-color:var(--blue);cursor:pointer}
.vd-landing .consent label{cursor:pointer}
.vd-landing .err{color:#b42318;background:#fef3f2;border:1px solid #fbd5d1;border-radius:10px;padding:10px 12px;font-size:12.5px;font-weight:600;margin-top:13px}
.vd-landing .success{text-align:center;padding:14px 4px 6px}
.vd-landing .success .tick{width:52px;height:52px;border-radius:50%;background:var(--blue-soft);color:var(--blue);display:grid;place-items:center;margin:0 auto 14px}
.vd-landing .success h3{color:var(--navy);font-size:22px;margin-bottom:8px}
.vd-landing .success p{color:var(--tx-soft);font-size:14px}

/* Meet your aligners: product image + numbered feature callouts */
.vd-landing .align-band{display:grid;grid-template-columns:1.05fr .95fr;gap:50px;align-items:center}
.vd-landing .align-media img{width:100%;border-radius:18px;display:block;box-shadow:0 20px 50px rgba(11,32,73,.18)}
.vd-landing .align-copy h2{font-size:36px;line-height:1.12;margin-top:12px;color:var(--navy)}
.vd-landing .align-intro{color:var(--tx-soft);font-size:16px;margin-top:14px;max-width:440px}
.vd-landing .align-feats{list-style:none;margin:26px 0 0;padding:0;display:grid;gap:18px}
.vd-landing .align-feats li{display:flex;gap:15px;align-items:flex-start}
.vd-landing .align-feats .an{flex:0 0 auto;width:38px;height:38px;border-radius:999px;display:grid;place-items:center;background:var(--blue-soft);color:var(--blue);font-weight:800;font-size:12.5px;font-variant-numeric:tabular-nums}
.vd-landing .align-feats h4{font-size:16px;color:var(--navy);margin:3px 0 3px}
.vd-landing .align-feats p{color:var(--tx-soft);font-size:14.5px;line-height:1.5}
@media(max-width:820px){.vd-landing .align-band{grid-template-columns:1fr;gap:26px}}

/* Before/after comparison slider (hygiene results band). White card holds the
   fixed-ratio frame so there is no layout shift; the slider is a client island. */
.vd-landing .ba-card{max-width:660px;margin:44px auto 0;background:#fff;border-radius:18px;padding:16px;box-shadow:0 30px 70px rgba(4,16,44,.42)}
.vd-landing .ba-slider{margin:0}
.vd-landing .ba-frame{position:relative;width:100%;aspect-ratio:623/400;border-radius:12px;overflow:hidden;background:#eef3fb;touch-action:none;cursor:ew-resize;-webkit-user-select:none;user-select:none}
.vd-landing .ba-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;-webkit-user-drag:none;-webkit-user-select:none;user-select:none}
.vd-landing .ba-badge{position:absolute;top:12px;z-index:3;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:5px 11px;border-radius:999px;color:#fff;pointer-events:none;box-shadow:0 4px 12px rgba(4,16,44,.28)}
.vd-landing .ba-badge-before{left:12px;background:var(--navy)}
.vd-landing .ba-badge-after{right:12px;background:var(--blue)}
.vd-landing .ba-divider{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:#fff;z-index:2;pointer-events:none;box-shadow:0 0 0 1px rgba(11,32,73,.14)}
.vd-landing .ba-handle{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:40px;height:40px;border-radius:50%;background:#fff;border:2px solid var(--blue);color:var(--blue);display:grid;place-items:center;box-shadow:0 4px 14px rgba(11,32,73,.3)}
.vd-landing .ba-handle svg{width:20px;height:20px;display:block}
.vd-landing .ba-range{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;opacity:0;border:0;background:transparent;pointer-events:none}
.vd-landing .ba-frame:focus-within .ba-handle{box-shadow:0 0 0 4px rgba(91,196,247,.55),0 4px 14px rgba(11,32,73,.3)}
.vd-landing .ba-cap{margin-top:14px;text-align:center;color:var(--tx-on-soft);font-size:12.5px;line-height:1.45}
@media(max-width:820px){.vd-landing .ba-card{margin-top:36px;padding:12px}}

/* FAQ: native disclosure list, one card per question. */
.vd-landing .faqs{max-width:820px;margin:44px auto 0;display:grid;gap:14px}
.vd-landing .faq-item{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:2px 22px}
.vd-landing .faq-item summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 0;font-size:16.5px;font-weight:700;color:var(--navy)}
.vd-landing .faq-item summary::-webkit-details-marker{display:none}
.vd-landing .faq-item summary::after{content:"+";color:var(--blue);font-weight:800;font-size:22px;line-height:1;transition:transform .2s ease}
.vd-landing .faq-item[open] summary::after{transform:rotate(45deg)}
.vd-landing .faq-item .faq-a{color:var(--tx-soft);font-size:14.5px;line-height:1.65;padding:0 0 18px}
`;
