import pg from 'pg';
import { Store } from './store.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 15_000 });
try { await new Store(pool).migrate(); console.log('Database schema is current'); }
finally { await pool.end(); }
