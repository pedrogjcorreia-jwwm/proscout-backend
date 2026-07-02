require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

// ── Database connection ────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/cleanup', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM players');
    res.json({ deleted: result.rowCount, message: 'All players deleted. Reimport now.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cleanup CF only — apaga só os avançados, preserva WIN e outras posições ──
app.get('/cleanup/cf', async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM players WHERE position_group = 'CF'");
    res.json({ deleted: result.rowCount, position: 'CF', message: 'CF players deleted. WIN and others kept.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Setup — creates all tables (run once) ─────────────────────────────────
app.get('/setup', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, country TEXT, team TEXT,
        league TEXT, league_level TEXT, position TEXT, position_group TEXT,
        age INTEGER, foot TEXT, size INTEGER, weight INTEGER,
        mkt_value NUMERIC, contract_end DATE, matches INTEGER, minutes INTEGER,
        xg NUMERIC, xa NUMERIC, fouls NUMERIC, yellows NUMERIC,
        def_duels NUMERIC, def_duels_pct NUMERIC, adj_intercept NUMERIC,
        goals_np NUMERIC, shots90 NUMERIC, goals_per_shot NUMERIC,
        crosses90 NUMERIC, crosses_pct NUMERIC, dribles90 NUMERIC,
        dribles_pct NUMERIC, box_touches NUMERIC, prog_carries NUMERIC,
        accels90 NUMERIC, passes90 NUMERIC, passes_pct NUMERIC,
        shot_assist NUMERIC, box_passes NUMERIC, box_passes_pct NUMERIC,
        recpt_depth NUMERIC, total_dist NUMERIC, hsr90 NUMERIC,
        sprint_dist90 NUMERIC, max_speed NUMERIC, sprints90 NUMERIC,
        hsr_sprint_pct NUMERIC, total_def NUMERIC, total_off NUMERIC,
        total_pass NUMERIC, total NUMERIC, total_physical NUMERIC,
        score NUMERIC, sf_rating NUMERIC, has_physical BOOLEAN DEFAULT false,
        imported_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(name, league)
      );
      CREATE INDEX IF NOT EXISTS idx_players_position_group ON players(position_group);
      CREATE INDEX IF NOT EXISTS idx_players_league ON players(league);
      CREATE INDEX IF NOT EXISTS idx_players_score ON players(score DESC NULLS LAST);
      CREATE TABLE IF NOT EXISTS metrics_config (
        id SERIAL PRIMARY KEY, position_group TEXT NOT NULL,
        metric_key TEXT NOT NULL, weight NUMERIC NOT NULL,
        label_pt TEXT, category TEXT, inverse BOOLEAN DEFAULT false,
        min_attempts INTEGER, UNIQUE(position_group, metric_key)
      );
      CREATE TABLE IF NOT EXISTS shadows (
        id SERIAL PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL DEFAULT 'My Shadow', tab TEXT NOT NULL DEFAULT 'my',
        formation TEXT DEFAULT '3-4-3', data JSONB DEFAULT '{}',
        notes JSONB DEFAULT '{}', custom_pos JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, name, tab)
      );
    `);
    res.json({ status: 'ok', message: 'Tables created successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PLAYERS ────────────────────────────────────────────────────────────────

// GET /players — list with filters
app.get('/players', async (req, res) => {
  try {
    const {
      position, league, league_level,
      age_max, size_min, size_max, foot,
      contract_before,
      sort = 'score', dir = 'desc',
      limit = 500, offset = 0,
    } = req.query;

    let where = ['p.score IS NOT NULL'];
    const params = [];
    let i = 1;

    if (position)        { where.push(`p.position_group = $${i++}`);  params.push(position); }
    if (league)          { where.push(`p.league = $${i++}`);          params.push(league); }
    if (league_level)    { where.push(`p.league_level = $${i++}`);    params.push(league_level); }
    if (age_max)         { where.push(`p.age <= $${i++}`);            params.push(parseInt(age_max)); }
    if (size_min)        { where.push(`p.size >= $${i++}`);           params.push(parseInt(size_min)); }
    if (size_max)        { where.push(`p.size <= $${i++}`);           params.push(parseInt(size_max)); }
    if (foot)            { where.push(`p.foot = $${i++}`);            params.push(foot); }
    if (contract_before) { where.push(`p.contract_end <= $${i++}`);   params.push(contract_before); }

    const allowedSort = ['score','total_off','total_def','total_pass','total_physical',
                         'age','mkt_value','xg','xa','sprints90','max_speed'];
    const sortCol = allowedSort.includes(sort) ? sort : 'score';
    const sortDir = dir === 'asc' ? 'ASC' : 'DESC';

    const sql = `
      SELECT * FROM players p
      WHERE ${where.join(' AND ')}
      ORDER BY ${sortCol} ${sortDir} NULLS LAST
      LIMIT $${i++} OFFSET $${i++}
    `;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(sql, params);
    res.json({ players: result.rows, total: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /players/:id
app.get('/players/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM players WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /players/by-name/:name
app.get('/players/by-name/:name', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM players WHERE name ILIKE $1 ORDER BY score DESC LIMIT 10',
      [`%${req.params.name}%`]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LEAGUES ────────────────────────────────────────────────────────────────
app.get('/leagues', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT league, league_level, COUNT(*) as player_count
       FROM players GROUP BY league, league_level ORDER BY league`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POSITIONS ──────────────────────────────────────────────────────────────
app.get('/positions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT position_group, COUNT(*) as player_count
       FROM players GROUP BY position_group ORDER BY position_group`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── METRICS CONFIG (weights per position) ─────────────────────────────────
app.get('/metrics/:position', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM metrics_config WHERE position_group = $1',
      [req.params.position]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SHADOW TEAMS ───────────────────────────────────────────────────────────
app.get('/shadows/:user_id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM shadows WHERE user_id = $1 ORDER BY updated_at DESC',
      [req.params.user_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/shadows', async (req, res) => {
  try {
    const { user_id, name, tab, formation, data, notes } = req.body;
    const result = await pool.query(
      `INSERT INTO shadows (user_id, name, tab, formation, data, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id, name, tab)
       DO UPDATE SET data = $5, notes = $6, updated_at = NOW()
       RETURNING *`,
      [user_id, name, tab, formation, JSON.stringify(data), JSON.stringify(notes)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── IMPORT — POST /import/players ─────────────────────────────────────────
// Accepts the JSON output of import_excel.py
app.post('/import/players', async (req, res) => {
  try {
    const { position, players, weights } = req.body;
    if (!players || !Array.isArray(players)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const client = await pool.connect();
    let inserted = 0, updated = 0;

    try {
      await client.query('BEGIN');

      for (const p of players) {
        const result = await client.query(
          `INSERT INTO players (
            name, country, team, league, league_level, position, position_group,
            age, foot, size, weight, mkt_value, contract_end, matches, minutes,
            xg, xa, fouls, yellows, def_duels, def_duels_pct, adj_intercept,
            goals_np, shots90, goals_per_shot, crosses90, crosses_pct,
            dribles90, dribles_pct, box_touches, prog_carries, accels90,
            passes90, passes_pct, shot_assist, box_passes, box_passes_pct, recpt_depth,
            total_dist, hsr90, sprint_dist90, max_speed, sprints90, hsr_sprint_pct,
            total_def, total_off, total_pass, total, total_physical,
            score, has_physical, imported_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
            $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
            $30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,
            $45,$46,$47,$48,$49,$50,$51,NOW()
          )
          ON CONFLICT (name, league)
          DO UPDATE SET
            team=EXCLUDED.team, age=EXCLUDED.age, mkt_value=EXCLUDED.mkt_value,
            contract_end=EXCLUDED.contract_end, matches=EXCLUDED.matches, minutes=EXCLUDED.minutes,
            xg=EXCLUDED.xg, xa=EXCLUDED.xa, score=EXCLUDED.score,
            total_off=EXCLUDED.total_off, total_def=EXCLUDED.total_def,
            total_pass=EXCLUDED.total_pass, total_physical=EXCLUDED.total_physical,
            has_physical=EXCLUDED.has_physical, imported_at=NOW()
          RETURNING (xmax = 0) as is_insert`,
          [
            p.name, p.country, p.team, p.league, p.league_level || null, p.position, position,
            p.age, p.foot, p.size, p.weight, p.mkt_value, p.contract_end, p.matches, p.minutes,
            p.xg, p.xa, p.fouls, p.yellows, p.def_duels, p.def_duels_pct, p.adj_intercept,
            p.goals_np, p.shots90, p.goals_per_shot, p.crosses90, p.crosses_pct,
            p.dribles90, p.dribles_pct, p.box_touches, p.prog_carries, p.accels90,
            p.passes90, p.passes_pct, p.shot_assist, p.box_passes, p.box_passes_pct, p.recpt_depth,
            p.total_dist, p.hsr90, p.sprint_dist90, p.max_speed, p.sprints90, p.hsr_sprint_pct,
            p.total_def, p.total_off, p.total_pass, p.total, p.total_physical,
            p.score, p.has_physical,
          ]
        );
        if (result.rows[0]?.is_insert) inserted++; else updated++;
      }

      // Upsert weights
      if (weights) {
        for (const [metric, weight] of Object.entries(weights)) {
          await client.query(
            `INSERT INTO metrics_config (position_group, metric_key, weight)
             VALUES ($1, $2, $3)
             ON CONFLICT (position_group, metric_key) DO UPDATE SET weight = $3`,
            [position, metric, weight]
          );
        }
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ inserted, updated, total: players.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`ProScout API running on port ${PORT}`));
