"""Compare candidate statistics against frozen, manually enumerated answers."""
import argparse
import hashlib
import json
from pathlib import Path

BASE = Path(__file__).parent


def verify(fixture: str, candidate: dict) -> None:
    expected = json.loads((BASE / "expected.json").read_text(encoding="utf-8"))[fixture]
    if candidate != expected:
        raise AssertionError(f"Incorrect result for {fixture}: expected {expected!r}, got {candidate!r}")


def self_test() -> None:
    from reference import analyze
    expected = json.loads((BASE / "expected.json").read_text(encoding="utf-8"))
    for fixture in expected:
        path = BASE / fixture
        verify(fixture, analyze(path))
        print(f"PASS {fixture} sha256={hashlib.sha256(path.read_bytes()).hexdigest()}")
    broken = dict(expected["normal.csv"], false_positive_rate=0.2)
    try:
        verify("normal.csv", broken)
    except AssertionError:
        print("PASS wrong denominator is rejected")
    else:
        raise AssertionError("Validator accepted a wrong denominator")
    print(f"PASS {len(expected)} fixtures and mutation rejection")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--fixture")
    parser.add_argument("--result", type=Path)
    args = parser.parse_args()
    if args.self_test:
        self_test()
    elif args.fixture and args.result:
        verify(args.fixture, json.loads(args.result.read_text(encoding="utf-8")))
        print("PASS candidate statistics")
    else:
        parser.error("Use --self-test or --fixture FILE --result PATH")
