import React from 'react';
import { Link } from 'react-router-dom';
import LegalLayout from './LegalLayout';
import { SMS_CONSENT_CLIENT } from '../../../constants/smsConsent';

// The verbatim SMS_CONSENT_CLIENT render is not decoration: /apply is behind
// auth and the quote wizard checkbox sits several steps into the wizard, so
// this page is the one public URL that evidences the opt-in for A2P review.
export default function PrivacyPage() {
  return (
    <LegalLayout
      eyebrow="No. 08 · The Fine Print"
      title="Privacy Policy"
      intro="What we collect, why we collect it, and what we never do with it."
      lastUpdated="July 22, 2026"
    >
      <p>
        Dr. Bartender LLC ("Dr. Bartender," "we," "us") provides bartending services
        for private events in Illinois, Indiana, and Michigan. This policy explains
        what we collect, why, and what we do with it. It covers drbartender.com and
        the client and staff portals we operate.
      </p>

      <h2>Information we collect</h2>
      <p>
        <strong>From clients.</strong> Your name, email address, phone number, event
        date, venue name and address, guest count, and the drink and service
        preferences you give us so we can plan and staff your event.
      </p>
      <p>
        <strong>From applicants and staff.</strong> Your name, email address, phone
        number, address, work experience and availability, emergency contact, and the
        payment details we use to pay you. We do not collect Social Security numbers
        or government ID numbers through this website.
      </p>
      <p>
        <strong>Automatically.</strong> Standard server logs and error diagnostics,
        which include IP address and browser information. We use these to keep the
        site working and to investigate problems.
      </p>
      <p>
        <strong>From other sources.</strong> If you contact us through a lead service
        such as Thumbtack, we receive the contact and event details you provided
        there.
      </p>
      <p>
        <strong>Payments.</strong> Card payments are processed by Stripe. Card numbers
        are entered on Stripe's systems and never reach our servers. We keep a record
        that a payment happened, its amount, and its status.
      </p>
      <p>
        <strong>What we do not collect.</strong> This site runs no advertising
        networks, no third-party analytics, and no tracking pixels.
      </p>

      <h2>How we use it</h2>
      <p>
        To prepare quotes, book and staff events, take payment, pay our staff, respond
        to you, and keep the tax and business records we are required to keep. We do
        not sell your personal information.
      </p>

      <h2>Text messaging (SMS)</h2>
      <p>
        If you provide your mobile number and check the SMS consent box on our quote
        form, Dr. Bartender may send you text messages about your quote, booking,
        payments, and event details. Our staff separately consent to shift and
        scheduling messages when they sign their contractor agreement. Message
        frequency varies. Message and data rates may apply. Reply STOP to any message
        to opt out, or reply HELP for help.
      </p>
      <p>
        We do not sell your personal information. No mobile information will be shared
        with third parties or affiliates for marketing or promotional purposes. Text
        messaging originator opt-in data and consent are never shared with any third
        party. We disclose phone numbers only to the service providers that transmit
        our messages on our behalf, such as Twilio, and only for that purpose.
      </p>
      <p>
        You may opt out at any time by replying STOP to any text message or emailing
        contact@drbartender.com. Opting out of text messages does not affect your
        booking or your employment.
      </p>
      <p>This is the exact consent statement we present on our quote form:</p>
      <blockquote>{SMS_CONSENT_CLIENT}</blockquote>
      <p>
        The box is unchecked by default, consent is never required to book with us,
        and we keep a dated record of what you agreed to.
      </p>

      <h2>Email</h2>
      <p>
        We email you about your quote, booking, payments, and event. We may also send
        occasional updates about our services. Every non-transactional email has an
        unsubscribe link, and unsubscribing does not affect messages about a booking
        you already have.
      </p>

      <h2>Cookies</h2>
      <p>
        We use cookies and similar browser storage only to keep you signed in and to
        remember your progress in our quote form. We do not use advertising or
        cross-site tracking cookies.
      </p>

      <h2>Who we share information with</h2>
      <p>
        We share only what a provider needs to do its job for us. We do not sell
        personal information, and we do not share it for anyone else's marketing.
      </p>
      <ul>
        <li>Stripe, to process payments</li>
        <li>Twilio, to send and receive text messages and calls</li>
        <li>Resend, to send email</li>
        <li>Google, for venue address lookup</li>
        <li>Sentry, for error diagnostics</li>
        <li>Cloudflare and Neon, for file storage and our database</li>
        <li>Our hosting providers, to run the site</li>
      </ul>
      <p>
        We may also disclose information when the law requires it, or to establish or
        defend legal claims.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Event, payment, and staffing records are kept as long as we need them for
        business, accounting, and legal purposes. Records of your text message consent
        and of any opt-out are kept for as long as we operate the messaging program,
        so we can show what you agreed to and when.
      </p>

      <h2>Your choices</h2>
      <p>
        Reply STOP to any text to stop texts. Use the unsubscribe link in any
        marketing email to stop those emails. To ask what we hold about you, to
        correct it, or to request deletion, email contact@drbartender.com. We will
        respond within a reasonable time. Some records we are required to keep cannot
        be deleted on request.
      </p>

      <h2>Security</h2>
      <p>
        Traffic to this site is encrypted, passwords are stored hashed, and access to
        client and staff records is limited to people who need it. No system is
        perfectly secure, and we cannot guarantee absolute security.
      </p>

      <h2>Children</h2>
      <p>
        This site is not directed to children, and we do not knowingly collect
        information from anyone under 18. Our staff positions require applicants to be
        21 or older.
      </p>

      <h2>Changes</h2>
      <p>
        If we change this policy we will update the date at the top of this page.
      </p>

      <h2>Contact</h2>
      <p>
        Dr. Bartender LLC, Chicago, Illinois.
        <br />
        <a href="mailto:contact@drbartender.com">contact@drbartender.com</a>
      </p>
      <p>
        See also our <Link to="/terms">Terms of Use</Link>.
      </p>
    </LegalLayout>
  );
}
