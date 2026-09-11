"""Rebuild a Familiar database from a portable bundle.

Disaster recovery, run outside the app:

    .venv/bin/python tools/restore_bundle.py backup.zip --into app-data/restored.sqlite3

It refuses to write into a database file that already exists unless you pass
--force, and it never merges into a database that already holds the bundle's
courses. Restore to a new file, check it, then move it into place yourself.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.app import database
from backend.app.portable import read_manifest, restore_bundle


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("bundle", type=Path, help="Bundle zip produced by /api/export")
    parser.add_argument("--into", type=Path, required=True, help="Database file to create")
    parser.add_argument("--assets", type=Path, help="Portrait directory (default: alongside --into)")
    parser.add_argument("--force", action="store_true", help="Allow writing into an existing database file")
    args = parser.parse_args()

    if not args.bundle.is_file():
        parser.error(f"No such bundle: {args.bundle}")
    if args.into.exists() and not args.force:
        parser.error(f"{args.into} already exists. Choose a new path, or pass --force if you are certain.")

    bundle = args.bundle.read_bytes()
    manifest = read_manifest(bundle)
    assets_dir = args.assets or args.into.parent / "assets"

    print(f"bundle exported {manifest['exported_at']}, progress={manifest['includes_progress']}")
    for course in manifest["courses"]:
        print(f"  {course['title']}: {len(course['cards'])} cards, {len(course.get('sessions') or [])} sessions")
    if manifest.get("missing_assets"):
        print(f"  warning: {len(manifest['missing_assets'])} portraits were missing when this bundle was made")

    args.into.parent.mkdir(parents=True, exist_ok=True)
    assets_dir.mkdir(parents=True, exist_ok=True)

    # `initialize_database` and `connection` both read this, so the restore
    # targets the requested file rather than whatever the app normally uses.
    database.os.environ["FLASHCARDS_APP_DATA_DIR"] = str(args.into.parent)
    original_database_path = database.database_path
    database.database_path = lambda: args.into
    try:
        database.initialize_database()
        with database.connection() as conn:
            restored = restore_bundle(bundle, conn, assets_dir)
    finally:
        database.database_path = original_database_path

    print(f"restored into {args.into}: {restored}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
