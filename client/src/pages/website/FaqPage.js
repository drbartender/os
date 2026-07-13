import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';

const FAQ_CATEGORIES = [
  {
    title: 'Booking & Pricing',
    roman: 'I',
    items: [
      {
        q: 'How much does it cost to hire a bartender?',
        a: (
          <>
            Pricing depends on your guest count, event duration, and package choice.
            Our BYOB package starts at $350 (up to 4 hours), while hosted packages (we provide
            the alcohol) start at $12–40 per guest depending on tier. Hosted packages are billed
            at a 25-guest minimum, with a $550 event minimum.{' '}
            <Link to="/quote">Use our quote tool</Link> to get exact pricing for your
            event in seconds.
          </>
        ),
      },
      {
        q: 'How far in advance should I book?',
        a: 'We recommend booking 4–8 weeks in advance for most events, and 3–6 months for weddings or large corporate events. Popular dates (holidays, summer weekends) book up fast.',
      },
      {
        q: 'How do I reserve a date?',
        a: (
          <>
            Start by <Link to="/quote">getting an instant quote</Link>. Once you review
            and sign your proposal, a $100 deposit secures your date.
          </>
        ),
      },
      {
        q: "What's your cancellation policy?",
        a: "Your $100 deposit is non-refundable. With at least 60 days' notice, we can usually apply it toward a new date within 12 months. If you need to cancel closer in, the full terms in your event services agreement apply. Reach out and we'll always try to work with you.",
      },
      {
        q: 'Is there a minimum guest count?',
        a: "For hosted packages (we provide the alcohol), the minimum is 25 guests. For BYOB and mocktail packages, there's no minimum.",
      },
      {
        q: 'Do you offer discounts for non-profits or recurring events?',
        a: (
          <>
            We handle pricing on a case-by-case basis for non-profits and multi-event
            bookings. <Link to="/quote">Get a quote</Link> and mention it in your event
            details.
          </>
        ),
      },
    ],
  },
  {
    title: 'Services & Packages',
    roman: 'II',
    items: [
      {
        q: 'What types of events do you handle?',
        a: "Weddings, birthday parties, corporate events, holiday gatherings, fundraisers, cocktail classes, and just about any private event that needs a professional bar. We've done everything from intimate dinner parties to 500+ guest galas.",
      },
      {
        q: 'Can I get a custom cocktail menu?',
        a: 'Absolutely. Signature cocktails, mocktails, and crowd-friendly options are all tailored to your event. We work with you during the consultation to design the perfect menu.',
      },
      {
        q: "What's the difference between BYOB and hosted packages?",
        a: "With BYOB, you buy the alcohol and we handle everything else: setup, mixing, serving, and cleanup. With hosted packages, we provide all beverages, mixers, garnishes, and bar supplies. Both include professional bartender service.",
      },
      {
        q: 'Do you offer mocktails or non-alcoholic options?',
        a: 'Yes! We have a dedicated mocktail package, and non-alcoholic options can be added to any bar package. Mocktail-only events are welcome too.',
      },
      {
        q: 'Do you offer cocktail classes?',
        a: (
          <>
            Yes, we run hands-on mixology classes for groups of 8–20 people, starting
            at $35/person. Perfect for team-building, bachelorette parties, or birthday
            celebrations. <Link to="/classes">Learn more about our classes.</Link>
          </>
        ),
      },
      {
        q: 'Do you provide the bar setup and equipment?',
        a: 'Every package includes one or more professional bartenders and essential bar tools. Cups, napkins, ice, and portable bars are available as add-on options to ensure your event has exactly what it needs.',
      },
    ],
  },
  {
    title: 'Logistics & Coverage',
    roman: 'III',
    items: [
      {
        q: 'What areas do you serve?',
        a: "We primarily serve Chicagoland and the surrounding suburbs across Illinois, Indiana, and Michigan. For events outside that range, reach out and we'll see what we can do.",
      },
      {
        q: 'How many bartenders do I need?',
        a: (
          <>
            As a general rule, one bartender per 100 guests. Our{' '}
            <Link to="/quote">quote tool</Link> automatically calculates the right
            staffing level based on your guest count and service style.
          </>
        ),
      },
      {
        q: 'What do bartenders bring with them?',
        a: "Essential bar tools (shakers, jiggers, strainers, etc.) come with every package. Cups, napkins, straws, and ice are brought only if you've added them to your package as add-ons. For BYOB events, you provide the alcohol and we bring the tools plus any add-ons you've selected.",
      },
      {
        q: 'Do you handle setup and cleanup?',
        a: "Yes. Bartenders arrive early to set up and stay after to break down and clean the bar area. It's all included.",
      },
      {
        q: 'Are your bartenders certified and insured?',
        a: 'Every bartender is BASSET-trained and vetted. We carry both general liability and liquor liability insurance. Certificate of insurance available on request.',
      },
    ],
  },
  {
    title: 'Event Day',
    roman: 'IV',
    items: [
      {
        q: 'What time do bartenders arrive?',
        a: 'Typically 30–60 minutes before your event start time, and up to 90 for larger or hosted builds that need more setup.',
      },
      {
        q: 'Can you accommodate dietary restrictions or allergies?',
        a: "Yes. Let us know about any allergies during consultation and we'll design the menu accordingly. We can label drinks and offer alternatives.",
      },
      {
        q: 'Do you provide garnishes and mixers?',
        a: 'For hosted packages, yes. Everything is included. For BYOB packages, basic mixers and garnishes are available as add-ons (The Foundation, The Formula, or The Full Compound packages).',
      },
    ],
  },
];

