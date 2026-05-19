#!/usr/bin/env python3
# Copyright (c) AgentHippo.ai. All rights reserved.
"""
Generate default analytics dashboard charts from OTEL trace data.

Usage:
  uv run --with matplotlib python3 generate-default-charts.py <traces_dir> <output_dir>
  uv run --with matplotlib python3 generate-default-charts.py

Reads DuckDB JSON output from stdin (piped from query script) or queries directly.
Outputs PNG charts to <output_dir>/charts/.

Exit codes:
  0  = charts generated
  1  = error
  2  = no data available
"""

import json
import os
import sys
from pathlib import Path
from datetime import datetime

try:
    import duckdb as _duckdb_module
    DUCKDB_AVAILABLE = True
except ImportError:
    DUCKDB_AVAILABLE = False

# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────

CHART_WIDTH = 8
CHART_HEIGHT = 4.5
DPI = 150

# VS Code-friendly dark theme colors
BG_COLOR = '#1e1e1e'
FG_COLOR = '#cccccc'
GRID_COLOR = '#333333'
ACCENT_COLORS = ['#569cd6', '#4ec9b0', '#ce9178', '#dcdcaa', '#c586c0', '#9cdcfe', '#d4d4d4']

def parse_disabled_charts():
    """Read disabled chart filenames from AGENTIDE_DISABLED_CHARTS."""
    raw = (os.environ.get('AGENTIDE_DISABLED_CHARTS') or '').strip()
    if not raw:
        return set()

    disabled = set()
    if raw.startswith('['):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                for item in parsed:
                    if isinstance(item, str) and item.strip():
                        disabled.add(Path(item.strip()).name.lower())
                return disabled
        except Exception:
            pass

    for part in raw.split(','):
        name = part.strip()
        if name:
            disabled.add(Path(name).name.lower())
    return disabled

def is_chart_disabled(disabled_set, filename):
    return Path(filename).name.lower() in disabled_set

def remove_chart_if_exists(output_dir, filename):
    target = Path(output_dir) / filename
    try:
        target.unlink()
    except FileNotFoundError:
        pass
    except Exception:
        pass

def format_session_handle(session_id):
    """Generate a short, stable session handle from full session id."""
    value = (session_id or '').strip()
    if not value:
        return 'S-UNKNOWN'
    first_segment = value.split('-', 1)[0] if '-' in value else value
    return f'S-{first_segment[:8]}'

def setup_matplotlib():
    """Configure matplotlib for headless dark-theme charts."""
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    plt.rcParams.update({
        'figure.figsize': (CHART_WIDTH, CHART_HEIGHT),
        'figure.dpi': DPI,
        'figure.facecolor': BG_COLOR,
        'axes.facecolor': BG_COLOR,
        'axes.edgecolor': GRID_COLOR,
        'axes.labelcolor': FG_COLOR,
        'axes.titlesize': 13,
        'axes.titleweight': 'bold',
        'axes.titlepad': 14,
        'axes.grid': True,
        'grid.color': GRID_COLOR,
        'grid.linewidth': 0.5,
        'text.color': FG_COLOR,
        'xtick.color': FG_COLOR,
        'ytick.color': FG_COLOR,
        'font.size': 10,
        'font.family': 'sans-serif',
        'legend.facecolor': BG_COLOR,
        'legend.edgecolor': GRID_COLOR,
        'legend.fontsize': 9,
        'savefig.facecolor': BG_COLOR,
        'savefig.edgecolor': BG_COLOR,
    })
    return plt

# ─────────────────────────────────────────────────────────────────────────────
# DuckDB Queries
# ─────────────────────────────────────────────────────────────────────────────

def run_query_conn(conn, sql):
    """Run a SQL query on an open DuckDB connection; return list of dicts."""
    try:
        rel = conn.execute(sql)
        cols = [d[0] for d in rel.description]
        return [dict(zip(cols, row)) for row in rel.fetchall()]
    except Exception as exc:
        sys.stderr.write(f'[Dashboard] Query failed: {exc}\n')
        return []


