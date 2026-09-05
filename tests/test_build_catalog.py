import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from scripts.build_catalog import build, extract_archive, load_config, normalize_url


class CatalogTests(unittest.TestCase):
    def test_normalize_url(self):
        self.assertEqual(normalize_url("HTTPS://Example.COM/path#frag"), "https://example.com/path")
        self.assertIsNone(normalize_url("ftp://example.com/file"))
        self.assertIsNone(normalize_url("https://localhost/path"))

    def test_fixture_build(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            source = td / "curlie-rdf"
            source.mkdir()
            (source / "rdf-Science-s.tsv").write_text(
                "1\tScience/Astronomy\t2\tAstronomy sites\n"
                "2\tShopping/Adult\t1\tBlocked\n",
                encoding="utf-8",
            )
            (source / "rdf-Science-c.tsv").write_text(
                "https://example.com/\tExample Science\tDesc\t1\n"
                "https://example.com/login\tLogin\tDesc\t1\n"
                "https://blocked.example/\tBlocked\tDesc\t2\n",
                encoding="utf-8",
            )
            archive = td / "fixture.tar.gz"
            with tarfile.open(archive, "w:gz") as tf:
                tf.add(source, arcname="curlie-rdf")
            extracted = extract_archive(archive, td / "out")
            output = td / "site-data"
            config = load_config(Path("config/catalog.json"))
            manifest = build(extracted, output, config)
            self.assertEqual(manifest["entries"], 1)
            self.assertEqual(manifest["roots"]["science"]["count"], 1)
            self.assertEqual(manifest["topics"]["space"]["count"], 1)
            rows = json.loads((output / "roots" / "science" / "0000.json").read_text())
            self.assertEqual(rows[0][0], "https://example.com/")


if __name__ == "__main__":
    unittest.main()
