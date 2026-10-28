'use strict';

// finalize's validation (instruction rewrite step 2, lane receipt-lib; spec
// 2026-10-19 sections 3.5 to 3.9), as pure functions. scripts/review-receipt.js
// reads the files and asks git, and hands the results here; nothing in this
// module touches the disk or git. validate() returns every problem, one line
// each, and the receipt.json finalize would write; a problem names lenses,
// files, ids and counts, never a word of a report, a log or a reason. The
// commits and the bases are judged in scripts/lib/receiptBase.js.
//
// The input to validate():
//   name, kind, tier       the review's working name, --kind and --tier
//   state                  the working receipt.json (reports, triage, tests,
//                          externals)
//   texts                  {report file: its text} for every stored report
//   select, selectError    select.json as parsed (or null), or why it could
//                          not be read
//   git                    what the CLI's gather read from git: base,
//                          reviewed, main, tip, head and tree (quick fix), parent
//                          (commit), mergeBase and baseOnTip (lane),
//                          baseOnMain, reviewedOnMain, key,
//                          files, changedSince ({position a report was read
//                          at: the files changed between it and the final
//                          one}), computedTier, computedTiers and
//                          computedFloors (sensitive-match's tierFromGit over
//                          the diff now), readBase, olderBase and
//                          overlapFiles (the base each report was read on,
//                          whether one is older, and what main changed between
//                          an older one and reviewed), landedSensitive (a
//                          sensitive path among the files main changed between
//                          the base, or an older base a report was read on,
//                          and reviewed),
//                          and problems (refs it could not resolve, a key or
//                          a tier it could not compute)
//   flags                  allowNotReached, staleBase, notAFix, proof ({json}, the
//                          parsed file scripts/comment-only-proof.js wrote, or
//                          {error}), failing ({file, count, text, logName} or
//                          {error})
//   now                    the ISO timestamp the receipt records
//
// select.json is review-select.js's output, read in snake_case only (a
// camelCase key is named as a problem, never read; other keys are ignored):
//   tier               required; one of A, hinge, B, C, docs; --tier may not
//                      be lower, nor lower than the tier finalize computes
//                      for the diff itself (sensitive-match's tierFromGit)
//   tiers_by_file      {file: tier}; each tier's floor lenses are required;
//                      its files are exactly the diff's (README.md and
//                      ARCHITECTURE.md aside), and each file's tier is the
//                      one tierFromGit computes now, else the selection is
//                      stale (a later change, a money write to a listed file
//                      among them, could have raised it); the computed floor
//                      lenses are required too
//   matched_paths      [{path, pattern, section}], recorded as given
//   content_rule_hits  [{file, line, text, rule}], recorded as given
//   floors             [lens], required
//   lenses             [{name, fired_because: [trigger name or floor],
//                      forecast: true|false}], required; forecast is false
//                      when absent
//   unforecast_lenses  [lens], recorded as given
//   externals, verify  true requires them below tier A too
//   tests              {smoke: bool, suites: [path], client_build: bool}; the
//                      smoke when smoke is true, a reached-suites run when
//                      suites is not empty
//   collapse           recorded nowhere (the skill reads it)
//   refuse_quick_fix   true refuses a quick-fix review (tier A is a lane)
//   tip                optional until review-tooling writes it: the full sha
//                      review-select read (a lane's tip, a quick fix's HEAD,
//                      a commit review's commit); finalize refuses one that
//                      is not the final tip (review 4, L2)
// A lens in the receipt carries fired_because from the selection, else floor
// for a floor lens, else an empty list (it ran without being selected).

const R = require('./receipt');
const { parse: parseTap } = require('./tapSummary');
const { TIER_FLOORS, TIER_ORDER } = require('../sensitive-match');
const { checkCommits, checkMains, checkOverlap: overlapPass, changedFor, stored, listed } = require('./receiptBase');

const REVIEWERS = Object.freeze(['codex', 'gemini']);
const SUITE_TIERS = Object.freeze(['A', 'B', 'hinge']);

function isObject(o) {
  return Boolean(o) && typeof o === 'object' && !Array.isArray(o);
}

const CAMEL = /[a-z0-9][A-Z]/;
const SELECT_LISTS = Object.freeze(['matched_paths', 'content_rule_hits', 'floors', 'lenses', 'unforecast_lenses']);
const SELECT_BOOLS = Object.freeze(['externals', 'verify', 'collapse', 'refuse_quick_fix']);