def open_duckdb_connection(traces_dir, use_indexed_db, index_db_path, trace_filter_clause):
    """
    Open one DuckDB connection and materialise a `filtered_traces` temp table.

    • indexed DB path  → read-only connection to .duckdb file; uses pre-built spans table
    • JSONL fallback   → in-memory DB; parses JSONL *once* into a temp table

    Always sets conservative memory / thread limits so multiple refreshes
    can never compete for all available RAM.
    Returns (conn, error_message).  On failure conn is None.
    """
    if not DUCKDB_AVAILABLE:
        return None, (
            'duckdb Python module not found. '
            'Add "duckdb" to your analytics requirements.txt or run: pip install duckdb'
        )

    memory_limit_mb = max(64, int(os.environ.get('AGENTIDE_DUCKDB_MEMORY_LIMIT_MB', '256') or '256'))
    threads = max(1, int(os.environ.get('AGENTIDE_DUCKDB_THREADS', '2') or '2'))
    temp_directory_env = (os.environ.get('AGENTIDE_DUCKDB_TEMP_DIRECTORY') or '').strip()

    conn = None
    try:
        if use_indexed_db and index_db_path and os.path.exists(index_db_path):
            # ── Indexed DB path: read-only, low memory needed (pre-built spans table) ──
            indexed_config = {
                'threads': threads,
                'memory_limit': f'{memory_limit_mb}MB',
            }
            if temp_directory_env:
                indexed_config['temp_directory'] = temp_directory_env
            conn = _duckdb_module.connect(
                index_db_path, read_only=True,
                config=indexed_config,
            )
            # spans table already normalised; just apply optional scope filters
            conn.execute(
                f"CREATE TEMP VIEW filtered_traces AS "
                f"SELECT * FROM spans {trace_filter_clause}"
            )
            sys.stderr.write(f'[Dashboard] Using indexed DuckDB: {index_db_path}\n')
        else:
            # ── JSONL fallback: in-memory DB with streaming reads ──────────
            # Use a VIEW so DuckDB streams JSONL per query instead of
            # materialising all 228 MB into the buffer pool at once.
            # Spill-to-disk ensures complex unnesting never hard-OOMs.
            import tempfile, os as _os
            _spill_dir = temp_directory_env or _os.path.join(tempfile.gettempdir(), 'duckdb_spotlight_spill')
            _os.makedirs(_spill_dir, exist_ok=True)
            conn = _duckdb_module.connect(
                ':memory:',
                config={
                    'threads': threads,
                    'memory_limit': f'{memory_limit_mb}MB',
                    'temp_directory': _spill_dir,
                    'preserve_insertion_order': False,
                },
            )
            conn.execute(
                f"CREATE TEMP VIEW filtered_traces AS "
                f"{base_query(traces_dir)}, "
                f"filtered AS (SELECT * FROM traces {trace_filter_clause}) "
                f"SELECT * FROM filtered"
            )
            sys.stderr.write(f'[Dashboard] Using JSONL streaming from {traces_dir}\n')

        return conn, None
    except Exception as exc:
        if conn:
            try:
                conn.close()
            except Exception:
                pass
        return None, f'DuckDB connection failed: {exc}'

