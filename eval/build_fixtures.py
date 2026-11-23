"""Build synthetic evaluation candidates. Does not call a model or execute submitted code."""
import csv
import hashlib
import importlib.util
import io
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT.parent / "examples" / "charging-analysis"
spec = importlib.util.spec_from_file_location("charging_reference", SOURCE / "reference.py")
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)
HEADER = ["alert_id", "device_id", "occurred_at", "severity", "review_state"]


def row(identifier, device="D01", timestamp="2026-11-01T06:00:00+08:00", severity="high", review="confirmed"):
    return [identifier, device, timestamp, severity, review]


CASES = [
    ("e01", "All reviewed alerts confirmed", [row("E01A"), row("E01B", "D02")]),
    ("e02", "Pending-only denominator is null", [row("E02A", review="pending"), row("E02B", review="pending")]),
    ("e03", "All reviewed alerts rejected", [row("E03A", review="rejected"), row("E03B", "D02", review="rejected")]),
    ("e04", "Ranking tie resolved by device identifier", [row("E04A", "D20"), row("E04B", "D02", review="pending")]),
    ("e05", "UTC timestamps cross the local date", [row("E05A", timestamp="2026-10-31T20:00:00Z"), row("E05B", timestamp="2026-11-01T10:00:00Z")]),
    ("e06", "Six-hour time-band boundaries", [row(f"E06{i}", timestamp=f"2026-11-01T{hour}:00+08:00") for i, hour in enumerate(["05:59", "06:00", "11:59", "12:00", "17:59", "18:00"])]),
    ("e07", "Missing optional values use explicit defaults", [row("E07A", severity="", review=""), row("E07B", "D02", severity="low", review="rejected")]),
    ("e08", "Required column missing", [row("E08A")[:-1]]),
    ("e09", "Malformed timestamp rejected", [row("E09A", timestamp="not-a-date")]),
    ("e10", "Naive timestamp rejected", [row("E10A", timestamp="2026-11-01T06:00:00")]),
    ("e11", "Duplicate alert identifier rejected", [row("E11A"), row("E11A", "D02")]),
    ("e12", "Unknown review enumeration rejected", [row("E12A", review="approved")]),
    ("e13", "Unknown severity enumeration rejected", [row("E13A", severity="critical")]),
    ("e14", "Missing device identifier rejected", [row("E14A", "")]),
    ("e15", "Missing alert identifier rejected", [row("")]),
    ("e16", "Unicode device identifiers preserved", [row("E16A", "设备甲"), row("E16B", "设备乙", review="rejected")]),
    ("e17", "Quoted CSV delimiter in device identifier", [row("E17A", "Device,East"), row("E17B", "Device,West", review="pending")]),
    ("e18", "Mixed device, review, severity and time bands", [row(f"E18{i:02}", f"D{i % 3:02}", f"2026-11-01T{(i * 2) % 24:02}:00:00+08:00", ["high", "medium", "low"][i % 3], ["confirmed", "rejected", "pending"][i % 3]) for i in range(12)]),
    ("e19", "Six-decimal denominator rounding excludes pending", [row("E19A"), row("E19B"), row("E19C", review="rejected"), row("E19D", review="pending")]),
    ("e20", "One-alert dataset has no invented trend", [row("E20A", "Solo", timestamp="2026-11-01T23:59:59+08:00", severity="low", review="rejected")]),
]


def build():
    target = ROOT / "fixtures"
    target.mkdir(exist_ok=True)
    tasks = []
    for index, original in enumerate(["normal.csv", "empty.csv", "missing-values.csv", "bad-columns.csv", "invalid-time.csv"], 1):
        identifier = f"c{index:02}"
        content = (SOURCE / original).read_bytes()
        (target / f"{identifier}.csv").write_bytes(content)
        tasks.append((identifier, "calibration", f"Calibration: {original}"))
    for identifier, title, rows in CASES:
        buffer = io.StringIO(newline="")
        writer = csv.writer(buffer, lineterminator="\n")
        writer.writerow(HEADER[:-1] if identifier == "e08" else HEADER)
        writer.writerows(rows)
        (target / f"{identifier}.csv").write_text(buffer.getvalue(), encoding="utf-8", newline="")
        tasks.append((identifier, "evaluation", title))
    entries = []
    for identifier, split, title in tasks:
        path = target / f"{identifier}.csv"
        answer = reference.analyze(path)
        entries.append({
            "id": identifier, "split": split, "title": title,
            "input": f"fixtures/{identifier}.csv", "inputSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "expectedStatistics": answer,
            "requiredChecks": ["statistics"] if "error" in answer else ["statistics", "report", "chart"],
        })
    manifest = {
        "schemaVersion": 1, "suiteId": "charging-analysis-candidate-v1",
        "phase": "candidate-awaiting-calibration", "frozenForFinalEvaluation": False,
        "expectedOrigin": "Calibration answers cross-checked against original frozen examples; evaluation answers reference-derived and require independent review before freezing.",
        "referenceSha256": hashlib.sha256((SOURCE / "reference.py").read_bytes()).hexdigest(),
        "taskPrompt": "TASK.md", "taskPromptSha256": hashlib.sha256((ROOT / "TASK.md").read_bytes()).hexdigest(),
        "tasks": entries,
    }
    (ROOT / "suite.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(entries)} synthetic candidates (5 calibration, 20 evaluation); not final-evaluation frozen.")


if __name__ == "__main__":
    build()
