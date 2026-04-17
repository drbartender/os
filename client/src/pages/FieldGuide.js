import React, { useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import api from '../utils/api';
import { useToast } from '../context/ToastContext';
import { COMPANY_PHONE } from '../utils/constants';

const SECTIONS = [
  {
    num: '01', title: 'Field Duties', image: '/images/field_duties.avif',
    content: (
      <>
        <p>You're the face of the lab. Whether you're slinging signature cocktails or crushing through a beer-and-wine wedding, your energy sets the tone.</p>
        <ul>
          <li>Bartending is your primary mission, but setup and cleanup are part of the job too.</li>
          <li>Sometimes you'll barback, prep garnishes, or run ice. We all get our hands dirty.</li>
          <li>We use custom menus. Review them in advance so you know what you're making — it shows, and clients notice.</li>
        </ul>
      </>
    )
  },
  {
    num: '02', title: 'Appearance Protocols', image: '/images/appearance.avif',
    content: (
      <>
        <p>Clients trust us to show up sharp. That doesn't mean boring — it means intentional.</p>
        <p className="guide-sub-heading">Indoor Events</p>
        <p>Black dress pants, black button-up or blouse, black shoes, black tie or bow tie.</p>
        <p className="guide-sub-heading">Outdoor Events</p>
        <p>Same pants and shoes, black polo or collar shirt (no logos).</p>
        <p className="guide-sub-heading">Optional Flair</p>
        <p>Black apron or black vest — go for it if it fits the vibe.</p>
        <p style={{marginTop:'0.5rem'}}>Hair neat. Beard trimmed. Minimal jewelry. Look like a pro, not like you just rolled out of a van (even if you did).</p>
      </>
    )
  },
  {
    num: '03', title: 'Tools of the Trade', image: '/images/tools.avif',
    content: (
      <>
        <p>You're expected to bring your own tools. Don't show up empty-handed — you won't be staffed again.</p>
        <p className="guide-sub-heading">Bare Minimum (for new recruits)</p>
        <ul><li>Wine Key</li><li>Bar Key / Opener</li><li>Ice Scoop</li><li>Clean Ice Bin</li></ul>
        <p className="guide-sub-heading">Standard Bar Kit (expected at most events)</p>
        <ul><li>Shaker + Strainer</li><li>Knife + Cutting Board</li><li>Bar Spoon</li><li>Muddler</li><li>Jigger</li></ul>
        <p className="guide-sub-heading">Optional (but super nice to have)</p>
        <ul><li>Pour Spouts</li><li>Tongs</li><li>Bar Towels</li><li>Bar Mats</li></ul>
        <p style={{marginTop:'0.5rem'}}>Most events use the Standard Kit. Always check the Event Details Page.</p>
      </>
    )
  },
  {
    num: '04', title: 'Timing & Punctuality', image: '/images/timing.avif',
    content: (
      <>
        <ul>
          <li>Setup begins 1 hour before the event unless otherwise noted. Breakdown is 30 minutes. Any additional time must be approved in advance — otherwise, it won't be paid.</li>
          <li>Arriving more than 10 minutes late will result in a 20% deduction in your contracted pay.</li>
          <li>If you're not sure or running behind, stay in touch with Dr. Bartender management. Communication keeps you on the schedule.</li>
        </ul>
        <p style={{marginTop:'0.75rem', fontStyle:'italic'}}>This is someone's wedding, retirement, or corporate big deal. Be there like it matters — because it does.</p>
      </>
    )
  },
  {
    num: '05', title: 'Tips & Gratuities', image: '/images/tips.avif',
    content: (
      <>
        <p>We believe good service earns good tips — and we're all for making money.</p>
        <ul>
          <li>Tip jars and digital tip codes are cool — unless we tell you otherwise.</li>
          <li>If gratuity is included, no tip jar or signs — but you can still discreetly accept a tip if someone offers.</li>
          <li>Classy signage only. No cringey signs or anything that feels like panhandling.</li>
          <li>Never ask directly for a tip.</li>
        </ul>
        <p style={{marginTop:'0.75rem', fontStyle:'italic'}}>Bottom line: Be gracious, be pro, and let your performance do the work.</p>
      </>
    )
  },
  {
    num: '06', title: 'Professional Boundaries', image: '/images/boundaries.avif',
    content: (
      <>
        <p>We're fun — not sloppy. We work with high-profile clients who expect chill, collected, competent bartenders.</p>
        <ul>
          <li>No drinking guests. No exceptions.</li>
          <li>Don't freelance side services or offer your own bartending outside of Dr. Bartending at events.</li>
          <li>Report anything weird or off ASAP. If it's sketchy, say something.</li>
        </ul>
        <p style={{marginTop:'0.75rem', fontStyle:'italic'}}>We're here to serve, not party. Respect the space, the guests, and yourself.</p>
      </>
    )
  },
  {
    num: '07', title: 'Event Flow 101', image: '/images/flow.avif',
    content: (
      <>
        <p>Call time is 1 hour before the event unless otherwise noted.</p>
        <ol style={{paddingLeft:'1.25rem'}}>
          {[
            ['Arrive & Check In', 'Say hi to the client, find the bar space, get your bearings.'],
            ['Set Up', 'Unload, ice down, prep tools, garnish, and signage. Be ready to pour by 10 minutes before scheduled start time.'],
            ['Service', 'Stay sharp, clean, and friendly. Keep the bar stocked and the vibe high.'],
            ['Wrap & Breakdown', 'Last call 20 minutes before scheduled end time. Clean up, pack out, and thank the host.'],
            ['Final Check', 'Grab all your gear and let management know how it went.'],
          ].map(([title, desc]) => (
            <li key={title} style={{marginBottom:'0.5rem'}}>
              <strong style={{color:'var(--warm-brown)'}}>{title}:</strong> {desc}
            </li>
          ))}
        </ol>
      </>
    )
  },
  {
    num: '08', title: 'Loaner Gear & Supply Runs', image: '/images/gear.avif',
    content: (
      <>
        <p>Sometimes we'll provide bars, coolers, garnish trays, or ice bins. Other times we'll ask you to grab items on the way — we'll cover costs if it's pre-approved.</p>
        <p className="guide-sub-heading">If we loan you gear</p>
        <ul>
          <li>Inspect it when you get it</li>
          <li>Use it like it's yours (but cleaner)</li>
          <li>Clean it, return it, or pass it off as directed</li>
          <li>Report any issues — before and after the gig</li>
        </ul>
        <p style={{marginTop:'0.5rem'}}>Got your own bar setup? Coolers? Storage bins? Folks with gear are first in line for gear-needed gigs. Missing or damaging gear = less trust, fewer loans.</p>
      </>
    )
  },
  {
    num: '09', title: 'Communication & Feedback', image: '/images/communication.avif',
    content: (
      <>
        <p>Good science needs good signal. Here's how we keep the lab connected.</p>
        <ul>
          <li>If you say you're available, plan to work — we staff based on what you tell us.</li>
          <li>Shifts will be posted here, where you can view details and request or confirm fits.</li>
          <li>Day-of or urgent issues? Text or Call {COMPANY_PHONE}</li>
          <li>If something goes great — or off the rails — we want to know. Feedback helps us keep evolving.</li>
        </ul>
      </>
    )
  },
  {
    num: '10', title: 'Paperwork & Payments', image: '/images/payments.avif',
    content: (
      <>
        <p>You're a contractor, not an employee. That means:</p>
        <ul>
          <li>You're responsible for your own taxes</li>
          <li>You set your availability</li>
          <li>You're paid hourly, by the gig — no time clocks. Your scheduled block = your payout.</li>
        </ul>
        <p className="guide-sub-heading">How Payments Work</p>
        <ul>
          <li>Payouts are processed on Tuesdays for the prior week.</li>
          <li>You can request early payment, but no promises.</li>
          <li>Extra time must be approved in advance to be included in your pay.</li>
        </ul>
        <p style={{marginTop:'0.5rem', fontStyle:'italic'}}>Keep track of your gigs for tax time. We won't send a 1099 unless you cross the IRS threshold, but your earnings are still taxable.</p>
      </>
    )
  },
  {
    num: '11', title: 'Alcohol Service Laws & Cut-Off Policy',
    content: (
      <>
        <p>Serving alcohol comes with legal responsibility. Know the laws and protect yourself, the guests, and Dr. Bartender.</p>
        <ul>
          <li><strong>BASSET certification is required.</strong> You must hold a valid BASSET (or equivalent: TIPS, ServSafe Alcohol) certification before working any event.</li>
          <li>Never serve a visibly intoxicated person. If someone is slurring, stumbling, or aggressive — cut them off politely and firmly.</li>
          <li>Do not serve anyone under 21. No exceptions, no "they look old enough." Always check ID if there's any doubt.</li>
          <li>If a guest becomes belligerent after being cut off, alert the event host or security immediately. Do not engage in a confrontation.</li>
        </ul>
        <p className="guide-sub-heading">Cut-Off Script</p>
        <p style={{fontStyle:'italic'}}>"I appreciate you coming out tonight, but I'm not able to serve any more drinks at this time. Can I get you some water or a soda?"</p>
        <p style={{marginTop:'0.5rem', fontStyle:'italic'}}>You are personally liable if you over-serve someone who causes harm. Take this seriously.</p>
      </>
    )
  },
  {
    num: '12', title: 'Carding & ID Verification',
    content: (
      <>
        <p>When in doubt, card them. It's the law, and it protects you.</p>
        <ul>
          <li>Acceptable IDs: State-issued driver's license or ID, U.S. passport, military ID.</li>
          <li>Check the photo, birthdate, and expiration date. Expired IDs are not valid.</li>
          <li>If the ID looks fake, altered, or doesn't match the person — politely decline service.</li>
          <li>If a minor attempts to order, do not serve them. Let the event host know if needed.</li>
        </ul>
        <p style={{marginTop:'0.5rem', fontStyle:'italic'}}>A good rule of thumb: if they look under 35, ask for ID. Better safe than sorry — and guests usually appreciate the compliment.</p>
      </>
    )
  },
  {
    num: '13', title: 'Contractor Sobriety Policy',
    content: (
      <>
        <p>This one's simple: <strong>do not drink on the job.</strong></p>
        <ul>
          <li>Zero tolerance for alcohol or substance use during events — before, during, or on breaks.</li>
          <li>Do not taste test drinks with alcohol. Use water or juice to check consistency if needed.</li>
          <li>If a guest offers you a drink, decline graciously: "Thanks so much, but I'm on the clock!"</li>
          <li>If you arrive at an event under the influence, you will be sent home immediately and removed from future staffing.</li>
        </ul>
        <p style={{marginTop:'0.5rem', fontStyle:'italic'}}>We're here to serve the party — not be at it. Stay sharp, stay professional.</p>
      </>
    )
  },
  {
    num: '14', title: 'Injury & Incident Reporting',
    content: (
      <>
        <p>If something goes wrong at an event — whether it involves you, a guest, or property — report it immediately.</p>
        <p className="guide-sub-heading">What to Report</p>
        <ul>
          <li>Any injury to yourself (cuts, burns, slips)</li>
          <li>Any injury to a guest</li>
          <li>Broken glassware, spills, or property damage</li>
          <li>Altercations, fights, or hostile guests</li>
          <li>Any situation that feels unsafe</li>
        </ul>
        <p className="guide-sub-heading">How to Report</p>
        <ul>
          <li>Call or text Dr. Bartender immediately: <strong>{COMPANY_PHONE}</strong></li>
          <li>Document what happened (time, location, who was involved)</li>
          <li>If there's a medical emergency, call 911 first, then notify Dr. Bartender</li>
        </ul>
        <p style={{marginTop:'0.5rem', fontStyle:'italic'}}>Don't try to hide incidents or handle them alone. Communication is how we keep everyone safe and covered.</p>
      </>
    )
  },
  {
    num: '15', title: 'Social Media & Photography Policy',
    content: (
      <>
        <p>Events are memorable, and we love seeing great moments — but there are boundaries.</p>
        <ul>
          <li><strong>Do not post photos or videos of guests, clients, or private events</strong> on your personal social media without explicit permission from the client.</li>
          <li>You may take photos of your bar setup (no guests visible) for your own portfolio, but do not tag or identify the venue or client unless approved.</li>
          <li>If the client or Dr. Bartender asks for event photos/videos for marketing, we'll let you know in advance.</li>
          <li>Do not use your phone for personal use during active service. Quick checks during downtime are fine, but stay present.</li>
        </ul>
        <p style={{marginTop:'0.5rem', fontStyle:'italic'}}>Your professionalism behind the bar speaks for itself. Let the work be the brand.</p>
      </>
    )
  },
  {
    num: '16', title: 'Harassment & Inappropriate Guest Behavior',
    content: (
      <>
        <p>You deserve a safe work environment at every event. Dr. Bartender takes harassment seriously — from any direction.</p>
        <p className="guide-sub-heading">If a Guest is Inappropriate</p>
        <ul>
          <li>Unwanted advances, comments about your appearance, or sexual innuendos — you do not have to tolerate it.</li>
          <li>Set a firm but professional boundary: "I appreciate it, but let's keep things professional."</li>
          <li>If it continues, alert the event host or step away from the situation and contact Dr. Bartender.</li>
          <li>You will never be penalized for reporting harassment or refusing to serve someone who is being inappropriate.</li>
        </ul>
        <p className="guide-sub-heading">Between Staff</p>
        <ul>
          <li>Treat all fellow staff with respect. Harassment, discrimination, or bullying of any kind will result in immediate removal.</li>
          <li>If you experience or witness inappropriate behavior from another contractor, report it to Dr. Bartender management.</li>
        </ul>
        <p style={{marginTop:'0.5rem', fontStyle:'italic'}}>We've got your back. Speak up — that's how we protect the team.</p>
      </>
    )
  },
];

export default function FieldGuide() {
  const navigate = useNavigate();
  const toast = useToast();
  const { setProgress } = useOutletContext();
  const [open, setOpen] = useState({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(false);

  function toggle(i) {
    setOpen(o => ({ ...o, [i]: !o[i] }));
  }

  async function proceed() {
    if (!acknowledged) return;
    setLoading(true);
    try {
      const r = await api.put('/progress/step', { step: 'field_guide_completed' });
      setProgress(r.data);
      navigate('/agreement');
    } catch (err) {
      toast.error(err.message || "Couldn't save your progress. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-container">
      <div className="text-center mb-3">
        <div className="section-label">Protocol Document</div>
        <h1>Dr. Bartender Field Guide</h1>
        <p className="text-muted italic">Expectations, gear, etiquette, and protocols. Read it — then let's go make cocktails.</p>
      </div>

      {SECTIONS.map((section, i) => (
        <div className="guide-section" key={section.num}>
          <div
            className="guide-section-header"
            onClick={() => toggle(i)}
            aria-expanded={!!open[i]}
          >
            <span className="guide-section-number">{section.num}</span>
            <span className="guide-section-title">{section.title}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--amber)', fontSize: '1.1rem' }}>
              {open[i] ? '−' : '+'}
            </span>
          </div>
          <div className={`guide-section-body ${open[i] ? 'open' : ''}`}>
            {open[i] ? (
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
                {section.image && (
                  <img
                    src={section.image}
                    alt={section.title}
                    style={{ height: '180px', width: 'auto', borderRadius: '4px', flexShrink: 0 }}
                  />
                )}
                <div style={{ flex: 1 }}>
                  {section.content}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ))}

      <div className="card mt-3">
        <label className="checkbox-group">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={e => setAcknowledged(e.target.checked)}
          />
          <span className="checkbox-label" style={{ fontWeight: 600 }}>
            I have reviewed the Dr. Bartender Field Guide.
          </span>
        </label>

        {!acknowledged && (
          <p className="text-muted text-small mt-1" style={{ paddingLeft: '1.65rem' }}>
            Please check this box to confirm you've reviewed all sections above.
          </p>
        )}

        <button
          className="btn btn-primary btn-full mt-2"
          disabled={!acknowledged || loading}
          onClick={proceed}
        >
          {loading ? 'Saving...' : 'Continue to Contractor Agreement →'}
        </button>
      </div>
    </div>
  );
}