def base_query(traces_dir):
    """Return the base CTE for OTEL trace parsing."""
    return f"""
WITH raw_spans AS (
    SELECT unnest(resourceSpans) as rs
    FROM read_json('{traces_dir}/*.jsonl', format='newline_delimited', ignore_errors=true)
),
spans AS (SELECT unnest(rs.scopeSpans) as ss FROM raw_spans),
flat_spans AS (SELECT unnest(ss.spans) as span FROM spans),
parsed AS (
    SELECT
        span.traceId as trace_id,
        span.name as span_name,
        span.startTimeUnixNano::BIGINT / 1000000 as start_ms,
        (span.endTimeUnixNano::BIGINT - span.startTimeUnixNano::BIGINT) / 1000000 as duration_ms,
        json_extract(to_json(span), '$.attributes') as attrs_json
    FROM flat_spans
),
attrs AS (
    SELECT trace_id, span_name, duration_ms, start_ms,
        json_extract_string(value, '$.key') as attr_key,
        json_extract_string(value, '$.value.stringValue') as attr_string,
        json_extract_string(value, '$.value.intValue') as attr_int,
        json_extract(value, '$.value.doubleValue') as attr_double
    FROM parsed, json_each(coalesce(attrs_json, '[]'::JSON))
    WHERE span_name = 'Received Proxy Server Request'
       OR EXISTS (SELECT 1 FROM json_each(coalesce(attrs_json, '[]'::JSON)) as attr
                  WHERE json_extract_string(attr.value, '$.key') = 'gen_ai.cost.total_cost')
),
traces AS (
    SELECT
        trace_id, span_name, duration_ms, start_ms,
        max(CASE WHEN attr_key IN ('gen_ai.request.model','gen_ai.response.model','model') THEN attr_string END) as model,
        max(CASE WHEN attr_key = 'gen_ai.cost.total_cost' THEN CAST(attr_double AS DOUBLE) END) as cost,
        max(CASE WHEN attr_key = 'gen_ai.usage.input_tokens' THEN CAST(attr_int AS BIGINT) END) as input_tokens,
        max(CASE WHEN attr_key = 'gen_ai.usage.output_tokens' THEN CAST(attr_int AS BIGINT) END) as output_tokens,
        NULLIF(regexp_extract(max(CASE WHEN attr_key = 'metadata.requester_custom_headers' THEN attr_string END), 'x-litellm-metadata-session-id'': ''([^'']+)''', 1), '') as session_id,
        NULLIF(regexp_extract(max(CASE WHEN attr_key = 'metadata.requester_custom_headers' THEN attr_string END), 'x-litellm-metadata-user-id'': ''([^'']+)''', 1), '') as user_id,
        NULLIF(regexp_extract(max(CASE WHEN attr_key = 'metadata.requester_custom_headers' THEN attr_string END), 'x-litellm-metadata-project-id'': ''([^'']+)''', 1), '') as project_id,
        NULLIF(regexp_extract(max(CASE WHEN attr_key = 'metadata.requester_custom_headers' THEN attr_string END), 'x-litellm-metadata-agent-id'': ''([^'']+)''', 1), '') as agent_id
    FROM attrs
    GROUP BY trace_id, span_name, duration_ms, start_ms
)"""

def sql_literal(value):
    return "'" + value.replace("'", "''") + "'"

def build_trace_filter_clause(scope, project_id, agent_id):
    conditions = []
    if scope == 'workspace':
        if project_id:
            conditions.append(f"project_id = {sql_literal(project_id)}")
        else:
            conditions.append('1 = 0')
    if agent_id:
        conditions.append(f"agent_id = {sql_literal(agent_id)}")
    if not conditions:
        return ''
    return 'WHERE ' + ' AND '.join(conditions)

def run_query(duckdb_path, traces_dir, sql_after_cte, trace_filter_clause=''):
    """Run a DuckDB query and return JSON results."""
    full_sql = f"""{base_query(traces_dir)},
filtered_traces AS (
    SELECT * FROM traces {trace_filter_clause}
)
{sql_after_cte}"""
    try:
        result = subprocess.run(
            [duckdb_path, '-json', '-c', full_sql],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            return []
        output = result.stdout.strip()
        if not output:
            return []
        return json.loads(output)
    except Exception:
        return []

# ─────────────────────────────────────────────────────────────────────────────
# Chart Generators
# ─────────────────────────────────────────────────────────────────────────────

def chart_daily_costs(plt, data, output_dir):
    """Line chart: daily cost trend with area fill."""
    if not data:
        return None
    fig, ax = plt.subplots()
    dates = [r['date'] for r in data]
    costs = [float(r['cost'] or 0) for r in data]
    display_dates = [d[5:] for d in dates]  # MM-DD

    ax.fill_between(range(len(dates)), costs, alpha=0.3, color=ACCENT_COLORS[0])
    ax.plot(range(len(dates)), costs, '-o', color=ACCENT_COLORS[0], linewidth=2, markersize=5)
    ax.set_xticks(range(len(dates)))
    ax.set_xticklabels(display_dates, rotation=45, ha='right')
    ax.set_ylabel('Cost ($)')
    ax.set_title('Daily Cost Trend')
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'${x:.3f}'))

    # Annotate total
    total = sum(costs)
    ax.annotate(f'Total: ${total:.4f}', xy=(0.98, 0.95), xycoords='axes fraction',
                ha='right', va='top', fontsize=10, color=ACCENT_COLORS[1],
                bbox=dict(boxstyle='round,pad=0.3', facecolor=BG_COLOR, edgecolor=GRID_COLOR))

    plt.tight_layout()
    path = os.path.join(output_dir, 'daily-cost-trend.png')
    plt.savefig(path, bbox_inches='tight')
    plt.close()
    return path

