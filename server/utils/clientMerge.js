/**
 * Merge a duplicate client (loser) into the canonical one (winner): backfill the
 * winner's NULL contact fields from the loser, repoint every FK reference, then
 * delete the loser. Caller wraps in a transaction.
 *
 * FK-referencing columns are discovered from the catalog (not hardcoded) so new
 * client_id columns are covered automatically. All client_id FKs are
 * ON DELETE SET NULL, so repointing before the delete preserves the links on
 * the winner (a missed reference would be silently NULLed — hence the dynamic
 * discovery rather than a fixed list).
 *
 * @param {import('pg').PoolClient} db - caller's transaction client
 * @param {number} loserId
 * @param {number} winnerId
 * @returns {Promise<{repointed: Array<{table:string,column:string,rows:number}>}>}
 */
async function mergeClients(db, loserId, winnerId) {
  if (Number(loserId) === Number(winnerId)) throw new Error('mergeClients: loser === winner');

  // Backfill the winner's NULL contact fields from the loser (never overwrite).
  await db.query(
    `UPDATE clients w SET email = COALESCE(w.email, l.email),
                          phone = COALESCE(w.phone, l.phone),
                          notes = COALESCE(w.notes, l.notes)
       FROM clients l WHERE w.id = $1 AND l.id = $2`,
    [winnerId, loserId]
  );

  // Discover every column that FK-references clients(id).
  const refs = await db.query(`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      AND ccu.table_name = 'clients' AND ccu.column_name = 'id'`);

  const repointed = [];
  for (const { table_name, column_name } of refs.rows) {
    const r = await db.query(
      `UPDATE ${quoteIdent(table_name)} SET ${quoteIdent(column_name)} = $1 WHERE ${quoteIdent(column_name)} = $2`,
      [winnerId, loserId]
    );
    if (r.rowCount > 0) repointed.push({ table: table_name, column: column_name, rows: r.rowCount });
  }

  await db.query('DELETE FROM clients WHERE id = $1', [loserId]);
  return { repointed };
}

// Identifiers come from the system catalog (trusted), but validate anyway —
// defense in depth before interpolating into SQL.
function quoteIdent(id) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(id)) throw new Error(`unsafe identifier: ${id}`);
  return `"${id}"`;
}

module.exports = { mergeClients };
