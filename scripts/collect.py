"""記事収集モジュール（プラグイン構造）。

各ソース（Google News / PR TIMES / PubMed / The Lancet）を Source クラスで表現し、
config.json のキーワード定義に従って記事を集める。すべて無料・APIキー不要のRSS/HTTPのみ。

新しいソースを足したいときは Source を継承したクラスを1つ書き、
collect_for_keyword() のソースリストに加えるだけでよい。
"""
from __future__ import annotations

import html
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from typing import Iterable

JST = timezone(timedelta(hours=9))
USER_AGENT = "ToudaiCurator/1.0 (+https://github.com/; personal daily digest)"
HTTP_TIMEOUT = 20


@dataclass
class Article:
    title: str
    source: str
    published_at: datetime
    url: str
    summary: str = ""          # 収集段階では空。summarize.py が埋める
    jump_url: str = ""         # Text Fragment 付きURL。空なら後段で url と同値に
    badge: str = ""            # 出典バッジ（例 "PubMed" / "The Lancet"）
    raw_text: str = ""         # 要約の材料（RSSの description など）
    guid: str = ""             # 重複排除キー

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "source": self.source,
            "publishedAt": self.published_at.astimezone(JST).isoformat(),
            "summary": self.summary,
            "url": self.url,
            "jumpUrl": self.jump_url or self.url,
            "badge": self.badge,
        }


def _fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return resp.read()


def _clean_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _parse_date(value: str | None) -> datetime:
    if not value:
        return datetime.now(JST)
    try:
        dt = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return datetime.now(JST)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=JST)
    return dt


_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "dc": "http://purl.org/dc/elements/1.1/",
    "content": "http://purl.org/rss/1.0/modules/content/",
}


def _iter_rss_items(xml_bytes: bytes) -> Iterable[dict]:
    """RSS 2.0 / RSS 1.0(RDF) / Atom のいずれでも item を辞書で返す。"""
    root = ET.fromstring(xml_bytes)
    tag = root.tag.split("}")[-1]

    def _rss_item(item) -> dict:
        def g(name: str) -> str:
            el = item.find(name)
            return el.text if el is not None and el.text else ""
        title = g("title")
        link = g("link")
        if not link:
            guid_el = item.find("guid")
            if guid_el is not None and guid_el.text:
                link = guid_el.text
        desc = g("description") or _findtext(item, "content:content") or _findtext(item, "dc:description")
        date = g("pubDate") or _findtext(item, "dc:date")
        guid = _findtext_first(item, ["guid"]) or link
        return {"title": title, "link": link, "desc": desc, "date": date, "guid": guid}

    if tag in ("rss",):
        for item in root.iter("item"):
            yield _rss_item(item)
    elif tag == "RDF":  # RSS 1.0 / RDF (PR TIMES index.rdf)
        for item in root.iter("{http://purl.org/rss/1.0/}item"):
            def g(name: str) -> str:
                el = item.find("{http://purl.org/rss/1.0/}" + name)
                return el.text if el is not None and el.text else ""
            title = g("title")
            link = g("link")
            desc = g("description") or _findtext(item, "content:content") or _findtext(item, "dc:description")
            date = _findtext(item, "dc:date") or g("date")
            guid = item.get("{http://www.w3.org/1999/02/22-rdf-syntax-ns#}about") or link
            yield {"title": title, "link": link, "desc": desc, "date": date, "guid": guid}
    elif tag == "feed":  # Atom
        for entry in root.iter("{http://www.w3.org/2005/Atom}entry"):
            title = _findtext(entry, "atom:title")
            link = ""
            for le in entry.findall("atom:link", _NS):
                if le.get("rel") in (None, "alternate"):
                    link = le.get("href", "")
                    break
            desc = _findtext(entry, "atom:summary") or _findtext(entry, "atom:content")
            date = _findtext(entry, "atom:updated") or _findtext(entry, "atom:published")
            guid = _findtext(entry, "atom:id") or link
            yield {"title": title, "link": link, "desc": desc, "date": date, "guid": guid}


def _findtext(el, path: str) -> str:
    node = el.find(path, _NS)
    return node.text if node is not None and node.text else ""


def _findtext_first(el, paths: list[str]) -> str:
    for p in paths:
        node = el.find(p)
        if node is not None and node.text:
            return node.text
    return ""


