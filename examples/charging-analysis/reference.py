"""Independent standard-library reference, never used as an Agent tool."""
import csv
import json
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

REQUIRED = {"alert_id", "device_id", "occurred_at", "severity", "review_state"}
BANDS = ["00-05", "06-11", "12-17", "18-23"]


def analyze(path: Path) -> dict:
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not REQUIRED.issubset(reader.fieldnames or []):
            return {"error": "MISSING_COLUMN"}
        rows = list(reader)
    reviews = Counter()
    totals, confirmed = Counter(), Counter()
    bands = dict.fromkeys(BANDS, 0)
    severity = dict.fromkeys(["high", "medium", "low", "unknown"], 0)
    ids = set()
    for row in rows:
        if not row["alert_id"] or not row["device_id"] or row["alert_id"] in ids:
            return {"error": "INVALID_ID"}
        ids.add(row["alert_id"])
        try:
            stamp = datetime.fromisoformat(row["occurred_at"])
            if stamp.tzinfo is None:
                raise ValueError("timezone required")
            stamp = stamp.astimezone(timezone(timedelta(hours=8)))
        except (ValueError, TypeError):
            return {"error": "INVALID_TIMESTAMP"}
        review = row["review_state"] or "pending"
        level = row["severity"] or "unknown"
        if review not in {"confirmed", "rejected", "pending"} or level not in severity:
            return {"error": "INVALID_ENUM"}
        reviews[review] += 1
        totals[row["device_id"]] += 1
        confirmed[row["device_id"]] += int(review == "confirmed")
        bands[BANDS[stamp.hour // 6]] += 1
        severity[level] += 1
    reviewed = reviews["confirmed"] + reviews["rejected"]
    return {
        "total_alerts": len(rows),
        "confirmed": reviews["confirmed"],
        "rejected": reviews["rejected"],
        "pending": reviews["pending"],
        "false_positive_rate": round(reviews["rejected"] / reviewed, 6) if reviewed else None,
        "devices": [{"device_id": d, "total": totals[d], "confirmed": confirmed[d]}
                    for d in sorted(totals, key=lambda d: (-totals[d], d))],
        "time_bands": bands,
        "severity": severity,
    }


if __name__ == "__main__":
    print(json.dumps(analyze(Path(sys.argv[1])), ensure_ascii=False, indent=2))