// select.json, review-select.js's output, read in snake_case only (the shape is
// in review-receipt.js's header) -> {select, problems}. A camelCase key is
// named, never read; a lens entry needs a name that exists and fired_because,
// a non-empty list of trigger names (or floor); forecast is true or false, and
// false when absent.
function readSelect(raw) {
  const problems = [];
  const P = (s) => problems.push(s);
  if (!isObject(raw)) return { select: null, problems: ['select: select.json is not an object'] };
  const keys = [
    ...Object.keys(raw),
    ...(Array.isArray(raw.lenses) ? raw.lenses.flatMap((l) => (isObject(l) ? Object.keys(l) : [])) : []),
    ...(isObject(raw.tests) ? Object.keys(raw.tests) : []),
  ];
  const camel = [...new Set(keys.filter((k) => CAMEL.test(k)))];
  if (camel.length) P(`select: select.json is snake_case; ${camel.join(', ')} is not read`);
  if (raw.tier === undefined) P('select: no tier (review-select.js prints one)');
  else if (!TIER_ORDER.includes(raw.tier)) P('select: its tier is not one of A, hinge, B, C, docs');
  const out = { tier: TIER_ORDER.includes(raw.tier) ? raw.tier : undefined, tiersByFile: raw.tiers_by_file === undefined ? {} : raw.tiers_by_file };
  if (!isObject(out.tiersByFile) || !Object.values(out.tiersByFile).every((t) => TIER_ORDER.includes(t))) {
    P('select: tiers_by_file maps each file to one of A, hinge, B, C, docs');
    out.tiersByFile = {};
  }
  const lists = {};
  for (const k of SELECT_LISTS) {
    lists[k] = raw[k] === undefined ? [] : raw[k];
    if (!Array.isArray(lists[k])) {
      P(`select: ${k} is not a list`);
      lists[k] = [];
    }
  }
  for (const k of SELECT_BOOLS) if (raw[k] !== undefined && typeof raw[k] !== 'boolean') P(`select: ${k} is not true or false`);
  if (!lists.floors.every((l) => R.LENSES.includes(l))) P('select: floors names a lens that does not exist');
  if (!lists.unforecast_lenses.every((l) => R.LENSES.includes(l))) P('select: unforecast_lenses names a lens that does not exist');
  if (!lists.lenses.every((l) => isObject(l) && R.LENSES.includes(l.name))) P('select: lenses names a lens that does not exist');
  out.lenses = [];
  for (const l of lists.lenses.filter((x) => isObject(x) && R.LENSES.includes(x.name))) {
    const why = l.fired_because;
    if (!Array.isArray(why) || why.length === 0 || !why.every((n) => typeof n === 'string' && n.trim())) P(`select: ${l.name} has no fired_because (a list of trigger names, or floor)`);
    if (l.forecast !== undefined && typeof l.forecast !== 'boolean') P(`select: ${l.name}'s forecast is not true or false`);
    out.lenses.push({ name: l.name, fired_because: Array.isArray(why) ? why : [], forecast: l.forecast === true });
  }
  const tests = raw.tests === undefined ? {} : raw.tests;
  if (!isObject(tests)) P('select: tests is not an object');
  const t = isObject(tests) ? tests : {};
  for (const k of ['smoke', 'client_build']) if (t[k] !== undefined && typeof t[k] !== 'boolean') P(`select: tests.${k} is not true or false`);
  if (t.suites !== undefined && !(Array.isArray(t.suites) && t.suites.every((x) => typeof x === 'string'))) P('select: tests.suites is not a list of paths');
  out.tests = { smoke: t.smoke === true, suites: Array.isArray(t.suites) ? t.suites.filter((x) => typeof x === 'string') : [], client_build: t.client_build === true };
  out.matchedPaths = lists.matched_paths;
  out.contentRuleHits = lists.content_rule_hits;
  out.floors = lists.floors.filter((l) => R.LENSES.includes(l));
  out.unforecast = lists.unforecast_lenses;
  for (const k of SELECT_BOOLS) out[k] = raw[k] === true;
  if (raw.tip !== undefined && !R.KEY_RE.test(String(raw.tip))) P('select: tip is not a full commit id');
  out.tip = R.KEY_RE.test(String(raw.tip)) ? raw.tip : null;
  return { select: out, problems };
}

// A stored report as its lens reads it: verify's findings only (no table,
// spec 3.5), a lens's own section of a collapsed report.
function parseStored(text, lens) {
  return R.parseVerdictTable(text, lens === 'verify' ? { findingsOnly: true } : { lens });
}