def chart_model_breakdown(plt, data, output_dir):
    """Donut chart: cost by model."""
    if not data:
        return None
    fig, ax = plt.subplots()
    models = [r['model'] or 'unknown' for r in data]
    costs = [float(r['cost'] or 0) for r in data]
    requests = [int(r['requests'] or 0) for r in data]

    # Shorten model names for display
    short_names = []
    for m in models:
        name = m.replace('claude-', '').replace('gpt-', '').replace('-20250', '')
        if len(name) > 20:
            name = name[:18] + '..'
        short_names.append(name)

    colors = ACCENT_COLORS[:len(models)]
    wedges, texts, autotexts = ax.pie(
        costs, labels=short_names, colors=colors, autopct='%1.0f%%',
        pctdistance=0.8, startangle=90,
        wedgeprops=dict(width=0.5, edgecolor=BG_COLOR, linewidth=2)
    )
    for t in texts:
        t.set_color(FG_COLOR)
        t.set_fontsize(9)
    for t in autotexts:
        t.set_color(FG_COLOR)
        t.set_fontsize(8)

    # Center label
    total = sum(costs)
    ax.text(0, 0, f'${total:.3f}\ntotal', ha='center', va='center',
            fontsize=12, fontweight='bold', color=FG_COLOR)
    ax.set_title('Cost by Model')

    plt.tight_layout()
    path = os.path.join(output_dir, 'cost-by-model.png')
    plt.savefig(path, bbox_inches='tight')
    plt.close()
    return path

def chart_top_sessions(plt, data, output_dir):
    """Horizontal bar chart: top sessions by cost."""
    if not data:
        return None
    fig, ax = plt.subplots()
    # Take top 8
    data = data[:8]
    session_ids = [format_session_handle(r.get('session_id')) for r in data]
    costs = [float(r['cost'] or 0) for r in data]
    requests = [int(r['requests'] or 0) for r in data]

    session_ids.reverse()
    costs.reverse()
    requests.reverse()

    bars = ax.barh(range(len(session_ids)), costs, color=ACCENT_COLORS[2], height=0.6)
    ax.set_yticks(range(len(session_ids)))
    ax.set_yticklabels(session_ids, fontsize=8)
    ax.set_xlabel('Cost ($)')
    ax.set_title('Top Sessions by Cost')
    ax.xaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'${x:.4f}'))

    # Add request count labels
    for i, (bar, req) in enumerate(zip(bars, requests)):
        ax.text(bar.get_width() + max(costs) * 0.02, bar.get_y() + bar.get_height()/2,
                f'{req} req', va='center', fontsize=8, color=FG_COLOR)

    plt.tight_layout()
    path = os.path.join(output_dir, 'top-sessions.png')
    plt.savefig(path, bbox_inches='tight')
    plt.close()
    return path