# ---------------------------------------------------------------------------
# ソース（プラグイン）
# ---------------------------------------------------------------------------
class Source:
    """収集ソースの基底。fetch() が Article のリストを返す。"""

    badge = ""

    def fetch(self, keyword: dict) -> list[Article]:  # pragma: no cover - interface
        raise NotImplementedError

    def _safe_items(self, url: str) -> list[dict]:
        try:
            return list(_iter_rss_items(_fetch(url)))
        except Exception as exc:  # ソース障害は握りつぶして他ソースを生かす
            print(f"  [warn] fetch失敗 {url}: {exc}")
            return []


class GoogleNewsSource(Source):
    """Google News RSS。キーワード×類義語ごとに検索。無料・キー不要。"""

    def fetch(self, keyword: dict) -> list[Article]:
        out: list[Article] = []
        for query in keyword.get("queries", []):
            q = urllib.parse.quote(query)
            url = f"https://news.google.com/rss/search?q={q}&hl=ja&gl=JP&ceid=JP:ja"
            for it in self._safe_items(url):
                src = it["title"].rsplit(" - ", 1)[-1] if " - " in it["title"] else "Google News"
                title = it["title"].rsplit(" - ", 1)[0] if " - " in it["title"] else it["title"]
                out.append(Article(
                    title=title.strip(),
                    source=src.strip(),
                    published_at=_parse_date(it["date"]),
                    url=it["link"],
                    raw_text=_clean_html(it["desc"]),
                    guid=it["guid"] or it["link"],
                ))
        return out


class PrTimesSource(Source):
    """PR TIMES 全体RSS を取得しキーワードでフィルタ。1日数百件流れるので GUID 重複排除必須。"""

    def __init__(self, feed_url: str):
        self.feed_url = feed_url

    def fetch(self, keyword: dict) -> list[Article]:
        queries = keyword.get("queries", [])
        out: list[Article] = []
        for it in self._safe_items(self.feed_url):
            haystack = f"{it['title']} {it['desc']}"
            if any(q.split()[0] in haystack for q in queries):
                out.append(Article(
                    title=_clean_html(it["title"]),
                    source="PR TIMES",
                    published_at=_parse_date(it["date"]),
                    url=it["link"],
                    raw_text=_clean_html(it["desc"]),
                    guid=it["guid"] or it["link"],
                    badge="PR TIMES",
                ))
        return out


class PubMedSource(Source):
    """PubMed E-utilities（esearch + efetch）。健康系の一次ソース。キー不要・3req/秒まで無料。"""

    badge = "PubMed"
    BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"

    def fetch(self, keyword: dict) -> list[Article]:
        out: list[Article] = []
        for query in keyword.get("pubmedQueries", []):
            try:
                ids = self._esearch(query)
                time.sleep(0.4)
                if ids:
                    out.extend(self._efetch(ids))
                    time.sleep(0.4)
            except Exception as exc:
                print(f"  [warn] PubMed失敗 {query}: {exc}")
        return out

    def _esearch(self, query: str, retmax: int = 5) -> list[str]:
        q = urllib.parse.quote(query)
        url = (f"{self.BASE}/esearch.fcgi?db=pubmed&term={q}"
               f"&retmax={retmax}&sort=date&retmode=json")
        import json
        data = json.loads(_fetch(url))
        return data.get("esearchresult", {}).get("idlist", [])

    def _efetch(self, ids: list[str]) -> list[Article]:
        idstr = ",".join(ids)
        url = f"{self.BASE}/efetch.fcgi?db=pubmed&id={idstr}&retmode=xml"
        root = ET.fromstring(_fetch(url))
        out: list[Article] = []
        for art in root.iter("PubmedArticle"):
            pmid = (art.findtext(".//PMID") or "").strip()
            title = _clean_html(art.findtext(".//ArticleTitle") or "")
            abstract = " ".join(
                (a.text or "") for a in art.iter("AbstractText")
            ).strip()
            journal = (art.findtext(".//Journal/Title") or "PubMed").strip()
            year = art.findtext(".//PubDate/Year") or art.findtext(".//PubDate/MedlineDate") or ""
            month = art.findtext(".//PubDate/Month") or "1"
            day = art.findtext(".//PubDate/Day") or "1"
            pub = self._pub_date(year, month, day)
            if not title:
                continue
            out.append(Article(
                title=title,
                source=journal,
                published_at=pub,
                url=f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
                raw_text=_clean_html(abstract),
                guid=f"pubmed:{pmid}",
                badge="PubMed",
            ))
        return out

    @staticmethod
    def _pub_date(year: str, month: str, day: str) -> datetime:
        months = {m: i for i, m in enumerate(
            ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], start=1)}
        y = re.search(r"\d{4}", year or "")
        if not y:
            return datetime.now(JST)
        mo = months.get((month or "")[:3], None)
        if mo is None:
            mo = int(month) if (month or "").isdigit() else 1
        try:
            return datetime(int(y.group()), mo, int(day) if str(day).isdigit() else 1, tzinfo=JST)
        except ValueError:
            return datetime(int(y.group()), 1, 1, tzinfo=JST)


