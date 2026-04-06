#!/usr/bin/env node
/**
 * Lightweight SQL Migration Runner
 *
 * Usage:
 *   node db/migrate.js up        Run all pending migrations
 *   node db/migrate.js down      Roll back the last applied migration
 *   node db/migrate.js status    Show which migrations have been applied
 *   node db/migrate.js redo      Roll back then re-apply the last migration
 *   node db/migrate.js create <name>   Scaffold a new migration file
 *
 * Migration files live in db/migrations/ and are plain .sql files.
 * Each file may contain two sections separated by "-- DOWN":
 *
 *   -- Everything above "-- DOWN" is the UP section (applied on `up`)
 *   CREATE TABLE ...;
 *
 *   -- DOWN
 *   DROP TABLE IF EXISTS ...;
 *
 * Migrations are tracked in a `_migrations` table in the same database.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// ─── Config ──────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATIONS_TABLE = '_migrations';

function getDbConfig() {
    return {
        host: process.env.MYSQL_HOST || 'localhost',
        port: parseInt(process.env.MYSQL_PORT || '3306', 10),
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DATABASE || 'chatsupport',
        charset: 'utf8mb4',
        multipleStatements: true          // required to run multi-statement .sql files
    };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

/** Return sorted list of migration filenames from the migrations dir */
function getMigrationFiles() {
    if (!fs.existsSync(MIGRATIONS_DIR)) {
        fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
        return [];
    }
    return fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();
}

/** Ensure _migrations tracking table exists */
async function ensureTrackingTable(conn) {
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\` (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            name        VARCHAR(255) NOT NULL UNIQUE,
            applied_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

/** Get list of already-applied migration names */
async function getApplied(conn) {
    const [rows] = await conn.execute(
        `SELECT name FROM \`${MIGRATIONS_TABLE}\` ORDER BY id`
    );
    return rows.map(r => r.name);
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function up(conn) {
    const files = getMigrationFiles();
    const applied = await getApplied(conn);
    const pending = files.filter(f => !applied.includes(f));

    if (pending.length === 0) {
        console.log('✅ Database is up-to-date — no pending migrations.');
        return;
    }

    for (const file of pending) {
        const { up: sql } = parseMigration(path.join(MIGRATIONS_DIR, file));
        if (!sql) {
            console.log(`⚠️  Skipping ${file} — empty UP section.`);
            continue;
        }
        console.log(`⬆️  Applying ${file} …`);
        await conn.query(sql);                          // multipleStatements handles ;-separated
        await conn.execute(
            `INSERT INTO \`${MIGRATIONS_TABLE}\` (name) VALUES (?)`,
            [file]
        );
        console.log(`   ✅ ${file} applied.`);
    }

    console.log(`\n🎉 ${pending.length} migration(s) applied.`);
}

async function down(conn) {
    const applied = await getApplied(conn);
    if (applied.length === 0) {
        console.log('ℹ️  Nothing to roll back.');
        return;
    }

    const last = applied[applied.length - 1];
    const filePath = path.join(MIGRATIONS_DIR, last);
    if (!fs.existsSync(filePath)) {
        console.error(`❌ Migration file not found: ${last}`);
        process.exit(1);
    }

    const { down: sql } = parseMigration(filePath);
    if (!sql) {
        console.error(`❌ No DOWN section in ${last} — cannot roll back.`);
        process.exit(1);
    }

    console.log(`⬇️  Rolling back ${last} …`);
    await conn.query(sql);
    await conn.execute(
        `DELETE FROM \`${MIGRATIONS_TABLE}\` WHERE name = ?`,
        [last]
    );
    console.log(`   ✅ ${last} rolled back.`);
}

async function status(conn) {
    const files = getMigrationFiles();
    const applied = await getApplied(conn);

    console.log('\n  Migration                                Status');
    console.log('  ' + '─'.repeat(55));
    for (const file of files) {
        const tag = applied.includes(file) ? '✅ applied' : '⏳ pending';
        console.log(`  ${file.padEnd(42)} ${tag}`);
    }
    if (files.length === 0) {
        console.log('  (no migration files found)');
    }
    console.log();
}

async function redo(conn) {
    await down(conn);
    await up(conn);
}

function create(name) {
    if (!name) {
        console.error('Usage: node db/migrate.js create <name>');
        process.exit(1);
    }

    if (!fs.existsSync(MIGRATIONS_DIR)) {
        fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
    }

    const files = getMigrationFiles();
    const lastNum = files.reduce((max, f) => {
        const m = f.match(/^(\d+)/);
        return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, 0);

    const num = String(lastNum + 1).padStart(3, '0');
    const slug = name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    const filename = `${num}_${slug}.sql`;
    const filePath = path.join(MIGRATIONS_DIR, filename);

    const template = `-- Migration: ${slug}
-- Created at: ${new Date().toISOString()}

-- Write your UP migration SQL here


-- DOWN
-- Write your rollback SQL here
`;

    fs.writeFileSync(filePath, template, 'utf-8');
    console.log(`📄 Created ${filename}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const command = process.argv[2] || 'up';

    // `create` does not need a DB connection
    if (command === 'create') {
        create(process.argv[3]);
        return;
    }

    let conn;
    try {
        conn = await mysql.createConnection(getDbConfig());
        await ensureTrackingTable(conn);

        switch (command) {
            case 'up': await up(conn); break;
            case 'down': await down(conn); break;
            case 'status': await status(conn); break;
            case 'redo': await redo(conn); break;
            default:
                console.error(`Unknown command: ${command}`);
                console.error('Usage: node db/migrate.js [up|down|status|redo|create <name>]');
                process.exit(1);
        }
    } catch (err) {
        console.error('❌ Migration error:', err.message);
        process.exit(1);
    } finally {
        if (conn) await conn.end();
    }
}

main();
