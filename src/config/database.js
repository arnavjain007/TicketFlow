/**
 * MySQL connection pool and low-level helpers.
 *
 * Every module that needs the database imports `pool` from here.
 * The pool is created lazily on first access and reused across the app.
 */

const mysql = require('mysql2/promise');
const config = require('./index');

// Create the shared connection pool
const pool = mysql.createPool({
  host: config.database.host,
  port: config.database.port,
  user: config.database.user,
  password: config.database.password,
  database: config.database.database,
  waitForConnections: true,
  connectionLimit: config.database.connectionLimit,
  queueLimit: 0,
  charset: config.database.charset,
});

/**
 * Convert any date value to MySQL DATETIME format (YYYY-MM-DD HH:MM:SS).
 * Returns null for invalid / falsy inputs.
 */
function toMySQLDatetime(val) {
  if (!val) return null;
  const d = new Date(val);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Verify the database connection is working.
 * @returns {Promise<boolean>}
 */
async function testConnection() {
  try {
    await pool.execute('SELECT 1');
    console.log('✅ MySQL connected to', config.database.database);
    return true;
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message);
    return false;
  }
}

/**
 * Run pending SQL migrations using the shared pool.
 * Safe to call on every startup — skips already-applied migrations.
 */
async function runMigrations() {
  try {
    const migrateLib = require('../../db/migrate-lib');
    await migrateLib.runPendingMigrations(pool);
  } catch (err) {
    console.error('⚠️  Auto-migration skipped:', err.message);
  }
}

/**
 * Gracefully close the pool (call on shutdown).
 */
async function closePool() {
  try {
    await pool.end();
    console.log('MySQL pool closed');
  } catch (_) {
    // best-effort
  }
}

module.exports = {
  pool,
  toMySQLDatetime,
  testConnection,
  runMigrations,
  closePool,
};
