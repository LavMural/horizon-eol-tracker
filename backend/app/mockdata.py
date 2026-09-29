"""Deterministic generator for the synthetic Horizon dataset.

Every number, hostname, IP address and person in the demo comes from here. Nothing is
real: the host counts are fictional (chosen to be a realistic scale for an enterprise
fleet), owners are invented names, and hostnames/IPs use reserved example ranges.

The generator builds a story rather than random noise:
  * each EOL OS has a fixed baseline population on BASELINE_DATE, split across portfolios
    and owners;
  * owners with a plan decommission roughly on schedule ("on track") or well short of it
    ("behind"); owners without a plan only see background attrition;
  * a slice of departing hosts are upgraded to a supported OS instead of decommissioned;
  * a few data-quality problems are planted on purpose (hosts with no owner, departed
    owners, owners with no portfolio mapping, brand-new owners) so the Actuals tab has
    something to triage.

Run `python scripts/generate_mock_data.py` to rebuild the database from scratch.
"""
from __future__ import annotations

import calendar
import random
from datetime import date, datetime, time, timedelta

from sqlalchemy.orm import Session

from . import config
from .db import SessionLocal, reset_db
from .models import Host, HostCount, Meta, Owner, PlanAudit, PlanLine, PlanMonthly, Portfolio, PortfolioMap

UBUNTU, ORACLE = config.TRACKED_OS

# (code, full name, origin). "feed" portfolios exist only in the CMDB feed, not in the
# owner-mapping file, so their hosts always arrive already labelled.
PORTFOLIOS = [
    ("AI Tech", "AI Technology", "mapping"),
    ("CDP", "Core Data Platforms", "mapping"),
    ("Cloud Engineering", "Cloud Engineering", "mapping"),
    ("Core Platforms", "Core Platforms", "mapping"),
    ("Credit Data", "Credit Data", "mapping"),
    ("DFS", "Data Foundational Services", "mapping"),
    ("DPE", "Developer Productivity Platform", "mapping"),
    ("FP&A Admin USA", "FP&A", "mapping"),
    ("FTES", "Financial Services", "mapping"),
    ("GI US", "Global Incidents", "mapping"),
    ("PCIS", "Cybersecurity", "mapping"),
    ("SMB", "SMB", "mapping"),
    ("SRE", "Site Reliability Engineering", "mapping"),
    ("Access and Network Security", "Access and Network Security", "feed"),
    ("Enterprise Services (RLCO)", "Enterprise Services (RLCO)", "feed"),
    ("Global Fraud Prevention", "Global Fraud Prevention", "feed"),
    ("Risk", "Risk", "feed"),
    (config.UNKNOWN, "Unknown (no portfolio)", "system"),
]

# Baseline hosts and number of owners per (OS, portfolio). Fictional.
ALLOCATION = {
    UBUNTU: {
        "SRE": (5800, 8), "CDP": (2600, 7), "Cloud Engineering": (860, 4),
        "DPE": (240, 5), "Core Platforms": (150, 3), "PCIS": (120, 4), "DFS": (90, 2),
        "AI Tech": (60, 2), "GI US": (40, 1), "Credit Data": (30, 1), "FTES": (25, 1),
        "SMB": (20, 1), "Risk": (12, 1), "FP&A Admin USA": (10, 1),
        "Access and Network Security": (8, 1),
    },
    ORACLE: {
        "CDP": (10400, 9), "PCIS": (1350, 5), "DPE": (1150, 6), "Cloud Engineering": (620, 4),
        "Core Platforms": (420, 3), "DFS": (300, 3), "FTES": (260, 2), "AI Tech": (90, 2),
        "SMB": (85, 2), "Enterprise Services (RLCO)": (60, 1), "Global Fraud Prevention": (45, 1),
        "Credit Data": (40, 1), "GI US": (35, 1), "Risk": (30, 1), "FP&A Admin USA": (20, 1),
        "Access and Network Security": (15, 1),
    },
}

