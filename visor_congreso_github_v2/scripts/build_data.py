#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Genera data/votacions.json per al visor de votacions del Congreso.

Pensat per executar-se a GitHub Actions, no al teu ordinador.
Font: Open Data del Congreso de los Diputados, XV legislatura.

Estratègia:
1) Recorre dies des del 17/08/2023 fins avui.
2) Detecta dies amb sessió plenària i enllaços 'Detalle' PDF.
3) Baixa cada PDF oficial i n'extreu: títol, totals i vot nominal per diputat/grup.
4) Desa un JSON únic que el visor pot consultar sense connexions externes.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import hashlib
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import quote, urljoin

import requests
from pypdf import PdfReader

BASE_PAGE = "https://www.congreso.es/es/opendata/votaciones"
BASE_URL = "https://www.congreso.es"
LEGISLATURA = "XV"
LEG_NUM = "15"
DEFAULT_START = date(2023, 8, 17)

SESSION_RE = re.compile(r"Sesión\s+Plenaria\s+n[úu]mero\s+(\d+)", re.IGNORECASE)
DATE_RE = re.compile(r"Fecha\s*:\s*(\d{2})/(\d{2})/(\d{4})", re.IGNORECASE)
LINK_RE = re.compile(r'href=["\']([^"\']+)["\']', re.IGNORECASE)
PDF_URL_RE = re.compile(r"/webpublica/opendata/votaciones/Leg15/Sesion(\d+)/(\d{8})/Votacion(\d+)/VOT_(\d+)\.pdf$")

VOTE_LABELS = {
    "SI": "Sí",
    "SÍ": "Sí",
    "NO": "No",
    "ABSTENCIONES": "Abstención",
    "ABSTENCION": "Abstención",
    "ABSTENCIÓN": "Abstención",
    "NO VOTAN": "No vota",
    "NO VOTA": "No vota",
}

PARTY_ORDER = ["PP","PSOE","VOX","SUMAR","ERC","Junts","EH Bildu","PNV","Podemos","BNG","Coalición Canaria","UPN","Mixt residual","Altres"]


def norm_key(s: str) -> str:
    return strip_accents_basic(s).lower()


def party_of_member(member: str, group: str) -> str:
    """Normalitza grup parlamentari i separa el Grup Mixt per partit real."""
    m = norm_key(member)
    g = norm_key(group)
    if "popular" in g:
        return "PP"
    if "socialista" in g:
        return "PSOE"
    if "vox" in g:
        return "VOX"
    if "junts" in g:
        return "Junts"
    if "republicano" in g or "esquerra" in g:
        return "ERC"
    if "sumar" in g:
        return "SUMAR"
    if "vasco" in g or "eaj" in g or "pnv" in g:
        return "PNV"
    if "bildu" in g:
        return "EH Bildu"
    if "mixto" in g or "mixt" in g:
        if "rego candamil" in m or "nestor rego" in m or "néstor rego" in (member or "").lower():
            return "BNG"
        if "valido garcia" in m or "cristina valido" in m or "coalicion canaria" in m:
            return "Coalición Canaria"
        if "catalan higueras" in m or "alberto catalan" in m:
            return "UPN"
        if any(x in m for x in ["belarra", "sanchez serna", "velarde", "santana perera", "noemi santana"]):
            return "Podemos"
        return "Mixt residual"
    return "Altres"


def normalize_vote_label(v: str) -> str:
    u = strip_accents_basic(v)
    if u in ("SI", "SÍ"):
        return "Sí"
    if u == "NO":
        return "No"
    if u in ("ABSTENCION", "ABSTENCIONES"):
        return "Abstención"
    if u in ("NO VOTA", "NO VOTAN"):
        return "No vota"
    return v or "Sense vot"


def majority_from_counts(c: dict) -> str:
    keys = ["Sí", "No", "Abstención", "No vota"]
    entries = sorted([(k, int(c.get(k, 0) or 0)) for k in keys], key=lambda x: x[1], reverse=True)
    if not entries or entries[0][1] == 0:
        return "Sense vot"
    if len(entries) > 1 and entries[0][1] == entries[1][1]:
        return "Dividit"
    return entries[0][0]