def chart_token_efficiency(plt, data, output_dir):
    """Stacked bar: input vs output tokens by model (shows context bloat)."""
    if not data:
        return None
    fig, ax = plt.subplots()
    models = [r['model'] or 'unknown' for r in data]
    input_t = [int(r['input_tokens'] or 0) for r in data]
    output_t = [int(r['output_tokens'] or 0) for r in data]

    short_names = []
    for m in models:
        name = m.replace('claude-', '').replace('gpt-', '').replace('-20250', '')
        if len(name) > 16:
            name = name[:14] + '..'
        short_names.append(name)

    x = range(len(short_names))
    ax.bar(x, input_t, label='Input', color=ACCENT_COLORS[0], width=0.6)
    ax.bar(x, output_t, bottom=input_t, label='Output', color=ACCENT_COLORS[1], width=0.6)
    ax.set_xticks(x)
    ax.set_xticklabels(short_names, rotation=45, ha='right', fontsize=8)
    ax.set_ylabel('Tokens')
    ax.set_title('Token Usage by Model')
    ax.legend(loc='upper right')
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'{x/1000:.0f}K' if x >= 1000 else f'{x:.0f}'))

    # Show ratio annotation
    for i in range(len(models)):
        total = input_t[i] + output_t[i]
        if total > 0:
            ratio = input_t[i] / max(output_t[i], 1)
            ax.text(i, total + max(input_t[j] + output_t[j] for j in range(len(models))) * 0.02,
                    f'{ratio:.1f}x', ha='center', fontsize=7, color=ACCENT_COLORS[3])

    plt.tight_layout()
    path = os.path.join(output_dir, 'token-efficiency.png')
    plt.savefig(path, bbox_inches='tight')
    plt.close()
    return path

def chart_latency_distribution(plt, data, output_dir):
    """Bar chart: latency percentiles by model."""
    if not data:
        return None
    fig, ax = plt.subplots()
    models = [r['model'] or 'unknown' for r in data]
    p50 = [float(r['p50'] or 0) for r in data]
    p95 = [float(r['p95'] or 0) for r in data]
    p99 = [float(r['p99'] or 0) for r in data]

    short_names = []
    for m in models:
        name = m.replace('claude-', '').replace('gpt-', '').replace('-20250', '')
        if len(name) > 16:
            name = name[:14] + '..'
        short_names.append(name)

    x = range(len(short_names))
    width = 0.25
    ax.bar([i - width for i in x], p50, width, label='p50', color=ACCENT_COLORS[0])
    ax.bar(x, p95, width, label='p95', color=ACCENT_COLORS[2])
    ax.bar([i + width for i in x], p99, width, label='p99', color=ACCENT_COLORS[4])

    ax.set_xticks(x)
    ax.set_xticklabels(short_names, rotation=45, ha='right', fontsize=8)
    ax.set_ylabel('Latency (ms)')
    ax.set_title('Response Latency by Model')
    ax.legend(loc='upper right')
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'{x/1000:.1f}s' if x >= 1000 else f'{x:.0f}ms'))

    plt.tight_layout()
    path = os.path.join(output_dir, 'latency-distribution.png')
    plt.savefig(path, bbox_inches='tight')
    plt.close()
    return path

