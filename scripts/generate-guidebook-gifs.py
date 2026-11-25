#!/usr/bin/env python3
"""Build guidebook GIFs from real-browser interaction frames.

`scripts/screenshots.mjs` records the real React UI and writes a manifest of
captured frames and their intended durations. This script resizes and encodes
those frames, then writes a still poster used for reduced-motion and playback
controls. Requires ImageMagick's `convert` command.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "public" / "guidebook"
SIZE = (800, 500)
CHAPTERS = (
    "navigation",
    "servers",
    "server-actions",
    "wardrobe",
    "account",
    "settings",
)


def run(command: list[str]) -> None:
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)


def encode_chapter(name: str, entries: list[dict], temp: Path) -> tuple[Path, Path]:
    if len(entries) < 2:
        raise SystemExit(f"{name}: expected browser-captured start and end frames")

    originals = [Path(entry["file"]) for entry in entries]
    missing = [path for path in originals if not path.is_file()]
    if missing:
        raise SystemExit(f"{name}: missing browser frame {missing[0]}")

    # Build one palette per chapter from representative real frames. This keeps
    # UI colours stable while the cursor moves and avoids frame-to-frame shimmer.
    sample_indices = sorted({
        round(index * (len(originals) - 1) / min(23, len(originals) - 1))
        for index in range(min(23, len(originals)))
    })
    palette = temp / f"{name}-palette.png"
    palette_command = ["convert"]
    for index in sample_indices:
        palette_command.extend([str(originals[index]), "-resize", "160x100!"])
    palette_command.extend(["-append", "-colors", "128", "-dither", "None", str(palette)])
    run(palette_command)

    converted: list[Path] = []
    for index, original in enumerate(originals):
        frame = temp / f"{name}-{index:04d}.png"
        run([
            "convert", str(original), "-resize", f"{SIZE[0]}x{SIZE[1]}!",
            "-remap", str(palette), "-dither", "None", str(frame),
        ])
        converted.append(frame)

    gif = temp / f"{name}.gif"
    command = ["convert"]
    for entry, frame in zip(entries, converted, strict=True):
        centiseconds = max(2, round(int(entry.get("durationMs", 50)) / 10))
        command.extend(["-delay", str(centiseconds), str(frame)])
    command.extend(["-loop", "0", "-layers", "Optimize", str(gif)])
    run(command)

    poster = temp / f"{name}.png"
    run(["convert", str(originals[0]), "-resize", f"{SIZE[0]}x{SIZE[1]}!", str(poster)])
    return gif, poster


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()

    if shutil.which("convert") is None:
        raise SystemExit("ImageMagick `convert` is required to generate guidebook GIFs.")
    if not args.manifest.is_file():
        raise SystemExit(f"Missing browser-capture manifest: {args.manifest}")

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if set(manifest) != set(CHAPTERS):
        raise SystemExit("The browser-capture manifest must contain all six guidebook chapters.")

    DEST.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".guidebook-build-", dir=DEST) as temp_dir:
        temp = Path(temp_dir)
        outputs: dict[str, tuple[Path, Path]] = {}
        for name in CHAPTERS:
            outputs[name] = encode_chapter(name, manifest[name], temp)

        # Publish only after every chapter encoded successfully.
        for name in CHAPTERS:
            gif, poster = outputs[name]
            shutil.move(str(gif), DEST / f"{name}.gif")
            shutil.move(str(poster), DEST / f"{name}.png")
            print(f"{name}: {DEST / f'{name}.gif'} ({(DEST / f'{name}.gif').stat().st_size // 1024} KiB)")


if __name__ == "__main__":
    main()