// One lens's (or verify's) stored reports in storage order, parsed, with the
// triage counts; the latest stored report that lists a file sets its verdict.
// A finding marked fixed is re-reviewed (spec 3.9) only by a pass of the lens
// that raised it, stored later, whose table lists the finding's file as pass
// (a pass that leaves the file out, or lists it as finding or not reached,
// does not count); verify, which returns no table, by a later verify pass
// that raises nothing on that file.
function lensSummary(state, texts, lens) {
  const entries = state.reports.map((r, i) => ({ ...r, i })).filter((r) => r.lens === lens).sort((a, b) => stored(a) - stored(b));
  const parsed = entries.map((e) => ({ entry: e, name: e.file, ...parseStored(texts[e.file], lens) }));
  const merged = R.mergeVerdicts(parsed);
  const findings = parsed.flatMap((p) => p.findings.map((f) => ({ report: p.name, at: stored(p.entry), id: f.id, file: f.file })));
  const cleared = (f) => parsed.some((q) => stored(q.entry) > f.at && (lens === 'verify'
    ? !q.malformed && !q.findings.some((x) => x.file === f.file)
    : q.rows.some((r) => r.file === f.file && r.verdict === 'pass')));
  const out = { entries, parsed, merged, raised: findings.length, confirmed: 0, fixed: 0, rejected: 0, untriaged: [], fixedNoRepass: [] };
  for (const f of findings) {
    const tr = state.triage[`${f.report}#${f.id}`];
    if (!tr) {
      out.untriaged.push(f);
    } else if (tr.status === 'rejected') {
      out.rejected++;
    } else {
      out.confirmed++;
      if (tr.status === 'fixed') {
        out.fixed++;
        if (!cleared(f)) out.fixedNoRepass.push(f);
      }
    }
  }
  return out;
}

// A verdict holds for the content its lens read (spec 3.8 and 3.9). Each
// stored report records where it was read: the branch tip in a lane, the
// staged tree in a quick fix (`posOf`). A file whose merged verdict came from
// a report read before a later change to that file is stale until a later
// report of the same lens lists it. What changed since a report is
// receiptBase.changedFor: the files changed between its position and `final`,
// and, read on an older base, the files main changed since that base; git
// unable to say leaves every file that report gave a verdict stale.
function staleFiles(s, diffFiles, final, g, posOf) {
  const byFile = new Map(s.entries.map((e) => [e.file, e]));
  return diffFiles.filter((f) => {
    const m = s.merged[f];
    if (!m || m.verdict === 'not reached') return false;
    const changed = changedFor(byFile.get(m.report) || {}, final, g, posOf);
    return !changed || changed.includes(f);
  });
}

// The review mode and the kind: {ok, problems}. ok means the CLI may gather
// the key for this kind.
function checkKind(mode, kind) {
  if (!R.KINDS.includes(kind)) return { ok: false, problems: [`kind: ${kind} is not one of the six kinds (${R.KINDS.join(', ')})`] };
  if (kind === 'squash' || kind === 'revert') return { ok: false, problems: [`kind: ${kind} receipts are written by merge-lane.sh ship, not by finalize`] };
  const allowed = { lane: ['lane', 'comment-only'], 'quick-fix': ['quick-fix', 'comment-only'], commit: ['commit'] }[mode];
  if (!allowed.includes(kind)) return { ok: false, problems: [`kind: a ${mode} review cannot be finalized as ${kind} (it takes ${allowed.join(' or ')})`] };
  return { ok: true, problems: [] };
}

// The overlap pass of spec 3.8 (scripts/lib/receiptBase.js checkOverlap), for
// a kind finalize gathers facts for.
function checkOverlap(c) {
  return checkKind(c.state.mode, c.kind).ok ? overlapPass(c) : [];
}

// Every test entry ran at the final position (spec 3.1 item 5: the final
// tree): a lane's or a commit's tip, a quick fix's staged tree, and a commit
// review's with the checkout's HEAD at the commit. An entry that ran
// elsewhere is named; `tests` moves earlier entries to tests_superseded when
// it records one at a new position, so a run before a fix commit is replaced
// by running it again, never counted.
function checkTestPositions(mode, tests, g) {
  const qf = mode === 'quick-fix';
  const final = qf ? g.tree : g.tip;
  if (!final) return [];
  const S = R.short;
  return tests.flatMap((x) => {
    const at = qf ? x.tree : x.tip;
    const what = `the ${x.type} entry ${x.log || '(no log)'}`;
    if (mode === 'commit' && x.head !== final) return [`tests: ${what} ran with HEAD at ${x.head ? S(x.head) : '(none)'}, not the commit ${S(final)}; check out the commit and run it again`];
    if (at === final) return [];
    if (!at) return [`tests: ${what} records no position; record it again after position`];
    return [qf ? `tests: ${what} ran at tree ${S(at)}, the staged tree is ${S(final)}; run it again on the final tree`
      : `tests: ${what} ran at ${S(at)}, the tip is ${S(final)}; run it again on the final tip`];
  });
}

