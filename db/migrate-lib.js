/**
 * migrate-lib.js  –  reusable migration helpers consumed by both
 *   • db/migrate.js  (CLI)
 *   • server.js      (auto-run on startup)
 *
 * This avoids duplicating the migration logic.
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATIONS_TABLE = '_migrations';

/** Parse a .sql migration file into { up, down } SQL strings */
function parseMigration(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const marker = /^--\s*DOWN\b/im;
    const match = raw.match(marker);
    if (match) {
        const idx = raw.indexOf(match[0]);
        return {
            up: raw.slice(0, idx).trim(),
            down: raw.slice(idx + match[0].length).trim()
        };
    }
    return { up: raw.trim(), down: '' };
}

/** Return sorted list of migration filenames */
function getMigrationFiles() {
    if (!fs.existsSync(MIGRATIONS_DIR)) return [];
    return fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();
}

/**
 * Run all pending migrations using an existing mysql2 pool (or connection).
 * Called from server.js on startup so no extra connection is needed.
 *
 * @param {import('mysql2/promise').Pool} pool
 */
async function runPendingMigrations(pool) {
    // Ensure tracking table
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\` (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            name        VARCHAR(255) NOT NULL UNIQUE,
            applied_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const [rows] = await pool.execute(
        `SELECT name FROM \`${MIGRATIONS_TABLE}\` ORDER BY id`
    );
    const applied = rows.map(r => r.name);
    const files = getMigrationFiles();
    const pending = files.filter(f => !applied.includes(f));

    if (pending.length === 0) {
        console.log('✅ Migrations up-to-date.');
        return;
    }

    for (const file of pending) {
        const { up: sql } = parseMigration(path.join(MIGRATIONS_DIR, file));
        if (!sql) continue;
        console.log(`⬆️  Applying migration ${file} …`);
        // pool.query supports multipleStatements when the pool was not created
        // with that flag, but each statement is separated by the server.
        // If the pool doesn't have multipleStatements, we split manually.
        const statements = sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
        for (const stmt of statements) {
            await pool.query(stmt);
        }
        await pool.execute(
            `INSERT INTO \`${MIGRATIONS_TABLE}\` (name) VALUES (?)`,
            [file]
        );
        console.log(`   ✅ ${file} applied.`);
    }

    console.log(`🎉 ${pending.length} migration(s) applied.`);
}

module.exports = {
    parseMigration,
    getMigrationFiles,
    runPendingMigrations,
    MIGRATIONS_DIR,
    MIGRATIONS_TABLE
};
