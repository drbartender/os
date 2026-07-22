import React from 'react';
import { Link } from 'react-router-dom';
import LegalLayout from './LegalLayout';

// Deliberately narrow: this page governs USE OF THE SITE. Booking, cancellation,
// and refund terms live in the signed Event Services Agreement and are never
// restated here, so the two can never drift apart and be played against each
// other. Alcohol is also absent on purpose: hosted packages include it and BYOB
// does not (FaqPage.js), so the usual "we never furnish alcohol" boilerplate
// would be false.
export default function TermsPage() {
  return (
    <LegalLayout
      eyebrow="No. 09 · The Fine Print"
      title="Terms of Use"
      intro="The rules for using this site. Your event is governed by the agreement you sign."
      lastUpdated="July 22, 2026"
    >
      <p>
        These terms govern your use of drbartender.com and the client and staff
        portals operated by Dr. Bartender LLC. By using the site you agree to them.
        If you do not agree, please do not use the site.
      </p>

      <h2>What this site does</h2>
      <p>
        The site describes our services, lets you request a quote, and lets clients
        and staff manage bookings and shifts. A quote, a proposal, or a saved draft is
        an estimate, not a booking. Neither you nor Dr. Bartender is bound to an event
        until the Event Services Agreement for that event is signed and the required
        payment is made.
      </p>

      <h2>Your event agreement controls</h2>
      <p>
        Booking, cancellation, refunds, rescheduling, staffing, and all other terms of
        the services we provide are governed solely by the Event Services Agreement
        you sign for your event. If anything on this page conflicts with that
        agreement, the agreement controls.
      </p>

      <h2>Accounts</h2>
      <p>
        Some parts of the site require an account. Keep your login credentials
        confidential, and tell us promptly at contact@drbartender.com if you believe
        someone else has used your account. You are responsible for activity under
        your account. We may suspend or close an account that is being misused.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Do not use this site to break the law, to interfere with its operation, to
        access accounts or data that are not yours, to scrape or harvest it by
        automated means, or to submit false information or someone else's contact
        details. Do not attempt to probe or bypass our security.
      </p>

      <h2>Our content</h2>
      <p>
        The text, photography, recipes, menus, and design on this site belong to Dr.
        Bartender LLC or are used with permission. You may view and share them for
        personal, non-commercial purposes. You may not republish, sell, or use them
        commercially without our written permission.
      </p>

      <h2>Your content</h2>
      <p>
        When you send us event details, preferences, application materials, or
        feedback, you give us permission to use that material to provide our services
        to you. You confirm you have the right to share whatever you send us.
      </p>

      <h2>Communications</h2>
      <p>
        How we contact you, including text messages and how to opt out, is described
        in our <Link to="/privacy">Privacy Policy</Link>.
      </p>

      <h2>Third-party links and services</h2>
      <p>
        The site links to and relies on services we do not control, such as our
        payment processor. We are not responsible for their content or their
        practices.
      </p>

      <h2>Disclaimer</h2>
      <p>
        The site is provided as is and as available. We do not warrant that it will be
        uninterrupted, error free, or that the information on it is complete or
        current. Prices, packages, and availability shown on the site are subject to
        change and are confirmed only in a signed agreement. To the fullest extent
        permitted by law, we disclaim all implied warranties, including
        merchantability and fitness for a particular purpose.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, Dr. Bartender LLC is not liable for
        indirect, incidental, special, consequential, or punitive damages arising from
        your use of this site. Nothing in this section limits liability that cannot be
        limited under applicable law, and nothing here changes the liability terms of
        a signed Event Services Agreement.
      </p>

      <h2>Indemnity</h2>
      <p>
        You agree to indemnify Dr. Bartender LLC against claims and costs arising from
        your misuse of the site or your breach of these terms.
      </p>

      <h2>Governing law</h2>
      <p>
        These terms are governed by the laws of the State of Illinois, without regard
        to its conflict of laws rules. Any dispute about this site will be brought in
        the state or federal courts located in Cook County, Illinois.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms. The date at the top of this page shows when they
        last changed, and continuing to use the site means you accept the update.
      </p>

      <h2>Contact</h2>
      <p>
        Dr. Bartender LLC, Chicago, Illinois.
        <br />
        <a href="mailto:contact@drbartender.com">contact@drbartender.com</a>
      </p>
    </LegalLayout>
  );
}
