"""Огляд фідів svitlo.live: які регіони й черги є, чи свіжі дні, як виглядає графік.

python tools/feed_report.py                 # усі регіони обох фідів
python tools/feed_report.py kyiv 3.1        # слоти черги: X — нема світла, + — є, . — невідомо
"""
import json
import sys
import urllib.request

NEW_API = "https://dtek-api.svitlo-proxy.workers.dev/"
OLD_API = "https://svitlo-proxy.svitlo-proxy.workers.dev"


def load(url):
    # Cloudflare відповідає 403 на стандартний User-Agent Python.
    req = urllib.request.Request(url, headers={"User-Agent": "svitlo-guard/feed_report", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = json.loads(resp.read().decode("utf-8"))
    return json.loads(raw["body"]) if isinstance(raw.get("body"), str) else raw


def slots(day):
    return "".join({0: ".", 1: "+", 2: "X"}.get(day.get(f"{h:02d}:{m:02d}"), "?") for h in range(24) for m in (0, 30))


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    region, queue = (sys.argv[1:] + [None, None])[:2]
    for name, url in (("NEW", NEW_API), ("OLD", OLD_API)):
        feed = load(url)
        print(f"== {name} {url} today={feed.get('date_today')} tomorrow={feed.get('date_tomorrow')}")
        for r in feed.get("regions", []):
            if region and r["cpu"] != region:
                continue
            schedule = r.get("schedule") or {}
            print(f"  {r['cpu']} — {r.get('name_ua')} emergency={r.get('emergency')} черги={list(schedule)[:14]}")
            for q, days in schedule.items():
                if queue and q != queue:
                    continue
                if not queue:
                    continue
                for date, day in days.items():
                    print(f"    {q} {date} {slots(day)}")


if __name__ == "__main__":
    main()
