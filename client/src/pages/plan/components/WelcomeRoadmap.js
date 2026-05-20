import React from 'react';

/**
 * Welcome roadmap: three cards showing the journey through the wizard, plus
 * a footer line previewing what the team delivers after submission.
 * Mounted below the welcome card on RefinementWelcomeStep.
 *
 * - mode: 'byob' | 'hosted'
 * - packageName: required when mode === 'hosted' (used in Part 1 body)
 */
export default function WelcomeRoadmap({ mode = 'byob', packageName = '' }) {
  const isHosted = mode === 'hosted';

  return (
    <>
      <div className="potion-roadmap">
        <div className={`potion-roadmap-step ${isHosted ? 'hosted' : 'shopping'}`}>
          <div className="potion-roadmap-num">Part 1</div>
          <h4 className="potion-roadmap-title">
            {isHosted ? 'Pick what we serve' : 'Build your drink menu'}
          </h4>
          <p className="potion-roadmap-body">
            {isHosted
              ? `Your ${packageName || 'package'} is locked in. Choose the specific drinks within it.`
              : "Cocktails, mocktails, beer and wine, spirits. Whatever you'd like to serve, we'll tally up what you need."}
          </p>
          <span className="potion-roadmap-tag">
            {isHosted ? '→ we stock everything' : '→ becomes your shopping list'}
          </span>
        </div>

        <div className="potion-roadmap-step">
          <div className="potion-roadmap-num">Part 2</div>
          <h4 className="potion-roadmap-title">Choose menu design</h4>
          <p className="potion-roadmap-body">
            Custom, standard, or skip it. We bring the printed and framed menu to display on the bar.
          </p>
        </div>

        <div className="potion-roadmap-step">
          <div className="potion-roadmap-num">Part 3</div>
          <h4 className="potion-roadmap-title">Confirm logistics</h4>
          <p className="potion-roadmap-body">
            Event-day contact, parking, equipment, access notes.
          </p>
        </div>
      </div>

      <div className="potion-roadmap-footer">
        <p>
          After you submit, we put together your final shopping list, menu, and event order. You'll hear from us within 2 business days.
        </p>
      </div>
    </>
  );
}
