#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""HEIC/HEIF → JPG，保留拍摄时间和 GPS 位置。

为什么需要它：iPhone 默认存 HEIC。后端现在允许 heic，但微信小程序和浏览器
仍然显示不了 HEIC，所以入库前通常要转成 JPG。这个脚本保证转换后
EXIF 原样保留——拍摄时间（DateTimeOriginal）、GPS 经纬度/海拔、机型、镜头都不丢。

依赖：
    pip install pillow-heif
（Pillow 一般环境里已有；pillow-heif 负责 HEIC 解码，Windows/macOS/Linux 都有预编译轮子）

用法：
    # 转单张 / 多张
    python scripts/heic2jpg.py IMG_0001.HEIC IMG_0002.heic

    # 递归转整个相册，输出到另一个目录，质量 90
    python scripts/heic2jpg.py "D:\\照片\\2023云南" -o "D:\\照片\\jpg" -q 90

    # 同时把输出文件的修改时间设成拍摄时间（方便按时间排序）
    python scripts/heic2jpg.py "D:\\照片" -o out --keep-time

    # 只看会做什么，不写文件
    python scripts/heic2jpg.py "D:\\照片" --dry-run

说明：
    · 不旋转像素，保留 Orientation 标记——所有看图软件都按它显示。
      刻意不用 exif_transpose：旋转会重编码像素并把 Orientation 归零，
      部分实现会在这一步丢掉 GPS 子 IFD。
    · HEIC 里的 Live Photo / 连拍多帧只取主图。
    · 转换后仍建议用插件上传，插件会走和小程序 / H5 相同的三步上传链路。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HEIC_EXTENSIONS = {".heic", ".heif"}

# EXIF 标签：拍摄时间优先 DateTimeOriginal，其次 DateTimeDigitized，最后 DateTime
TAG_DATETIME_ORIGINAL = 36867
TAG_DATETIME_DIGITIZED = 36868
TAG_DATETIME = 306
TAG_OFFSET_ORIGINAL = 36881
TAG_OFFSET = 36880


def require_pillow():
    try:
        from PIL import Image
    except ImportError:
        sys.exit("缺少 Pillow：pip install pillow")
    try:
        import pillow_heif
    except ImportError:
        sys.exit("缺少 pillow-heif：pip install pillow-heif")
    pillow_heif.register_heif_opener()
    return Image


