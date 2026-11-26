// 纯 JS 读照片/视频的元数据：拍摄时间、GPS、尺寸、机型。
//
// 不引任何第三方依赖，因为插件要求「解压即用、不用 npm install」。
// 覆盖顺序（重要性从高到低）：
//   JPEG  → EXIF APP1（DateTimeOriginal 最准，含 GPS）
//   PNG   → eXIf 块 / tEXt 里的 Creation Time
//   MP4/MOV → moov.mvhd 的 creation_time（iPhone 拍视频常走这里）
//   HEIC  → 只探测格式，不解析（盒子结构复杂），交给文件名/文件时间兜底
//   其它  → 文件名里的日期（IMG_20230815_、mmexport1234567890123、Screenshot_...）
// 最后兜底：文件修改时间 mtime。
import { open } from 'node:fs/promises'
import { basename } from 'node:path'

const HEAD_BYTES = 512 * 1024
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 }

/** 读一个文件的元数据。永不抛错：实在读不出就返回只带文件时间的对象。 */
export async function readMeta(file) {
  const fh = await open(file, 'r')
  try {
    const st = await fh.stat()
    const size = st.size
    const head = Buffer.alloc(Math.min(size, HEAD_BYTES))
    await fh.read(head, 0, head.length, 0)
    const format = detectFormat(head)

    let info = null
    if (format === 'jpeg') info = parseJpeg(head)
    else if (format === 'png') info = parsePng(head)
    else if (format === 'mp4') info = parseMp4(head)

    let takenAt = info?.takenAt || null
    let timeSource = takenAt ? 'exif' : null
    if (!takenAt) {
      const fromName = dateFromName(basename(file))
      if (fromName) {
        takenAt = fromName
        timeSource = 'filename'
      }
    }
    if (!takenAt) {
      takenAt = toLocalIso(st.mtime)
      timeSource = 'mtime'
    }

    return {
      path: file,
      name: basename(file),
      format,
      takenAt,
      takenAtMs: Date.parse(takenAt) || 0,
      timeSource,
      gps: info?.gps || null,
      width: info?.width || 0,
      height: info?.height || 0,
      orientation: info?.orientation || 0,
      camera: info?.camera || '',
      bytes: size,
    }
  } finally {
    await fh.close()
  }
}

function detectFormat(buf) {
  if (buf.length < 12) return 'unknown'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg'
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png'
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12).toLowerCase()
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'heic'
    return 'mp4'
  }
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif'
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return 'unknown'
}

// ---------------- JPEG / EXIF ----------------

function parseJpeg(buf) {
  let offset = 2
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) break
    const marker = buf[offset + 1]
    // 无长度的标记
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xda) break // 到了图像数据
    const len = buf.readUInt16BE(offset + 2)
    if (len < 2) break
    const segStart = offset + 4
    if (marker === 0xe1 && buf.toString('latin1', segStart, segStart + 4) === 'Exif') {
      return parseTiff(buf, segStart + 6)
    }
    offset += 2 + len
  }
  return null
}

/**
 * 解析 TIFF 结构（EXIF 本体）。base 是 TIFF 头在 buf 中的起点，
 * 所有内部偏移都相对 base。PNG 的 eXIf 块可以直接传 base=0。
 */
function parseTiff(buf, base) {
  if (buf.length < base + 8) return null
  const order = buf.toString('latin1', base, base + 2)
  const little = order === 'II'
  if (!little && order !== 'MM') return null
  const u16 = (o) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
  const u32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  if (u16(base + 2) !== 42) return null

  function readIfd(offset) {
    const entries = new Map()
    if (offset < 0 || offset + 2 > buf.length) return entries
    const count = u16(offset)
    if (count > 500) return entries
    for (let i = 0; i < count; i += 1) {
      const e = offset + 2 + i * 12
      if (e + 12 > buf.length) break
      entries.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 })
    }
    return entries
  }
  function dataOffset(entry) {
    const unit = TYPE_SIZE[entry.type] || 1
    return unit * entry.count <= 4 ? entry.at : base + u32(entry.at)
  }
  function ascii(entry) {
    if (!entry) return ''
    const off = dataOffset(entry)
    const end = Math.min(buf.length, off + entry.count)
    return buf.toString('latin1', off, end).replace(/\0[\s\S]*$/, '').trim()
  }
  function short(entry) {
    if (!entry) return 0
    return entry.count > 1 ? u16(base + u32(entry.at)) : u16(entry.at)
  }
  function long(entry) {
    if (!entry) return 0
    return entry.count > 1 ? u32(base + u32(entry.at)) : u32(entry.at)
  }
  function rationals(entry) {
    if (!entry) return []
    const off = dataOffset(entry)
    const out = []
    for (let i = 0; i < entry.count; i += 1) {
      const p = off + i * 8
      if (p + 8 > buf.length) break
      const num = u32(p)
      const den = u32(p + 4)
      out.push(den ? num / den : 0)
    }
    return out
  }

  const ifd0 = readIfd(base + u32(base + 4))
  const exifPointer = ifd0.get(0x8769)
  const gpsPointer = ifd0.get(0x8825)
  const exif = exifPointer ? readIfd(base + long(exifPointer)) : new Map()
  const gps = gpsPointer ? readIfd(base + long(gpsPointer)) : new Map()

  const takenAt =
    exifDate(ascii(exif.get(0x9003))) ||
    exifDate(ascii(exif.get(0x9004))) ||
    exifDate(ascii(ifd0.get(0x0132))) ||
    null

  let gpsPos = null
  const lat = rationals(gps.get(0x0002))
  const lon = rationals(gps.get(0x0004))
  if (lat.length === 3 && lon.length === 3) {
    let latDec = lat[0] + lat[1] / 60 + lat[2] / 3600
    let lonDec = lon[0] + lon[1] / 60 + lon[2] / 3600
    if (/s/i.test(ascii(gps.get(0x0001)))) latDec = -latDec
    if (/w/i.test(ascii(gps.get(0x0003)))) lonDec = -lonDec
    if (Number.isFinite(latDec) && Number.isFinite(lonDec) && (latDec || lonDec)) {
      gpsPos = { lat: round6(latDec), lon: round6(lonDec) }
    }
  }

  const make = ascii(ifd0.get(0x010f))
  const model = ascii(ifd0.get(0x0110))
  return {
    takenAt,
    gps: gpsPos,
    width: long(exif.get(0xa002)) || long(ifd0.get(0x0100)) || 0,
    height: long(exif.get(0xa003)) || long(ifd0.get(0x0101)) || 0,
    orientation: short(ifd0.get(0x0112)) || 0,
    camera: [make, model].filter(Boolean).join(' ').trim(),
  }
}

