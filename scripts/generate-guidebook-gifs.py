#!/usr/bin/env python3
"""Build guidebook GIFs from real-browser interaction frames.

`scripts/screenshots.mjs` records the real React UI and writes a manifest of
captured frames and their intended durations. This script builds a shared
256-colour palette with ImageMagick, remaps native Full HD frames, and assembles
the GIF with Pillow's lower-memory encoder. It also writes a still poster used
for reduced-motion and playback controls.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

try:
    from PIL import Image
except ImportError as error:
    raise SystemExit(
        "Pillow is required for Full-HD GIF encoding. "
        "Install it with: python3 -m pip install -r scripts/requirements-guidebook.txt"
    ) from error

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "public" / "guidebook"
SIZE = (1920, 1080)
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

    # Never upscale captures to satisfy the deliverable size. Screenshots must
    # come from the real browser at native Full HD; reject stale or synthetic
    # lower-resolution frames rather than silently stretching them.
    for original in originals:
        dimensions = subprocess.run(
            ["identify", "-format", "%w %h", str(original)],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        if dimensions != f"{SIZE[0]} {SIZE[1]}":
            raise SystemExit(
                f"{name}: browser frame {original} is {dimensions}, expected native {SIZE[0]} {SIZE[1]}"
            )

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
    palette_command.extend(["-append", "-colors", "256", "-dither", "None", str(palette)])
    run(palette_command)

    converted: list[Path] = []
    for index, original in enumerate(originals):
        frame = temp / f"{name}-{index:04d}.png"
        run([
            "convert", str(original),
            "-remap", str(palette), "-dither", "None", str(frame),
        ])
        converted.append(frame)

    gif = temp / f"{name}.gif"
    frames = []
    durations = []
    try:
        for entry, frame_path in zip(entries, converted, strict=True):
            frame = Image.open(frame_path)
            if frame.mode != "P":
                frame = frame.convert("P")
            frames.append(frame)
            centiseconds = max(2, round(int(entry.get("durationMs", 50)) / 10))
            durations.append(centiseconds * 10)
        frames[0].save(
            gif,
            format="GIF",
            save_all=True,
            append_images=frames[1:],
            duration=durations,
            loop=0,
            optimize=True,
            disposal=1,
        )
    finally:
        for frame in frames:
            frame.close()

    poster = temp / f"{name}.png"
    run(["convert", str(originals[0]), str(poster)])
    return gif, poster


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()

    if shutil.which("convert") is None or shutil.which("identify") is None:
        raise SystemExit("ImageMagick `convert` and `identify` are required to generate guidebook GIFs.")
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