# Hosts that land in the Unknown bucket, per OS: no owner at all, owners the mapping
# doesn't know, and owners first seen in the latest refresh.
UNKNOWN_HOSTS = {
    UBUNTU: {"no_owner": 20, "unmapped": [15, 10], "new": [0, 0]},
    ORACLE: {"no_owner": 55, "unmapped": [160, 30], "new": [22, 13]},
}

# Share of departing hosts that were upgraded (vs decommissioned), and where they went.
UPGRADE_SHARE = {UBUNTU: 0.12, ORACLE: 0.25}
UPGRADE_DEST = {
    UBUNTU: [("Ubuntu 22.04", 0.80), ("Ubuntu 24.04", 0.12), ("Ubuntu 20.04", 0.05), ("Oracle 8", 0.03)],
    ORACLE: [("Oracle 8", 0.55), ("Oracle 9", 0.40), ("Ubuntu 22.04", 0.05)],
}
HOST_TYPES = {
    UBUNTU: [("virtual", 0.65), ("physical", 0.30), ("container", 0.03), ("lb", 0.02)],
    ORACLE: [("virtual", 0.55), ("physical", 0.42), ("lb", 0.03)],
}
ROLES = {UBUNTU: ["web", "app", "api", "batch", "cache", "build", "proxy"],
         ORACLE: ["db", "app", "etl", "batch", "report", "mq"]}
AZS = ["dc1-a", "dc1-b", "dc2-a", "dc2-b", "cloud-west-1", "cloud-east-1"]

# Which owners in a portfolio have a plan, and how they are executing against it.
#   cover:  "all" | "half" | "smallest" (only the owner with the fewest hosts)
#   behind: how many planned owners are behind ("all" or an int)
#   finish: how many small planned owners have already finished
PLAN_SCENARIOS = {
    (UBUNTU, "SRE"): {"cover": "all", "behind": 2},
    (UBUNTU, "CDP"): {"cover": "all", "behind": 0},
    (UBUNTU, "Cloud Engineering"): {"cover": "all", "behind": "all"},
    (UBUNTU, "Core Platforms"): {"cover": "all", "behind": 0},
    (UBUNTU, "DPE"): {"cover": "smallest", "behind": 0},
    (UBUNTU, "PCIS"): {"cover": "all", "behind": 0, "finish": 1},
    (ORACLE, "CDP"): {"cover": "all", "behind": 0},
    (ORACLE, "PCIS"): {"cover": "half", "behind": 0},
    (ORACLE, "DPE"): {"cover": "smallest", "behind": 0},
    (ORACLE, "Cloud Engineering"): {"cover": "all", "behind": "all"},
    (ORACLE, "SMB"): {"cover": "all", "behind": 0},
    (ORACLE, "DFS"): {"cover": "all", "behind": "all"},
}

# How aggressively each OS's plans are scheduled and executed. Oracle plans start
# earlier and finish sooner, so Oracle projects to finish inside the window while Ubuntu
# (later starts, longer tails) projects past it: one program on track, one at risk.
PLAN_PACE = {
    UBUNTU: {"start": [0, 1, 2, 3], "end": (5, 12), "on_track": (1.0, 1.15)},
    ORACLE: {"start": [0, 0, 1, 2], "end": (5, 9), "on_track": (1.05, 1.2)},
}

APPLICATIONS = {
    "SRE": ["Observability Stack", "Edge Proxy", "Incident Tooling", "Log Pipeline"],
    "CDP": ["Data Lake Ingest", "Stream Processor", "Warehouse Loader", "Metadata Catalog"],
    "Cloud Engineering": ["Compute Platform", "Image Factory", "Service Mesh"],
    "Core Platforms": ["Identity API", "Config Service", "Job Scheduler"],
    "DPE": ["CI Runners", "Artifact Store", "Build Farm"],
    "PCIS": ["Key Management", "Threat Analytics", "Access Gateway"],
    "SMB": ["Merchant Portal", "Onboarding Service"],
    "DFS": ["Feature Store", "Data Quality Checks", "Lineage Service"],
}