// ---------------- PNG ----------------

function parsePng(buf) {
  let pos = 8
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const start = pos + 8
    if (start + len > buf.length) break
    if (type === 'eXIf') {
      const tiff = parseTiff(buf.subarray(start, start + len), 0)
      if (tiff?.takenAt) return tiff
    }
    if (type === 'tEXt') {
      const text = buf.toString('latin1', start, start + len)
      const nul = text.indexOf('\0')
      if (nul > 0) {
        const key = text.slice(0, nul)
        if (/creation.?time|date/i.test(key)) {
          const value = text.slice(nul + 1).trim()
          const iso = normalizeDate(value)
          if (iso) return { takenAt: iso }
        }
      }
    }
    pos = start + len + 4
  }
  return null
}

// ---------------- MP4 / MOV ----------------

function parseMp4(buf) {
  let pos = 0
  while (pos + 8 <= buf.length) {
    const size = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    if (size < 8) break
    if (type === 'moov') {
      const mvhd = findBox(buf, pos + 8, Math.min(pos + size, buf.length), 'mvhd')
      if (mvhd) {
        const version = buf[mvhd]
        // mvhd 的 creation_time 是「1904-01-01 起」的秒数（UTC）
        const raw = version === 1 ? Number(buf.readBigUInt64BE(mvhd + 4)) : buf.readUInt32BE(mvhd + 4)
        if (raw > 0) {
          const ms = (raw - 2082844800) * 1000
          if (ms > 0) return { takenAt: toLocalIso(new Date(ms)) }
        }
      }
    }
    pos += size
  }
  return null
}

function findBox(buf, start, end, wanted) {
  let pos = start
  while (pos + 8 <= end) {
    const size = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    if (size < 8) return -1
    if (type === wanted) {
      // 返回 version 字节所在位置
      return pos + 8
    }
    pos += size
  }
  return -1
}

// ---------------- 时间工具 ----------------

/** "2023:08:15 09:12:33" → "2023-08-15T09:12:33"（EXIF 无时区，当本地时间） */
function exifDate(text) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text || ''))
  if (!m) return null
  const [, y, mo, d, hh, mm, ss] = m
  return validIso(y, mo, d, hh, mm, ss)
}

function normalizeDate(text) {
  const s = String(text || '').trim()
  let m = /^(\d{4})[-:/.年](\d{1,2})[-:/.月](\d{1,2})日?[ T]?(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?/.exec(s)
  if (!m) return null
  return validIso(m[1], m[2], m[3], m[4] || '0', m[5] || '0', m[6] || '0')
}

function validIso(y, mo, d, hh, mm, ss) {
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  if (year < 1900 || year > 2200) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const h = Math.min(23, Math.max(0, Number(hh) || 0))
  const mi = Math.min(59, Math.max(0, Number(mm) || 0))
  const se = Math.min(59, Math.max(0, Number(ss) || 0))
  return `${year}-${pad(month)}-${pad(day)}T${pad(h)}:${pad(mi)}:${pad(se)}`
}

/** 从文件名里猜日期：iPhone/Android 的 IMG_、微信 mmexport、各种截图命名。 */
export function dateFromName(name) {
  const text = String(name || '')
  const compact = /(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/.exec(text)
  if (compact) return validIso(compact[1], compact[2], compact[3], compact[4], compact[5], compact[6])

  const dashed = /(20\d{2})[-_.](\d{1,2})[-_.](\d{1,2})[ T_-]?(\d{1,2})?[-:_.]?(\d{1,2})?[-:_.]?(\d{1,2})?/.exec(text)
  if (dashed) return validIso(dashed[1], dashed[2], dashed[3], dashed[4] || '0', dashed[5] || '0', dashed[6] || '0')

  // 微信导出的毫秒时间戳：mmexport1692000000000.jpg
  const epoch = /(?:mmexport|wx_camera_)(\d{12,13})/.exec(text)
  if (epoch) {
    const ms = Number(epoch[1]) > 99999999999 ? Number(epoch[1]) : Number(epoch[1]) * 1000
    const d = new Date(ms)
    if (!Number.isNaN(d.getTime())) return toLocalIso(d)
  }
  return null
}

export function toLocalIso(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return null
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

const pad = (n) => String(n).padStart(2, '0')
const round6 = (n) => Math.round(n * 1e6) / 1e6
