// Submit success panel for the quote and class wizards (default export): the state after
// POST /api/proposals/public/submit answers 201. With a token it offers the proposal link;
// without one the submit resolved to an existing client and the link went to the address on
// file, so it says where to look and offers no link (audit 2026-11-05 AUTH-12).

import React from 'react';
import { formatCurrency } from './helpers';

export default function SubmitSuccess({ success, topShelf = false, readyHeading = 'Your proposal is ready!', onView }) {
  // The server answers token: null when the submit matched an existing client
  // (clients.email is unique, so the proposal attached to that client's row
  // and its link was mailed to the address on file, never handed to the
  // submitter). delivered_to is that address, masked.
  const sentToFile = !success?.token;
  const where = success?.delivered_to ? success.delivered_to : 'the email address on file';

  let heading;
  let body;
  if (topShelf) {
    heading = 'Request submitted!';
    body = sentToFile
      ? <p>We'll follow up with custom Top Shelf pricing at {where}.</p>
      : <p>We'll follow up with custom Top Shelf pricing. Check your email for details.</p>;
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