FIRST = ["Alex", "Blake", "Casey", "Dana", "Elliot", "Frankie", "Gray", "Harper", "Indy", "Jordan",
         "Kai", "Logan", "Morgan", "Noel", "Oakley", "Parker", "Quinn", "Reese", "Sage", "Taylor",
         "Umi", "Val", "Wren", "Xen", "Yael", "Zion", "Avery", "Brook", "Cameron", "Drew",
         "Emery", "Finley", "Hayden", "Jamie", "Kendall", "Lane", "Marlowe", "Nico", "Remy", "Skyler"]
LAST = ["Abbott", "Brennan", "Castillo", "Delgado", "Ellison", "Fairbanks", "Garrison", "Holloway",
        "Iverson", "Jennings", "Kowalski", "Lindqvist", "Moreau", "Nakamura", "Okafor", "Petrov",
        "Quintero", "Rasmussen", "Sorensen", "Thornton", "Underwood", "Vasquez", "Whitaker",
        "Xiong", "Yamada", "Zimmerman", "Ashford", "Bellamy", "Carrington", "Donovan"]

SEED_ACTOR = "PMO intake"
EDIT_ACTORS = ["jordan.ellison", "sage.moreau", "quinn.okafor"]


# --------------------------------------------------------------------------- helpers

def _month_bounds(month: str) -> tuple[date, date]:
    y, m = map(int, month.split("-"))
    return date(y, m, 1), date(y, m, calendar.monthrange(y, m)[1])


def _active_window(month: str) -> tuple[date, date] | None:
    """The slice of a month that falls between the baseline and the as-of date."""
    start, end = _month_bounds(month)
    start = max(start, config.BASELINE_DATE + timedelta(days=1))
    end = min(end, config.AS_OF_DATE)
    return (start, end) if start <= end else None


def _weighted(rng: random.Random, choices):
    r, acc = rng.random(), 0.0
    for value, w in choices:
        acc += w
        if r <= acc:
            return value
    return choices[-1][0]


def _split(total: int, weights: list[float]) -> list[int]:
    """Split an integer total by weights using largest-remainder rounding."""
    s = sum(weights)
    raw = [total * w / s for w in weights]
    out = [int(x) for x in raw]
    for i in sorted(range(len(raw)), key=lambda i: raw[i] - out[i], reverse=True)[: total - sum(out)]:
        out[i] += 1
    return out


class _Names:
    def __init__(self, rng: random.Random):
        pairs = [(f, l) for f in FIRST for l in LAST]
        rng.shuffle(pairs)
        self._pairs = iter(pairs)
        self._used: set[str] = set()

    def next(self) -> tuple[str, str]:
        for first, last in self._pairs:
            user = (first[0] + last).lower()
            if user not in self._used:
                self._used.add(user)
                return user, f"{first} {last}"
        raise RuntimeError("ran out of dummy names")


# --------------------------------------------------------------------------- generator