// validate() runs these named checks in order over one context (c): the input,
// plus what the checks before have read (select, diffFiles, the per-lens
// summaries and verify's). Each returns problems; the order of the lines is
// the order a refusal prints them.

// A comment-only proof (scripts/comment-only-proof.js's JSON, plan 2026-10-27
// "The receipt tool") against the review: version 1, ok, the review's mode
// (a range proof for a lane, a staged one for a quick fix), its base and tip
// (lane) or its base and staged tree (quick fix), and every diff file but the
// generated docs present and ok. The checks run in stages and stop at the
// first stage that fails, so each refusal is one line about one thing; a
// value from the proof is printed only as a sha7 or a whole number (the
// console carries no text a file brought in).
function proofProblems(p, mode, g) {
  const S = (x) => (typeof x === 'string' && R.KEY_RE.test(x) ? R.short(x) : '(none)');
  if (!isObject(p)) return ['proof: not a proof object'];
  if (p.version !== 1) return [`proof: version ${Number.isSafeInteger(p.version) ? p.version : '(not a number)'} is not 1`];
  if (p.ok !== true) return ['proof: the proof says not comment-only'];
  const lane = mode === 'lane';
  if (lane && p.mode !== 'range') return [p.mode === 'staged' ? 'proof: a staged proof cannot finalize a lane review' : 'proof: its mode is neither range nor staged'];
  if (!lane && p.mode !== 'staged') return [p.mode === 'range' ? 'proof: a range proof cannot finalize a quick fix' : 'proof: its mode is neither range nor staged'];
  const problems = [];
  if (p.base !== g.base) problems.push(`proof: base ${S(p.base)} is not the review's base ${S(g.base)}`);
  if (lane && p.tip !== g.tip) problems.push(`proof: tip ${S(p.tip)} is not the review's tip ${S(g.tip)}`);
  if (!lane && p.tree !== g.tree) problems.push(`proof: tree ${S(p.tree)} is not the staged tree ${S(g.tree)}`);
  if (problems.length) return problems;
  if (!Array.isArray(p.files)) return ['proof: files is not a list'];
  // A path listed twice is ok only when every entry for it is.
  const verdicts = new Map();
  for (const f of p.files.filter(isObject)) verdicts.set(f.path, verdicts.get(f.path) !== false && f.ok === true);
  const want = (g.files || []).filter((f) => !R.GENERATED_DOCS.includes(f));
  const missing = want.filter((f) => !verdicts.has(f));
  const bad = want.filter((f) => verdicts.get(f) === false);
  if (missing.length) problems.push(`proof: ${listed(missing)} ${missing.length === 1 ? 'is' : 'are'} not in the proof`);
  if (bad.length) problems.push(`proof: ${listed(bad)} ${bad.length === 1 ? 'is' : 'are'} not ok in the proof`);
  return problems;
}

// The kind and the proof.
function checkProof(c) {
  const { kind, tier, state, flags, g } = c;
  const kindCheck = checkKind(state.mode, kind);
  const problems = [...kindCheck.problems];
  const proof = flags.proof;
  if (proof !== undefined && proof !== null && kind !== 'comment-only') problems.push('proof: --proof is only for --kind comment-only');
  if (kind === 'comment-only' && (proof === undefined || proof === null)) problems.push('proof: --kind comment-only needs --proof <file>');
  if (proof && proof.error) problems.push(`proof: ${proof.error}`);
  else if (proof && kind === 'comment-only' && kindCheck.ok) problems.push(...proofProblems(proof.json, state.mode, g));
  if (tier === 'A' && (state.mode === 'quick-fix' || kind === 'quick-fix')) problems.push('tier: tier A is a lane, never a quick fix');
  return problems;
}