def chart_hourly_activity(plt, data, output_dir):
    """Bar chart: request count by hour of day."""
    if not data:
        return None
    fig, ax = plt.subplots()
    hours = [int(r['hour']) for r in data]
    counts = [int(r['count'] or 0) for r in data]
    costs = [float(r['cost'] or 0) for r in data]

    # Fill missing hours
    hour_counts = [0] * 24
    hour_costs = [0.0] * 24
    for h, c, co in zip(hours, counts, costs):
        if 0 <= h < 24:
            hour_counts[h] = c
            hour_costs[h] = co

    colors = [ACCENT_COLORS[0] if c > 0 else GRID_COLOR for c in hour_counts]
    bars = ax.bar(range(24), hour_counts, color=colors, width=0.8)
    ax.set_xlabel('Hour of Day')
    ax.set_ylabel('Requests')
    ax.set_title('Activity by Hour')
    ax.set_xticks(range(0, 24, 3))
    ax.set_xticklabels([f'{h:02d}:00' for h in range(0, 24, 3)], fontsize=8)

    # Highlight peak hour
    if max(hour_counts) > 0:
        peak = hour_counts.index(max(hour_counts))
        bars[peak].set_color(ACCENT_COLORS[3])
        ax.annotate(f'Peak: {peak:02d}:00', xy=(peak, hour_counts[peak]),
                    xytext=(peak + 2, hour_counts[peak] * 0.9),
                    arrowprops=dict(arrowstyle='->', color=ACCENT_COLORS[3], lw=1.5),
                    fontsize=9, color=ACCENT_COLORS[3])

    plt.tight_layout()
    path = os.path.join(output_dir, 'hourly-activity.png')
    plt.savefig(path, bbox_inches='tight')
    plt.close()
    return path

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    traces_dir = ''
    output_dir = ''
    if len(sys.argv) >= 3:
        traces_dir = sys.argv[1]
        output_dir = sys.argv[2]
    else:
        traces_dir = os.environ.get('AGENTIDE_TRACES_DIR', '').strip()
        output_dir = os.environ.get('AGENTIDE_OUTPUT_DIR', '').strip()

    if not traces_dir or not output_dir:
        print(
            f"Usage: {sys.argv[0]} <traces_dir> <output_dir> "
            "(or set AGENTIDE_TRACES_DIR + AGENTIDE_OUTPUT_DIR)",
            file=sys.stderr,
        )
        sys.exit(1)
    scope = os.environ.get('AGENTIDE_ANALYTICS_SCOPE', 'global').strip().lower()
    if scope not in ('global', 'workspace'):
        scope = 'global'
    project_id = os.environ.get('AGENTIDE_ANALYTICS_PROJECT_ID', '').strip()
    agent_id = os.environ.get('AGENTIDE_ANALYTICS_AGENT_ID', '').strip()
    trace_filter_clause = build_trace_filter_clause(scope, project_id, agent_id)

    # Verify traces exist
    traces_path = Path(traces_dir)
    if not traces_path.exists() or not list(traces_path.glob('*.jsonl')):
        print(json.dumps({"status": "no_data", "charts": []}))
        sys.exit(2)

    # ── DuckDB: prefer indexed DB when available, fall back to JSONL ──────────
    configured_index_db_path = os.environ.get('AGENTIDE_INDEX_DB_PATH', '').strip()
    fallback_index_db_path = str((traces_path / 'analytics.duckdb').resolve())
    index_db_path = configured_index_db_path or fallback_index_db_path
    use_duckdb_env = os.environ.get('AGENTIDE_USE_DUCKDB', '').strip().lower() == 'true'
    # Auto-enable indexed mode when the DB exists; AGENTIDE_USE_DUCKDB can still force true.
    use_indexed_db = bool(index_db_path) and os.path.exists(index_db_path)
    # If AGENTIDE_USE_DUCKDB=true is provided, it is honored; otherwise indexed mode is auto-on when DB exists.
    if use_duckdb_env and not use_indexed_db:
        sys.stderr.write('[Dashboard] AGENTIDE_USE_DUCKDB=true but indexed DB path was not found\n')

    if use_indexed_db:
        sys.stderr.write(f'[Dashboard] Indexed mode enabled: {index_db_path}\n')
    else:
        sys.stderr.write('[Dashboard] Indexed DB unavailable; falling back to JSONL mode\n')

    # Default charts output location when not supplied by caller.
    chart_dir_override = os.environ.get('AGENTIDE_CHART_DIR', '').strip()

    conn, conn_error = open_duckdb_connection(
        traces_dir, use_indexed_db, index_db_path, trace_filter_clause
    )
    if conn is None:
        print(json.dumps({"status": "error", "error": conn_error}))
        sys.exit(1)

    # Ensure output dir
    charts_dir = chart_dir_override or os.path.join(output_dir, 'charts')
    os.makedirs(charts_dir, exist_ok=True)
    disabled_charts = parse_disabled_charts()

    plt = setup_matplotlib()
    generated = []

    try:
        # All 5 queries run through the same connection — zero extra processes spawned.

        # 1. Daily cost trend (past 14 days)
        daily_data = run_query_conn(conn, """
            SELECT strftime(to_timestamp(start_ms / 1000), '%Y-%m-%d') as date,
                   SUM(cost) as cost, COUNT(*) as requests
            FROM filtered_traces WHERE cost IS NOT NULL
              AND start_ms > (EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - INTERVAL '14 days')) * 1000)
            GROUP BY date ORDER BY date ASC
        """)
        if is_chart_disabled(disabled_charts, 'daily-cost-trend.png'):
            remove_chart_if_exists(charts_dir, 'daily-cost-trend.png')
        else:
            path = chart_daily_costs(plt, daily_data, charts_dir)
            if path:
                generated.append({"file": path, "title": "Daily Cost Trend", "type": "chart"})

        # 2. Cost by model (donut)
        model_data = run_query_conn(conn, """
            SELECT COALESCE(model, 'unknown') as model, SUM(cost) as cost, COUNT(*) as requests,
                   SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens
            FROM filtered_traces WHERE cost IS NOT NULL
            GROUP BY model ORDER BY cost DESC
        """)
        if is_chart_disabled(disabled_charts, 'cost-by-model.png'):
            remove_chart_if_exists(charts_dir, 'cost-by-model.png')
        else:
            path = chart_model_breakdown(plt, model_data, charts_dir)
            if path:
                generated.append({"file": path, "title": "Cost by Model", "type": "chart"})

        # 3. Top sessions by cost
        session_data = run_query_conn(conn, """
            SELECT COALESCE(session_id, '(none)') as session_id, SUM(cost) as cost, COUNT(*) as requests
            FROM filtered_traces WHERE cost IS NOT NULL AND session_id IS NOT NULL
            GROUP BY session_id ORDER BY cost DESC LIMIT 10
        """)
        top_sessions_disabled = is_chart_disabled(disabled_charts, 'top-sessions.png')
        if top_sessions_disabled:
            remove_chart_if_exists(charts_dir, 'top-sessions.png')
        else:
            path = chart_top_sessions(plt, session_data, charts_dir)
            if path:
                generated.append({"file": path, "title": "Top Sessions by Cost", "type": "chart"})

        # 4. Token efficiency by model (input vs output stacked) — reuses model_data
        if is_chart_disabled(disabled_charts, 'token-efficiency.png'):
            remove_chart_if_exists(charts_dir, 'token-efficiency.png')
        else:
            path = chart_token_efficiency(plt, model_data, charts_dir)
            if path:
                generated.append({"file": path, "title": "Token Usage by Model", "type": "chart"})

        # 5. Latency distribution by model (p50/p95/p99)
        latency_data = run_query_conn(conn, """
            SELECT COALESCE(model, 'unknown') as model,
                   PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms) as p50,
                   PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95,
                   PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) as p99
            FROM filtered_traces WHERE cost IS NOT NULL
            GROUP BY model ORDER BY p50 DESC
        """)
        if is_chart_disabled(disabled_charts, 'latency-distribution.png'):
            remove_chart_if_exists(charts_dir, 'latency-distribution.png')
        else:
            path = chart_latency_distribution(plt, latency_data, charts_dir)
            if path:
                generated.append({"file": path, "title": "Latency Distribution", "type": "chart"})

        # 6. Hourly activity heatmap
        hourly_data = run_query_conn(conn, """
            SELECT EXTRACT(HOUR FROM to_timestamp(start_ms / 1000)) as hour,
                   COUNT(*) as count, SUM(cost) as cost
            FROM filtered_traces WHERE cost IS NOT NULL
            GROUP BY hour ORDER BY hour
        """)
        if is_chart_disabled(disabled_charts, 'hourly-activity.png'):
            remove_chart_if_exists(charts_dir, 'hourly-activity.png')
        else:
            path = chart_hourly_activity(plt, hourly_data, charts_dir)
            if path:
                generated.append({"file": path, "title": "Activity by Hour", "type": "chart"})

    finally:
        conn.close()

    if not generated:
        print(json.dumps({"status": "no_data", "charts": []}))
        sys.exit(2)

    # Output manifest
    result = {
        "status": "ok",
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "charts": generated
    }
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
