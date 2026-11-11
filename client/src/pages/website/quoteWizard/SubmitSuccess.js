// Submit success panel for the quote and class wizards (default export): the state after
// POST /api/proposals/public/submit answers 201. With a token it offers the proposal link;
// without one the submit resolved to an existing client and the link went to the address on
// file, so it says where to look and offers no link (audit 2026-11-05 AUTH-12).

import React from 'react';
import { formatCurrency } from './helpers';
import { COMPANY_PHONE, COMPANY_PHONE_TEL } from '../../../utils/constants';

export default function SubmitSuccess({ success, topShelf = false, readyHeading = 'Your proposal is ready!', onView }) {
  // The server answers token: null when the submit matched an existing client
  // (by email, or by name and phone on a row with no email): the proposal
  // attached to that client's row and its link went to the contact on file,
  // never handed to the submitter. delivered_to is that address, masked;
  // delivered_to_phone is the number on file, masked, when the link went by
  // text instead.
  const sentToFile = !success?.token;
  const textedTo = !success?.delivered_to && success?.delivered_to_phone ? success.delivered_to_phone : null;
  const where = success?.delivered_to || textedTo || 'the email address on file';
  // delivery_failed: the mail was the delivery and the server could not send
  // it (it says so rather than claim it), so the panel offers the follow-up
  // and the business line instead of "check your inbox".
  const failed = sentToFile && success?.delivery_failed === true;

  let heading;
  let body;
  if (failed && !topShelf) {
    heading = 'We\'ll follow up shortly';
    body = (
      <>
        <p>Estimated total: <strong>{formatCurrency(success.total)}</strong></p>
        <p>
          We couldn't send the link just now. We'll follow up at the contact we have on file, or reach us at{' '}
          <a href={COMPANY_PHONE_TEL}>{COMPANY_PHONE}</a>.
        </p>
      </>
    );
  } else if (topShelf) {
    heading = 'Request submitted!';
    body = sentToFile
      ? <p>We'll follow up with custom Top Shelf pricing at {where}.</p>
      : <p>We'll follow up with custom Top Shelf pricing. Check your email for details.</p>;
  } else if (sentToFile && textedTo) {
    heading = 'Check your texts';
    body = (
      <>
        <p>Estimated total: <strong>{formatCurrency(success.total)}</strong></p>
        <p>We've texted the proposal link to {textedTo}. Open it from your messages to view it.</p>
      </>
    );
  } else if (sentToFile) {
    heading = 'Check your email';
    body = (
      <>
        <p>Estimated total: <strong>{formatCurrency(success.total)}</strong></p>
        <p>We've sent the full proposal to {where}. Open it from your inbox to view it.</p>
      </>
    );
  } else {
    heading = readyHeading;
    body = (
      <>
        <p>Estimated total: <strong>{formatCurrency(success.total)}</strong></p>
        <p>We've sent the full proposal to your email. You can also view it now:</p>
      </>
    );
  }

  return (
    <div className="wz-success">
      <div className="wz-success-icon">&#10003;</div>
      <h2>{heading}</h2>
      {body}
      {!sentToFile && (
        <button className="btn btn-primary" onClick={onView} style={{ marginTop: '1rem' }}>
          View Your Proposal
        </button>
      )}
    </div>
  );
}
