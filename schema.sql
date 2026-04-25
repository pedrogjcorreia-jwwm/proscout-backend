-- ProScout Database Schema
-- Run this once on your PostgreSQL database

-- ── Players ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS players (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  country         TEXT,
  team            TEXT,
  league          TEXT,
  league_level    TEXT,
  position        TEXT,          -- raw position string e.g. "LAMF, LW, AMF"
  position_group  TEXT,          -- normalised e.g. "WIN", "CB", "DM"
  age             INTEGER,
  foot            TEXT,
  size            INTEGER,       -- cm
  weight          INTEGER,       -- kg
  mkt_value       NUMERIC,
  contract_end    DATE,
  matches         INTEGER,
  minutes         INTEGER,

  -- Raw metrics
  xg              NUMERIC,
  xa              NUMERIC,
  fouls           NUMERIC,
  yellows         NUMERIC,
  def_duels       NUMERIC,
  def_duels_pct   NUMERIC,
  adj_intercept   NUMERIC,
  goals_np        NUMERIC,
  shots90         NUMERIC,
  goals_per_shot  NUMERIC,
  crosses90       NUMERIC,
  crosses_pct     NUMERIC,
  dribles90       NUMERIC,
  dribles_pct     NUMERIC,
  box_touches     NUMERIC,
  prog_carries    NUMERIC,
  accels90        NUMERIC,
  passes90        NUMERIC,
  passes_pct      NUMERIC,
  shot_assist     NUMERIC,
  box_passes      NUMERIC,
  box_passes_pct  NUMERIC,
  recpt_depth     NUMERIC,
  total_dist      NUMERIC,
  hsr90           NUMERIC,
  sprint_dist90   NUMERIC,
  max_speed       NUMERIC,
  sprints90       NUMERIC,
  hsr_sprint_pct  NUMERIC,

  -- Totals (calculated by Excel, stored here)
  total_def       NUMERIC,
  total_off       NUMERIC,
  total_pass      NUMERIC,
  total           NUMERIC,
  total_physical  NUMERIC,
  score           NUMERIC,       -- final score

  -- Meta
  sf_rating       NUMERIC,       -- SofaScore rating (fetched separately)
  has_physical    BOOLEAN DEFAULT false,
  imported_at     TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW(),

  UNIQUE(name, league)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_players_position_group ON players(position_group);
CREATE INDEX IF NOT EXISTS idx_players_league ON players(league);
CREATE INDEX IF NOT EXISTS idx_players_score ON players(score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_players_contract ON players(contract_end);
CREATE INDEX IF NOT EXISTS idx_players_age ON players(age);

-- ── Metrics config (weights per position) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS metrics_config (
  id              SERIAL PRIMARY KEY,
  position_group  TEXT NOT NULL,
  metric_key      TEXT NOT NULL,
  weight          NUMERIC NOT NULL,
  label_pt        TEXT,          -- Portuguese label
  category        TEXT,          -- 'offensive', 'defensive', 'passing', 'physical'
  inverse         BOOLEAN DEFAULT false,  -- lower is better (e.g. fouls)
  min_attempts    INTEGER,       -- minimum attempts before scoring (outlier filter)
  created_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE(position_group, metric_key)
);

-- ── Shadow teams ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shadows (
  id          SERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL DEFAULT 'default',
  name        TEXT NOT NULL DEFAULT 'My Shadow',
  tab         TEXT NOT NULL DEFAULT 'my',   -- 'my', 'overall', 'contract', 'u23'
  formation   TEXT DEFAULT '3-4-3',
  data        JSONB DEFAULT '{}',           -- slot assignments
  notes       JSONB DEFAULT '{}',           -- player notes
  custom_pos  JSONB DEFAULT '{}',           -- custom dot positions
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, name, tab)
);

-- ── Users (for future multi-user) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email       TEXT UNIQUE NOT NULL,
  name        TEXT,
  role        TEXT DEFAULT 'scout',         -- 'scout', 'admin'
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ── League metadata ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leagues (
  code        TEXT PRIMARY KEY,             -- e.g. 'BEL1'
  name        TEXT,                         -- e.g. 'Belgian Pro League'
  country     TEXT,
  level       INTEGER DEFAULT 1,
  has_physical BOOLEAN DEFAULT true
);
