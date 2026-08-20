import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../../../utils/api';
import { useToast } from '../../../../context/ToastContext';
import EntityLink from '../../../../components/EntityLink';
import StatusChip from '../../../../components/adminos/StatusChip';
import { fmt$fromCents } from '../../../../components/adminos/format';
import AwardDialog from './AwardDialog';

// The quarterly contest, moved out of the retired Reviews page's
// LeaderboardTab and
// restyled as the rail beside the review workbench (spec §7). The logic is
// unchanged: the quarter selector mirrors the server's own format rule, the
// standings and the split are rendered from the payload and never recomputed,
// and the QUARTER_IN_PROGRESS 409 still asks before it sends force.

const QUARTER_RE = /^\d{4}-Q[1-4]$/;

function currentQuarter() {
  const now = new Date();
  return `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
}

export default function ContestRail({ onAwarded, openPeriod, pendingNames = [] }) {
  const toast = useToast();
  const [quarter, setQuarter] = useState(currentQuarter());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [awarding, setAwarding] = useState(false);

  const validQuarter = QUARTER_RE.test(quarter);
  // The award writes a payout line, so the button states the reason it cannot
  // rather than firing into the server's 409. That 409 stays the backstop.
  //
  // Three states, not two. openPeriod is null while the hub's summary fetch is
  // in flight and stays null if that fetch fails, and null is UNKNOWN, not
  // closed: claiming "no open pay period" there states a fact the page does not
  // have, and disabling on it locks out an award the server would accept. Only
  // a summary that actually arrived can assert the reason; an unknown period
  // falls through to the server, whose 409 says so with authority.
  const openNow = !!(openPeriod && openPeriod.exists && openPeriod.status === 'open');
  const noOpenPeriod = !!openPeriod && !openNow;

  const load = useCallback(async (q) => {
    // Mirrors the server rule: a half-typed quarter is not a request.
    if (!QUARTER_RE.test(q)) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setData(null); // never render one quarter's standings under another's label
    try {
      const res = await api.get(`/admin/staff-reviews/leaderboard?quarter=${encodeURIComponent(q)}`);
      setData(res.data);
    } catch (err) {
      setError(err?.message || 'Failed to load the leaderboard.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(quarter); }, [load, quarter]);

  const rows = useMemo(() => data?.rows || [], [data]);
  // Winners and the split are SERVER truth. The client renders the payload and
  // never recomputes them, so the dialog cannot disagree with what gets paid.
  const shares = useMemo(() => data?.shares || [], [data]);
  const rowsById = useMemo(
    () => Object.fromEntries(rows.map(r => [r.user_id, r])),
    [rows]
  );

  async function award() {
    setAwarding(true);
    try {
      let res;
      try {
        res = await api.post('/admin/staff-reviews/contest-award', { quarter });
      } catch (err) {
        // api.js rejects a FLATTENED envelope: read err.status and err.message.
        // There is no err.response here.
        if (err?.status === 409 && (err?.code === 'QUARTER_IN_PROGRESS' || String(err?.message || '').includes('still in progress'))) {
          const go = window.confirm(
            'This quarter is not over yet. Awarding now is permanent and cannot be revised later. Award anyway?'
          );
          if (!go) return;
          res = await api.post('/admin/staff-reviews/contest-award', { quarter, force: true });
        } else {
          throw err;
        }
      }
      if (res.data?.awarded_already) {
        toast.success('This quarter was already awarded. Nothing new was created.');
      } else {
        toast.success(`Awarded ${res.data?.awards?.length || 0} winner(s).`);
      }
      setDialogOpen(false);
      load(quarter);
      if (onAwarded) onAwarded();
    } catch (err) {
      toast.error(err?.message || 'The award failed. Try again.');
    } finally {
      setAwarding(false);
    }
  }

  // Artboard 1i draws ONE contest card: head = quarter + pot, a .tbl of
  // standings, then a bordered body carrying the "if it ended today" sentence
  // and the award. The quarter selector (which no artboard draws, spec section 7)
  // sits in the same card's first body, and the empty state keeps the head, so
  // "No qualifiers yet" still reads under its quarter and its pot.
  const showStandings = validQuarter && !loading && !error;

  return (
    <>
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head">
          <h3>{quarter} contest</h3>
          {validQuarter && data && <span className="k">{fmt$fromCents(data.pot_cents)} pot</span>}
        </div>
        <div className="card-body vstack" style={{ gap: 8 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span className="muted">Quarter</span>
            <input
              className="input"
              type="text"
              value={quarter}
              placeholder="2026-Q3"
              onChange={e => setQuarter(e.target.value.trim().toUpperCase())}
              style={{ width: 120 }}
            />
          </label>
          {!validQuarter && (
            <span className="muted tiny">Enter a quarter like 2026-Q3.</span>
          )}
          {validQuarter && data && (
            <span className="muted tiny">
              {data.start_date} to {data.end_date}. Qualifying takes at least {data.min_events_worked} events
              worked and {data.min_named_five_stars} named five-star reviews.
              {data.in_progress ? ' This quarter is still running.' : ''}
            </span>
          )}
          {loading && !data && <span className="muted tiny">Loading…</span>}
          {!loading && error && (
            <>
              <span className="tiny">{error}</span>
              <div><button type="button" className="btn btn-sm" onClick={() => load(quarter)}>Retry</button></div>
            </>
          )}
          {showStandings && rows.length === 0 && (
            <span className="muted tiny">
              No qualifiers yet.
              {pendingNames.length > 0 && data && (() => {
                const row = (data.rows || []).find(r => r.name === pendingNames[0]);
                const k = (row ? Number(row.named_five_stars) : 0) + 1;
                return <> Confirming the pending review puts {pendingNames[0]} {k} of {data.min_named_five_stars} toward the floor.</>;
              })()}
            </span>
          )}
        </div>

        {showStandings && rows.length > 0 && (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Staffer</th><th className="num">Named</th><th>Qualifies</th></tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.user_id}>
                    <td className={r.eligible ? undefined : 'muted'}>
                      <EntityLink to={`/staffing/users/${r.user_id}`}>
                        {r.eligible ? <strong>{r.name}</strong> : r.name}
                      </EntityLink>
                    </td>
                    <td className={r.eligible ? 'num' : 'num muted'}>{r.named_five_stars} of {r.events_worked}</td>
                    <td>
                      {r.eligible
                        ? <StatusChip kind="ok">yes</StatusChip>
                        : <span className="muted tiny">below the floor</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="card-body vstack" style={{ gap: 8, borderTop: '1px solid var(--line-1)' }}>
          {showStandings && shares.length > 0 && (
            <span className="tiny muted">
              {data.in_progress ? 'Quarter still running. If it ended today, ' : 'Quarter closed: '}
              {shares.map(sh => sh.name).join(shares.length === 2 ? ' and ' : ', ')} {shares.length === 1 ? 'takes' : 'split'} the pot.
            </span>
          )}
          <div className="hstack" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!validQuarter || loading || shares.length === 0 || noOpenPeriod}
              onClick={() => setDialogOpen(true)}
            >
              Award the quarter
            </button>
            {noOpenPeriod && <span className="muted tiny">No open pay period. Open one before awarding.</span>}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>How review money works</h3></div>
        <div className="card-body">
          <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
            <li>Thumbtack reviews land here on their own. Log Google reviews by hand.</li>
            <li>Name who earned it. Five stars with a name carries the bounty.</li>
            <li>Confirm writes the bounty line to the open pay run. Each quarter, the most reviewed split the pot.</li>
          </ol>
        </div>
      </div>

      {dialogOpen && (
        <AwardDialog
          quarter={quarter}
          shares={shares}
          rowsById={rowsById}
          inProgress={!!data?.in_progress}
          busy={awarding}
          onCancel={() => setDialogOpen(false)}
          onConfirm={award}
        />
      )}
    </>
  );
}
