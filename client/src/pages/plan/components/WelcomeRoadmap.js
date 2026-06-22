import React from 'react';

/**
 * The welcome "procedure": a passive, vertical numbered itinerary (an <ol>),
 * deliberately NOT a row of clickable cards. The first node is a genuinely
 * completed "step zero" (the booking) that delivers an honest endowed-progress
 * head start. Only Part One differs by package type.
 *
 * - mode: 'byob' | 'hosted'
 * - packageName: shown in the hosted Part One copy
 * - metaBits: short "120 guests · Sep 14, 2026 · BYOB" string for the done node
 */
export default function WelcomeRoadmap({ mode = 'byob', packageName = 'package', metaBits = '' }) {
  const isHosted = mode === 'hosted';

  const parts = [
    isHosted
      ? {
          title: 'Pick what we pour',
          desc: <>Your <strong>{packageName}</strong> is set. Just choose the specific drinks within it.</>,
        }
      : {
          title: 'Choose your drinks',
          desc: (
            <>
              Cocktails, beer and wine, spirits, whatever you'd like to pour. We turn it into{' '}
              <strong>your shopping list</strong>.
            </>
          ),
        },
    {
      title: 'Design your menu card',
      desc: 'Custom, standard, or skip it. We print and frame it to display on the bar.',
    },
    {
      title: 'The day-of details',
      desc: 'Where the bar sets up, parking, power, and how we get in. The practical stuff so the day runs smooth.',
    },
  ];

  const ordinals = ['One', 'Two', 'Three'];

  return (
    <ol className="potion-procedure">
      <li className="potion-proc-item done">
        <div className="potion-proc-rail">
          <span className="potion-proc-node" aria-hidden="true">✓</span>
          <span className="potion-proc-line" />
        </div>
        <div className="potion-proc-body">
          <span className="potion-proc-step">Already done</span>
          <h2 className="potion-proc-title">Booking confirmed</h2>
          <p className="potion-proc-desc">
            {metaBits ? <><strong>{metaBits}</strong>. </> : null}
            We've carried over your booking details, so you won't re-enter anything.
          </p>
        </div>
      </li>
      {parts.map((p, i) => (
        <li className="potion-proc-item" key={i}>
          <div className="potion-proc-rail">
            <span className="potion-proc-node" aria-hidden="true">{i + 1}</span>
            <span className="potion-proc-line" />
          </div>
          <div className="potion-proc-body">
            <span className="potion-proc-step">Part {ordinals[i]}</span>
            <h2 className="potion-proc-title">{p.title}</h2>
            <p className="potion-proc-desc">{p.desc}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