class HealthFeedSource(Source):
    """The Lancet 等の公式ジャーナルRSS。キーワード（英語）でフィルタ。"""

    badge = "The Lancet"

    def __init__(self, feed_url: str, name_hint: str = ""):
        self.feed_url = feed_url
        self.name_hint = name_hint

    def fetch(self, keyword: dict) -> list[Article]:
        filters = [f.lower() for f in keyword.get("healthFeedFilter", [])]
        out: list[Article] = []
        for it in self._safe_items(self.feed_url):
            haystack = f"{it['title']} {it['desc']}".lower()
            if filters and not any(f in haystack for f in filters):
                continue
            badge = "The Lancet" if "lancet" in self.feed_url.lower() else (self.name_hint or "Journal")
            out.append(Article(
                title=_clean_html(it["title"]),
                source=badge,
                published_at=_parse_date(it["date"]),
                url=it["link"],
                raw_text=_clean_html(it["desc"]),
                guid=it["guid"] or it["link"],
                badge=badge,
            ))
        return out


# ---------------------------------------------------------------------------
# キーワード単位の収集
# ---------------------------------------------------------------------------
_BLOCK_DOMAINS = {"google.com/url", "removed.com"}


def _domain(url: str) -> str:
    try:
        return urllib.parse.urlparse(url).netloc.lower()
    except ValueError:
        return ""


def collect_for_keyword(keyword: dict, config: dict) -> list[Article]:
    sources: list[Source] = [GoogleNewsSource()]

    for feed in config.get("extraFeeds", []):
        if "prtimes" in feed:
            sources.append(PrTimesSource(feed))

    if keyword.get("pubmedQueries"):
        sources.append(PubMedSource())
    for feed in keyword.get("healthFeeds", []):
        sources.append(HealthFeedSource(feed))

    collected: list[Article] = []
    for src in sources:
        collected.extend(src.fetch(keyword))

    return _dedupe_and_filter(collected, keyword, config)


def _dedupe_and_filter(articles: list[Article], keyword: dict, config: dict) -> list[Article]:
    exclude = keyword.get("exclude", [])
    max_n = config.get("maxArticlesPerKeyword", 10)

    seen_guid: set[str] = set()
    seen_title: set[str] = set()
    result: list[Article] = []

    # 新着順（新しい記事を優先）
    articles.sort(key=lambda a: a.published_at, reverse=True)

    for a in articles:
        if not a.title or not a.url:
            continue
        if any(bad in _domain(a.url) for bad in _BLOCK_DOMAINS):
            continue
        text = f"{a.title} {a.raw_text}"
        if any(ex and ex in text for ex in exclude):
            continue
        key = a.guid or a.url
        norm_title = re.sub(r"\s+", "", a.title)[:40]
        if key in seen_guid or norm_title in seen_title:
            continue
        seen_guid.add(key)
        seen_title.add(norm_title)
        result.append(a)
        if len(result) >= max_n:
            break
    return result


def collect_all(config: dict) -> list[dict]:
    """config 全体を収集。keywords ごとに Article リストを持つ辞書を返す。"""
    out = []
    for kw in config.get("keywords", []):
        print(f"[collect] {kw['label']} …")
        articles = collect_for_keyword(kw, config)
        print(f"          {len(articles)} 件")
        out.append({"keyword": kw["label"], "articles": articles})
    return out


if __name__ == "__main__":
    import json
    import pathlib

    cfg = json.loads((pathlib.Path(__file__).resolve().parents[1] / "config.json").read_text("utf-8"))
    for group in collect_all(cfg):
        print(f"\n=== {group['keyword']} ===")
        for a in group["articles"]:
            print(f"- {a.title}  [{a.source}]  {a.published_at.date()}")
