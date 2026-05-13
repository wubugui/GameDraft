"""将大文件按固定字节数切分为多个分片（例如满足 GitHub 单文件 100 MiB 限制）。"""
from __future__ import annotations

import argparse
import os


def main() -> None:
    p = argparse.ArgumentParser(description="Split a file into fixed-size chunks.")
    p.add_argument("input_path", help="源文件路径")
    p.add_argument("-o", "--out-dir", required=True, help="输出目录（不存在会创建）")
    p.add_argument(
        "-s",
        "--chunk-mib",
        type=int,
        default=99,
        help="每块 MiB（默认 99）",
    )
    args = p.parse_args()

    chunk = args.chunk_mib * 1024 * 1024
    src = os.path.abspath(args.input_path)
    if not os.path.isfile(src):
        raise SystemExit(f"not a file: {src}")

    base = os.path.basename(src)
    os.makedirs(args.out_dir, exist_ok=True)

    written: list[str] = []
    with open(src, "rb") as f:
        part = 0
        while True:
            data = f.read(chunk)
            if not data:
                break
            part += 1
            name = f"{base}.{part:03d}"
            out_path = os.path.join(args.out_dir, name)
            with open(out_path, "wb") as o:
                o.write(data)
            written.append(name)
            print(f"{name}\t{len(data)}")

    sub = os.path.basename(os.path.normpath(args.out_dir))
    copy_b_local = "copy /b " + "+".join(f'"{n}"' for n in written) + f" {base}.restored.zip"
    copy_b_root = (
        "copy /b "
        + "+".join(f'"{sub}\\{n}"' for n in written)
        + f" {base}.restored.zip"
    )
    readme = os.path.join(args.out_dir, "README_JOIN.txt")
    text = "\n".join(
        [
            "分片说明",
            "========",
            f"逻辑文件: {base}",
            f"每片约 {args.chunk_mib} MiB，共 {len(written)} 片；单片低于 GitHub 100 MiB 限制。",
            "",
            "在分片所在目录下，用 CMD 合并为可解压的 zip：",
            copy_b_local,
            "",
            "在仓库根目录下合并（分片在子目录时）：",
            copy_b_root,
            "",
            "将生成的 restored 文件改回 " + base + " 后可用解压工具打开。",
            "",
        ]
    )
    with open(readme, "w", encoding="utf-8") as rf:
        rf.write(text)
    print(f"wrote {readme}")


if __name__ == "__main__":
    main()
