#!/usr/bin/env python3
"""
Export OpenClaw pc-agent learning data from Postgres for offline SFT or DPO-style JSONL.

Requires OPENCLAW_DATABASE_URL and tables ai_generation_log + learning_feedback (see docker/postgres/init/08-learning-feedback.sql).

Examples:
  python scripts/export-learning-dataset.py --format sft --out training.jsonl --since-days 30 --min-avg-score 0.25
  python scripts/export-learning-dataset.py --format dpo --out pairs.jsonl --since-days 60 --limit 5000
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("Install deps: pip install -r scripts/requirements-learning-export.txt", file=sys.stderr)
    sys.exit(1)


def connect():
    url = (os.environ.get("OPENCLAW_DATABASE_URL") or "").strip()
    if not url:
        print("OPENCLAW_DATABASE_URL is not set.", file=sys.stderr)
        sys.exit(1)
    return psycopg2.connect(url)


def fetch_scored_generations(cur, since: datetime | None, source: str | None, limit: int):
    sql = """
    SELECT g.id::text AS id, g.prompt_hash, g.prompt_text, g.response_text, g.source, g.created_at,
           (SELECT AVG(f.score)::float FROM learning_feedback f WHERE f.generation_id = g.id) AS avg_score,
           (SELECT COUNT(*)::int FROM learning_feedback f WHERE f.generation_id = g.id) AS n_feedback
    FROM ai_generation_log g
    WHERE EXISTS (SELECT 1 FROM learning_feedback f WHERE f.generation_id = g.id)
    """
    params: list[Any] = []
    if since is not None:
        sql += " AND g.created_at >= %s"
        params.append(since)
    if source:
        sql += " AND g.source = %s"
        params.append(source)
    sql += " ORDER BY g.created_at DESC LIMIT %s"
    params.append(limit)
    cur.execute(sql, params)
    return cur.fetchall()


def main() -> None:
    p = argparse.ArgumentParser(description="Export learning dataset JSONL from OpenClaw Postgres.")
    p.add_argument("--format", choices=("sft", "dpo"), default="sft")
    p.add_argument("--out", required=True, help="Output JSONL path")
    p.add_argument("--since-days", type=int, default=0, help="Only rows newer than N days (0 = all)")
    p.add_argument("--source", default="", help="Filter ai_generation_log.source (e.g. voice)")
    p.add_argument("--min-avg-score", type=float, default=-1.0, help="For sft: minimum average feedback score per row")
    p.add_argument("--limit", type=int, default=50_000, help="Max rows scanned from DB")
    args = p.parse_args()

    since = None
    if args.since_days > 0:
        since = datetime.now(timezone.utc) - timedelta(days=args.since_days)

    source = args.source.strip() or None
    conn = connect()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            rows = fetch_scored_generations(cur, since, source, args.limit)
    finally:
        conn.close()

    out_path = args.out
    n_out = 0

    if args.format == "sft":
        with open(out_path, "w", encoding="utf-8") as f:
            for row in rows:
                avg = float(row["avg_score"] or 0)
                if avg < args.min_avg_score:
                    continue
                rec = {
                    "messages": [
                        {"role": "user", "content": row["prompt_text"] or ""},
                        {"role": "assistant", "content": row["response_text"] or ""},
                    ],
                    "meta": {
                        "id": row["id"],
                        "avg_score": avg,
                        "n_feedback": row["n_feedback"],
                        "source": row["source"],
                    },
                }
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                n_out += 1
        print(f"Wrote {n_out} SFT lines to {out_path}", file=sys.stderr)
        return

    # DPO: pair lowest vs highest avg_score within same prompt_hash (requires at least two scored generations).
    by_hash: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        ph = row["prompt_hash"] or ""
        if not ph:
            continue
        by_hash[ph].append(dict(row))

    with open(out_path, "w", encoding="utf-8") as f:
        for ph, items in by_hash.items():
            if len(items) < 2:
                continue
            items.sort(key=lambda x: float(x.get("avg_score") or 0))
            low = items[0]
            high = items[-1]
            if float(high.get("avg_score") or 0) <= float(low.get("avg_score") or 0):
                continue
            prompt = (high.get("prompt_text") or "").strip()
            if not prompt:
                continue
            rec = {
                "prompt": prompt,
                "chosen": (high.get("response_text") or "").strip(),
                "rejected": (low.get("response_text") or "").strip(),
                "meta": {
                    "prompt_hash": ph,
                    "chosen_id": high.get("id"),
                    "rejected_id": low.get("id"),
                },
            }
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n_out += 1

    print(f"Wrote {n_out} DPO-style pair lines to {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
