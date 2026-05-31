#!/usr/bin/env python3
"""Collect GitHub star history for the last N days and write a strict 2-column CSV."""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Dict, Iterable, List, Optional, Tuple

GITHUB_API = "https://api.github.com"
GRAPHQL_URL = "https://api.github.com/graphql"
PER_PAGE = 100

GRAPHQL_QUERY_DESC = """
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    stargazerCount
    stargazers(first: 100, after: $cursor, orderBy: {field: STARRED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      edges { starredAt }
    }
  }
}
"""

CSV_COLUMNS = ("date", "new_stars")
AGENT_HOME_ENV = os.path.expanduser("~/.agent-hippo/.env")
TOKEN_ENV_KEYS = ("GITHUB_TOKEN", "GH_TOKEN")


def parse_env_file(path: str) -> Dict[str, str]:
    result: Dict[str, str] = {}
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                trimmed = line.strip()
                if not trimmed or trimmed.startswith("#"):
                    continue
                if "=" not in trimmed:
                    continue
                key, value = trimmed.split("=", 1)
                key = key.strip()
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                if key:
                    result[key] = value
    except OSError:
        return {}
    return result


def load_agent_home_env() -> None:
    """Load GITHUB_TOKEN/GH_TOKEN from ~/.agent-hippo/.env when not already set."""
    for key in TOKEN_ENV_KEYS:
        if os.environ.get(key, "").strip():
            return
    parsed = parse_env_file(AGENT_HOME_ENV)
    for key in TOKEN_ENV_KEYS:
        value = parsed.get(key, "").strip()
        if value:
            os.environ[key] = value
            return


def parse_repo(value: str) -> Tuple[str, str]:
    value = value.strip().rstrip("/")
    if not value:
        raise ValueError("Repository is required (owner/repo or GitHub URL).")
    if value.startswith("http://") or value.startswith("https://"):
        match = re.search(r"github\.com[:/]+([^/]+)/([^/#?]+)", value, re.I)
        if not match:
            raise ValueError(f"Could not parse GitHub URL: {value}")
        return match.group(1), match.group(2).removesuffix(".git")
    if "/" in value:
        owner, repo = value.split("/", 1)
        owner, repo = owner.strip(), repo.strip().removesuffix(".git")
        if owner and repo:
            return owner, repo
    raise ValueError(f"Expected owner/repo or GitHub URL, got: {value}")


def github_token() -> Optional[str]:
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    return token.strip() if token and token.strip() else None


def require_token() -> str:
    load_agent_home_env()
    token = github_token()
    if not token:
        print(
            "GITHUB_TOKEN or GH_TOKEN is required. "
            f"Add one to {AGENT_HOME_ENV} or export it before running.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return token


def _sleep_for_rate_limit(resp_headers: Dict[str, str]) -> None:
    remaining = resp_headers.get("x-ratelimit-remaining")
    if remaining != "0":
        return
    reset = int(resp_headers.get("x-ratelimit-reset", "0") or "0")
    wait = max(reset - int(time.time()), 1)
    print(f"Rate limit hit; sleeping {wait}s...", file=sys.stderr)
    time.sleep(wait)


def http_request(
    url: str,
    *,
    method: str = "GET",
    headers: Optional[Dict[str, str]] = None,
    data: Optional[bytes] = None,
    retries: int = 3,
) -> Tuple[bytes, Dict[str, str]]:
    last_error: Optional[Exception] = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=data, method=method)
        for key, val in (headers or {}).items():
            req.add_header(key, val)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read()
                resp_headers = {k.lower(): v for k, v in resp.headers.items()}
                return body, resp_headers
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", errors="replace")
            resp_headers = {k.lower(): v for k, v in err.headers.items()}
            if err.code in (403, 429) and "rate limit" in detail.lower():
                _sleep_for_rate_limit(resp_headers)
                last_error = RuntimeError(f"HTTP {err.code} for {url}: {detail}")
                continue
            raise RuntimeError(f"HTTP {err.code} for {url}: {detail}") from err
        except Exception as err:
            last_error = err
            if attempt < retries:
                time.sleep(2 ** attempt)
                continue
            raise
    if last_error:
        raise last_error
    raise RuntimeError(f"Request failed for {url}")


