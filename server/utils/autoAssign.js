/**
 * Auto-assign algorithm for shift staffing.
 * Ranks candidates by seniority, geographic proximity, and equipment match.
 */

const { pool } = require('../db');
const { sendSMS, normalizePhone } = require('./sms');
const { getEventTypeLabel } = require('./eventTypes');

// ─── Haversine distance (miles) ──────────────────────────────────

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 3958.8; // Earth radius in miles
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Parse travel distance string ────────────────────────────────

function parseTravelDistance(travelStr) {
  if (!travelStr) return 50; // default
  const match = travelStr.match(/(\d+)/);
  if (!match) return 50;
  const num = parseInt(match[1], 10);
  // "More than 100 miles" → treat as 150
  if (/more\s+than/i.test(travelStr)) return num + 50;
  return num;
}

// ─── Scoring functions ───────────────────────────────────────────

function computeSeniorityScore(eventsWorked, hireDateISO, seniorityAdjustment, weights) {
  const eventScore = eventsWorked || 0;

  let tenureMonths = 0;
  if (hireDateISO) {
    const hire = new Date(hireDateISO);
    const now = new Date();
    tenureMonths = Math.max(0,
      (now.getFullYear() - hire.getFullYear()) * 12 +
      (now.getMonth() - hire.getMonth())
    );
  }

  const raw =
    eventScore * (weights.events || 0.7) +
    tenureMonths * (weights.tenure || 0.3) +
    (seniorityAdjustment || 0);

  return { raw, eventScore, tenureMonths };
}

function computeGeoScore(staffLat, staffLng, shiftLat, shiftLng, staffTravelDistance, maxDistance) {
  // If either side has no coordinates, return neutral score
  if (
    staffLat === null || staffLat === undefined ||
    staffLng === null || staffLng === undefined ||
    shiftLat === null || shiftLat === undefined ||
    shiftLng === null || shiftLng === undefined
  ) {
    return { score: 50, distance: null };
  }

  const distance = haversineDistance(staffLat, staffLng, shiftLat, shiftLng);
  const staffMax = parseTravelDistance(staffTravelDistance);

  // Beyond absolute max → disqualified
  if (distance > maxDistance) {
    return { score: 0, distance };
  }

  let score = Math.max(0, (1 - distance / maxDistance) * 100);

  // Penalize if beyond self-reported comfort zone
  if (distance > staffMax) {
    score *= 0.5;
  }

  return { score, distance };
}

function computeEquipmentScore(profile, requiredItems, willPickup) {
  if (!requiredItems || requiredItems.length === 0) {
    return { score: 100, matched: [], missing: [] };
  }

  if (willPickup) {
    return { score: 100, matched: requiredItems, missing: [] };
  }

  const equipmentMap = {
    portable_bar: profile.equipment_portable_bar,
    cooler: profile.equipment_cooler,
    table_with_spandex: profile.equipment_table_with_spandex,
  };

  const matched = requiredItems.filter(item => equipmentMap[item]);
  const missing = requiredItems.filter(item => !equipmentMap[item]);

  let score = (matched.length / requiredItems.length) * 100;

  // Partial credit if open to getting equipment
  if (missing.length > 0 && profile.equipment_none_but_open) {
    score = Math.max(score, 50);
  }

  return { score, matched, missing };
}

// ─── Main orchestration ──────────────────────────────────────────