def aggregate_party_votes(members: list[dict]) -> dict:
    out: dict[str, dict] = {}
    for m in members or []:
        party = party_of_member(m.get("name", ""), m.get("group", ""))
        vote = normalize_vote_label(m.get("vote", ""))
        if party not in out:
            out[party] = {"si": 0, "no": 0, "abst": 0, "absent": 0, "total": 0, "sentit": "Sense vot"}
        if vote == "Sí":
            out[party]["si"] += 1
        elif vote == "No":
            out[party]["no"] += 1
        elif vote == "Abstención":
            out[party]["abst"] += 1
        elif vote == "No vota":
            out[party]["absent"] += 1
        else:
            out[party]["absent"] += 1
        out[party]["total"] += 1
    for party, c in out.items():
        c["sentit"] = majority_from_counts({"Sí": c["si"], "No": c["no"], "Abstención": c["abst"], "No vota": c["absent"]})
    return {k: out[k] for k in sorted(out, key=lambda x: (PARTY_ORDER.index(x) if x in PARTY_ORDER else 99, x))}


def lighten_vote(v: dict) -> dict:
    """Converteix una votació nominal en votació agregada per partit i elimina el detall nominal."""
    out = dict(v)
    if "partyVotes" not in out:
        out["partyVotes"] = aggregate_party_votes(out.get("members", []))
    out.pop("members", None)
    return out

@dataclass(frozen=True)
class VoteDay:
    day: date
    session_number: str
    pdf_urls: tuple[str, ...]


def normalize_space(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def strip_accents_basic(s: str) -> str:
    return (s or "").upper().translate(str.maketrans("ÁÉÍÓÚÀÈÌÒÙÜ", "AEIOUAEIOUU"))


def iter_days(start: date, end: date) -> Iterable[date]:
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def http_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": "Mozilla/5.0 (compatible; VisorVotacionsCongreso/1.0; +https://www.congreso.es/opendata/votaciones)",
        "Accept-Language": "ca,es;q=0.9,en;q=0.8",
    })
    return s


def page_url_for_day(d: date) -> str:
    return f"{BASE_PAGE}?targetDate={quote(d.strftime('%d/%m/%Y'), safe='')}&targetLegislatura={LEGISLATURA}"


def fetch_text(s: requests.Session, url: str, timeout: int = 40) -> str:
    r = s.get(url, timeout=timeout)
    r.raise_for_status()
    return r.text


def fetch_bytes(s: requests.Session, url: str, timeout: int = 90) -> bytes:
    r = s.get(url, timeout=timeout)
    r.raise_for_status()
    return r.content


def unique_sorted(urls: Iterable[str]) -> tuple[str, ...]:
    out, seen = [], set()
    for u in urls:
        if u not in seen:
            out.append(u)
            seen.add(u)
    return tuple(sorted(out))


def extract_vote_day(html: str, expected_day: date) -> Optional[VoteDay]:
    sm = SESSION_RE.search(html)
    if not sm:
        return None

    session_number = sm.group(1).zfill(3)
    dm = DATE_RE.search(html)
    if dm:
        dd, mm, yyyy = map(int, dm.groups())
        day = date(yyyy, mm, dd)
    else:
        day = expected_day

    raw_links = [urljoin(BASE_URL, href.replace("&amp;", "&")) for href in LINK_RE.findall(html)]
    pdf_urls = [u for u in raw_links if PDF_URL_RE.search(u)]
    if not pdf_urls:
        return None

    return VoteDay(day=day, session_number=session_number, pdf_urls=unique_sorted(pdf_urls))


def parse_url_meta(url: str) -> dict:
    m = PDF_URL_RE.search(url)
    if not m:
        return {}
    session, yyyymmdd, vote_number, stamp = m.groups()
    return {
        "session": str(int(session)),
        "session_padded": session.zfill(3),
        "date": f"{yyyymmdd[0:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:8]}",
        "vote_number": str(int(vote_number)),
        "vote_number_padded": vote_number.zfill(3),
        "stamp": stamp,
    }


def pdf_text_from_bytes(pdf_bytes: bytes, tmp_path: Path) -> str:
    tmp_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path.write_bytes(pdf_bytes)
    try:
        reader = PdfReader(str(tmp_path))
        parts = []
        for page in reader.pages:
            try:
                parts.append(page.extract_text() or "")
            except Exception:
                parts.append("")
        return "\n".join(parts)
    finally:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass


def title_from_pdf_text(text: str) -> str:
    # El títol surt abans de "Votación:" / "Sesión:".
    t = text.replace("\r", "\n")
    m = re.search(r"(.*?)\bVotaci[oó]n\s*:", t, re.IGNORECASE | re.DOTALL)
    if not m:
        m = re.search(r"(.*?)\bSesi[oó]n\s*:", t, re.IGNORECASE | re.DOTALL)
    raw = m.group(1) if m else ""
    raw = re.sub(r"^\s*-\s*", "", raw.strip())
    raw = re.sub(r"\s*\n\s*", " ", raw)
    raw = normalize_space(raw)
    return raw[:900]


def totals_from_pdf_text(text: str) -> dict:
    # Després de les etiquetes PRESENTES/SI/NO/ABSTENCIONES/NO VOTAN acostumen a sortir 5 nombres.
    compact = re.sub(r"\s+", " ", text)
    m = re.search(
        r"PRESENTES\s+SI\s+NO\s+ABSTENCIONES\s+NO\s+VOTAN\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)",
        strip_accents_basic(compact),
    )
    if not m:
        return {"presentes": None, "si": None, "no": None, "abstenciones": None, "no_votan": None}
    presentes, si, no, abst, novotan = map(int, m.groups())
    return {"presentes": presentes, "si": si, "no": no, "abstenciones": abst, "no_votan": novotan}


def clean_member_name(line: str) -> str:
    x = normalize_space(line)
    x = re.sub(r"^[-–—]\s*", "", x)
    x = re.sub(r"^TELEM[ÁA]TICO\s*[-–—]\s*", "", x, flags=re.IGNORECASE)
    x = re.sub(r"\s*TELEM[ÁA]TICO\s*$", "", x, flags=re.IGNORECASE)
    x = re.sub(r"\s*\d{1,5}\s*$", "", x)
    x = re.sub(r"^\d{1,5}\s*[-–—]\s*", "", x)
    x = normalize_space(x)
    return x


def parse_members_from_pdf_text(text: str) -> list[dict]:
    t = text.replace("\r", "\n")
    # Neteja artefactes de pàgina i separa línies que pypdf pot enganxar.
    t = re.sub(r"P[áa]gina\s+\d+\s+de\s+\d+", "\n", t, flags=re.IGNORECASE)
    t = re.sub(r"(\d{1,5}|TELEM[ÁA]TICO)\s+[-–—]\s+", r"\1\n - ", t, flags=re.IGNORECASE)
    t = re.sub(r"(\d{1,5}|TELEM[ÁA]TICO)(Grupo Parlamentario)", r"\1\n\2", t, flags=re.IGNORECASE)
    lines = [normalize_space(x) for x in t.splitlines() if normalize_space(x)]

    members: list[dict] = []
    current_vote: Optional[str] = None
    current_group: Optional[str] = None
    in_result = False

    for raw in lines:
        upper = strip_accents_basic(raw)
        if "RESULTADO DE LA VOTACION" in upper:
            in_result = True
            continue
        if not in_result:
            continue

        # Canvis de secció de vot.
        if upper in ("SI", "SÍ"):
            current_vote = "Sí"
            current_group = None
            continue
        if upper == "NO":
            current_vote = "No"
            current_group = None
            continue
        if upper in ("ABSTENCIONES", "ABSTENCION", "ABSTENCIÓN"):
            current_vote = "Abstención"
            current_group = None
            continue
        if upper in ("NO VOTAN", "NO VOTA"):
            current_vote = "No vota"
            current_group = None
            continue

        # Grups.
        if raw.startswith("Grupo Parlamentario") or raw.startswith("Grupo Parlamentario"):
            current_group = raw
            continue

        # Tall final, totals, línies de soroll.
        if raw.startswith("Total:") or upper.startswith("TOTAL:"):
            continue
        if not current_vote or not current_group:
            continue
        if raw.startswith("-") or raw.upper().startswith("TELEM") or re.match(r"^\d{1,5}\s*[-–—]", raw):
            name = clean_member_name(raw)
            if "," in name and len(name) > 4:
                members.append({
                    "name": name,
                    "group": current_group,
                    "vote": current_vote,
                    "telematic": "TELEM" in strip_accents_basic(raw),
                })
            continue

    # Deduplicació conservant ordre.
    seen = set()
    out = []
    for m in members:
        key = (m["name"], m["group"], m["vote"])
        if key not in seen:
            seen.add(key)
            out.append(m)
    return out


