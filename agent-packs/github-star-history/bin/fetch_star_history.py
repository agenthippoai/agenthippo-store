#!/usr/bin/env python3
"""Fetch GitHub repository star history and write a daily cumulative CSV."""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = "https://api.github.com"
MAX_STARGAZER_PAGES = 400
PER_PAGE = 100


def parse_repo(value: str) -> tuple[str, str]:
    value = value.strip().rstrip("/")
    m = re.match(
        r"(?:https?://)?(?:www\.)?github\.com/(?P<owner>[^/]+)/(?P<repo>[^/#?]+)",
        value,
    )
    if m:
        return m.group("owner"), m.group("repo").removesuffix(".git")
    if "/" in value:
        owner, repo = value.split("/", 1)
        return owner.strip(), repo.strip().removesuffix(".git")
    raise ValueError(f"Invalid repo identifier: {value!r}")


def github_request(url: str, token: str | None) -> dict | list:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "agenthippo-github-star-history",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API {e.code} for {url}: {detail}") from e


def _stargazer_headers(token: str | None) -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github.star+json",
        "User-Agent": "agenthippo-github-star-history",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _parse_last_page(link_header: str | None) -> int | None:
    if not link_header:
        return None
    m = re.search(r'page=(\d+)>; rel="last"', link_header)
    return int(m.group(1)) if m else None


def _fetch_stargazer_page(
    owner: str, repo: str, page: int, token: str | None
) -> tuple[list[dict], str | None]:
    qs = urllib.parse.urlencode({"per_page": PER_PAGE, "page": page})
    url = f"{API}/repos/{owner}/{repo}/stargazers?{qs}"
    req = urllib.request.Request(url, headers=_stargazer_headers(token))
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            chunk = json.loads(resp.read().decode("utf-8"))
            if resp.headers.get("X-RateLimit-Remaining") == "0":
                reset = int(resp.headers.get("X-RateLimit-Reset", "0"))
                wait = max(0, reset - int(time.time()) + 1)
                if wait:
                    print(f"Rate limited; sleeping {wait}s", file=sys.stderr)
                    time.sleep(wait)
            return chunk, resp.headers.get("Link")
    except urllib.error.HTTPError as e:
        if e.code == 403 and not token:
            raise RuntimeError("Set GITHUB_TOKEN or GH_TOKEN and retry.") from e
        raise RuntimeError(f"GitHub API {e.code} page {page}") from e


def fetch_stargazer_timestamps(
    owner: str,
    repo: str,
    token: str | None,
    max_pages: int,
    cutoff_date: str | None = None,
) -> list[str]:
    timestamps: list[str] = []
    cap = min(max_pages, MAX_STARGAZER_PAGES)

    if cutoff_date:
        # Stargazers are oldest-first; recent stars live on the last pages.
        first_chunk, link = _fetch_stargazer_page(owner, repo, 1, token)
        last_page = _parse_last_page(link) or 1
        start_page = max(1, last_page - cap + 1)
        for page in range(last_page, start_page - 1, -1):
            chunk = first_chunk if page == 1 else _fetch_stargazer_page(owner, repo, page, token)[0]
            if not chunk:
                break
            page_dates: list[str] = []
            for entry in chunk:
                if entry.get("starred_at"):
                    ts = entry["starred_at"]
                    if ts[:10] >= cutoff_date:
                        timestamps.append(ts)
                    page_dates.append(ts[:10])
            if page_dates and max(page_dates) < cutoff_date:
                break
        return timestamps

    for page in range(1, cap + 1):
        chunk, _ = _fetch_stargazer_page(owner, repo, page, token)
        if not chunk:
            break
        for entry in chunk:
            if entry.get("starred_at"):
                timestamps.append(entry["starred_at"])
        if len(chunk) < PER_PAGE:
            break
    return timestamps


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo")
    parser.add_argument("-o", "--output", default="star-history.csv")
    parser.add_argument(
        "--days",
        type=int,
        default=None,
        help="Only include stars from the last N calendar days (stops pagination early).",
    )
    parser.add_argument("--max-pages", type=int, default=MAX_STARGAZER_PAGES)
    args = parser.parse_args()

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    owner, repo = parse_repo(args.repo)

    meta = github_request(f"{API}/repos/{owner}/{repo}", token)
    if not isinstance(meta, dict):
        raise RuntimeError("Unexpected repo response")

    cutoff_date: str | None = None
    if args.days is not None:
        if args.days < 1:
            raise SystemExit("--days must be >= 1")
        cutoff_date = (
            datetime.now(timezone.utc).date() - timedelta(days=args.days - 1)
        ).isoformat()

    print(
        f"Stars: {meta.get('stargazers_count')} | Created: {meta.get('created_at')}"
        + (f" | Window: last {args.days} days" if args.days else ""),
        file=sys.stderr,
    )
    timestamps = fetch_stargazer_timestamps(
        owner, repo, token, args.max_pages, cutoff_date
    )
    if cutoff_date:
        timestamps = [ts for ts in timestamps if ts[:10] >= cutoff_date]
    print(f"Fetched {len(timestamps)} events", file=sys.stderr)

    by_date: dict[str, int] = defaultdict(int)
    for ts in timestamps:
        by_date[ts[:10]] += 1

    rows: list[tuple[str, int, int]] = []
    cumulative = 0
    for day in sorted(by_date):
        cumulative += by_date[day]
        rows.append((day, by_date[day], cumulative))

    total = meta.get("stargazers_count", 0)
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8") as f:
        f.write(f"# repo={owner}/{repo}\n")
        f.write(f"# total_stars={total}\n")
        f.write(f"# fetched_stargazer_events={len(timestamps)}\n")
        if args.days is not None:
            f.write(f"# days={args.days}\n")
            f.write(f"# date_range_start={cutoff_date}\n")
        complete = len(timestamps) >= total if args.days is None else "n/a"
        if isinstance(complete, bool):
            f.write(f"# complete_history={'yes' if complete else 'no'}\n")
        else:
            f.write("# complete_history=windowed\n")
        if len(timestamps) < total:
            f.write("# note=API max 40000 stargazer events; partial for large repos.\n")
        f.write(f"# generated_at={datetime.now(timezone.utc).isoformat()}\n")
        w = csv.writer(f)
        w.writerow(["date", "daily_stars", "cumulative_stars"])
        w.writerows(rows)

    print(f"Wrote {len(rows)} rows to {out.resolve()}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