def generate(db: Session) -> dict:
    rng = random.Random(config.MOCK_SEED)
    names = _Names(rng)
    months = config.months()
    checkpoint = config.last_completed_month()

    for code, full, origin in PORTFOLIOS:
        db.add(Portfolio(code=code, full_name=full, origin=origin))

    owners: dict[str, Owner] = {}

    def new_owner(status="active", first_seen=date(2024, 10, 18), note=None) -> str:
        user, display = names.next()
        owners[user] = Owner(username=user, display_name=display, status=status,
                             first_seen=first_seen, note=note)
        return user

    # Owner pools per portfolio, shared by both OSes so some owners run both.
    pool_size: dict[str, int] = {}
    for alloc in ALLOCATION.values():
        for pf, (_, n) in alloc.items():
            pool_size[pf] = max(pool_size.get(pf, 0), n)
    pools = {pf: [new_owner() for _ in range(n)] for pf, n in sorted(pool_size.items())}

    feed_only = {code for code, _, origin in PORTFOLIOS if origin == "feed"}
    owner_map = {u: pf for pf, users in pools.items() if pf not in feed_only for u in users}
    db.add_all(PortfolioMap(owner=u, portfolio=pf) for u, pf in owner_map.items())

    # Planted data-quality cases (departed owners are chosen after hosts exist, below).
    unmapped = [new_owner(status="unknown", note="Not in the owner-mapping file") for _ in range(2)]
    newcomers = [new_owner(first_seen=config.AS_OF_DATE, note="First seen in the latest refresh")
                 for _ in range(2)]

    hosts: list[dict] = []
    plan_lines: list[dict] = []
    ip_counter = [0]

    def make_host(os_name: str, owner: str | None, feed_pf: str | None) -> dict:
        ip_counter[0] += 1
        n = ip_counter[0]
        prefix = "u16" if os_name == UBUNTU else "ol7"
        return {
            "hostname": f"{prefix}-{rng.choice(ROLES[os_name])}-{n:05d}.example.internal",
            "baseline_os": os_name, "owner": owner, "feed_portfolio": feed_pf,
            "host_type": _weighted(rng, HOST_TYPES[os_name]), "az": rng.choice(AZS),
            "ip": f"10.{(n >> 16) & 255}.{(n >> 8) & 255}.{n & 255}",
            "left_date": None, "status": "remaining", "current_os": os_name,
        }

    for os_name in config.TRACKED_OS:
        for pf, (count, n_owners) in ALLOCATION[os_name].items():
            users = pools[pf][:n_owners]
            weights = [1 / (i + 1) ** 1.1 for i in range(len(users))]
            rng.shuffle(weights)
            per_owner = dict(zip(users, _split(count, weights)))
            owner_hosts: dict[str, list[dict]] = {}
            for user, k in per_owner.items():
                owner_hosts[user] = []
                for _ in range(k):
                    # Most hosts arrive labelled by the feed; some rely on the owner map.
                    feed_pf = pf if (pf in feed_only or rng.random() > 0.06) else None
                    h = make_host(os_name, user, feed_pf)
                    owner_hosts[user].append(h)
                    hosts.append(h)
            _play_out(rng, os_name, pf, owner_hosts, months, checkpoint, plan_lines)

        unk = UNKNOWN_HOSTS[os_name]
        background = []
        for _ in range(unk["no_owner"]):
            background.append(make_host(os_name, None, None))
        for user, k in zip(unmapped, unk["unmapped"]):
            background += [make_host(os_name, user, None) for _ in range(k)]
        for user, k in zip(newcomers, unk["new"]):
            background += [make_host(os_name, user, None) for _ in range(k)]
        _attrition(rng, os_name, background)
        hosts += background

    # Departed owners: the smallest owner in a few portfolios, so the flag stays a
    # realistic handful of hosts rather than a whole team's fleet.
    per_owner_total: dict[str, int] = {}
    for h in hosts:
        if h["owner"]:
            per_owner_total[h["owner"]] = per_owner_total.get(h["owner"], 0) + 1
    for pf in ("SRE", "CDP", "PCIS"):
        departed = min((u for u in pools[pf] if per_owner_total.get(u)), key=per_owner_total.get)
        owners[departed].status = "departed"
        owners[departed].note = "Left the company; hosts need a new owner"

    # Derive the portfolio the same way the app does (feed first, then owner map).
    for h in hosts:
        h["portfolio"] = h["feed_portfolio"] or owner_map.get(h["owner"]) or config.UNKNOWN

    db.add_all(owners.values())
    db.flush()
    db.bulk_insert_mappings(Host, hosts)
    _write_history(db, hosts)
    _write_plans(rng, db, plan_lines)

    db.add(Meta(key="dataset", value="Synthetic demo data (seed %d)" % config.MOCK_SEED))
    db.add(Meta(key="last_refresh", value=datetime.combine(config.AS_OF_DATE, time(13, 0)).isoformat()))
    db.commit()
    return {"hosts": len(hosts), "owners": len(owners), "plan_lines": len(plan_lines)}


