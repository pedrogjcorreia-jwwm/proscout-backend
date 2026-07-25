require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type'] }));
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

    res.json({ inserted, updated, total: players.length });
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
        "email2 TEXT", "company_info TEXT", "postal_code TEXT"
      ]) { await pool.query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS '+col+';'); }
      // posicao do jogador associado (para agrupar por posicao na ficha)
      await pool.query('ALTER TABLE agent_players ADD COLUMN IF NOT EXISTS player_pos TEXT;');
      // comissões por jogador associado + pagamentos parcelados
      await pool.query(`
        CREATE TABLE IF NOT EXISTS agent_commissions (
          id           SERIAL PRIMARY KEY,
          agent_player_id INTEGER NOT NULL REFERENCES agent_players(id) ON DELETE CASCADE,
          total_val    BIGINT DEFAULT 0,
          n_payments   INTEGER DEFAULT 0,
          created_at   TIMESTAMPTZ DEFAULT now(),
          UNIQUE(agent_player_id)
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
          company_info, postal_code, num_players, portfolio_val, status, notes_ctx)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *;`,
        [String(b.company).trim(), b.agent_name||null, b.website||null, b.photo_url||null, Math.max(0,Math.min(5,parseInt(b.rating,10)||0)),
         b.nationality||null, b.birthdate||null,
         b.email||null, b.email2||null, b.phone||null, b.phone2||null, b.whatsapp||null, b.whatsapp2||null,
         b.languages||null, b.lang1||null, b.lang2||null, b.lang3||null,
         b.company_info||null, b.postal_code||null,
         parseInt(b.num_players,10)||0, parseInt(b.portfolio_val,10)||0, b.status||'active', b.notes_ctx||null]);
      res.json({ agent: rows[0] });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- ATUALIZAR (campos parciais) ----
  app.put('/agents/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const b = req.body || {};
      const allowed = ['company','agent_name','website','photo_url','rating','nationality','birthdate','email','email2','phone','phone2','whatsapp','whatsapp2','languages','lang1','lang2','lang3','company_info','postal_code','num_players','portfolio_val','status','notes_ctx'];
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
      const { rows } = await pool.query(`UPDATE agents SET ${sets.join(', ')} WHERE id=$${i} RETURNING *;`, vals);
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
      const { rows } = await pool.query(`
        INSERT INTO agent_notes (agent_id, kind, body, entry_date)
        VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE)) RETURNING *;`,
        [id, kind, String(b.body).trim(), b.entry_date||null]);
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
      // garantir tabelas (idempotente)
      await pool.query(`CREATE TABLE IF NOT EXISTS agent_commissions (id SERIAL PRIMARY KEY, agent_player_id INTEGER NOT NULL REFERENCES agent_players(id) ON DELETE CASCADE, total_val BIGINT DEFAULT 0, n_payments INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(agent_player_id));`);
      await pool.query(`CREATE TABLE IF NOT EXISTS agent_payments (id SERIAL PRIMARY KEY, commission_id INTEGER NOT NULL REFERENCES agent_commissions(id) ON DELETE CASCADE, seq INTEGER, amount BIGINT DEFAULT 0, due_date DATE, paid BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());`);
      // upsert da comissão
      const c = await pool.query(`
        INSERT INTO agent_commissions (agent_player_id, total_val, n_payments)
        VALUES ($1,$2,$3)
        ON CONFLICT (agent_player_id) DO UPDATE SET total_val=$2, n_payments=$3
        RETURNING *;`, [linkId, total, n]);
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

app.listen(PORT, () => console.log(`ProScout API running on port ${PORT}`));
