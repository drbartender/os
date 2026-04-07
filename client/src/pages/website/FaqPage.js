import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';

const FAQ_CATEGORIES = [
  {
    title: 'Booking & Pricing',
    items: [
      {
        q: 'How much does it cost to hire a bartender?',
        a: (
          <>
            Pricing depends on your guest count, event duration, and package choice.
            Our BYOB packages start around $200–400, while hosted (we provide alcohol)
            packages start at $25–45 per guest.{' '}
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
        a: 'Deposits are non-refundable but can be applied to a rescheduled date within 12 months. Final payments are due before the event.',
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
        a: "With BYOB, you buy the alcohol and we handle everything else — setup, mixing, serving, and cleanup. With hosted packages, we provide all beverages, mixers, garnishes, and bar supplies. Both include professional bartender service.",
      },
      {
        q: 'Do you offer mocktails or non-alcoholic options?',
        a: 'Yes! We have a dedicated mocktail package, and non-alcoholic options can be added to any bar package. Mocktail-only events are welcome too.',
      },
      {
        q: 'Do you offer cocktail classes?',
        a: (
          <>
            Yes — we run hands-on mixology classes for groups of 8–20 people, starting
            at $35/person. Perfect for team-building, bachelorette parties, or birthday
            celebrations. <Link to="/classes">Learn more about our classes.</Link>
          </>
        ),
      },
      {
        q: 'Do you provide the bar setup and equipment?',
        a: "Every package includes our professional bartender(s) with all bar tools, cups, napkins, and ice. Portable bar rentals are available as an add-on if your venue doesn't have one.",
      },
    ],
  },
  {
    title: 'Logistics & Coverage',
    items: [
      {
        q: 'What areas do you serve?',
        a: "We primarily serve Chicagoland and the surrounding suburbs across Illinois, Indiana, and Michigan. For events outside that range, reach out and we'll see what we can do.",
      },
      {
        q: 'How many bartenders do I need?',
        a: (
          <>
            As a general rule, one bartender per 50–75 guests. Our{' '}
            <Link to="/quote">quote tool</Link> automatically calculates the right
            staffing level based on your guest count and service style.
          </>
        ),
      },
      {
        q: 'What do bartenders bring with them?',
        a: 'All bar tools (shakers, jiggers, strainers, etc.), cups, napkins, straws, ice, and any mixers/garnishes included in your package. For BYOB events, you provide the alcohol and we bring everything else.',
      },
      {
        q: 'Do you handle setup and cleanup?',
        a: "Yes. Bartenders arrive early to set up and stay after to break down and clean the bar area. It's all included.",
      },
      {
        q: 'Are your bartenders licensed and insured?',
        a: 'Every bartender is vetted and trained. We carry $2 million in liquor liability insurance for your peace of mind.',
      },
    ],
  },
  {
    title: 'Event Day',
    items: [
      {
        q: 'What time do bartenders arrive?',
        a: 'Typically 30–60 minutes before your event start time for setup, depending on the size and complexity of the bar.',
      },
      {
        q: 'Can you accommodate dietary restrictions or allergies?',
        a: "Yes. Let us know about any allergies during consultation and we'll design the menu accordingly. We can label drinks and offer alternatives.",
      },
      {
        q: 'Do you provide garnishes and mixers?',
        a: 'For hosted packages, yes — everything is included. For BYOB packages, basic mixers and garnishes are available as add-ons (The Foundation, The Formula, or The Full Compound packages).',
      },
    ],
  },
];

export default function FaqPage() {
  const [openFaq, setOpenFaq] = useState(null);

  const toggleFaq = (key) => {
    setOpenFaq((prev) => (prev === key ? null : key));
  };

  return (
    <PublicLayout>
      <section className="ws-section">
        <div className="ws-section-heading">
          <span className="ws-kicker">FAQ</span>
          <h2>Frequently Asked Questions</h2>
          <div className="ws-divider ws-divider-center" />
          <p style={{ maxWidth: 600, margin: '0 auto', opacity: 0.85 }}>
            Can't find your answer?{' '}
            <Link to="/quote">Get a personalized quote</Link> and we'll walk you
            through everything.
          </p>
        </div>

        {FAQ_CATEGORIES.map((category, catIdx) => (
          <div key={catIdx} className="ws-faq-category">
            <h3>{category.title}</h3>
            <div className="ws-faq-list">
              {category.items.map((item, itemIdx) => {
                const key = `${catIdx}-${itemIdx}`;
                const isOpen = openFaq === key;
                return (
                  <div
                    key={key}
                    className={`ws-faq-item${isOpen ? ' open' : ''}`}
                  >
                    <button className="ws-faq-q" onClick={() => toggleFaq(key)}>
                      <h4>{item.q}</h4>
                      <span className="ws-faq-toggle">{isOpen ? '−' : '+'}</span>
                    </button>
                    <p className="ws-faq-a">{item.a}</p>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <div className="ws-cta-banner">
          <h2>Ready to get started?</h2>
          <Link to="/quote" className="btn btn-primary">
            Get Your Free Quote
          </Link>
        </div>
      </section>
    </PublicLayout>
  );
}