def _play_out(rng, os_name, pf, owner_hosts, months, checkpoint, plan_lines) -> None:
    """Decide which owners plan, write their plans, and decommission hosts to match."""
    scen = PLAN_SCENARIOS.get((os_name, pf))
    users = sorted(owner_hosts, key=lambda u: len(owner_hosts[u]))
    planned: list[str] = []
    if scen:
        if scen["cover"] == "all":
            planned = list(users)
        elif scen["cover"] == "half":
            planned = users[len(users) // 2:]
        elif scen["cover"] == "smallest":
            planned = users[:1]
    n_behind = len(planned) if scen and scen["behind"] == "all" else (scen or {}).get("behind", 0)
    by_size = sorted(planned, key=lambda u: -len(owner_hosts[u]))
    behind = set(by_size[:n_behind])
    finish = set(sorted(planned, key=lambda u: len(owner_hosts[u]))[: (scen or {}).get("finish", 0)])
    if finish & behind:
        behind -= finish

    for user in users:
        hs = owner_hosts[user]
        base = len(hs)
        if user not in planned or base == 0:
            _attrition(rng, os_name, hs)
            continue

        # Plan: spread the owner's whole baseline over a run of months.
        if user in finish:
            start_i, end_i = 1, 2  # Jul-Aug: already done by the as-of date
        else:
            pace = PLAN_PACE[os_name]
            start_i = rng.choice([0, 1, 1, 2]) if user in behind else rng.choice(pace["start"])
            end_i = rng.randint(max(start_i + 3, pace["end"][0]), pace["end"][1])
        span = months[start_i:end_i + 1]
        weights = [1 + 0.35 * i + rng.random() * 0.5 for i in range(len(span))]
        plan = dict(zip(span, _split(base, weights)))
        plan_lines.append({"os": os_name, "portfolio": pf, "owner": user,
                           "application": rng.choice(APPLICATIONS.get(pf, [""]) + [""]),
                           "months": plan})

        # Execution: cumulative departures track the plan by a factor.
        factor = 1.0 if user in finish else (rng.uniform(0.35, 0.75) if user in behind
                                             else rng.uniform(*PLAN_PACE[os_name]["on_track"]))
        left_by_month: dict[str, int] = {}
        cum_plan = 0
        for m in months:
            win = _active_window(m)
            if not win:
                break
            month_plan = plan.get(m, 0)
            if m == config.current_month():
                # In-progress month: credit only the elapsed part of it.
                days = (win[1] - win[0]).days + 1
                cum = cum_plan + month_plan * days / _month_bounds(m)[1].day
            else:
                cum = cum_plan + month_plan
            cum_plan += month_plan
            target = min(base, round(cum * factor))
            left_by_month[m] = max(target, left_by_month.get(_prev(months, m), 0))
        _depart(rng, os_name, hs, left_by_month)


def _prev(months: list[str], m: str) -> str | None:
    i = months.index(m)
    return months[i - 1] if i else None


def _attrition(rng, os_name, hs: list[dict]) -> None:
    """Background churn for hosts with no plan: a small share leaves each month."""
    rate = rng.uniform(0.005, 0.025)
    left_by_month, cum = {}, 0.0
    for m in config.months():
        win = _active_window(m)
        if not win:
            break
        frac = ((win[1] - win[0]).days + 1) / _month_bounds(m)[1].day
        cum += len(hs) * rate * frac
        left_by_month[m] = min(len(hs), round(cum))
    _depart(rng, os_name, hs, left_by_month)


def _depart(rng, os_name, hs: list[dict], left_by_month: dict[str, int]) -> None:
    """Mark hosts as upgraded/decommissioned so cumulative departures match the targets."""
    rng.shuffle(hs)
    done = 0
    for m, cum in left_by_month.items():
        win = _active_window(m)
        for h in hs[done:cum]:
            h["left_date"] = win[0] + timedelta(days=rng.randint(0, (win[1] - win[0]).days))
            if rng.random() < UPGRADE_SHARE[os_name]:
                h["status"], h["current_os"] = "upgraded", _weighted(rng, UPGRADE_DEST[os_name])
            else:
                h["status"], h["current_os"] = "decommissioned", None
        done = max(done, cum)


def _write_history(db: Session, hosts: list[dict]) -> None:
    """Daily host count per EOL OS from the baseline date on, derived from the hosts."""
    for os_name in config.TRACKED_OS:
        cohort = [h for h in hosts if h["baseline_os"] == os_name]
        left = sorted(h["left_date"] for h in cohort if h["left_date"])
        rows, d, j = [], config.BASELINE_DATE, 0
        while d <= config.AS_OF_DATE:
            while j < len(left) and left[j] <= d:
                j += 1
            rows.append({"os": os_name, "date": d, "count": len(cohort) - j})
            d += timedelta(days=1)
        db.bulk_insert_mappings(HostCount, rows)


def _write_plans(rng, db: Session, plan_lines: list[dict]) -> None:
    """Insert plan lines with an audit trail that looks like a real intake."""
    for i, pl in enumerate(plan_lines):
        entry = date(2026, 6, 18) + timedelta(days=rng.randint(0, 25))
        stamp = datetime.combine(entry, time(16 + i % 7, rng.randint(0, 59)))  # UTC
        line = PlanLine(os=pl["os"], portfolio=pl["portfolio"], application=pl["application"],
                        owner=pl["owner"], entry_date=entry, updated_at=stamp)
        line.months = [PlanMonthly(month=m, planned_count=c) for m, c in pl["months"].items() if c]
        db.add(line)
        db.flush()
        ident = dict(plan_line_id=line.id, os=line.os, portfolio=line.portfolio,
                     application=line.application, owner=line.owner)
        detail = "plan_intake_%s.csv" % entry.strftime("%Y-%m")
        db.add(PlanAudit(ts=stamp, action="import", field="line", new_value="created",
                         source="import", actor=SEED_ACTOR, detail=detail, **ident))
        for pm in line.months:
            db.add(PlanAudit(ts=stamp, action="import", field="month:" + pm.month,
                             new_value=str(pm.planned_count), source="import",
                             actor=SEED_ACTOR, detail=detail, **ident))

    # A handful of later hand edits so the Activity log and "Last changed" column have
    # something other than the intake to show. Moves are between future months only, so
    # totals and on-track status are unchanged.
    lines = db.query(PlanLine).all()
    for n, line in enumerate(rng.sample(lines, min(6, len(lines)))):
        future = [pm for pm in line.months if pm.month > config.current_month()]
        if len(future) < 2:
            continue
        a, b = future[0], future[-1]
        moved = max(1, a.planned_count // 4)
        a.planned_count -= moved
        b.planned_count += moved
        stamp = datetime.combine(date(2026, 8, 4) + timedelta(days=n * 6), time(21, 10 + n))  # UTC
        line.updated_at = stamp
        ident = dict(plan_line_id=line.id, os=line.os, portfolio=line.portfolio,
                     application=line.application, owner=line.owner)
        actor = EDIT_ACTORS[n % len(EDIT_ACTORS)]
        for pm, old in ((a, a.planned_count + moved), (b, b.planned_count - moved)):
            db.add(PlanAudit(ts=stamp, action="update", field="month:" + pm.month,
                             old_value=str(old), new_value=str(pm.planned_count),
                             source="ui", actor=actor, **ident))


def rebuild() -> dict:
    """Drop and recreate every table, then generate the dataset."""
    reset_db()
    db = SessionLocal()
    try:
        return generate(db)
    finally:
        db.close()
