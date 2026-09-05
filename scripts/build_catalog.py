#!/usr/bin/env python3
"""Build a compact, sharded Stumble catalogue from the Curlie directory dump.

Curlie's current export is a tar.gz containing UTF-8 TSV files:
  * rdf-*-c.tsv: URL, title, description, category_id
  * rdf-*-s.tsv: category_id, category_path, site_count, description, ...

The output intentionally omits descriptions to keep the GitHub Pages payload small.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
import time
from typing import Dict, Iterator, List, Tuple
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

DEFAULT_DOWNLOAD = "https://curlie.org/directory-dl"
USER_AGENT = "StumblePersonalCatalogue/1.0 (+https://github.com/bojango/stumble)"


def load_config(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    req = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=120) as response, destination.open("wb") as out:
        shutil.copyfileobj(response, out, length=1024 * 1024)


def extract_archive(archive: Path, destination: Path) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tf:
        root = destination.resolve()
        for member in tf.getmembers():
            target = (destination / member.name).resolve()
            if target != root and root not in target.parents:
                raise RuntimeError(f"Unsafe archive member: {member.name}")
        tf.extractall(destination)
    candidates = list(destination.rglob("rdf-*-c.tsv"))
    if not candidates:
        raise RuntimeError("No Curlie content TSV files found after extraction")
    return candidates[0].parent


def read_categories(root: Path) -> Dict[str, str]:
    categories: Dict[str, str] = {}
    for path in sorted(root.glob("rdf-*-s.tsv")):
        with path.open("r", encoding="utf-8", errors="replace", newline="") as handle:
            reader = csv.reader(handle, delimiter="\t")
            for row in reader:
                if len(row) < 2:
                    continue
                category_id = row[0].strip()
                category_path = row[1].strip().strip("/")
                if category_id and category_path:
                    categories[category_id] = category_path
    return categories


def normalize_url(raw: str) -> str | None:
    raw = raw.strip()
    try:
        parts = urlsplit(raw)
    except ValueError:
        return None
    if parts.scheme.lower() not in {"http", "https"} or not parts.netloc:
        return None
    host = parts.hostname
    if not host or "." not in host:
        return None
    if parts.username or parts.password:
        return None
    netloc = host.lower()
    if parts.port and not ((parts.scheme.lower() == "http" and parts.port == 80) or (parts.scheme.lower() == "https" and parts.port == 443)):
        netloc = f"{netloc}:{parts.port}"
    path = parts.path or "/"
    return urlunsplit((parts.scheme.lower(), netloc, path, parts.query, ""))


def blocked_url(url: str, config: dict) -> bool:
    lower = url.lower()
    path = urlsplit(url).path.lower()
    if any(token in lower for token in config["blocked_url_tokens"]):
        return True
    if any(path.endswith(ext) for ext in config["blocked_extensions"]):
        return True
    return False


def blocked_category(category: str, config: dict) -> bool:
    return any(category == prefix or category.startswith(prefix + "/") for prefix in config["blocked_category_prefixes"])


def safe_title(title: str) -> str:
    title = re.sub(r"\s+", " ", title).strip()
    return title[:180]


def slug(value: str) -> str:
    value = value.strip().lower().replace("_", "-")
    value = re.sub(r"[^a-z0-9-]+", "-", value)
    return re.sub(r"-+", "-", value).strip("-") or "other"


class ShardWriter:
    def __init__(self, output: Path, namespace: str, shard_size: int):
        self.output = output
        self.namespace = namespace
        self.shard_size = shard_size
        self.buffers: Dict[str, List[list]] = {}
        self.indices: Dict[str, int] = {}
        self.counts: Dict[str, int] = {}

    def add(self, group: str, entry: list) -> None:
        key = slug(group)
        buf = self.buffers.setdefault(key, [])
        buf.append(entry)
        self.counts[key] = self.counts.get(key, 0) + 1
        if len(buf) >= self.shard_size:
            self.flush(key)

    def flush(self, key: str) -> None:
        buf = self.buffers.get(key)
        if not buf:
            return
        idx = self.indices.get(key, 0)
        folder = self.output / self.namespace / key
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{idx:04d}.json"
        path.write_text(json.dumps(buf, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        self.indices[key] = idx + 1
        self.buffers[key] = []

    def finish(self) -> dict:
        for key in list(self.buffers):
            self.flush(key)
        return {
            key: {"count": self.counts[key], "shards": self.indices.get(key, 0)}
            for key in sorted(self.counts)
        }


def category_root(path: str) -> str:
    return path.split("/", 1)[0] if path else "Other"


def matching_topics(path: str, topic_prefixes: dict) -> List[str]:
    out: List[str] = []
    for topic, prefixes in topic_prefixes.items():
        if any(path == prefix or path.startswith(prefix + "/") for prefix in prefixes):
            out.append(topic)
    return out


def iter_sites(root: Path) -> Iterator[Tuple[str, str, str]]:
    for path in sorted(root.glob("rdf-*-c.tsv")):
        with path.open("r", encoding="utf-8", errors="replace", newline="") as handle:
            reader = csv.reader(handle, delimiter="\t")
            for row in reader:
                if len(row) < 4:
                    continue
                yield row[0], row[1], row[3]


def build(curlie_root: Path, output: Path, config: dict) -> dict:
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)

    categories = read_categories(curlie_root)
    shard_size = int(config.get("shard_size", 4000))
    roots = ShardWriter(output, "roots", shard_size)
    topics = ShardWriter(output, "topics", shard_size)

    seen: set[str] = set()
    accepted = 0
    rejected = 0
    started = time.time()

    for raw_url, raw_title, category_id in iter_sites(curlie_root):
        category = categories.get(category_id, "Other")
        url = normalize_url(raw_url)
        if not url or url in seen or blocked_url(url, config) or blocked_category(category, config):
            rejected += 1
            continue
        seen.add(url)
        root_name = category_root(category)
        topic_names = matching_topics(category, config.get("topic_prefixes", {}))
        entry = [url, safe_title(raw_title), category, topic_names]
        roots.add(root_name, entry)
        for topic in topic_names:
            topics.add(topic, entry)
        accepted += 1

    root_manifest = roots.finish()
    topic_manifest = topics.finish()
    informational = [slug(x) for x in config.get("informational_roots", [])]

    manifest = {
        "schema": 1,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "Curlie Directory",
        "source_url": "https://curlie.org/",
        "license": "CC BY 3.0",
        "entries": accepted,
        "rejected": rejected,
        "shard_size": shard_size,
        "roots": root_manifest,
        "topics": topic_manifest,
        "informational_roots": informational,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (output / "build-stats.json").write_text(
        json.dumps({**manifest, "build_seconds": round(time.time() - started, 2)}, indent=2),
        encoding="utf-8",
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, help="Use an existing Curlie tar.gz instead of downloading")
    parser.add_argument("--download-url", default=DEFAULT_DOWNLOAD)
    parser.add_argument("--output", type=Path, default=Path("_site/data"))
    parser.add_argument("--config", type=Path, default=Path("config/catalog.json"))
    args = parser.parse_args()

    config = load_config(args.config)
    with tempfile.TemporaryDirectory(prefix="stumble-curlie-") as td:
        temp = Path(td)
        archive = args.archive
        if archive is None:
            archive = temp / "curlie-rdf-all.tar.gz"
            print(f"Downloading Curlie data from {args.download_url}")
            download(args.download_url, archive)
        print(f"Extracting {archive}")
        curlie_root = extract_archive(archive, temp / "extract")
        print("Building catalogue")
        manifest = build(curlie_root, args.output, config)
        print(f"Built {manifest['entries']:,} unique entries; rejected {manifest['rejected']:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
