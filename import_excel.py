"""
ProScout — Excel Importer
Reads all position Excel files and outputs a single JSON file per position.
Usage: python import_excel.py <excel_file> <position_name>
Example: python import_excel.py WIN_PHY_ProScout25_04.xlsx WIN
"""

import pandas as pd
import json
import sys
import os
from datetime import datetime

# ── Column mapping (scoring section starts at col 42) ────────────────────────
INFO_COLS = {
    'name':         42,
    'country':      43,
    'team':         44,
    'league':       45,
    'position':     47,
    'age':          48,
    'foot':         49,
    'size':         50,
    'weight':       51,
    'mkt_value':    52,
    'contract_end': 53,
    'matches':      54,
    'minutes':      55,
}

# metric_key: (value_col, points_col, league_avg_col)
METRIC_COLS = {
    'xg':             (56,  58,  57),
    'xa':             (60,  62,  61),
    'fouls':          (64,  None, 65),
    'yellows':        (66,  None, 67),
    'def_duels':      (69,  71,  70),
    'def_duels_pct':  (73,  75,  74),
    'adj_intercept':  (77,  79,  78),
    'goals_np':       (81,  83,  82),
    'shots90':        (85,  87,  86),
    'goals_per_shot': (89,  91,  90),
    'crosses90':      (93,  95,  94),
    'crosses_pct':    (97,  99,  98),
    'dribles90':      (101, 103, 102),
    'dribles_pct':    (105, 107, 106),
    'box_touches':    (109, 111, 110),
    'prog_carries':   (113, 115, 114),
    'accels90':       (117, 119, 118),
    'passes90':       (121, 123, 122),
    'passes_pct':     (125, 127, 126),
    'shot_assist':    (129, 131, 130),
    'box_passes':     (133, 135, 134),
    'box_passes_pct': (137, 139, 138),
    'recpt_depth':    (141, 143, 142),
    'total_dist':     (145, 147, 146),
    'hsr90':          (149, 151, 150),
    'sprint_dist90':  (153, 155, 154),
    'max_speed':      (157, 159, 158),
    'sprints90':      (161, 163, 162),
    'hsr_sprint_pct': (165, 167, 166),
}

TOTAL_COLS = {
    'total_def':      169,
    'total_off':      170,
    'total_pass':     171,
    'total':          172,
    'ranking':        173,
    'total_dist_sum': 174,
    'hsr_sum':        175,
    'sprint_sum':     176,
    'max_speed_sum':  177,
    'sprints_sum':    178,
    'hsr_sprint_sum': 179,
    'total_physical': 180,
    'phy_ranking':    181,
    'score':          196,
}


def safe(val, typ=float):
    """Convert value safely, return None if invalid."""
    try:
        if pd.isna(val):
            return None
        v = typ(val)
        return None if (typ == float and (v == 0.0)) else v
    except:
        return None


def safe_str(val):
    if pd.isna(val):
        return None
    s = str(val).strip()
    return s if s and s != 'nan' and s != '0' else None


def extract_weights(template_sheet):
    """Extract metric weights from template row 1."""
    row1 = list(template_sheet.iloc[1])
    weights = {}
    for key, (val_col, pts_col, _) in METRIC_COLS.items():
        if pts_col and pts_col < len(row1):
            raw = str(row1[pts_col])
            # e.g. "Points\n3" or "Points\n4,5"
            if 'Points' in raw or raw.replace(',', '.').replace('\n', '').strip().replace('.', '').isdigit():
                num = raw.split('\n')[-1].replace(',', '.').strip()
                try:
                    weights[key] = float(num)
                except:
                    weights[key] = None
    return weights


def extract_players(df, league_name, has_physical):
    """Extract player rows from a league sheet."""
    players = []
    for i in range(2, len(df)):
        row = df.iloc[i]

        name = safe_str(row[INFO_COLS['name']])
        if not name or name == '0':
            continue

        p = {
            'name':         name,
            'country':      safe_str(row[INFO_COLS['country']]),
            'team':         safe_str(row[INFO_COLS['team']]),
            'league':       safe_str(row[INFO_COLS['league']]) or league_name,
            'position':     safe_str(row[INFO_COLS['position']]),
            'age':          safe(row[INFO_COLS['age']], int),
            'foot':         safe_str(row[INFO_COLS['foot']]),
            'size':         safe(row[INFO_COLS['size']], int),
            'weight':       safe(row[INFO_COLS['weight']], int),
            'mkt_value':    safe(row[INFO_COLS['mkt_value']], float),
            'contract_end': safe_str(row[INFO_COLS['contract_end']]),
            'matches':      safe(row[INFO_COLS['matches']], int),
            'minutes':      safe(row[INFO_COLS['minutes']], int),
        }

        # Fix contract_end format
        if p['contract_end']:
            p['contract_end'] = p['contract_end'][:10]

        # Raw metrics
        for key, (val_col, pts_col, avg_col) in METRIC_COLS.items():
            if val_col < len(row):
                p[key] = safe(row[val_col])
            else:
                p[key] = None

        # Totals
        for key, col in TOTAL_COLS.items():
            if col < len(row):
                val = safe(row[col])
                if key in ('ranking', 'phy_ranking'):
                    val = safe(row[col], int)
                p[key] = val
            else:
                p[key] = None

        # Alias for app compatibility
        p['sf_rating']    = None  # SofaScore — not in Excel, fetched separately
        p['has_physical'] = bool(has_physical)

        if p['score']:  # Only include players with a score
            players.append(p)

    return players


def import_file(excel_path, position_name):
    print(f"Reading {excel_path}...")
    xl = pd.ExcelFile(excel_path)

    sheets = [s for s in xl.sheet_names if s not in ('TEMPLATE+PHY', 'TEMPLATE')]
    print(f"Found {len(sheets)} league sheets")

    # Extract weights from template
    template = pd.read_excel(xl, 'TEMPLATE+PHY', header=None)
    weights = extract_weights(template)
    print(f"Extracted {len(weights)} metric weights")

    all_players = []
    for sheet in sheets:
        try:
            df = pd.read_excel(xl, sheet, header=None)
            has_phy = df.shape[1] > 180 and df.iloc[2:, 180].notna().any()
            players = extract_players(df, sheet, has_phy)
            print(f"  {sheet}: {len(players)} players")
            all_players.extend(players)
        except Exception as e:
            print(f"  ERROR in {sheet}: {e}")

    output = {
        'position':   position_name,
        'imported_at': datetime.utcnow().isoformat(),
        'weights':    weights,
        'leagues':    sheets,
        'total':      len(all_players),
        'players':    all_players,
    }

    out_path = f"{position_name}_players.json"
    # Custom encoder to handle numpy types and booleans
    class SafeEncoder(json.JSONEncoder):
        def default(self, obj):
            import numpy as np
            if isinstance(obj, (np.integer,)): return int(obj)
            if isinstance(obj, (np.floating,)): return float(obj)
            if isinstance(obj, (np.bool_,)): return bool(obj)
            return super().default(obj)

    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2, cls=SafeEncoder)

    print(f"\n✓ Exported {len(all_players)} players to {out_path}")
    return out_path


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python import_excel.py <excel_file> <position_name>")
        print("Example: python import_excel.py WIN_PHY_ProScout25_04.xlsx WIN")
        sys.exit(1)

    import_file(sys.argv[1], sys.argv[2])
