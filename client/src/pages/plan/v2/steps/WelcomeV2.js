import React from 'react';

function formatEventDate(value) {
  if (!value) return null;
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Honest roadmap (spec §3.1): four short parts + a quick review, and the two
// promises v2 actually keeps: costs disclose in place, nothing takes payment.
export default function WelcomeV2({ plan, onStart }) {
  const isHosted = plan.package_category === 'hosted';
  const firstName = plan.client_name ? String(plan.client_name).trim().split(/\s+/)[0] : '';
  const metaBits = [
    plan.guest_count ? `${plan.guest_count} guests` : null,
    formatEventDate(plan.event_date),
    isHosted ? plan.package_name : 'BYOB',
  ].filter(Boolean).join(' · ');

  const parts = [
    isHosted
      ? { title: 'Pick what we pour', desc: <>Your <strong>{plan.package_name || 'package'}</strong> already answered the big questions. Just choose the drinks within it.</> }
      : { title: 'Choose your drinks', desc: <>Cocktails, beer and wine, spirits, whatever you'd like to pour. We turn it into <strong>your shopping list</strong>.</> },
    { title: 'A quick word on your crowd', desc: 'Two questions that size the shopping list. We only ask what the math uses.' },
    { title: 'Design your menu card', desc: 'Custom, standard, or skip it. We print and frame it to display on the bar.' },
    { title: 'The day-of details', desc: 'Where the bar sets up, parking, power, and how we get in.' },
  ];
  const ordinals = ['One', 'Two', 'Three', 'Four'];

  return (
    <div className="potion-welcome">
      <div className="card potion-card-inner-frame potion-welcome-card">
        <span className="potion-kicker">Finalize your bar</span>
        <h1 className="potion-welcome-title">Welcome back{firstName ? `, ${firstName}` : ''}.</h1>
        <p className="potion-welcome-lede">
          Your booking's confirmed{isHosted ? ` and your ${plan.package_name || 'package'} already answered the big questions, so this is short` : ', so you’re already underway'}.{' '}
          <strong>Four short parts, then a quick review. Just a few minutes.</strong>
        </p>

        <ol className="potion-procedure">
          <li className="potion-proc-item done">
            <div className="potion-proc-rail">
              <span className="potion-proc-node" aria-hidden="true">&#10003;</span>
              <span className="potion-proc-line" />
            </div>
            <div className="potion-proc-body">
              <span className="potion-proc-step">Already done</span>
              <h2 className="potion-proc-title">Booking confirmed</h2>
              <p className="potion-proc-desc">
                {metaBits ? <><strong>{metaBits}</strong>. </> : null}
                We carried over your booking details, so you won't re-enter anything.
              </p>
            </div>
          </li>
          {parts.map((p, i) => (
            <li className="potion-proc-item" key={p.title}>
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

        <div className="potion-launch">
          <button type="button" className="btn potion-start" onClick={onStart}>Start</button>
          <p className="potion-launch-reassure">
            No wrong answers. Your progress saves as you go, and you can change anything before you submit.
          </p>
          <p className="potion-launch-cost">
            Any choice that adds a cost says so right where you make it, and it's added to your event balance. Nothing here takes payment.
          </p>
        </div>
      </div>
    </div>
  );
}
