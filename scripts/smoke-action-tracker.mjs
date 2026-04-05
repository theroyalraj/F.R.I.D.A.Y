/**
 * Smoke test: Postgres tables + todosDb + actionItemsDb (no long-running agent required).
 * Usage: node scripts/smoke-action-tracker.mjs
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: path.join(root, '.env') });

const url = process.env.OPENCLAW_DATABASE_URL?.trim();
if (!url) {
  console.error('FAIL: OPENCLAW_DATABASE_URL not set');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
const tables = ['todos', 'reminders', 'action_items', 'message_scan_log'];
for (const t of tables) {
  const r = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1)`,
    [t],
  );
  if (!r.rows[0].exists) {
    console.error(`FAIL: missing table ${t}`);
    process.exit(1);
  }
}
console.log('OK: tables', tables.join(', '));

await pool.end();

const { getTodos, addTodo, deleteTodo, LEGACY_TODO_SCOPE } = await import('../pc-agent/src/todosDb.js');
const n = (await getTodos(LEGACY_TODO_SCOPE)).length;
const todo = await addTodo({ title: 'smoke-mjs-todo', source: 'smoke-mjs' }, LEGACY_TODO_SCOPE);
console.log('OK: todosDb add/get, count was', n, 'new id', todo.id);
await deleteTodo(todo.id, LEGACY_TODO_SCOPE);
console.log('OK: todosDb delete');

const ai = await import('../pc-agent/src/actionItemsDb.js');
const row = await ai.insertActionItem({
  title: 'smoke action item',
  source: 'smoke-mjs',
  sourceMessageId: `smoke-msg-${Date.now()}`,
  priority: 'low',
});
const sum = await ai.summaryByPriority();
console.log('OK: actionItems insert, pendingCount', sum.pendingCount);
await ai.deleteActionItem(row.id);
console.log('OK: actionItems delete');

console.log('\nAll smoke checks passed.');
