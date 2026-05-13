from __future__ import annotations

import argparse
import os
from pathlib import Path

import oss2


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--file", required=True)
    parser.add_argument("--key", required=True)
    args = parser.parse_args()

    key_id = os.environ.get("OSS_ACCESS_KEY_ID")
    key_secret = os.environ.get("OSS_ACCESS_KEY_SECRET")
    if not key_id or not key_secret:
        raise SystemExit("OSS_ACCESS_KEY_ID and OSS_ACCESS_KEY_SECRET must be set.")

    archive = Path(args.file)
    if not archive.is_file():
        raise SystemExit(f"File not found: {archive}")

    auth = oss2.Auth(key_id, key_secret)
    bucket = oss2.Bucket(auth, args.endpoint, args.bucket)
    bucket.put_object_from_file(args.key, str(archive))
    print(f"Uploaded {archive} to oss://{args.bucket}/{args.key}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