def parse_vote_pdf(pdf_bytes: bytes, url: str, cache_dir: Path) -> dict:
    meta = parse_url_meta(url)
    digest = hashlib.sha256(pdf_bytes).hexdigest()[:16]
    text = pdf_text_from_bytes(pdf_bytes, cache_dir / f"tmp_{digest}.pdf")
    title = title_from_pdf_text(text)
    totals = totals_from_pdf_text(text)
    members = parse_members_from_pdf_text(text)
    vote_id = f"{meta.get('date','')}_S{meta.get('session_padded','')}_V{meta.get('vote_number_padded','')}"
    return {
        "id": vote_id,
        "date": meta.get("date", ""),
        "year": (meta.get("date", "") or "")[:4],
        "month": (meta.get("date", "") or "")[5:7],
        "session": meta.get("session", ""),
        "session_padded": meta.get("session_padded", ""),
        "vote_number": meta.get("vote_number", ""),
        "vote_number_padded": meta.get("vote_number_padded", ""),
        "title": title or "Sense títol detectat",
        "totals": totals,
        "partyVotes": aggregate_party_votes(members),
        "source_pdf": url,
        "source_page": page_url_for_day(datetime.strptime(meta.get("date", "1970-01-01"), "%Y-%m-%d").date()) if meta.get("date") else BASE_PAGE,
    }


def merge_votes(old: list[dict], new: list[dict]) -> list[dict]:
    by_id = {v.get("id"): v for v in old if v.get("id")}
    for v in new:
        if v.get("id"):
            by_id[v["id"]] = v
    return sorted(by_id.values(), key=lambda v: (v.get("date", ""), int(v.get("session") or 0), int(v.get("vote_number") or 0)))


def build_indexes(votes: list[dict]) -> dict:
    parties = set()
    total_party_votes = 0
    for v in votes:
        pv = v.get("partyVotes") or aggregate_party_votes(v.get("members", []))
        for p in pv.keys():
            parties.add(p)
            total_party_votes += 1
    sessions = sorted({f"{v.get('date')} · Sessió {v.get('session')}" for v in votes})
    return {
        "groups": sorted(parties, key=lambda x: (PARTY_ORDER.index(x) if x in PARTY_ORDER else 99, x)),
        "members": [],
        "sessions": sessions,
        "total_votes": len(votes),
        "total_party_votes": total_party_votes,
        "last_vote_date": max([v.get("date", "") for v in votes] or [""]),
        "data_model": "group_only_v7",
    }



def load_existing_chunked(data_dir: Path) -> list[dict]:
    manifest_path = data_dir / "manifest.json"
    if not manifest_path.exists():
        return []
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return []
    votes: list[dict] = []
    for ch in manifest.get("chunks", []):
        fp = data_dir / ch.get("file", "")
        if not fp.exists():
            continue
        try:
            obj = json.loads(fp.read_text(encoding="utf-8"))
            votes.extend(obj.get("votes", []))
        except Exception:
            pass
    return votes


