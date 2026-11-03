"""Exercise the standard-library SDK against an already-running local Workbench."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sdks/python"))
from vesper import Workbench

parser = argparse.ArgumentParser()
parser.add_argument("--data-root", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
client = Workbench.from_directory(Path(args.data_root) / "workbench", timeout=30)
before = client.schedules()
assert all(not item["enabled"] for item in before), "Pause schedules before qualification"
preview = client.calendar_preview("0 9 * * *", "Europe/London", 1774656000000)
assert len(preview["occurrences"]) == 5
assert preview["occurrences"][1] == 1774771200000
owned_id = None
try:
    created = client.create_schedule(
        "Owned Python calendar qualification", "inspect",
        {"url": "http://127.0.0.1:9/", "engine": "vesper"},
        next_at=1893456000000, cron="0 9 * * 1-5", timezone="Europe/London",
    )
    owned_id = created["id"]
    client.schedule_control(owned_id, "pause")
    assert not next(item for item in client.schedules() if item["id"] == owned_id)["enabled"]
finally:
    if owned_id:
        client.schedule_control(owned_id, "remove")
assert client.schedules() == before
report = {
    "state": "passed", "client": "Python standard-library Workbench SDK",
    "version": client.capabilities()["version"], "calendarDSTPreview": True,
    "futureScheduleCreatedPausedRemoved": True, "originalSchedulesPreserved": True,
}
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report))