// The selection: review-select.js's output, required for every kind but
// comment-only (no lens runs there). Sets c.select.
function checkSelection(c) {
  const { kind, tier, state, input } = c;
  const problems = [];
  c.select = null;
  if (input.selectError) {
    problems.push(`select: ${input.selectError}`);
  } else if (input.select !== undefined && input.select !== null) {
    const r = readSelect(input.select);
    c.select = r.select;
    problems.push(...r.problems);
  } else if (kind !== 'comment-only' && R.KINDS.includes(kind)) {
    problems.push(`select: --kind ${kind} needs --select <select.json> (review-select.js's output)`);
  }
  const sel = c.select;
  if (sel && sel.refuse_quick_fix && state.mode === 'quick-fix') problems.push('tier: select.json computes a tier A file; tier A is a lane, never a quick fix');
  if (sel && sel.tier !== undefined && TIER_ORDER.includes(sel.tier) && TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(sel.tier)) {
    problems.push(`tier: ${tier} is lower than the computed tier ${sel.tier}`);
  }
  return problems;
}

// The commits, the key and the files: git's own problems, the commits
// against each other, each report against the base, and the selection
// against the diff. Sets c.diffFiles.
function checkGit(c) {
  const { state, g, flags, select } = c;
  const problems = [...(g.problems || []), ...checkCommits(state.mode, g, flags)];
  // A kind finalize refuses gathers no facts for the reports (review 3, L5).
  if (!c.commentOnly && checkKind(state.mode, c.kind).ok) problems.push(...checkMains(state.mode, state.reports, g, flags));
  c.diffFiles = g.files || [];
  // A selection computed before a later commit names other files: its tier
  // and lenses are stale. tiers_by_file names the generated docs; the key
  // does not.
  if (select && g.files) {
    const keys = Object.keys(select.tiersByFile).filter((f) => !R.GENERATED_DOCS.includes(f));
    const missing = c.diffFiles.filter((f) => !keys.includes(f));
    const extra = keys.filter((f) => !c.diffFiles.includes(f));
    const parts = [missing.length ? `not in it: ${listed(missing)}` : '', extra.length ? `not in the diff: ${listed(extra)}` : ''].filter(Boolean);
    if (parts.length) problems.push(`select: tiers_by_file does not match the diff (${parts.join('; ')}); run review-select again at the final tip`);
  }
  if (select && select.tip && g.tip && select.tip !== g.tip) problems.push(`select: select.json was computed at ${R.short(select.tip)}; the tip is ${R.short(g.tip)}: run review-select again`);
  return problems;
}

// The tier the diff computes to now (review 3, M3): --tier may not be lower,
// and select.json's per-file tiers must be the computed ones, so a selection
// read before a later change (a money write to a listed file) cannot keep a
// lighter review. A kind finalize refuses gathers no tier. Comment-only is
// held to the floor too: its --tier is what the receipt and the commit block
// record, so it may not read lower than the diff computes.
function checkTier(c) {
  const { tier, g, select, state, kind } = c;
  if (!checkKind(state.mode, kind).ok) return [];
  if (!g.computedTier) {
    return g.files && !(g.problems || []).some((p) => p.startsWith('tier:')) ? ['tier: no computed tier for the diff; finalize computes it itself'] : [];
  }
  const problems = [];
  if (TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(g.computedTier)) problems.push(`tier: ${tier} is lower than the tier sensitive-match computes for the diff, ${g.computedTier}`);
  const computed = g.computedTiers || {};
  const differ = select ? Object.keys(computed).filter((f) => select.tiersByFile[f] !== undefined && select.tiersByFile[f] !== computed[f]) : [];
  if (differ.length) {
    problems.push(`select: tiers_by_file gives ${listed(differ.map((f) => `${f} (${select.tiersByFile[f]}, computed ${computed[f]})`))} another tier than sensitive-match computes for the diff now; run review-select again at the final tip`);
  }
  return problems;
}