def fetch_repo_meta(owner: str, repo: str, token: str) -> Dict[str, object]:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "agenthippo-github-star"}
    headers["Authorization"] = f"Bearer {token}"
    body, _ = http_request(f"{GITHUB_API}/repos/{owner}/{repo}", headers=headers)
    return json.loads(body.decode("utf-8"))


def iter_recent_stars_graphql(
    owner: str,
    repo: str,
    token: str,
    cutoff_day: date,
    max_pages: Optional[int],
) -> Iterable[str]:
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "User-Agent": "agenthippo-github-star",
    }
    cursor: Optional[str] = None
    page = 0
    cutoff_iso = cutoff_day.isoformat()
    while True:
        page += 1
        if max_pages is not None and page > max_pages:
            break
        payload = {
            "query": GRAPHQL_QUERY_DESC,
            "variables": {"owner": owner, "name": repo, "cursor": cursor},
        }
        body, resp_headers = http_request(
            GRAPHQL_URL,
            method="POST",
            headers=headers,
            data=json.dumps(payload).encode("utf-8"),
        )
        data = json.loads(body.decode("utf-8"))
        if data.get("errors"):
            raise RuntimeError(f"GraphQL errors: {data['errors']}")
        stargazers = data["data"]["repository"]["stargazers"]
        stop = False
        for edge in stargazers["edges"]:
            starred_at = edge["starredAt"]
            day = starred_at[:10]
            if day < cutoff_iso:
                stop = True
                break
            yield day
        if stop:
            break
        page_info = stargazers["pageInfo"]
        if not page_info["hasNextPage"]:
            break
        cursor = page_info["endCursor"]
        _sleep_for_rate_limit(resp_headers)


def window_days(days: int, *, today: Optional[date] = None) -> Tuple[date, date]:
    if days < 1:
        raise ValueError("--days must be at least 1")
    end = today or datetime.now(timezone.utc).date()
    start = end - timedelta(days=days - 1)
    return start, end


def aggregate_window(star_days: Iterable[str], start: date, end: date) -> List[Tuple[str, int]]:
    per_day: Dict[str, int] = defaultdict(int)
    for day in star_days:
        per_day[day] += 1
    rows: List[Tuple[str, int]] = []
    current = start
    while current <= end:
        key = current.isoformat()
        rows.append((key, per_day.get(key, 0)))
        current += timedelta(days=1)
    return rows


def output_filename(owner: str, repo: str) -> str:
    safe_owner = re.sub(r"[^A-Za-z0-9._-]+", "-", owner)
    safe_repo = re.sub(r"[^A-Za-z0-9._-]+", "-", repo)
    return f"agenthippo-{safe_owner}-{safe_repo}-star-history.csv"


def write_csv(path: str, rows: List[Tuple[str, int]]) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(CSV_COLUMNS)
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export GitHub star history (last N days) to a 2-column CSV",
    )
    parser.add_argument(
        "repo",
        help="Required: owner/repo or https://github.com/owner/repo",
    )
    parser.add_argument(
        "--output-dir",
        default="data/github-star",
        help="Directory for CSV output (default: data/github-star)",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=30,
        help="Rolling window length in days (default: 30)",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=None,
        help="Limit GraphQL pages (100 stars each); smoke tests only",
    )
    args = parser.parse_args()
    load_agent_home_env()

    owner, repo = parse_repo(args.repo)
    token = require_token()
    start, end = window_days(args.days)

    meta = fetch_repo_meta(owner, repo, token)
    total_stars = int(meta.get("stargazers_count") or 0)

    print(
        f"Collecting stars for {owner}/{repo} "
        f"({start.isoformat()} .. {end.isoformat()}, GraphQL DESC)...",
        file=sys.stderr,
    )
    star_days = list(
        iter_recent_stars_graphql(owner, repo, token, start, args.max_pages),
    )
    rows = aggregate_window(star_days, start, end)

    out_path = os.path.join(args.output_dir, output_filename(owner, repo))
    write_csv(out_path, rows)

    new_in_window = sum(count for _, count in rows)
    print(out_path)
    print(
        f"Wrote {len(rows)} rows ({CSV_COLUMNS[0]},{CSV_COLUMNS[1]}); "
        f"{new_in_window} new stars in window; repo total {total_stars}",
        file=sys.stderr,
    )
    if args.max_pages is not None:
        print(
            f"Note: partial fetch (--max-pages {args.max_pages}); "
            "omit for production runs.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
