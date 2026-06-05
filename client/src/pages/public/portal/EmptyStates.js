import React from 'react';
export function BrandNewEmpty({ name }) {
  return (<div className="cp-empty"><h3>Welcome to the lab{name ? `, ${name}` : ''}.</h3>
    <p>You do not have any events on file yet.</p>
    <a className="btn client-btn-primary" href="/quote">Get an instant quote</a></div>);
}
export function NoEvent({ archiveCount }) {
  return (<div className="cp-empty"><h3>No event on the books yet.</h3>
    <p>{archiveCount > 0 ? 'Your past events are below.' : 'When we build your next event, it shows up here.'}</p>
    <a className="btn client-btn-primary" href="/quote">Start a new quote</a></div>);
}