// The lenses: the floors of every tier in the diff, the selection, and every
// lens that stored a report. A lens fired because of its trigger names (the
// selection's fired_because) or its floor; one that ran without either
// carries an empty fired_because. Sets c.lenses, c.summaries, c.notReached,
// c.escalated and c.tiersByFile.
function checkLenses(c) {
  const { kind, tier, state, texts, select, diffFiles } = c;
  const problems = [];
  c.tiersByFile = select ? select.tiersByFile : {};
  const floors = new Set(select ? select.floors : []);
  for (const t of new Set([tier, ...Object.values(c.tiersByFile)])) for (const l of TIER_FLOORS[t] || []) floors.add(l);
  for (const l of c.g.computedFloors || []) floors.add(l);
  const selected = new Map(((select && select.lenses) || []).map((l) => [l.name, l]));
  const required = kind === 'comment-only' ? new Set() : new Set([...floors, ...selected.keys()]);
  const ran = new Set(state.reports.filter((r) => r.lens !== 'verify').map((r) => r.lens));
  for (const l of R.LENSES) if (required.has(l) && !ran.has(l)) problems.push(`lenses: ${l} was selected and has no report`);
  Object.assign(c, { summaries: new Map(), lenses: [], notReached: [], escalated: [] });
  for (const lens of R.LENSES.filter((l) => required.has(l) || ran.has(l))) {
    const s = ran.has(lens) ? lensSummary(state, texts, lens) : null;
    c.summaries.set(lens, s);
    const merged = s ? s.merged : Object.create(null);
    const cov = R.coverage(diffFiles, merged);
    // A lens with no report at all is its own problem above, not a coverage gap.
    if (s) for (const f of cov.not_reached) c.notReached.push({ lens, file: f });
    for (const f of diffFiles) if (merged[f] && merged[f].verdict === 'escalate') c.escalated.push({ lens, file: f });
    const sel = selected.get(lens);
    c.lenses.push({
      name: lens,
      fired_because: sel ? sel.fired_because : floors.has(lens) ? ['floor'] : [],
      forecast: sel ? sel.forecast : false,
      raised: s ? s.raised : 0,
      confirmed: s ? s.confirmed : 0,
      fixed: s ? s.fixed : 0,
      rejected: s ? s.rejected : 0,
      passes: s ? s.entries.map((e) => e.file) : [],
      verdicts: Object.fromEntries(diffFiles.filter((f) => merged[f]).map((f) => [f, merged[f].verdict])),
      _covered: cov.files_with_verdicts,
    });
  }
  return problems;
}

// Spec 3.5: a file not reached is re-dispatched to its lens once, and a
// second miss blocks unless --allow-not-reached; so the flag admits a file
// only when a --pass report of its lens (the re-dispatch) says so, with an
// explicit not reached row for it. A re-pass that leaves it out (one of
// another file) or is malformed is no evidence it was re-dispatched.
function checkCoverage(c) {
  const { notReached, summaries, flags } = c;
  if (!notReached.length || c.commentOnly) return [];
  const named = (list) => `${list.slice(0, 8).map((x) => `${x.lens}: ${x.file}`).join(', ')}${list.length > 8 ? `, and ${list.length - 8} more` : ''}`;
  if (!flags.allowNotReached) {
    return [`coverage: ${new Set(notReached.map((x) => x.file)).size} file(s) not reached (${named(notReached)}); re-dispatch each to its lens once, or pass --allow-not-reached`];
  }
  const missedAgain = (x) => summaries.get(x.lens).parsed.some((p) => p.entry.pass > 0 && p.rows.some((r) => r.file === x.file && r.verdict === 'not reached'));
  const unproven = notReached.filter((x) => !missedAgain(x));
  return unproven.length ? [`coverage: --allow-not-reached admits a file only after its one re-dispatch missed it too, a --pass report of its lens with a not reached row for it; none for ${named(unproven)} (re-dispatch it to that lens once, --pass <n>)`] : [];
}

// Stale verdicts: a lane's reports against the final tip, a quick fix's
// against the finalize-time staged tree (a commit review's tip never moves),
// then an escalation below tier A. Sets c.v, verify's summary.
function checkStale(c) {
  const { state, texts, g, tier, diffFiles, summaries, escalated, commentOnly } = c;
  const problems = [];
  const final = { lane: g.tip, 'quick-fix': g.tree }[state.mode];
  const posOf = state.mode === 'quick-fix' ? (e) => e.tree : (e) => e.tip;
  if (!commentOnly && (state.mode === 'lane' || state.mode === 'quick-fix')) {
    for (const [lens, s] of summaries) {
      if (!s) continue;
      const stale = staleFiles(s, diffFiles, final, g, posOf);
      const it = stale.length === 1 ? 'it' : 'them';
      if (stale.length) problems.push(`stale: ${lens} read ${listed(stale)} before a later change to ${it}; re-pass ${lens} on ${it} (--pass <n>)`);
    }
  }
  if (escalated.length && tier !== 'A') {
    problems.push(`escalate: ${escalated.length} file(s) escalated (${escalated.map((x) => `${x.lens}: ${x.file}`).join(', ')}); an escalation makes the review tier A`);
  }
  const v = state.reports.some((r) => r.lens === 'verify') ? lensSummary(state, texts, 'verify') : null;
  c.v = v;
  // A lane's verify returns no table, so its latest pass must have read every
  // diff file as it stands at the final tip (the stale rule, lane-wide, an
  // older base's main changes among them).
  if (!commentOnly && state.mode === 'lane' && v) {
    const latest = v.entries[v.entries.length - 1];
    const changed = changedFor(latest, g.tip, g, (e) => e.tip);
    const stale = diffFiles.filter((f) => !changed || changed.includes(f));
    if (stale.length) problems.push(`stale: verify's latest pass (${latest.file}) read the lane before a later change to ${listed(stale)}; re-pass verify (--pass <n>)`);
  }
  // A quick fix keys the staged tree (spec 3.7): every lens's latest stored
  // report, and verify's, must have read that tree.
  if (!commentOnly && state.mode === 'quick-fix') {
    for (const [lens, s] of [...summaries, ['verify', v]]) {
      if (!s) continue;
      const latest = s.entries[s.entries.length - 1];
      if (!latest.tree || latest.tree !== g.tree) problems.push(`stale: the staged tree changed after ${lens}'s latest report (${latest.file}); re-pass ${lens} on the staged tree (--pass <n>)`);
    }
  }
  return problems;
}