export default function FaqPage() {
  const [openKey, setOpenKey] = useState('0-0');
  const toggle = (k) => setOpenKey((p) => (p === k ? null : k));

  return (
    <PublicLayout>
      {/* Page hero */}
      <section className="ws-press-pagehero">
        <div className="ws-wrap">
          <div className="ornament" aria-hidden="true">⚗</div>
          <div className="ws-press-eyebrow">No. 05 · The Field Guide</div>
          <h1 className="ws-press-pagehero-title">Frequently asked.</h1>
          <p className="ws-press-pagehero-sub">
            Everything we wish every host knew before the first sip. Can't find your answer?{' '}
            <Link to="/quote">Get a personalized quote</Link> and we'll walk you through everything.
          </p>
        </div>
      </section>

      <section className="ws-press-faq">
        <div className="ws-wrap narrow">
          {FAQ_CATEGORIES.map((category, catIdx) => (
            <div key={catIdx} className="ws-faq-section">
              <div className="ws-faq-cat-head">
                <span className="ws-faq-cat-roman">{category.roman}.</span>
                <h2 className="ws-faq-cat-title">{category.title}</h2>
                <span className="ws-faq-cat-count">{category.items.length} entries</span>
              </div>

              <div className="card ws-faq-card">
                {category.items.map((item, itemIdx) => {
                  const key = `${catIdx}-${itemIdx}`;
                  const isOpen = openKey === key;
                  const isLast = itemIdx === category.items.length - 1;
                  return (
                    <div
                      key={key}
                      className={`ws-faq-item ${isOpen ? 'open' : ''} ${isLast ? 'last' : ''}`}
                    >
                      <button
                        className="ws-faq-q"
                        onClick={() => toggle(key)}
                        aria-expanded={isOpen}
                      >
                        <span className="ws-faq-q-inner">
                          <span className="ws-faq-num">
                            {category.roman}.{String(itemIdx + 1).padStart(2, '0')}
                          </span>
                          <span className="ws-faq-text">{item.q}</span>
                        </span>
                        <span
                          className="ws-faq-toggle"
                          aria-hidden="true"
                        >+</span>
                      </button>
                      {isOpen && (
                        <div className="ws-faq-a">
                          <p>{item.a}</p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="ws-faq-footer">
            <span className="kicker center">Still curious?</span>
            <h2 className="ws-press-h2 ws-faq-footer-h">Send a note. We answer ourselves.</h2>
            <div className="ws-faq-footer-cta">
              <Link to="/quote" className="btn btn-primary">Get Your Free Quote</Link>
              <a href="mailto:contact@drbartender.com" className="btn btn-secondary">Email the Doctor</a>
            </div>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
