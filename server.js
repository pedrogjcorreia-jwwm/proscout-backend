require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type'], exposedHeaders: ['Content-Disposition'] }));
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

app.get('/cleanup/lb', async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM players WHERE position_group = 'LB'");
    res.json({ deleted: result.rowCount, position: 'LB', message: 'LB players deleted. Others kept.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/cleanup/rb', async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM players WHERE position_group = 'RB'");
    res.json({ deleted: result.rowCount, position: 'RB', message: 'RB players deleted. Others kept.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Diagnóstico LB: estado atual da base de dados (só leitura) ──
app.get('/diag/lb-check', async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*)::int AS c FROM players');
    const byGroup = await pool.query('SELECT position_group, COUNT(*)::int AS c FROM players GROUP BY position_group ORDER BY c DESC');
    const lbRemaining = await pool.query("SELECT COUNT(*)::int AS c FROM players WHERE position_group = 'LB'");
    const winWithLb = await pool.query("SELECT COUNT(*)::int AS c FROM players WHERE position_group = 'WIN' AND position ILIKE '%LB%'");
    const otherWithLb = await pool.query("SELECT position_group, COUNT(*)::int AS c FROM players WHERE position_group <> 'LB' AND position ILIKE '%LB%' GROUP BY position_group ORDER BY c DESC");
    const sample = await pool.query("SELECT name, league, position, position_group FROM players WHERE position_group <> 'LB' AND position ILIKE '%LB%' ORDER BY position_group LIMIT 40");
    res.json({ total: total.rows[0].c, by_group: byGroup.rows, lb_remaining: lbRemaining.rows[0].c, win_with_lb_in_position: winWithLb.rows[0].c, other_groups_with_lb: otherWithLb.rows, sample: sample.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/diag/find', async (req, res) => {
  try {
    const name = req.query.name || '';
    const r = await pool.query('SELECT name, team, league, position, position_group, xg, shot_int_adjtackl, adj_intercept, aerial_duels90, prog_pass FROM players WHERE name ILIKE $1 ORDER BY position_group', ['%'+name+'%']);
    res.json({ query: name, count: r.rowCount, players: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/diag/dupes', async (req, res) => {
  try {
    const r = await pool.query('SELECT name, COUNT(*)::int AS c, array_agg(position_group) AS groups, array_agg(league) AS leagues FROM players GROUP BY name HAVING COUNT(*)>1 ORDER BY c DESC, name LIMIT 100');
    res.json({ duplicate_names: r.rowCount, rows: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Fix nomes de liga (normaliza para os nomes canónicos do frontend) ──
app.get('/fix/league-names', async (req, res) => {
  try {
    // 1. apagar duplicados do import (mesmo nome já existe com o nome de liga canónico)
    const d1 = await pool.query("DELETE FROM players p WHERE p.league='Czechia1' AND EXISTS (SELECT 1 FROM players q WHERE q.name=p.name AND q.league='Czech1')");
    const d2 = await pool.query("DELETE FROM players p WHERE p.league='Croacia1' AND EXISTS (SELECT 1 FROM players q WHERE q.name=p.name AND q.league='Croatia1')");
    // 2. renomear os restantes (sem duplicado)
    const u1 = await pool.query("UPDATE players SET league='Czech1' WHERE league='Czechia1'");
    const u2 = await pool.query("UPDATE players SET league='Croatia1' WHERE league='Croacia1'");
    res.json({ czech: { deleted_dupes: d1.rowCount, renamed: u1.rowCount }, croatia: { deleted_dupes: d2.rowCount, renamed: u2.rowCount } });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
        off_duels90 NUMERIC, off_duels_pct NUMERIC, aerial_duels90 NUMERIC,
        aerial_pct NUMERIC, header_goals NUMERIC,
        imported_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(name, league)
      );
      ALTER TABLE players ADD COLUMN IF NOT EXISTS off_duels90 NUMERIC;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS off_duels_pct NUMERIC;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS aerial_duels90 NUMERIC;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS aerial_pct NUMERIC;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS header_goals NUMERIC;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS goals NUMERIC;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS shot_int_adjtackl NUMERIC;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS prog_pass NUMERIC;
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
    const { position, players, weights, forceGroup } = req.body;
    if (!players || !Array.isArray(players)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const client = await pool.connect();
    let inserted = 0, updated = 0, skippedOtherGroup = 0;

    try {
      await client.query('BEGIN');

      for (const p of players) {
        // existing_group_skip: não sobrescrever jogadores que já existem noutro grupo (ex.: WIN/CF)
        const _ex = await client.query('SELECT position_group FROM players WHERE name=$1 AND league=$2 LIMIT 1', [p.name, p.league]);
        if (_ex.rows.length && _ex.rows[0].position_group && _ex.rows[0].position_group !== position) {
          if (forceGroup) { await client.query('DELETE FROM players WHERE name=$1 AND league=$2', [p.name, p.league]); }
          else { skippedOtherGroup++; continue; }
        }
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
            score, has_physical,
            off_duels90, off_duels_pct, aerial_duels90, aerial_pct, header_goals, goals,
            imported_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
            $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
            $30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,
            $45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55,$56,$57,NOW()
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
            p.off_duels90||null, p.off_duels_pct||null, p.aerial_duels90||null, p.aerial_pct||null, p.header_goals||null, p.goals||null,
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

    res.json({ skipped_other_group: skippedOtherGroup, inserted, updated, total: players.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── /import/win ── dedicado a WIN (35 métricas) ──────────────
app.post('/import/win', async (req, res) => {
  try {
    const { position, players, weights, forceGroup } = req.body;
    if (!players || !Array.isArray(players)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const client = await pool.connect();
    let inserted = 0, updated = 0, skippedOtherGroup = 0;

    try {
      await client.query('BEGIN');

      for (const p of players) {
        // existing_group_skip: não sobrescrever jogadores que já existem noutro grupo (ex.: WIN/CF)
        const _ex = await client.query('SELECT position_group FROM players WHERE name=$1 AND league=$2 LIMIT 1', [p.name, p.league]);
        if (_ex.rows.length && _ex.rows[0].position_group && _ex.rows[0].position_group !== position) {
          if (forceGroup) { await client.query('DELETE FROM players WHERE name=$1 AND league=$2', [p.name, p.league]); }
          else { skippedOtherGroup++; continue; }
        }
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
            score, has_physical,
            off_duels90, off_duels_pct, aerial_duels90, aerial_pct, header_goals, goals,
            imported_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
            $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
            $30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,
            $45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55,$56,$57,NOW()
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
            p.off_duels90||null, p.off_duels_pct||null, p.aerial_duels90||null, p.aerial_pct||null, p.header_goals||null, p.goals||null,
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

    res.json({ skipped_other_group: skippedOtherGroup, inserted, updated, total: players.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── /import/rb ── dedicado a RB (29 metricas FB) ──────────────
app.post('/import/rb', async (req, res) => {
  try {
    const { position, players, weights, forceGroup } = req.body;
    if (!players || !Array.isArray(players)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const client = await pool.connect();
    let inserted = 0, updated = 0, skippedOtherGroup = 0;

    try {
      await client.query('BEGIN');

      for (const p of players) {
        // existing_group_skip: não sobrescrever jogadores que já existem noutro grupo (ex.: WIN/CF)
        const _ex = await client.query('SELECT position_group FROM players WHERE name=$1 AND league=$2 LIMIT 1', [p.name, p.league]);
        if (_ex.rows.length && _ex.rows[0].position_group && _ex.rows[0].position_group !== position) {
          if (forceGroup) { await client.query('DELETE FROM players WHERE name=$1 AND league=$2', [p.name, p.league]); }
          else { skippedOtherGroup++; continue; }
        }
        const result = await client.query(
          `INSERT INTO players (
            name, country, team, league, league_level, position, position_group,
            age, foot, size, weight, mkt_value, contract_end, matches, minutes,
            xg, xa, fouls, yellows, def_duels, def_duels_pct, adj_intercept,
            shots90, crosses90, crosses_pct, dribles90, dribles_pct,
            box_touches, prog_carries, recpt_depth,
            passes90, passes_pct, shot_assist, box_passes, prog_pass,
            total_dist, hsr90, sprint_dist90, max_speed, sprints90, hsr_sprint_pct,
            aerial_duels90, aerial_pct, shot_int_adjtackl,
            total_def, total_off, total_pass, total, total_physical,
            score, has_physical, imported_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
            $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
            $28,$29,$30,$31,$32,$33,$34,$35,
            $36,$37,$38,$39,$40,$41,$42,$43,$44,
            $45,$46,$47,$48,$49,$50,$51,NOW()
          )
          ON CONFLICT (name, league)
          DO UPDATE SET
            team=EXCLUDED.team, age=EXCLUDED.age, mkt_value=EXCLUDED.mkt_value,
            contract_end=EXCLUDED.contract_end, matches=EXCLUDED.matches, minutes=EXCLUDED.minutes,
            xg=EXCLUDED.xg, xa=EXCLUDED.xa, score=EXCLUDED.score,
            total_off=EXCLUDED.total_off, total_def=EXCLUDED.total_def,
            total_pass=EXCLUDED.total_pass, total_physical=EXCLUDED.total_physical,
            shot_int_adjtackl=EXCLUDED.shot_int_adjtackl, prog_pass=EXCLUDED.prog_pass,
            aerial_duels90=EXCLUDED.aerial_duels90, aerial_pct=EXCLUDED.aerial_pct,
            has_physical=EXCLUDED.has_physical, imported_at=NOW()
          RETURNING (xmax = 0) as is_insert`,
          [
            p.name, p.country, p.team, p.league, p.league_level || null, p.position, position,
            p.age, p.foot, p.size, p.weight, p.mkt_value, p.contract_end, p.matches, p.minutes,
            p.xg, p.xa, p.fouls, p.yellows, p.def_duels, p.def_duels_pct, p.adj_intercept,
            p.shots90, p.crosses90, p.crosses_pct, p.dribles90, p.dribles_pct,
            p.box_touches, p.prog_carries, p.recpt_depth,
            p.passes90, p.passes_pct, p.shot_assist, p.box_passes, p.prog_pass,
            p.total_dist, p.hsr90, p.sprint_dist90, p.max_speed, p.sprints90, p.hsr_sprint_pct,
            p.aerial_duels90, p.aerial_pct, p.shot_int_adjtackl,
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

    res.json({ skipped_other_group: skippedOtherGroup, inserted, updated, total: players.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── /import/lb ── dedicado a LB (29 metricas FB) ──────────────
app.post('/import/lb', async (req, res) => {
  try {
    const { position, players, weights, forceGroup } = req.body;
    if (!players || !Array.isArray(players)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const client = await pool.connect();
    let inserted = 0, updated = 0, skippedOtherGroup = 0;

    try {
      await client.query('BEGIN');

      for (const p of players) {
        // existing_group_skip: não sobrescrever jogadores que já existem noutro grupo (ex.: WIN/CF)
        const _ex = await client.query('SELECT position_group FROM players WHERE name=$1 AND league=$2 LIMIT 1', [p.name, p.league]);
        if (_ex.rows.length && _ex.rows[0].position_group && _ex.rows[0].position_group !== position) {
          if (forceGroup) { await client.query('DELETE FROM players WHERE name=$1 AND league=$2', [p.name, p.league]); }
          else { skippedOtherGroup++; continue; }
        }
        const result = await client.query(
          `INSERT INTO players (
            name, country, team, league, league_level, position, position_group,
            age, foot, size, weight, mkt_value, contract_end, matches, minutes,
            xg, xa, fouls, yellows, def_duels, def_duels_pct, adj_intercept,
            shots90, crosses90, crosses_pct, dribles90, dribles_pct,
            box_touches, prog_carries, recpt_depth,
            passes90, passes_pct, shot_assist, box_passes, prog_pass,
            total_dist, hsr90, sprint_dist90, max_speed, sprints90, hsr_sprint_pct,
            aerial_duels90, aerial_pct, shot_int_adjtackl,
            total_def, total_off, total_pass, total, total_physical,
            score, has_physical, imported_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
            $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
            $28,$29,$30,$31,$32,$33,$34,$35,
            $36,$37,$38,$39,$40,$41,$42,$43,$44,
            $45,$46,$47,$48,$49,$50,$51,NOW()
          )
          ON CONFLICT (name, league)
          DO UPDATE SET
            team=EXCLUDED.team, age=EXCLUDED.age, mkt_value=EXCLUDED.mkt_value,
            contract_end=EXCLUDED.contract_end, matches=EXCLUDED.matches, minutes=EXCLUDED.minutes,
            xg=EXCLUDED.xg, xa=EXCLUDED.xa, score=EXCLUDED.score,
            total_off=EXCLUDED.total_off, total_def=EXCLUDED.total_def,
            total_pass=EXCLUDED.total_pass, total_physical=EXCLUDED.total_physical,
            shot_int_adjtackl=EXCLUDED.shot_int_adjtackl, prog_pass=EXCLUDED.prog_pass,
            aerial_duels90=EXCLUDED.aerial_duels90, aerial_pct=EXCLUDED.aerial_pct,
            has_physical=EXCLUDED.has_physical, imported_at=NOW()
          RETURNING (xmax = 0) as is_insert`,
          [
            p.name, p.country, p.team, p.league, p.league_level || null, p.position, position,
            p.age, p.foot, p.size, p.weight, p.mkt_value, p.contract_end, p.matches, p.minutes,
            p.xg, p.xa, p.fouls, p.yellows, p.def_duels, p.def_duels_pct, p.adj_intercept,
            p.shots90, p.crosses90, p.crosses_pct, p.dribles90, p.dribles_pct,
            p.box_touches, p.prog_carries, p.recpt_depth,
            p.passes90, p.passes_pct, p.shot_assist, p.box_passes, p.prog_pass,
            p.total_dist, p.hsr90, p.sprint_dist90, p.max_speed, p.sprints90, p.hsr_sprint_pct,
            p.aerial_duels90, p.aerial_pct, p.shot_int_adjtackl,
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

    res.json({ skipped_other_group: skippedOtherGroup, inserted, updated, total: players.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});



// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

// ── GET /import/cf — importa o CF_players.json commitado no repo (só cliques, sem PowerShell) ──
app.get('/import/cf', async (req, res) => {
  try {
    const fs = require('fs');
    const raw = fs.readFileSync(__dirname + '/CF_players.json', 'utf8');
    const { position, players } = JSON.parse(raw);
    if (!players || !Array.isArray(players)) return res.status(400).json({ error: 'Ficheiro inválido' });
    const client = await pool.connect();
    let inserted = 0, updated = 0;
    const skipped = [];
    try {
      await client.query('BEGIN');
      const others = await client.query("SELECT name, league FROM players WHERE position_group <> 'CF'");
      const otherKeys = new Set(others.rows.map(r => r.name + '|' + r.league));
      for (const p of players) {
        if (otherKeys.has(p.name + '|' + p.league)) { skipped.push({ name: p.name, league: p.league }); continue; }
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
            score, has_physical,
            off_duels90, off_duels_pct, aerial_duels90, aerial_pct, header_goals, goals,
            imported_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
            $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
            $30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,
            $45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55,$56,$57,NOW()
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
            p.off_duels90||null, p.off_duels_pct||null, p.aerial_duels90||null, p.aerial_pct||null, p.header_goals||null, p.goals||null,
          ]
        );
        if (result.rows[0]?.is_insert) inserted++; else updated++;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK'); throw e;
    } finally { client.release(); }
    res.json({ position, inserted, updated, skipped: skipped.length, skipped_players: skipped, total: players.length });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});




// ── GET /fix/lwb-takeover — remove versao antiga (WIN/CF) dos jogadores marcados para sair, para que /import/lwb os insira em LWB ──
app.get('/fix/lwb-takeover', async (req, res) => {
  try {
    const fs = require('fs');
    const { move_to_lwb } = JSON.parse(fs.readFileSync(__dirname + '/lwb_takeover_list.json', 'utf8'));
    if (!move_to_lwb || !Array.isArray(move_to_lwb)) return res.status(400).json({ error: 'Lista invalida' });
    const client = await pool.connect();
    let removed = 0;
    const removedList = [];
    try {
      await client.query('BEGIN');
      for (const m of move_to_lwb) {
        const r = await client.query(
          "DELETE FROM players WHERE name = $1 AND league = $2 AND position_group <> 'LWB' RETURNING position_group",
          [m.name, m.league]
        );
        if (r.rowCount > 0) { removed += r.rowCount; removedList.push({ name: m.name, league: m.league, from: r.rows[0].position_group }); }
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    res.json({ removed, removed_players: removedList, note: 'Agora corre /import/lwb para inserir estes jogadores em LWB' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /fix/lwb-to-lb — renomeia position_group LWB -> LB ──
app.get('/fix/lwb-to-lb', async (req, res) => {
  try {
    const r = await pool.query("UPDATE players SET position_group='LB' WHERE position_group='LWB' RETURNING id");
    res.json({ updated: r.rowCount, note: 'position_group LWB -> LB' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /diag/lwb-conflicts — os LWB do ficheiro que já existem noutra posição (com posição e score atuais) ──
app.get('/diag/lwb-conflicts', async (req, res) => {
  try {
    const fs = require('fs');
    const { players } = JSON.parse(fs.readFileSync(__dirname + '/LWB_players.json', 'utf8'));
    const lwbScore = {};
    players.forEach(p => { lwbScore[p.name + '|' + p.league] = p.score; });
    const lwbKeys = new Set(Object.keys(lwbScore));
    const r = await pool.query("SELECT name, league, position_group, position, score FROM players WHERE position_group <> 'LWB'");
    const conflicts = r.rows
      .filter(row => lwbKeys.has(row.name + '|' + row.league))
      .map(row => ({
        name: row.name, league: row.league,
        current_position_group: row.position_group,
        current_position: row.position,
        current_score: row.score,
        lwb_score: lwbScore[row.name + '|' + row.league]
      }))
      .sort((a, b) => (b.lwb_score || 0) - (a.lwb_score || 0));
    res.json({ conflict_count: conflicts.length, conflicts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /diag/cf-conflicts — jogadores do CF cujo (nome,liga) colide com outra posição na BD ──
app.get('/diag/cf-conflicts', async (req, res) => {
  try {
    const fs = require('fs');
    const { players } = JSON.parse(fs.readFileSync(__dirname + '/CF_players.json', 'utf8'));
    const cfKeys = new Set(players.map(p => p.name + '|' + p.league));
    const r = await pool.query("SELECT name, league, position_group, position, score FROM players WHERE position_group <> 'CF'");
    const conflicts = r.rows.filter(row => cfKeys.has(row.name + '|' + row.league));
    const cfCount = await pool.query("SELECT COUNT(*) FROM players WHERE position_group = 'CF'");
    res.json({ cf_in_db: Number(cfCount.rows[0].count), cf_in_file: players.length, conflict_count: conflicts.length, conflicts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── GET /fix/cf-takeover — remove versões NÃO-CF de jogadores decididos como CF (nome+liga do ficheiro) ──
app.get('/fix/cf-takeover', async (req, res) => {
  try {
    const fs = require('fs');
    const { players } = JSON.parse(fs.readFileSync(__dirname + '/CF_players.json', 'utf8'));
    const cfKeys = new Set(players.map(p => p.name + '|' + p.league));
    const others = await pool.query("SELECT name, league, position_group FROM players WHERE position_group <> 'CF'");
    const toDelete = others.rows.filter(r => cfKeys.has(r.name + '|' + r.league));
    for (const r of toDelete) {
      await pool.query("DELETE FROM players WHERE name=$1 AND league=$2 AND position_group <> 'CF'", [r.name, r.league]);
    }
    res.json({ deleted_count: toDelete.length, deleted: toDelete });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ============================================================================
// THRIVELLA — Agentes (CRM)  [inserido automaticamente]
// Tabelas criadas via GET /agents/setup (nao-destrutivo).
// ============================================================================
  // ---- migração (não-destrutiva, à imagem do /setup existente) ----
  app.get('/agents/setup', async (req, res) => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS agents (
          id            SERIAL PRIMARY KEY,
          company       TEXT NOT NULL,
          website       TEXT,
          photo_url     TEXT,
          rating        SMALLINT DEFAULT 0,          -- 0..5 estrelas
          email         TEXT,
          phone         TEXT,
          whatsapp      TEXT,
          languages     TEXT,                        -- livre: "PT, EN, ES"
          num_players   INTEGER DEFAULT 0,           -- editável à mão
          portfolio_val BIGINT  DEFAULT 0,           -- editável à mão (em euros)
          status        TEXT DEFAULT 'cold',         -- cold | contact | established
          notes_ctx     TEXT,                        -- notas de contexto do perfil
          created_at    TIMESTAMPTZ DEFAULT now(),
          updated_at    TIMESTAMPTZ DEFAULT now()
        );`);
      // jogadores da app associados ao agente (opcional, só para quem existe na BD)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS agent_players (
          id         SERIAL PRIMARY KEY,
          agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          player_name TEXT NOT NULL,
          player_league TEXT,
          created_at TIMESTAMPTZ DEFAULT now(),
          UNIQUE(agent_id, player_name, player_league)
        );`);
      // notas / histórico (chamada, email, reunião, proposta) — trata do CRM
      await pool.query(`
        CREATE TABLE IF NOT EXISTS agent_notes (
          id         SERIAL PRIMARY KEY,
          agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          kind       TEXT NOT NULL DEFAULT 'note',   -- call | email | meeting | proposal | note
          body       TEXT NOT NULL,
          entry_date DATE DEFAULT CURRENT_DATE,
          created_at TIMESTAMPTZ DEFAULT now()
        );`);
      // colunas acrescentadas (nao-destrutivo — preserva agentes existentes)
      for (const col of [
        "agent_name TEXT", "nationality TEXT", "birthdate DATE",
        "phone2 TEXT", "whatsapp2 TEXT", "lang1 TEXT", "lang2 TEXT", "lang3 TEXT",
        "email2 TEXT", "company_info TEXT", "postal_code TEXT",
        "fifa_agent BOOLEAN DEFAULT false", "role_label TEXT", "curiosities TEXT",
        "annual_commission BIGINT DEFAULT 0", "slogan TEXT"
      ]) { await pool.query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS '+col+';'); }
      // estado das notas (Concluída/Pendente)
      await pool.query("ALTER TABLE agent_notes ADD COLUMN IF NOT EXISTS note_status TEXT DEFAULT 'done';");
      // posicao do jogador associado (para agrupar por posicao na ficha)
      await pool.query('ALTER TABLE agent_players ADD COLUMN IF NOT EXISTS player_pos TEXT;');
      await pool.query("ALTER TABLE agent_commissions ADD COLUMN IF NOT EXISTS comm_type TEXT;");
      // migração: remover UNIQUE(agent_player_id) para permitir múltiplas comissões por jogador
      await pool.query(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agent_commissions_agent_player_id_key') THEN
          ALTER TABLE agent_commissions DROP CONSTRAINT agent_commissions_agent_player_id_key;
        END IF;
      END $$;`);
      // comissões por jogador associado + pagamentos parcelados
      await pool.query(`
        CREATE TABLE IF NOT EXISTS agent_commissions (
          id           SERIAL PRIMARY KEY,
          agent_player_id INTEGER NOT NULL REFERENCES agent_players(id) ON DELETE CASCADE,
          total_val    BIGINT DEFAULT 0,
          n_payments   INTEGER DEFAULT 0,
          comm_type    TEXT,
          created_at   TIMESTAMPTZ DEFAULT now()
        );`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS agent_payments (
          id            SERIAL PRIMARY KEY,
          commission_id INTEGER NOT NULL REFERENCES agent_commissions(id) ON DELETE CASCADE,
          seq           INTEGER,
          amount        BIGINT DEFAULT 0,
          due_date      DATE,
          paid          BOOLEAN DEFAULT false,
          created_at    TIMESTAMPTZ DEFAULT now()
        );`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_payments_comm ON agent_payments(commission_id);');
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_notes_agent   ON agent_notes(agent_id);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_players_agent ON agent_players(agent_id);`);
      res.json({ ok: true, tables: ['agents', 'agent_players', 'agent_notes', 'agent_commissions', 'agent_payments'] });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- LISTA (para o ecrã tipo ranking) ----
  app.get('/agents', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT a.*,
          (SELECT COUNT(*) FROM agent_notes n WHERE n.agent_id=a.id)        AS notes_count,
          (SELECT COUNT(*) FROM agent_players p WHERE p.agent_id=a.id)       AS linked_count,
          (SELECT MAX(entry_date) FROM agent_notes n WHERE n.agent_id=a.id)  AS last_contact
        FROM agents a
        ORDER BY a.rating DESC, a.company ASC;`);
      res.json({ agents: rows });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- FICHA completa de um agente ----
  app.get('/agents/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const a = await pool.query(`SELECT * FROM agents WHERE id=$1;`, [id]);
      if (!a.rows.length) return res.status(404).json({ error: 'not found' });
      const players = await pool.query(`SELECT * FROM agent_players WHERE agent_id=$1 ORDER BY player_name;`, [id]);
      const notes   = await pool.query(`SELECT * FROM agent_notes WHERE agent_id=$1 ORDER BY entry_date DESC, id DESC;`, [id]);
      // comissões + pagamentos por jogador associado (tolerante: cria tabelas se faltarem)
      let comm = { rows: [] }, pays = { rows: [] };
      try {
        comm = await pool.query(`
          SELECT c.*, p.player_name FROM agent_commissions c
          JOIN agent_players p ON p.id=c.agent_player_id WHERE p.agent_id=$1;`, [id]);
        pays = await pool.query(`
          SELECT pay.* FROM agent_payments pay
          JOIN agent_commissions c ON c.id=pay.commission_id
          JOIN agent_players p ON p.id=c.agent_player_id
          WHERE p.agent_id=$1 ORDER BY pay.seq;`, [id]);
      } catch (err) {
        // tabelas ainda não criadas — criar agora e devolver vazio (não rebenta a ficha)
        await pool.query(`CREATE TABLE IF NOT EXISTS agent_commissions (id SERIAL PRIMARY KEY, agent_player_id INTEGER NOT NULL REFERENCES agent_players(id) ON DELETE CASCADE, total_val BIGINT DEFAULT 0, n_payments INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(agent_player_id));`);
      await pool.query('ALTER TABLE agent_commissions ADD COLUMN IF NOT EXISTS comm_type TEXT;');
        await pool.query(`CREATE TABLE IF NOT EXISTS agent_payments (id SERIAL PRIMARY KEY, commission_id INTEGER NOT NULL REFERENCES agent_commissions(id) ON DELETE CASCADE, seq INTEGER, amount BIGINT DEFAULT 0, due_date DATE, paid BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());`);
      }
      res.json({ agent: a.rows[0], players: players.rows, notes: notes.rows, commissions: comm.rows, payments: pays.rows });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- CRIAR ----
  app.post('/agents', async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.company || !String(b.company).trim()) return res.status(400).json({ error: 'company obrigatório' });
      const { rows } = await pool.query(`
        INSERT INTO agents (company, agent_name, website, photo_url, rating, nationality, birthdate,
          email, email2, phone, phone2, whatsapp, whatsapp2, languages, lang1, lang2, lang3,
          company_info, postal_code, num_players, portfolio_val, status, notes_ctx,
          fifa_agent, role_label, curiosities, annual_commission, slogan)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28) RETURNING *;`,
        [String(b.company).trim(), b.agent_name||null, b.website||null, b.photo_url||null, Math.max(0,Math.min(5,parseInt(b.rating,10)||0)),
         b.nationality||null, b.birthdate||null,
         b.email||null, b.email2||null, b.phone||null, b.phone2||null, b.whatsapp||null, b.whatsapp2||null,
         b.languages||null, b.lang1||null, b.lang2||null, b.lang3||null,
         b.company_info||null, b.postal_code||null,
         parseInt(b.num_players,10)||0, parseInt(b.portfolio_val,10)||0, b.status||'active', b.notes_ctx||null,
         !!b.fifa_agent, b.role_label||null, b.curiosities||null, parseInt(b.annual_commission,10)||0, b.slogan||null]);
      res.json({ agent: rows[0] });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- ATUALIZAR (campos parciais) ----
  app.put('/agents/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const b = req.body || {};
      const allowed = ['company','agent_name','website','photo_url','rating','nationality','birthdate','email','email2','phone','phone2','whatsapp','whatsapp2','languages','lang1','lang2','lang3','company_info','postal_code','num_players','portfolio_val','status','notes_ctx','fifa_agent','role_label','curiosities','annual_commission','slogan'];
      const sets = [], vals = []; let i = 1;
      for (const k of allowed) if (k in b) {
        let v = b[k];
        if (k === 'rating') v = Math.max(0, Math.min(5, parseInt(v,10)||0));
        if (k === 'num_players' || k === 'portfolio_val') v = parseInt(v,10)||0;
        sets.push(`${k}=$${i++}`); vals.push(v);
      }
      if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });
      sets.push(`updated_at=now()`);
      vals.push(id);
      const sql = `UPDATE agents SET ${sets.join(', ')} WHERE id=$${i} RETURNING *;`;
      let rows;
      try {
        rows = (await pool.query(sql, vals)).rows;
      } catch (errUpd) {
        // coluna em falta — criar as colunas novas (idempotente) e repetir
        for (const col of [
          "agent_name TEXT","nationality TEXT","birthdate DATE","phone2 TEXT","whatsapp2 TEXT",
          "lang1 TEXT","lang2 TEXT","lang3 TEXT","email2 TEXT","company_info TEXT","postal_code TEXT",
          "fifa_agent BOOLEAN DEFAULT false","role_label TEXT","curiosities TEXT",
          "annual_commission BIGINT DEFAULT 0","slogan TEXT","updated_at TIMESTAMPTZ DEFAULT now()"
        ]) { try { await pool.query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS '+col+';'); } catch(e2){} }
        rows = (await pool.query(sql, vals)).rows;
      }
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ agent: rows[0] });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- APAGAR (cascata para notas e jogadores) ----
  app.delete('/agents/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      await pool.query(`DELETE FROM agents WHERE id=$1;`, [id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- NOTAS: adicionar ----
  app.post('/agents/:id/notes', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const b = req.body || {};
      if (!b.body || !String(b.body).trim()) return res.status(400).json({ error: 'body obrigatório' });
      const kind = ['call','whatsapp','email','meeting','proposal','note'].includes(b.kind) ? b.kind : 'note';
      // garantir tabela + coluna note_status (resiliente a setup não corrido)
      await pool.query(`CREATE TABLE IF NOT EXISTS agent_notes (id SERIAL PRIMARY KEY, agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE, kind TEXT, body TEXT, entry_date DATE DEFAULT CURRENT_DATE, note_status TEXT DEFAULT 'done', created_at TIMESTAMPTZ DEFAULT now());`);
      await pool.query("ALTER TABLE agent_notes ADD COLUMN IF NOT EXISTS note_status TEXT DEFAULT 'done';");
      const { rows } = await pool.query(`
        INSERT INTO agent_notes (agent_id, kind, body, entry_date, note_status)
        VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5) RETURNING *;`,
        [id, kind, String(b.body).trim(), b.entry_date||null, (b.note_status==='pending'?'pending':'done')]);
      res.json({ note: rows[0] });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- NOTAS: alternar estado (done/pending) ----
  app.put('/agents/:id/notes/:noteId', async (req, res) => {
    try {
      const b = req.body || {};
      const st = (b.note_status==='pending') ? 'pending' : 'done';
      await pool.query("ALTER TABLE agent_notes ADD COLUMN IF NOT EXISTS note_status TEXT DEFAULT 'done';");
      const { rows } = await pool.query(`UPDATE agent_notes SET note_status=$1 WHERE id=$2 AND agent_id=$3 RETURNING *;`,
        [st, parseInt(req.params.noteId,10), parseInt(req.params.id,10)]);
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ note: rows[0] });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- NOTAS: apagar ----
  app.delete('/agents/:id/notes/:noteId', async (req, res) => {
    try {
      await pool.query(`DELETE FROM agent_notes WHERE id=$1 AND agent_id=$2;`,
        [parseInt(req.params.noteId,10), parseInt(req.params.id,10)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- JOGADORES-NA-APP: associar / desassociar ----
  app.post('/agents/:id/players', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const b = req.body || {};
      if (!b.player_name) return res.status(400).json({ error: 'player_name obrigatório' });
      const { rows } = await pool.query(`
        INSERT INTO agent_players (agent_id, player_name, player_league, player_pos)
        VALUES ($1,$2,$3,$4) ON CONFLICT (agent_id, player_name, player_league) DO NOTHING RETURNING *;`,
        [id, b.player_name, b.player_league||null, b.player_pos||null]);
      res.json({ player: rows[0] || null });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  app.delete('/agents/:id/players/:linkId', async (req, res) => {
    try {
      await pool.query(`DELETE FROM agent_players WHERE id=$1 AND agent_id=$2;`,
        [parseInt(req.params.linkId,10), parseInt(req.params.id,10)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });


  // ---- COMISSÕES: criar/atualizar para um jogador associado, com N pagamentos ----
  app.post('/agents/players/:linkId/commission', async (req, res) => {
    try {
      const linkId = parseInt(req.params.linkId, 10);
      const b = req.body || {};
      const total = parseInt(b.total_val,10)||0;
      const n = parseInt(b.n_payments,10)||0;
      // garantir tabelas (idempotente, sem UNIQUE — permite múltiplas comissões por jogador)
      await pool.query(`CREATE TABLE IF NOT EXISTS agent_commissions (id SERIAL PRIMARY KEY, agent_player_id INTEGER NOT NULL REFERENCES agent_players(id) ON DELETE CASCADE, total_val BIGINT DEFAULT 0, n_payments INTEGER DEFAULT 0, comm_type TEXT, created_at TIMESTAMPTZ DEFAULT now());`);
      await pool.query('ALTER TABLE agent_commissions ADD COLUMN IF NOT EXISTS comm_type TEXT;');
      await pool.query(`CREATE TABLE IF NOT EXISTS agent_payments (id SERIAL PRIMARY KEY, commission_id INTEGER NOT NULL REFERENCES agent_commissions(id) ON DELETE CASCADE, seq INTEGER, amount BIGINT DEFAULT 0, due_date DATE, paid BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());`);
      let c;
      if (b.commission_id) {
        // atualizar comissão existente
        c = await pool.query(`UPDATE agent_commissions SET total_val=$1, n_payments=$2, comm_type=$3 WHERE id=$4 AND agent_player_id=$5 RETURNING *;`,
          [total, n, b.comm_type||null, parseInt(b.commission_id,10), linkId]);
        if (!c.rows.length) return res.status(404).json({ error: 'commission not found' });
      } else {
        // criar nova comissão (resiliente: se houver UNIQUE antiga em agent_player_id, remove-a e repete)
        try {
          c = await pool.query(`INSERT INTO agent_commissions (agent_player_id, total_val, n_payments, comm_type) VALUES ($1,$2,$3,$4) RETURNING *;`,
            [linkId, total, n, b.comm_type||null]);
        } catch (errIns) {
          // remover qualquer restrição UNIQUE sobre agent_player_id (nome pode variar)
          await pool.query(`DO $$ DECLARE r record; BEGIN
            FOR r IN (SELECT conname FROM pg_constraint WHERE conrelid='agent_commissions'::regclass AND contype='u') LOOP
              EXECUTE 'ALTER TABLE agent_commissions DROP CONSTRAINT ' || quote_ident(r.conname);
            END LOOP;
          END $$;`);
          c = await pool.query(`INSERT INTO agent_commissions (agent_player_id, total_val, n_payments, comm_type) VALUES ($1,$2,$3,$4) RETURNING *;`,
            [linkId, total, n, b.comm_type||null]);
        }
      }
      const commId = c.rows[0].id;
      // substituir pagamentos: apagar e recriar a partir do array recebido
      await pool.query(`DELETE FROM agent_payments WHERE commission_id=$1;`, [commId]);
      const pays = Array.isArray(b.payments) ? b.payments : [];
      for (let i=0;i<pays.length;i++){
        const pmt = pays[i]||{};
        await pool.query(`
          INSERT INTO agent_payments (commission_id, seq, amount, due_date, paid)
          VALUES ($1,$2,$3,$4,$5);`,
          [commId, i+1, parseInt(pmt.amount,10)||0, pmt.due_date||null, !!pmt.paid]);
      }
      const out = await pool.query(`SELECT * FROM agent_payments WHERE commission_id=$1 ORDER BY seq;`, [commId]);
      res.json({ commission: c.rows[0], payments: out.rows });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- COMISSÃO: apagar ----
  app.delete('/agents/commissions/:commId', async (req, res) => {
    try {
      const { rows } = await pool.query(`DELETE FROM agent_commissions WHERE id=$1 RETURNING id;`, [parseInt(req.params.commId,10)]);
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, deleted: rows[0].id });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- PAGAMENTO: marcar pago / não pago ----
  app.put('/agents/payments/:payId', async (req, res) => {
    try {
      const payId = parseInt(req.params.payId, 10);
      const b = req.body || {};
      const { rows } = await pool.query(`UPDATE agent_payments SET paid=$1 WHERE id=$2 RETURNING *;`, [!!b.paid, payId]);
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ payment: rows[0] });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });


// ═══ CARTÃO PDF (inline) ═══════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// card_pdf.js — gera o PDF do cartão do agente (design Thrivella v2) com links
// clicáveis (Email mailto, Telefone→WhatsApp wa.me, Transfermarkt).
//
// Uso no server.js:
//   const { registerCardPdfRoute } = require('./card_pdf');
//   // ── DIAGNÓSTICO temporário do Chromium ──
app.get('/agents/_diag/chromium', (req, res) => {
  const fs = require('fs');
  const { execSync } = require('child_process');
  const paths = ['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/root/.cache/puppeteer','/tmp/chromium'];
  const found = {};
  paths.forEach(pp=>{ try{ found[pp]=fs.existsSync(pp); }catch(e){ found[pp]='err'; } });
  let which='';
  try{ which=execSync('which chromium chromium-browser google-chrome 2>/dev/null || true').toString(); }catch(e){ which=String(e.message); }
  let ldd='';
  try{ if(fs.existsSync('/usr/bin/chromium')) ldd=execSync('ldd /usr/bin/chromium 2>&1 | grep -i "not found" || echo "todas as libs OK (/usr/bin/chromium)"').toString(); }catch(e){ ldd=String(e.message); }
  res.json({
    engine_detetado: engine,
    sysChromePath: sysChromePath,
    env_PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || null,
    paths_existem: found,
    which: which.trim(),
    libs_em_falta: ldd.trim(),
  });
});

registerCardPdfRoute(app, pool);
//
// Requer:  npm i puppeteer
// (No Railway: o puppeteer descarrega o Chromium no build. Se falhar, ver o
//  fallback @sparticuz/chromium comentado no fim deste ficheiro.)
// ═══════════════════════════════════════════════════════════════════════════

// Carregamento do motor de render.
// No Railway usamos o Chromium do SISTEMA (instalado via Dockerfile, com o caminho
// em PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium). Fallback para @sparticuz se existir.
const fs = require('fs');
let puppeteer = null, sparticuz = null, engine = 'none', sysChromePath = null;
try { puppeteer = require('puppeteer-core'); } catch (e) { /* ver package.json */ }
// procurar o Chromium do sistema em caminhos comuns (nixpacks/Debian)
try {
  const cands = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) { sysChromePath = c; break; } } catch(_){} }
} catch(_){}
if (sysChromePath && puppeteer) {
  engine = 'system';
} else {
  try { sparticuz = require('@sparticuz/chromium'); if (puppeteer) engine = 'sparticuz'; }
  catch (e1) {
    try { puppeteer = require('puppeteer'); engine = 'puppeteer'; } catch (e2) {}
  }
}

function esc(t){ return String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function money(v){
  v = parseInt(v,10)||0;
  if (v>=1e9) return '€'+(v/1e9).toFixed(v%1e9?1:0)+'B';
  if (v>=1e6) return '€'+(v/1e6).toFixed(v%1e6?1:0)+'M';
  if (v>=1e3) return '€'+Math.round(v/1e3)+'k';
  return '€'+v;
}

// nome do país por extenso + código ISO (2 letras minúsculas) para a bandeira
const COUNTRY = {
  PT:['Portugal','pt'], ES:['Espanha','es'], FR:['França','fr'], GB:['Reino Unido','gb'],
  IT:['Itália','it'], DE:['Alemanha','de'], NL:['Holanda','nl'], BE:['Bélgica','be'],
  BR:['Brasil','br'], AR:['Argentina','ar'], US:['EUA','us'], CH:['Suíça','ch'],
  AT:['Áustria','at'], DK:['Dinamarca','dk'], SE:['Suécia','se'], NO:['Noruega','no'],
  PL:['Polónia','pl'], HR:['Croácia','hr'], RS:['Sérvia','rs'], GR:['Grécia','gr'],
  TR:['Turquia','tr'], MA:['Marrocos','ma'], SN:['Senegal','sn'], NG:['Nigéria','ng'],
  CI:['Costa do Marfim','ci'], GH:['Gana','gh'], JP:['Japão','jp'], KR:['Coreia do Sul','kr'],
  MX:['México','mx'], CO:['Colômbia','co'], UY:['Uruguai','uy'], CL:['Chile','cl'],
};

function buildHtml(a){
  const name = a.agent_name || a.company || 'Agente';
  const org  = a.company || '';
  const active = (a.status !== 'inactive');
  const status = 'Agent Tracker';        // rótulo interno, sempre igual
  const dotCol = '#43e5b0';               // luz verde sempre, independente do estado
  const serial = 'THV · ' + (new Date().getFullYear());
  const players = (a.num_players||0);
  const mv = money(a.portfolio_val);
  const fifa = !!a.fifa_agent;

  // país
  const natCode = (a.nationality||'').toUpperCase();
  const cinfo = COUNTRY[natCode] || null;
  const countryName = cinfo ? cinfo[0] : (a.nationality || '');
  const countryIso  = cinfo ? cinfo[1] : (natCode ? natCode.toLowerCase() : '');
  const langs = [a.lang1,a.lang2,a.lang3].filter(Boolean).join(' · ');

  // avatar
  let avatar;
  if (a.photo_url) {
    avatar = '<img src="'+a.photo_url+'" alt="'+esc(name)+'">';
  } else {
    const ini = name.split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
    avatar = '<span class="mono">'+esc(ini)+'</span>';
  }
  const seal = ''; // selo verificado só aparece na box "Agente FIFA", não na foto

  // contactos
  const emailHtml = a.email
    ? '<a href="mailto:'+esc(a.email)+'"><svg class="ico" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg><span class="lbl">Email</span><span class="val">Contactar ›</span></a>'
    : '';
  const wa = String(a.whatsapp||a.phone||'').replace(/[^0-9]/g,'');
  const phoneHtml = wa
    ? '<a href="https://wa.me/'+wa+'"><svg class="ico wa" viewBox="0 0 24 24"><path d="M12 2a10 10 0 0 0-8.6 15l-1.3 4.7 4.8-1.3A10 10 0 1 0 12 2zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-2.8.8.7-2.7-.2-.3A8 8 0 1 1 12 20zm4.4-5.9c-.2-.1-1.4-.7-1.6-.8s-.4-.1-.5.1-.6.8-.7 1-.3.2-.5.1a6.5 6.5 0 0 1-1.9-1.2 7.3 7.3 0 0 1-1.4-1.7c-.1-.2 0-.4.1-.5l.4-.4.2-.4v-.4l-.8-1.8c-.2-.5-.4-.4-.5-.4h-.5a1 1 0 0 0-.7.3A2.8 2.8 0 0 0 6.5 9a5 5 0 0 0 1 2.6 11.4 11.4 0 0 0 4.4 3.9c.6.3 1.1.4 1.5.5a3.5 3.5 0 0 0 1.6.1c.5-.1 1.4-.6 1.6-1.1a2 2 0 0 0 .1-1.1c0-.1-.2-.2-.4-.3z"/></svg><span class="lbl">WhatsApp</span><span class="val">Mensagem ›</span></a>'
    : '';
  const tmHtml = a.website
    ? '<a href="'+esc(a.website)+'"><svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg><span class="lbl">Transfermarkt</span><span class="val">Ver perfil ›</span></a>'
    : '';

  const tileFifa = fifa
    ? '<div class="tile compact" style="--c:#4da0ff"><div class="glow"></div><span class="badge"><svg viewBox="0 0 24 24"><polygon points="12,0.8 14.25,3.6 17.6,2.3 18.15,5.85 21.7,6.4 20.4,9.75 23.2,12 20.4,14.25 21.7,17.6 18.15,18.15 17.6,21.7 14.25,20.4 12,23.2 9.75,20.4 6.4,21.7 5.85,18.15 2.3,17.6 3.6,14.25 0.8,12 3.6,9.75 2.3,6.4 5.85,5.85 6.4,2.3 9.75,3.6" fill="#3897f0"/><path d="M8.2 12.3 l2.6 2.6 l5.0 -5.4" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg></span><div class="ctext"><div class="v">Agente FIFA</div><div class="s">Licenciado</div></div></div>'
    : '<div class="tile compact" style="--c:#4da0ff"><div class="glow"></div><div class="ctext"><div class="v">Agente</div><div class="s">de Jogadores</div></div></div>';

  const tileCountry = '<div class="tile compact" style="--c:#4da0ff"><div class="glow"></div><div class="ctext"><div class="v">'+esc(countryName||'—')+'</div>'+(langs?'<div class="s">Idiomas: '+esc(langs)+'</div>':'<div class="s">País</div>')+'</div></div>';

  return `<!DOCTYPE html><html lang="pt"><head><meta charset="UTF-8"><style>
  @page{size:460px 760px;margin:0}
  :root{--deep:#060d1e;--line:rgba(120,170,255,.14);--line-strong:rgba(120,170,255,.30);--ink:#eef4ff;--muted:#8aa0c6;--muted-2:#61759b;--blue:#4da0ff;--blue-bright:#7bbcff;--mint:#43e5b0;--fx-display:'Segoe UI',system-ui,sans-serif;--fx-body:'Segoe UI',system-ui,sans-serif}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:460px;height:760px}
  body{font-family:var(--fx-body);background:radial-gradient(120% 90% at 50% -10%,#0a1836 0%,#060d1e 46%,#03060f 100%);color:var(--ink);display:flex;align-items:center;justify-content:center;-webkit-font-smoothing:antialiased}
  .card{position:relative;width:420px;border-radius:28px;padding:34px 26px 22px;background:linear-gradient(180deg,rgba(20,38,74,.72),rgba(7,15,32,.86));border:1px solid var(--line-strong);box-shadow:0 1px 0 rgba(160,200,255,.14) inset,0 30px 70px -30px rgba(0,10,40,.9);overflow:hidden}
  .holo{position:absolute;top:0;left:0;right:0;height:140px;z-index:0;pointer-events:none;opacity:.45;-webkit-mask:linear-gradient(180deg,#000 0%,transparent 100%);background:repeating-linear-gradient(58deg,rgba(120,180,255,.10) 0 1px,transparent 1px 7px),repeating-linear-gradient(-58deg,rgba(90,150,255,.08) 0 1px,transparent 1px 7px)}
  .content{position:relative;z-index:2}
  .eyebrow{display:flex;align-items:center;justify-content:space-between;font-family:var(--fx-display);font-size:9px;letter-spacing:.28em;text-transform:uppercase;color:var(--muted-2);margin-bottom:18px}
  .eyebrow .dot{width:6px;height:6px;border-radius:50%;background:${dotCol};box-shadow:0 0 10px ${dotCol};display:inline-block;margin-right:7px;vertical-align:middle}
  .avatar-wrap{display:flex;justify-content:center;margin-bottom:18px}
  .avatar{position:relative;width:120px;height:120px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle at 35% 28%,#17335f,#081327 72%);box-shadow:0 0 0 1px rgba(120,180,255,.35),0 0 30px rgba(70,140,255,.45),inset 0 2px 14px rgba(0,0,0,.6)}
  .avatar .ring{position:absolute;inset:-4px;border-radius:50%;padding:2px;background:conic-gradient(from 90deg,#4da0ff,#12e0ff,#7a3bff,#4da0ff);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;opacity:.9}
  .avatar .mono{font-family:var(--fx-display);font-weight:700;font-size:42px;background:linear-gradient(180deg,#eaf3ff,#8fb6ff);-webkit-background-clip:text;background-clip:text;color:transparent}
  .avatar img{width:100%;height:100%;border-radius:50%;object-fit:cover;position:relative;z-index:1}
  .seal{position:absolute;right:2px;bottom:4px;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(150deg,#2f8bff,#1b5fd6);box-shadow:0 4px 14px rgba(20,80,200,.6),0 0 0 3px var(--deep);z-index:2}
  .seal svg{width:15px;height:15px;stroke:#fff;stroke-width:3;fill:none}
  .name{font-family:var(--fx-display);font-weight:700;font-size:34px;line-height:1;text-align:center;letter-spacing:-.015em;background:linear-gradient(180deg,#fff,#c7dcff);-webkit-background-clip:text;background-clip:text;color:transparent;margin-bottom:10px}
  .org{text-align:center;font-family:var(--fx-display);font-weight:600;font-size:13px;letter-spacing:.34em;text-transform:uppercase;color:var(--blue-bright);margin-bottom:20px}
  .contact{display:grid;grid-template-columns:1fr 1fr 1fr;border:1px solid var(--line);border-radius:16px;overflow:hidden;background:linear-gradient(180deg,rgba(18,34,66,.5),rgba(9,18,38,.5));margin-bottom:14px}
  .contact a{text-decoration:none;color:inherit;padding:13px 8px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:6px;position:relative}
  .contact a+a::before{content:"";position:absolute;left:0;top:22%;bottom:22%;width:1px;background:var(--line)}
  .contact .ico{width:20px;height:20px;stroke:var(--blue);stroke-width:1.6;fill:none}
  .contact .ico.wa{stroke:var(--mint)}
  .contact .lbl{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted-2)}
  .contact .val{font-size:11px;font-weight:600;color:var(--blue-bright)}
  .stats{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:20px}
  .tile{position:relative;border-radius:18px;padding:16px 15px 14px;overflow:hidden;border:1px solid var(--line);background:linear-gradient(180deg,rgba(20,38,74,.55),rgba(9,18,38,.55))}
  .tile .glow{position:absolute;inset:0;opacity:.5;background:radial-gradient(120px 80px at 82% -10%,var(--c,#4da0ff)44,transparent 70%)}
  .tile .k{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted-2);display:flex;align-items:center;gap:6px;margin-bottom:7px;position:relative}
  .tile .k svg{width:13px;height:13px;stroke:var(--c,#4da0ff);stroke-width:1.8;fill:none}
  .tile .v{font-family:var(--fx-display);font-weight:700;font-size:30px;line-height:1;color:var(--c,#4da0ff);position:relative}
  .tile .s{font-size:11px;color:var(--muted);margin-top:4px;position:relative}
  .tile.compact{display:flex;align-items:center;gap:12px;padding:13px 14px}
  .tile.compact .badge{flex:none;width:32px;height:32px}
  .tile.compact .badge svg{width:100%;height:100%}
  .tile.compact .flag{flex:none;width:32px;height:22px;border-radius:5px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.14)}
  .tile.compact .flag img{display:block;width:100%;height:100%;object-fit:cover}
  .tile.compact .ctext .v{font-family:var(--fx-display);font-size:15px;font-weight:600;color:var(--ink)}
  .tile.compact .ctext .s{font-size:10px;color:var(--muted);margin-top:2px}
  .foot{display:flex;flex-direction:column;align-items:center;gap:5px;padding-top:2px}
  .rule{display:flex;align-items:center;gap:10px;width:100%}
  .rule .ln{height:1px;flex:1;background:linear-gradient(90deg,transparent,var(--line-strong))}
  .rule .ln.r{background:linear-gradient(90deg,var(--line-strong),transparent)}
  .rule svg{width:13px;height:13px;fill:var(--blue)}
  .wordmark{font-family:var(--fx-display);font-weight:600;font-size:24px;letter-spacing:-.01em;background:linear-gradient(120deg,#5aa6ff,#8fd0ff,#5aa6ff);-webkit-background-clip:text;background-clip:text;color:transparent}
  .powered{font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted-2)}
  </style></head><body>
  <div class="card"><div class="holo"></div><div class="content">
    <div class="eyebrow"><span><span class="dot"></span>${esc(status)}</span><span>${esc(serial)}</span></div>
    <div class="avatar-wrap"><div class="avatar"><div class="ring"></div>${avatar}${seal}</div></div>
    <h1 class="name">${esc(name)}</h1>
    <div class="org">${esc(org)}</div>
    <nav class="contact">${emailHtml}${phoneHtml}${tmHtml}</nav>
    <section class="stats">
      <div class="tile" style="--c:#4da0ff"><div class="glow"></div><div class="k"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5"/><path d="M16 6.5a3 3 0 0 1 0 5.5M18 20c0-2.4-1-4.2-2.6-5.2"/></svg>Jogadores</div><div class="v">${players}</div><div class="s">Sob gestão</div></div>
      <div class="tile" style="--c:#43e5b0"><div class="glow"></div><div class="k"><svg viewBox="0 0 24 24"><path d="M4 18V6l8 6 8-6v12"/><path d="M4 20h16"/></svg>Valor de Mercado</div><div class="v">${esc(mv)}</div><div class="s">Carteira agregada</div></div>
      ${tileFifa}${tileCountry}
    </section>
    <footer class="foot"><div class="rule"><span class="ln"></span><svg viewBox="0 0 24 24"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z"/></svg><span class="wordmark">thrivella</span><svg viewBox="0 0 24 24"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z"/></svg><span class="ln r"></span></div><div class="powered">Powered by Thrivella</div></footer>
  </div></div></body></html>`;
}

async function renderPdf(html){
  let launchOpts;
  if (engine === 'system') {
    launchOpts = {
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--single-process'],
      executablePath: sysChromePath,
      headless: 'new',
    };
  } else if (engine === 'sparticuz') {
    launchOpts = {
      args: [...sparticuz.args, '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
      defaultViewport: sparticuz.defaultViewport,
      executablePath: await sparticuz.executablePath(),
      headless: 'new',
    };
  } else {
    launchOpts = {
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
      headless: 'new',
    };
  }
  const browser = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      width: '460px', height: '760px',
      printBackground: true, preferCSSPageSize: true,
    });
    return pdf;
  } finally {
    await browser.close();
  }
}

function registerCardPdfRoute(app, pool){
  app.get('/agents/:id/card.pdf', async (req, res) => {
    try {
      if (!puppeteer) return res.status(500).json({ error: 'Motor de PDF indisponível. Instala no backend: "npm i @sparticuz/chromium puppeteer-core" (recomendado p/ Railway) OU "npm i puppeteer".' });
      const id = parseInt(req.params.id, 10);
      const r = await pool.query('SELECT * FROM agents WHERE id=$1;', [id]);
      if (!r.rows.length) return res.status(404).json({ error: 'agente não encontrado' });
      const a = r.rows[0];
      const html = buildHtml(a);
      const pdf = await renderPdf(html);
      const safe = String(a.agent_name || a.company || 'agente').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9]+/g,'');
      const fname = 'THV.'+safe+'.pdf';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="'+fname+'"');
      res.send(pdf);
    } catch (e) {
      console.error('card.pdf error:', e);
      res.status(500).json({ error: String(e.message || e) });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// FALLBACK Railway (se o puppeteer normal não arrancar o Chromium):
//   npm i puppeteer-core @sparticuz/chromium
// e trocar renderPdf por:
//   const chromium = require('@sparticuz/chromium');
//   const puppeteer = require('puppeteer-core');
//   const browser = await puppeteer.launch({
//     args: chromium.args, executablePath: await chromium.executablePath(),
//     headless: 'new',
//   });
// ─────────────────────────────────────────────────────────────────────────

// ═══ fim cartão PDF ════════════════════════════════════════════════════════

registerCardPdfRoute(app, pool);

app.listen(PORT, () => console.log(`ProScout API running on port ${PORT}`));