// Every finding triaged, and every fix re-reviewed. A finding's location is
// the report's words: printed only when it is a file in the diff.
function checkTriage(c) {
  const { summaries, v, diffFiles } = c;
  const problems = [];
  const all = [...[...summaries.values()].filter(Boolean), ...(v ? [v] : [])];
  const untriaged = all.flatMap((s) => s.untriaged);
  if (untriaged.length) {
    const shown = untriaged.slice(0, 10).map((f) => `${f.report} ${f.id}`).join(', ');
    problems.push(`triage: ${untriaged.length} finding(s) untriaged (${shown}${untriaged.length > 10 ? `, and ${untriaged.length - 10} more` : ''}); triage each one`);
  }
  for (const s of all) {
    const lens = s.entries[0].lens;
    for (const f of s.fixedNoRepass) {
      const where = diffFiles.includes(f.file) ? f.file : 'the file it names (not a file in the diff)';
      problems.push(lens === 'verify'
        ? `triage: ${f.report} ${f.id} (verify) is marked fixed but no later verify pass clears ${where} (--pass <n>)`
        : `triage: ${f.report} ${f.id} (${lens}) is marked fixed but no later ${lens} pass lists ${where} as pass (--pass <n>)`);
    }
  }
  return problems;
}

// Verify and the externals ride tier A (spec 3.3), or the selection's say.
// Sets c.externals.
function checkVerifyExternals(c) {
  const { tier, state, select, v, commentOnly } = c;
  const problems = [];
  const why = (selKey) => (commentOnly ? null : tier === 'A' ? 'tier A' : select && select[selKey] ? 'select.json' : null);
  if (!v && why('verify')) problems.push(`verify: ${why('verify')} needs the verify pass (verify <name> <report.md>)`);
  for (const p of v ? v.parsed.filter((x) => x.malformed) : []) problems.push(`verify: ${p.name} is malformed (${p.problems.length} problem(s)); a finding read twice or in a form the reading misses escapes triage, and a report with neither a finding nor the No findings record is no verdict, so a malformed verify report blocks finalize`);
  c.externals = {};
  for (const who of REVIEWERS) {
    if (state.externals[who]) c.externals[who] = state.externals[who];
    else if (why('externals')) problems.push(`externals: ${why('externals')} records ${who} as run or not run (externals <name> ${who}=...)`);
    else c.externals[who] = { state: 'not_run', reason: commentOnly ? 'comment-only: no lens runs (spec 3.7)' : `not required at tier ${tier}` };
  }
  return problems;
}

// Tests (spec 3.3's tests column, or the selection's), each run at the final
// position.
function checkTests(c) {
  const { tier, state, g, select, diffFiles } = c;
  if (c.commentOnly) return [];
  const problems = [...checkTestPositions(state.mode, state.tests, g)];
  const st = (select && select.tests) || { smoke: false, suites: [], client_build: false };
  const suitesWhy = SUITE_TIERS.includes(tier) ? `tier ${tier}` : st.suites.length ? 'select.json' : null;
  if (suitesWhy && !state.tests.some((x) => x.type === 'suites' || x.type === 'log')) {
    problems.push(`tests: no reached-suites run recorded; ${suitesWhy} needs one (tests <name> --suites <dir> or --log <file>)`);
  }
  const smokeWhy = tier === 'A' ? 'tier A' : st.smoke ? 'select.json' : null;
  if (smokeWhy && !state.tests.some((x) => x.type === 'smoke')) problems.push(`tests: no money smoke recorded; ${smokeWhy} needs one (tests <name> --smoke <dir>)`);
  // The client build: the latest recorded build counts, and a failed one is
  // refused whether or not a build was required.
  const builds = state.tests.filter((x) => x.type === 'build');
  const build = builds[builds.length - 1];
  const buildWhy = diffFiles.some((f) => f.startsWith('client/')) ? 'a client/ file in the diff' : st.client_build ? 'select.json' : null;
  if (build && build.ok !== true) problems.push(`tests: the latest client build failed (${build.why || `exit ${build.exit}`}); record a green one (tests <name> --build <log> --exit <code>)`);
  else if (buildWhy && !build) problems.push(`tests: no client build recorded; ${buildWhy} needs one (tests <name> --build <log> --exit <code>)`);
  return problems;
}

