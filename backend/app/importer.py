import hashlib
import re
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from pypdf import PdfReader
from PIL import Image
import pytesseract

from .database import app_data_dir


NAME_PATTERNS = (
    re.compile(r"^\s*([A-Z][A-Za-z'\-]+),\s*([A-Z][A-Za-z'\-]+)\s*$"),
    re.compile(r"^\s*(?:Name\s*:\s*)?([A-Z][A-Za-z'\-]+)\s+([A-Za-z][A-Za-z'\-]*(?:\s+[A-Za-z][A-Za-z'\-]*){0,2})\s*$"),
)


def _checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _candidates(text: str) -> list[tuple[str, str]]:
    candidates: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for line in text.splitlines():
        line = " ".join(line.split())
        for pattern_index, pattern in enumerate(NAME_PATTERNS):
            match = pattern.match(line)
            if not match:
                continue
            first, last = (match.group(2), match.group(1)) if pattern_index == 0 else match.groups()
            # Ignore all-caps headings such as the course code while retaining
            # multi-part names like "Daniel Ambrosio Palma" and "Ben de Hoyos".
            if not any(character.islower() for character in f"{first}{last}"):
                continue
            key = (first, last)
            if key not in seen:
                candidates.append(key)
                seen.add(key)
            break
    return candidates


