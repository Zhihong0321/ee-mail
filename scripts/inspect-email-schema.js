import pg from 'pg';
const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function inspectEmailSchema() {
  try {
    const tables = ['agent_email_accounts', 'agent', 'user'];
    
    for (const tableName of tables) {
      console.log(`\n========================================`);
      console.log(`TABLE: ${tableName}`);
      console.log(`========================================\n`);
      
      // Get columns
      const columnsResult = await pool.query(`
        SELECT 
          column_name, 
          data_type, 
          character_maximum_length,
          is_nullable,
          column_default
        FROM information_schema.columns 
        WHERE table_name = $1
        ORDER BY ordinal_position;
      `, [tableName]);
      
      console.log('COLUMNS:');
      columnsResult.rows.forEach(col => {
        const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
        const length = col.character_maximum_length ? `(${col.character_maximum_length})` : '';
        const defaultVal = col.column_default ? ` DEFAULT ${col.column_default}` : '';
        console.log(`  ${col.column_name}: ${col.data_type}${length} ${nullable}${defaultVal}`);
      });
      
      const countResult = await pool.query(`SELECT COUNT(*) FROM "${tableName.replace(/"/g, '""')}"`);
      console.log(`\nTOTAL ROWS: ${countResult.rows[0].count}`);
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

inspectEmailSchema();