// The failing test on the old code (D13), or why this is not a fix.
function checkFailing(c) {
  const { failing, notAFix } = c.flags;
  if (!failing) {
    return notAFix === undefined && !c.commentOnly
      ? ['failing test: name the test that fails on the old code (--failing-test <file>:<count> --failing-log <log>) or say why this is not a fix (--not-a-fix <reason>)']
      : [];
  }
  const problems = [];
  if (failing.count < 1) problems.push('failing test: the count must be at least 1');
  if (failing.error) {
    problems.push(`failing test: ${failing.error}`);
  } else {
    const s = parseTap(failing.text);
    if (!s.found) problems.push(`failing test: ${failing.logName} has no TAP summary`);
    else if (s.fail !== failing.count) problems.push(`failing test: the log's # fail line says ${s.fail}, not ${failing.count}`);
  }
  return problems;
}

// The receipt.json finalize writes, once every check passed.
function buildReceipt(c) {
  const { name, kind, tier, state, g, flags, now, select, diffFiles, lenses, v } = c;
  const { failing, proof } = flags;
  const covered = lenses.length ? diffFiles.filter((f) => lenses.every((l) => l._covered.includes(f))) : [];
  for (const l of lenses) delete l._covered;
  return {
    version: 1,
    state: 'final',
    key: g.key,
    kind,
    name,
    mode: state.mode,
    branch: state.branch,
    tip: g.tip,
    reviewed_against: g.reviewed,
    base: g.base,
    stale_base: Boolean(flags.staleBase),
    tier,
    tiers_by_file: c.tiersByFile,
    matched_paths: select ? select.matchedPaths : [],
    content_rule_hits: select ? select.contentRuleHits : [],
    lenses,
    unforecast_lenses: select ? select.unforecast : [],
    coverage: { files_in_diff: diffFiles, files_with_verdicts: covered, not_reached: c.notReached, allowed_not_reached: Boolean(flags.allowNotReached) },
    tests: state.tests,
    tests_superseded: state.tests_superseded || [],
    failing_test_on_old_code: failing ? { file: failing.file, count: failing.count, log: 'tests/failing-on-old-code.log' } : null,
    not_a_fix: flags.notAFix !== undefined ? flags.notAFix : c.commentOnly && !failing ? 'comment-only: the proof shows the diff adds nothing but comment lines' : null,
    externals: c.externals,
    verify: {
      run: Boolean(v),
      findings: v ? v.raised : 0,
      raised: v ? v.raised : 0,
      confirmed: v ? v.confirmed : 0,
      fixed: v ? v.fixed : 0,
      rejected: v ? v.rejected : 0,
      passes: v ? v.entries.map((e) => e.file) : [],
    },
    escalated: c.escalated,
    triage: state.triage,
    reports: state.reports,
    proof: proof && !proof.error ? 'proof.json' : null,
    created_at: state.created_at,
    timestamp: now,
    written_by: kind === 'commit' ? 'review --commit' : kind === 'comment-only' ? 'comment-only proof' : 'review skill',
  };
}

const CHECKS = Object.freeze([checkProof, checkSelection, checkGit, checkTier, checkOverlap, checkLenses, checkCoverage, checkStale, checkTriage, checkVerifyExternals, checkTests, checkFailing]);

function validate(input) {
  const { name, kind, tier, state, texts, git: g, flags, now } = input;
  // Comment-only runs no lens (spec 3.7: the proof is the receipt's body), so
  // no lens, coverage, verify, externals, tests or failing test is required
  // of it at any tier (the tier floor still holds); every other kind keeps
  // them all.
  const c = { input, name, kind, tier, state, texts, g, flags, now, commentOnly: kind === 'comment-only' };
  const problems = CHECKS.flatMap((check) => check(c));
  if (problems.length) return { problems, receipt: null };
  return { problems: [], receipt: buildReceipt(c) };
}

module.exports = { validate, readSelect, lensSummary, parseStored, checkKind, checkTestPositions, REVIEWERS, SUITE_TIERS };