def collect_files(paths: list[str]) -> list[Path]:
    found: list[Path] = []
    for raw in paths:
        path = Path(raw).expanduser()
        if path.is_dir():
            for item in sorted(path.rglob("*")):
                if item.is_file() and item.suffix.lower() in HEIC_EXTENSIONS:
                    found.append(item)
        elif path.is_file():
            if path.suffix.lower() in HEIC_EXTENSIONS:
                found.append(path)
            else:
                print(f"跳过（不是 HEIC）：{path}", file=sys.stderr)
        else:
            print(f"跳过（路径不存在）：{path}", file=sys.stderr)
    # 去重但保持顺序
    seen = set()
    unique = []
    for item in found:
        key = str(item.resolve())
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def exif_timestamp(raw_exif: bytes | None) -> float | None:
    """从原始 EXIF 里取拍摄时间，返回 epoch 秒（有偏移就按偏移换算）。"""
    if not raw_exif:
        return None
    from PIL import Image

    try:
        exif = Image.Exif()
        exif.load(raw_exif)
    except Exception:
        return None

    text = exif.get(TAG_DATETIME_ORIGINAL) or exif.get(TAG_DATETIME_DIGITIZED) or exif.get(TAG_DATETIME)
    if not text:
        return None
    try:
        moment = datetime.strptime(str(text).strip(), "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None

    offset = exif.get(TAG_OFFSET_ORIGINAL) or exif.get(TAG_OFFSET)
    if offset:
        try:
            raw = str(offset).strip()
            sign = -1 if raw.startswith("-") else 1
            hours, minutes = raw[1:].split(":")
            moment = moment.replace(tzinfo=timezone(sign * timedelta(hours=int(hours), minutes=int(minutes))))
        except Exception:
            pass
    return moment.timestamp()


def has_gps_ifd(raw_exif: bytes | None) -> bool:
    """判断 EXIF 里是否有 GPS 子 IFD（不能靠搜 "GPS" 字符串，那是 XMP 才有）。"""
    if not raw_exif:
        return False
    from PIL import Image

    try:
        exif = Image.Exif()
        exif.load(raw_exif)
        return bool(exif.get_ifd(0x8825))
    except Exception:
        return False


def convert_one(Image, src: Path, dst: Path, quality: int, keep_exif: bool) -> dict:
    with Image.open(src) as image:
        raw_exif = image.info.get("exif") if keep_exif else None

        if image.mode in ("RGBA", "LA"):
            background = Image.new("RGB", image.size, (255, 255, 255))
            background.paste(image, mask=image.split()[-1])
            working = background
        elif image.mode != "RGB":
            working = image.convert("RGB")
        else:
            working = image

        save_kwargs = {"quality": quality, "optimize": True}
        if raw_exif:
            save_kwargs["exif"] = raw_exif
        working.save(dst, "JPEG", **save_kwargs)
        width, height = working.size

    taken_at = exif_timestamp(raw_exif) if keep_exif else None
    return {
        "source": str(src),
        "output": str(dst),
        "width": width,
        "height": height,
        "bytes": dst.stat().st_size,
        "taken_at": datetime.fromtimestamp(taken_at).isoformat(sep=" ") if taken_at else None,
        "has_gps": has_gps_ifd(raw_exif) if keep_exif else False,
        "taken_at_epoch": taken_at,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="把 HEIC/HEIF 转成 JPG，保留拍摄时间与 GPS 等 EXIF 信息。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("paths", nargs="+", help="HEIC 文件或目录（目录会递归）")
    parser.add_argument("-o", "--out", help="输出目录，默认和原文件同目录")
    parser.add_argument("-q", "--quality", type=int, default=90, help="JPEG 质量，默认 90")
    parser.add_argument("--keep-time", action="store_true", help="把输出文件修改时间设为拍摄时间")
    parser.add_argument("--no-exif", action="store_true", help="不保留 EXIF（默认保留）")
    parser.add_argument("--overwrite", action="store_true", help="已存在同名 JPG 时覆盖")
    parser.add_argument("--dry-run", action="store_true", help="只列出会转换哪些文件")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出结果")
    args = parser.parse_args()

    files = collect_files(args.paths)
    if not files:
        print("没有找到 .heic / .heif 文件。", file=sys.stderr)
        return 1

    if args.dry_run:
        for item in files:
            print(f"[dry-run] {item} → {item.with_suffix('.jpg')}")
        return 0

    Image = require_pillow()
    out_dir = Path(args.out).expanduser() if args.out else None
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)

    results = []
    failures = []
    skipped = 0

    for source in files:
        target = (out_dir / source.name).with_suffix(".jpg") if out_dir else source.with_suffix(".jpg")
        if target.exists() and not args.overwrite:
            skipped += 1
            if not args.json:
                print(f"跳过（已存在）：{target}")
            continue
        try:
            info = convert_one(Image, source, target, args.quality, not args.no_exif)
            if args.keep_time and info["taken_at_epoch"]:
                epoch = info["taken_at_epoch"]
                os.utime(target, (epoch, epoch))
            results.append({"ok": True, **info})
            if not args.json:
                extra = f"，拍摄于 {info['taken_at']}" if info["taken_at"] else ""
                print(f"✓ {source.name} → {target.name}（{info['width']}×{info['height']}，{info['bytes'] // 1024} KB{extra}）")
        except Exception as error:  # noqa: BLE001
            failures.append({"source": str(source), "error": str(error)})
            if not args.json:
                print(f"✗ {source}：{error}", file=sys.stderr)

    if args.json:
        print(json.dumps({"converted": results, "failed": failures, "skipped": skipped}, ensure_ascii=False, indent=2))
    else:
        print(f"\n完成：成功 {len(results)}，失败 {len(failures)}，跳过 {skipped}")
        if failures:
            print("失败的文件可以用 --overwrite 重试，或先确认 Install pillow-heif 是否正常。", file=sys.stderr)

    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