async function autoAssignShift(shiftId, { dryRun = false } = {}) {
  // 1. Fetch shift
  const shiftResult = await pool.query(
    `SELECT * FROM shifts WHERE id = $1`,
    [shiftId]
  );
  if (shiftResult.rows.length === 0) {
    throw new Error(`Shift ${shiftId} not found`);
  }
  const shift = shiftResult.rows[0];

  const positionsNeeded = JSON.parse(shift.positions_needed || '[]');
  const equipmentRequired = JSON.parse(shift.equipment_required || '[]');

  // Count already approved
  const approvedResult = await pool.query(
    `SELECT COUNT(*) AS cnt FROM shift_requests WHERE shift_id = $1 AND status = 'approved'`,
    [shiftId]
  );
  const alreadyApproved = parseInt(approvedResult.rows[0].cnt, 10);
  const slotsRemaining = positionsNeeded.length - alreadyApproved;

  if (slotsRemaining <= 0) {
    return { approved: [], scores: [], message: 'All positions already filled.' };
  }

  // 2. Fetch pending requests with contractor profiles
  const pendingResult = await pool.query(`
    SELECT sr.id AS request_id, sr.user_id, sr.position, sr.notes,
           cp.preferred_name, cp.phone, cp.lat, cp.lng,
           cp.travel_distance, cp.equipment_portable_bar,
           cp.equipment_cooler, cp.equipment_table_with_spandex,
           cp.equipment_none_but_open, cp.equipment_no_space,
           cp.equipment_will_pickup, cp.seniority_adjustment,
           cp.hire_date, cp.city, cp.state
    FROM shift_requests sr
    JOIN contractor_profiles cp ON cp.user_id = sr.user_id
    WHERE sr.shift_id = $1 AND sr.status = 'pending'
  `, [shiftId]);

  if (pendingResult.rows.length === 0) {
    return { approved: [], scores: [], message: 'No pending requests to evaluate.' };
  }

  // 3. Fetch events-worked count per candidate (completed events only)
  const userIds = pendingResult.rows.map(r => r.user_id);
  const eventsResult = await pool.query(`
    SELECT sr.user_id, COUNT(*) AS events_worked
    FROM shift_requests sr
    JOIN shifts s ON s.id = sr.shift_id
    WHERE sr.user_id = ANY($1)
      AND sr.status = 'approved'
      AND s.event_date < CURRENT_DATE
    GROUP BY sr.user_id
  `, [userIds]);

  const eventsMap = {};
  for (const row of eventsResult.rows) {
    eventsMap[row.user_id] = parseInt(row.events_worked, 10);
  }

  // 4. Fetch settings
  const settingsResult = await pool.query(`SELECT key, value FROM app_settings`);
  const settings = {};
  for (const row of settingsResult.rows) {
    settings[row.key] = row.value;
  }

  const seniorityWeights = {
    events: parseFloat(settings.seniority_weight_events || '0.7'),
    tenure: parseFloat(settings.seniority_weight_tenure || '0.3'),
  };
  const maxDistance = parseFloat(settings.geo_max_distance_miles || '100');

  // 5. Score each candidate
  const scored = pendingResult.rows.map(candidate => {
    const seniority = computeSeniorityScore(
      eventsMap[candidate.user_id] || 0,
      candidate.hire_date,
      candidate.seniority_adjustment,
      seniorityWeights
    );

    const geo = computeGeoScore(
      candidate.lat, candidate.lng,
      shift.lat, shift.lng,
      candidate.travel_distance,
      maxDistance
    );

    const equipment = computeEquipmentScore(
      candidate,
      equipmentRequired,
      candidate.equipment_will_pickup
    );

    // Normalize seniority to 0–100 range (cap at a reasonable max)
    const maxSeniorityRaw = 50; // ~35 events or ~100 months tenure
    const seniorityNorm = Math.min(100, (seniority.raw / maxSeniorityRaw) * 100);

    const totalScore =
      seniorityNorm * 0.40 +
      geo.score * 0.35 +
      equipment.score * 0.25;

    return {
      request_id: candidate.request_id,
      user_id: candidate.user_id,
      preferred_name: candidate.preferred_name,
      phone: candidate.phone,
      position: candidate.position,
      city: candidate.city,
      state: candidate.state,
      scores: {
        total: Math.round(totalScore * 100) / 100,
        seniority: Math.round(seniorityNorm * 100) / 100,
        geography: Math.round(geo.score * 100) / 100,
        equipment: Math.round(equipment.score * 100) / 100,
        distance_miles: geo.distance !== null && geo.distance !== undefined ? Math.round(geo.distance * 10) / 10 : null,
        events_worked: eventsMap[candidate.user_id] || 0,
        tenure_months: seniority.tenureMonths,
      },
      equipment_details: equipment,
    };
  });

  // 6. Sort by total score descending
  scored.sort((a, b) => b.scores.total - a.scores.total);

  // 7. Select top N candidates
  let selected = scored.slice(0, slotsRemaining);

  // 8. Equipment constraint check: ensure at least one selected has each required item
  if (equipmentRequired.length > 0) {
    // Get already-approved staff equipment
    const approvedEquipResult = await pool.query(`
      SELECT cp.equipment_portable_bar, cp.equipment_cooler,
             cp.equipment_table_with_spandex, cp.equipment_will_pickup
      FROM shift_requests sr
      JOIN contractor_profiles cp ON cp.user_id = sr.user_id
      WHERE sr.shift_id = $1 AND sr.status = 'approved'
    `, [shiftId]);

    const allStaff = [...approvedEquipResult.rows, ...selected.map(s => {
      const c = pendingResult.rows.find(r => r.user_id === s.user_id);
      return c;
    })];

    for (const reqItem of equipmentRequired) {
      const equipKey = `equipment_${reqItem}`;
      const covered = allStaff.some(s => s.equipment_will_pickup || s[equipKey]);

      if (!covered) {
        // Try to swap in someone from remaining candidates who has this equipment
        const remaining = scored.slice(slotsRemaining);
        const replacement = remaining.find(r => {
          const c = pendingResult.rows.find(p => p.user_id === r.user_id);
          return c && (c.equipment_will_pickup || c[equipKey]);
        });

        if (replacement) {
          // Swap out the lowest-scoring selected candidate
          selected[selected.length - 1] = replacement;
        }
      }
    }
  }

  // 9. Dry run → return scores only
  if (dryRun) {
    return {
      approved: [],
      scores: scored,
      slots_remaining: slotsRemaining,
      selected: selected.map(s => s.request_id),
    };
  }

  // 10. Approve selected candidates — batch DB update, then sequential SMS (Twilio throttle)
  const approved = [];
  if (selected.length) {
    await pool.query(
      `UPDATE shift_requests SET status = 'approved' WHERE id = ANY($1)`,
      [selected.map(c => c.request_id)]
    );
  }

  for (const candidate of selected) {
    // Send SMS notification (same pattern as shifts.js)
    if (candidate.phone) {
      try {
        const phone = normalizePhone(candidate.phone);
        if (phone) {
          const name = candidate.preferred_name || 'Team member';
          const eventTypeLabel = getEventTypeLabel({ event_type: shift.event_type, event_type_custom: shift.event_type_custom });
          const eventCtx = shift.client_name ? `${eventTypeLabel} at ${shift.client_name}` : `${eventTypeLabel}`;
          const msg = `Hey ${name}! You've been approved for the ${eventCtx} on ${shift.event_date}.` +
            (shift.start_time ? ` Time: ${shift.start_time}${shift.end_time ? ' - ' + shift.end_time : ''}.` : '') +
            (shift.location ? ` Location: ${shift.location}.` : '') +
            ` — Dr. Bartender`;
          await sendSMS(phone, msg);
        }
      } catch (smsErr) {
        console.error(`[AutoAssign] SMS failed for user ${candidate.user_id}:`, smsErr.message);
      }
    }

    approved.push(candidate);
  }

  // 11. Mark shift as auto-assigned
  await pool.query(
    `UPDATE shifts SET auto_assigned_at = NOW() WHERE id = $1`,
    [shiftId]
  );

  return {
    approved,
    scores: scored,
    slots_remaining: slotsRemaining,
  };
}

module.exports = {
  autoAssignShift,
  haversineDistance,
  computeSeniorityScore,
  computeGeoScore,
  computeEquipmentScore,
  parseTravelDistance,
};