def _positioned_candidates(image: Image.Image) -> list[tuple[str, str, int]]:
    """Read name lines from the right column and retain their page position."""
    right_edge = int(image.width * 0.45)
    right_column = image.crop((right_edge, 0, image.width, image.height))
    data = pytesseract.image_to_data(
        right_column, config="--psm 4", output_type=pytesseract.Output.DICT
    )
    lines: dict[tuple[int, int, int], list[tuple[str, int]]] = {}
    for index, word in enumerate(data["text"]):
        word = word.strip()
        if not word:
            continue
        key = (data["block_num"][index], data["par_num"][index], data["line_num"][index])
        lines.setdefault(key, []).append((word, data["top"][index]))

    result = []
    for words in lines.values():
        name = _candidates(" ".join(word for word, _ in words))
        if name:
            result.append((*name[0], sum(top for _, top in words) // len(words)))
    return result


def _row_fallback_candidates(image: Image.Image) -> list[tuple[str, str, int]]:
    """Read individual name cells when page-layout OCR misses a roster row."""
    right_column = image.crop((int(image.width * 0.50), 0, image.width, image.height))
    candidates = []
    # The supported roster template has three equally spaced name cells. Cropping
    # each one prevents one weak cell from affecting OCR of the entire page.
    for fraction in (0.216, 0.435, 0.655):
        center = int(image.height * fraction)
        cell = right_column.crop((0, center - int(image.height * 0.09), right_column.width, center + int(image.height * 0.09)))
        names = _candidates(pytesseract.image_to_string(cell, config="--psm 7"))
        if names:
            candidates.append((*names[0], center))
    return candidates


def _save_portrait(image: Image.Image, course_id: str, page_number: int, ordinal: int, name_y: int) -> str:
    """Save the photo cell to local application storage beside its detected name."""
    portrait_dir = app_data_dir() / "assets" / course_id
    portrait_dir.mkdir(parents=True, exist_ok=True)
    width, height = image.size
    crop = image.crop(
        (
            int(width * 0.10),
            max(0, name_y - int(height * 0.13)),
            int(width * 0.45),
            min(height, name_y + int(height * 0.13)),
        )
    ).convert("RGB")
    filename = f"page-{page_number:02d}-person-{ordinal:02d}.jpg"
    crop.save(portrait_dir / filename, "JPEG", quality=88, optimize=True)
    return f"{course_id}/{filename}"


class MissingOcrTools(RuntimeError):
    """Raised when the local OCR binaries are not installed."""


def _ocr_pdf(path: Path, course_id: str) -> tuple[str, int, list[dict]]:
    """Render image-based PDFs locally, then OCR them page by page."""
    # Scanned rosters need poppler and tesseract. Docker installs both; a native
    # run may not have them, and "No such file or directory: 'pdftoppm'" tells
    # a user nothing about what to do.
    if shutil.which("pdftoppm") is None:
        raise MissingOcrTools(
            "This roster has no embedded text, so it needs local OCR, and poppler is not installed. "
            "Run Familiar with Docker (which includes it), or install poppler and tesseract on this machine."
        )
    with tempfile.TemporaryDirectory(prefix="flashcards-ocr-") as directory:
        output_prefix = Path(directory) / "page"
        subprocess.run(
            ["pdftoppm", "-r", "220", "-png", str(path), str(output_prefix)],
            check=True,
            capture_output=True,
            text=True,
        )
        pages = sorted(Path(directory).glob("page-*.png"))
        page_text = []
        candidates = []
        seen: set[tuple[str, str]] = set()
        for page_number, page in enumerate(pages, start=1):
            with Image.open(page) as image:
                # These roster PDFs place the name in a clean right-hand column.
                # OCR that region separately because face photos and table rules make
                # whole-page OCR significantly less reliable.
                right_column = image.crop((int(image.width * 0.45), 0, image.width, image.height))
                page_text.append(pytesseract.image_to_string(image, config="--psm 6"))
                page_text.append(pytesseract.image_to_string(right_column, config="--psm 4"))
                detected = _positioned_candidates(image)
                if len(detected) < 3:
                    detected.extend(_row_fallback_candidates(image))
                for ordinal, (first_name, last_name, name_y) in enumerate(detected, start=1):
                    key = (first_name, last_name)
                    if key in seen:
                        continue
                    seen.add(key)
                    candidates.append(
                        {
                            "first_name": first_name,
                            "last_name": last_name,
                            "image_path": _save_portrait(image, course_id, page_number, ordinal, name_y),
                        }
                    )
        text = "\n".join(page_text)
        return text, len(pages), candidates


def import_pdf(path: Path, original_filename: str, conn, course_id: str | None = None, title: str | None = None) -> dict:
    """Extract people from a roster PDF into a course the caller chose.

    The caller says which course this roster belongs to, so nothing here has to
    guess. That is what makes it safe to build one class from several exports,
    to re-import an updated roster without creating a duplicate class, and to
    merge two sections deliberately. Passing no course creates one.

    New people arrive unreviewed, so they go through the same approval step as
    the very first import. People already in the course are left exactly as they
    are, keeping their study history; only a missing portrait is filled in.
    """
    checksum = _checksum(path)
    created = course_id is None
    now = datetime.now(timezone.utc).isoformat()

    if created:
        course_id = f"course-{uuid.uuid4().hex[:12]}"
    else:
        if not conn.execute("SELECT 1 FROM courses WHERE id = ?", (course_id,)).fetchone():
            raise ValueError("That course no longer exists.")

    started_at = now
    run = conn.execute(
        "INSERT INTO import_runs (source_filename, source_checksum, started_at, status) VALUES (?, ?, ?, 'running')",
        (original_filename, checksum, started_at),
    )
    try:
        reader = PdfReader(str(path))
        embedded_text = "\n".join(page.extract_text() or "" for page in reader.pages)
        candidates = [
            {"first_name": first_name, "last_name": last_name, "image_path": None}
            for first_name, last_name in _candidates(embedded_text)
        ]
        text = embedded_text
        ocr_pages = 0
        if not candidates:
            ocr_text, ocr_pages, candidates = _ocr_pdf(path, course_id)
            text = f"{embedded_text}\n{ocr_text}"

        if created:
            conn.execute(
                "INSERT INTO courses (id, title, source_filename, imported_at) VALUES (?, ?, ?, ?)",
                (course_id, title or Path(original_filename).stem.replace("_", " "), original_filename, now),
            )

        # Exact first-and-last-name matching, mirroring core/src/import.ts.
        # A fuzzy match would silently merge two people's histories; an extra
        # candidate only costs a click during review.
        existing_cards = {
            (row["first_name"].strip(), row["last_name"].strip()): row["id"]
            for row in conn.execute("SELECT id, first_name, last_name FROM cards WHERE course_id = ?", (course_id,))
        }
        added = 0
        already_present = 0
        for candidate in candidates:
            key = (candidate["first_name"].strip(), candidate["last_name"].strip())
            if key in existing_cards:
                already_present += 1
                if candidate["image_path"]:
                    conn.execute(
                        "UPDATE cards SET image_path = COALESCE(image_path, ?) WHERE id = ?",
                        (candidate["image_path"], existing_cards[key]),
                    )
                continue
            card_id = f"{course_id}-card-{uuid.uuid4().hex[:8]}"
            conn.execute(
                "INSERT INTO cards (id, course_id, first_name, last_name, image_path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (card_id, course_id, candidate["first_name"], candidate["last_name"], candidate["image_path"], now),
            )
            conn.execute("INSERT INTO card_progress (card_id) VALUES (?)", (card_id,))
            existing_cards[key] = card_id
            added += 1

        warning = None
        if not candidates:
            warning = "No high-confidence name lines were found, even after local OCR. Add people manually, or check that this is a 3-students-per-page BYU Flashcards export."
        elif not added:
            warning = "Everybody in this roster is already in the course, so nothing was added."
        conn.execute(
            "UPDATE import_runs SET finished_at = ?, status = 'complete', pages = ?, extracted_text_length = ?, candidate_count = ?, warning = ? WHERE id = ?",
            (now, len(reader.pages), len(text), len(candidates), warning, run.lastrowid),
        )
        return {
            "status": "created" if created else "updated",
            "course_id": course_id,
            "pages": len(reader.pages),
            "ocr_pages": ocr_pages,
            "found": len(candidates),
            "added": added,
            "already_present": already_present,
            "warning": warning,
        }
    except Exception as exc:
        conn.execute(
            "UPDATE import_runs SET finished_at = ?, status = 'failed', warning = ? WHERE id = ?",
            (datetime.now(timezone.utc).isoformat(), str(exc), run.lastrowid),
        )
        raise