def write_chunked_dataset(data_dir: Path, votes: list[dict], metadata: dict) -> None:
    """Escriu les dades partides per mes per evitar el límit de 100 MB de GitHub."""
    chunks_dir = data_dir / "chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)

    # V7: desa només vot agregat per partit/grup. El detall nominal no es publica al web.
    votes = [lighten_vote(v) for v in votes]

    # Neteja chunks antics perquè no quedin mesos obsolets.
    for old in chunks_dir.glob("votacions_*.json"):
        try:
            old.unlink()
        except Exception:
            pass

    by_month: dict[tuple[str, str], list[dict]] = {}
    for v in votes:
        year = v.get("year") or (v.get("date", "")[:4] if v.get("date") else "sense_any")
        month = v.get("month") or (v.get("date", "")[5:7] if v.get("date") else "sense_mes")
        by_month.setdefault((year, month), []).append(v)

    chunks = []
    for (year, month), items in sorted(by_month.items()):
        items = sorted(items, key=lambda v: (v.get("date", ""), int(v.get("session") or 0), int(v.get("vote_number") or 0)))
        rel = f"chunks/votacions_{year}_{month}.json"
        fp = data_dir / rel
        payload = {
            "metadata": {**metadata, "year": year, "month": month},
            "votes": items,
        }
        fp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        size = fp.stat().st_size
        chunks.append({
            "year": year,
            "month": month,
            "file": rel,
            "votes": len(items),
            "party_votes": sum(len(v.get("partyVotes", {})) for v in items),
            "bytes": size,
            "first_date": min([v.get("date", "") for v in items] or [""]),
            "last_date": max([v.get("date", "") for v in items] or [""]),
        })

    manifest = {
        "metadata": metadata,
        "indexes": build_indexes(votes),
        "chunks": chunks,
    }
    (data_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default=DEFAULT_START.isoformat())
    ap.add_argument("--end", default=date.today().isoformat())
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--merge-existing", action="store_true")
    ap.add_argument("--sleep", type=float, default=0.25)
    ap.add_argument("--limit-days", type=int, default=0, help="Per proves: limita el nombre de dies explorats")
    ap.add_argument("--limit-votes", type=int, default=0, help="Per proves: limita el nombre de votacions baixades")
    args = ap.parse_args()

    start = datetime.strptime(args.start, "%Y-%m-%d").date()
    end = datetime.strptime(args.end, "%Y-%m-%d").date()
    data_dir = Path(args.data_dir)
    cache_dir = Path(".cache_pdf")
    data_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(exist_ok=True)

    old_votes = load_existing_chunked(data_dir) if args.merge_existing else []

    s = http_session()
    new_votes: list[dict] = []
    seen_sessions = set()
    days_seen = 0
    vote_count = 0

    for idx, d in enumerate(iter_days(start, end), start=1):
        if args.limit_days and idx > args.limit_days:
            break
        try:
            html = fetch_text(s, page_url_for_day(d))
        except Exception as e:
            print(f"[WARN] {d} no es pot llegir: {e}", file=sys.stderr)
            time.sleep(args.sleep)
            continue

        vd = extract_vote_day(html, d)
        if not vd:
            time.sleep(args.sleep)
            continue

        key = (vd.day.isoformat(), vd.session_number)
        if key in seen_sessions:
            time.sleep(args.sleep)
            continue
        seen_sessions.add(key)
        days_seen += 1
        print(f"Sessió {vd.session_number} · {vd.day}: {len(vd.pdf_urls)} votacions")

        for url in vd.pdf_urls:
            if args.limit_votes and vote_count >= args.limit_votes:
                break
            try:
                pdf = fetch_bytes(s, url)
                vote = parse_vote_pdf(pdf, url, cache_dir)
                new_votes.append(vote)
                vote_count += 1
                print(f"  OK {vote.get('id')} · grups: {len(vote.get('partyVotes', {}))}")
            except Exception as e:
                print(f"  [ERROR] {url}: {e}", file=sys.stderr)
            time.sleep(args.sleep)
        if args.limit_votes and vote_count >= args.limit_votes:
            break
        time.sleep(args.sleep)

    all_votes = merge_votes(old_votes, new_votes) if args.merge_existing else sorted(new_votes, key=lambda v: (v.get("date", ""), int(v.get("session") or 0), int(v.get("vote_number") or 0)))
    metadata = {
        "generated_at": datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        "source": "Congreso de los Diputados · Open Data · Votaciones · XV Legislatura",
        "source_url": BASE_PAGE,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "note": "Generat automàticament des dels PDF oficials de detall de votació. V7 lleugera: el web publica només vot agregat per partit/grup, amb Grup Mixt separat, i no publica el vot nominal.",
    }
    write_chunked_dataset(data_dir, all_votes, metadata)
    print(f"Creat {data_dir}/manifest.json · votacions: {len(all_votes)} · sessions detectades en aquesta passada: {days_seen}")
    print("Chunks creats:", len(json.loads((data_dir / "manifest.json").read_text(encoding="utf-8")).get("chunks", [])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
