"""Build OFL-licensed Unseen Sans shards from a pinned Adobe release.

Only needed to regenerate assets; deployed applications need no Python tools.
Install fonttools==4.62.1 and brotli==1.2.0 in an isolated environment first.
"""

import hashlib
import json
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from urllib.request import urlopen

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "server/public"
CACHE = ROOT / ".tools/fonts"
OUTPUT = PUBLIC / "assets/fonts/unseen-sans"
REVISION = "6c709ca72d3d7c46ab42ebecc1a26e7d69595a37"
UPSTREAM = f"https://raw.githubusercontent.com/adobe-fonts/source-han-sans/{REVISION}"
SOURCE_PATH = "Variable/WOFF2/OTF/SourceHanSansSC-VF.otf.woff2"
SOURCE_SHA256 = "085cc88c530b9c434165ab926f81608a55b24e60e05719f3d41340ac45d9c62f"
LICENSE_SHA256 = "fcac737e761ec63dbfbdce11030a1780161920d80315edba9c8beff1c2bac5a2"
FAMILY = "Unseen Sans"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def download(relative, expected=None):
    dest = CACHE / Path(relative).name
    if not dest.exists():
        with urlopen(f"{UPSTREAM}/{relative}", timeout=120) as response:
            dest.write_bytes(response.read())
    if expected and digest(dest.read_bytes()) != expected:
        raise ValueError(f"Upstream checksum mismatch: {relative}")
    return dest


def ranges(codepoints):
    runs = []
    for cp in sorted(codepoints):
        if runs and cp == runs[-1][1] + 1:
            runs[-1][1] = cp
        else:
            runs.append([cp, cp])
    return ",".join(f"U+{a:X}" if a == b else f"U+{a:X}-{b:X}" for a, b in runs)


def variation_sequences(font):
    return {(selector, base) for table in font["cmap"].tables if table.format == 14
            for selector, entries in table.uvsDict.items() for base, _ in entries}


def build_shard(task):
    label, codepoints = task
    font = TTFont(CACHE / Path(SOURCE_PATH).name, recalcTimestamp=False)
    original_sequences = variation_sequences(font)
    # Rename every localized family/full/PostScript/unique name, including named
    # variable instances. Keep upstream copyright, trademark, author and OFL text.
    for record in list(font["name"].names):
        value = record.toUnicode()
        if record.nameID in {1, 4, 16, 21}:
            value = FAMILY
        elif record.nameID == 3:
            value = "2.005;UnseenSans;WebSubset-1"
        elif record.nameID == 6 or "SourceHanSans" in value:
            value = value.replace("SourceHanSansSCVF", "UnseenSans")
        elif record.nameID == 25:
            value = "UnseenSans"
        else:
            continue
        font["name"].setName(value, record.nameID, record.platformID,
                             record.platEncID, record.langID)
    options = subset.Options()
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.name_legacy = True
    options.layout_features = ["*"]
    options.notdef_glyph = True
    options.notdef_outline = True
    # Retain variation sequences whenever their base belongs to this shard.
    selectors = {selector for selector, _ in original_sequences}
    job = subset.Subsetter(options=options)
    job.populate(unicodes=set(codepoints) | selectors)
    job.subset(font)
    font.flavor = "woff2"
    temporary = OUTPUT / f"{label}.woff2"
    font.save(temporary)
    data = temporary.read_bytes()
    sha256 = digest(data)
    filename = f"{label}-{sha256[:12]}.woff2"
    temporary.replace(OUTPUT / filename)
    verified = TTFont(OUTPUT / filename)
    assert set(verified.getBestCmap()) == set(codepoints), label
    assert variation_sequences(verified) == {
        (s, b) for s, b in original_sequences if b in codepoints
    }, label
    assert verified["name"].getDebugName(1) == FAMILY
    assert all("Source" not in r.toUnicode() for r in verified["name"].names
               if r.nameID in {1, 3, 4, 6, 16, 21, 25} or r.nameID >= 265)
    assert all(verified["name"].getDebugName(n) for n in (0, 7, 8, 9, 13, 14))
    axis = verified["fvar"].axes[0]
    assert (axis.axisTag, axis.minValue, axis.maxValue) == ("wght", 250, 900)
    return {"file": filename, "bytes": len(data), "sha256": sha256,
            "characters": len(codepoints), "unicodeRange": ranges(codepoints)}


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    source = download(SOURCE_PATH, SOURCE_SHA256)
    license_file = download("LICENSE.txt", LICENSE_SHA256)
    (OUTPUT / "LICENSE.txt").write_bytes(license_file.read_bytes())
    font = TTFont(source)
    all_characters = set(font.getBestCmap())
    # Fast first paint: all current UI text + basic Latin share one small file.
    # Everything else remains available; this is not a UI-only font subset.
    ui = set(range(0x20, 0x100))
    for file in sorted(PUBLIC.iterdir()):
        if file.suffix in {".html", ".css", ".js", ".mjs"}:
            ui.update(map(ord, file.read_text(encoding="utf-8")))
    ui &= all_characters
    remainder = sorted(all_characters - ui)
    tasks = [("ui", sorted(ui))] + [
        (f"text-{i // 1024:02d}", remainder[i:i + 1024])
        for i in range(0, len(remainder), 1024)
    ]
    assert set().union(*(set(cps) for _, cps in tasks)) == all_characters
    assert sum(len(cps) for _, cps in tasks) == len(all_characters)
    with ProcessPoolExecutor(max_workers=2) as pool:
        assets = []
        for asset in pool.map(build_shard, tasks):
            assets.append(asset)
            print(f"Built {asset['file']}: {asset['bytes']} bytes", flush=True)
    css = ["/* Generated by scripts/build-fonts.py; Adobe derivative, SIL OFL 1.1. */"]
    for asset in assets:
        css.append("@font-face {\n"
                   f"  font-family: '{FAMILY}';\n"
                   "  font-style: normal;\n  font-weight: 250 900;\n"
                   "  font-display: swap;\n"
                   f"  src: url('./{asset['file']}') format('woff2');\n"
                   f"  unicode-range: {asset['unicodeRange']};\n}}")
    (OUTPUT / "fonts.css").write_text("\n".join(css) + "\n", encoding="utf-8", newline="\n")
    manifest = {"upstream": f"{UPSTREAM}/{SOURCE_PATH}", "version": "2.005R",
                "upstreamSha256": SOURCE_SHA256, "family": FAMILY,
                "licenseSha256": digest(license_file.read_bytes()),
                "weightRange": [250, 900], "sourceCharacters": len(all_characters),
                "variationSequences": len(variation_sequences(font)),
                "totalFontBytes": sum(asset["bytes"] for asset in assets),
                "assets": assets}
    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"Total: {len(assets)} files, {manifest['totalFontBytes']} font bytes")


if __name__ == "__main__":
    main()
