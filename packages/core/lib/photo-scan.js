// 把一堆照片文件变成「拍摄场次」：按拍摄时间间隔 + GPS 距离聚类，
// 让 AI 能一眼看出「这 18 张是 8 月 15 日那次徒步」「这 9 张是春节家里」。
//
// 只读：不移动、不上传、不改任何照片。
import { readdir, stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { readMeta } from './exif.js'

export const MEDIA_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif',
  '.gif', '.bmp', '.tif', '.tiff', '.mp4', '.mov',
])

/**
 * 收集路径下的媒体文件。paths 可以是文件或文件夹（递归）。
 * 返回 { files, skipped, truncated }。
 */
export async function collectMedia(paths, { maxMedia = 300, maxDepth = 6 } = {}) {
  const files = []
  const skipped = []
  let truncated = false

  async function walk(target, depth) {
    if (files.length >= maxMedia) {
      truncated = true
      return
    }
    let st
    try {
      st = await stat(target)
    } catch (error) {
      skipped.push(`${target}（读不到：${error.code || error.message}）`)
      return
    }
    if (st.isDirectory()) {
      if (depth >= maxDepth) {
        skipped.push(`${target}（目录层级太深，已跳过）`)
        return
      }
      let entries
      try {
        entries = await readdir(target, { withFileTypes: true })
      } catch (error) {
        skipped.push(`${target}（目录打不开：${error.code || error.message}）`)
        return
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (files.length >= maxMedia) {
          truncated = true
          return
        }
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory()) await walk(resolve(target, entry.name), depth + 1)
        else if (entry.isFile() && MEDIA_EXTS.has(extname(entry.name).toLowerCase())) {
          files.push(resolve(target, entry.name))
        }
      }
      return
    }
    if (st.isFile() && MEDIA_EXTS.has(extname(target).toLowerCase())) files.push(target)
  }

  for (const p of paths) await walk(resolve(String(p)), 0)
  return { files: files.slice(0, maxMedia), skipped, truncated }
}

/** 扫描 + 聚类。events 传进来时顺便算出「和哪条已有记录可能是一件事」。 */
export async function scanMedia(paths, options = {}) {
  const { maxMedia = 300, gapMinutes = 120, gpsKm = 5, events = [] } = options
  const collected = await collectMedia(paths, { maxMedia })
  const items = []
  const skipped = [...collected.skipped]

  for (const file of collected.files) {
    try {
      items.push(await readMeta(file))
    } catch (error) {
      skipped.push(`${file}（解析失败：${error.message}）`)
    }
  }
  items.sort((a, b) => a.takenAtMs - b.takenAtMs)

  const sessions = clusterSessions(items, { gapMinutes, gpsKm })
  for (const session of sessions) session.candidates = matchEvents(session, events)

  return {
    items,
    sessions,
    skipped,
    truncated: collected.truncated,
    total: collected.files.length,
    paths,
  }
}

/** 相邻两张：时间差超过 gapMinutes，或 GPS 距离超过 gpsKm，就切成新场次。 */
export function clusterSessions(items, { gapMinutes = 120, gpsKm = 5 } = {}) {
  const gapMs = Math.max(1, gapMinutes) * 60 * 1000
  const maxKm = gpsKm <= 0 ? Infinity : gpsKm
  const sessions = []
  let current = null

  for (const item of items) {
    const last = current?.photos[current.photos.length - 1]
    let startNew = !current
    if (!startNew) {
      if (item.takenAtMs - last.takenAtMs > gapMs) startNew = true
      else if (item.gps && last.gps) {
        const km = haversineKm(last.gps, item.gps)
        if (km > maxKm) startNew = true
      }
    }
    if (startNew) {
      current = { photos: [], start: item.takenAt, end: item.takenAt, gps: item.gps || null }
      sessions.push(current)
    }
    current.photos.push(item)
    current.end = item.takenAt
  }
  return sessions
}

/**
 * 给每个场次找候选记录：日期差 ≤ 7 天；两边都有 GPS 时再按距离筛。
 * 置信度：日期同一天且距离 < 2km = 高；同一天 = 中；仅日期接近 = 低。
 */
export function matchEvents(session, events = [], { days = 7, nearKm = 30 } = {}) {
  const startMs = Date.parse(session.start) || 0
  if (!startMs || !Array.isArray(events) || !events.length) return []
  const day = 24 * 60 * 60 * 1000
  const gps = session.gps
  const out = []

  for (const event of events) {
    const rawDate = String(event?.start_date || event?.startDate || '').slice(0, 10)
    const eventMs = Date.parse(rawDate)
    if (!eventMs) continue
    const diffDays = Math.abs(eventMs - startMs) / day
    if (diffDays > days) continue

    const loc = event?.location
    const lat = Number(loc?.latitude) || 0
    const lon = Number(loc?.longitude) || 0
    const km = gps && lat && lon ? haversineKm(gps, { lat, lon }) : null
    if (km !== null && km > nearKm) continue

    let confidence = 'low'
    if (diffDays < 1) confidence = km !== null && km < 2 ? 'high' : 'medium'
    out.push({
      eventId: String(event?.event_id || event?.eventId || event?.id || ''),
      title: String(event?.title || '(无标题)'),
      date: rawDate,
      km,
      diffDays,
      confidence,
    })
  }
  out.sort((a, b) => rank(b.confidence) - rank(a.confidence) || (a.km ?? 999) - (b.km ?? 999))
  return out.slice(0, 3)
}

const rank = (c) => ({ high: 3, medium: 2, low: 1 }[c] || 0)

export function haversineKm(a, b) {
  const R = 6371
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return Math.round(R * 2 * Math.asin(Math.min(1, Math.sqrt(s))) * 10) / 10
}

/** 给 AI 看的紧凑报告：场次为主，照片路径按需展开。 */
export function formatScan(result, { detail = false, limitPerSession = 20 } = {}) {
  const { items, sessions, skipped = [], truncated, total, paths = [] } = result
  if (!items.length) {
    return [
      `没找到可用的照片/视频（给的路径：${paths.join(', ') || '（空）'}）。`,
      skipped.length ? `跳过：${skipped.slice(0, 5).join('；')}` : '',
      '支持的格式：jpg/jpeg/png/webp/heic/heif/gif/bmp/tif/mp4/mov。',
    ]
      .filter(Boolean)
      .join('\n')
  }

  const bySource = { exif: 0, filename: 0, mtime: 0 }
  for (const item of items) bySource[item.timeSource] = (bySource[item.timeSource] || 0) + 1

  const lines = []
  lines.push(`照片扫描：${items.length} 个文件 / ${sessions.length} 个拍摄场次`)
  lines.push(
    `拍摄时间来源：EXIF ${bySource.exif} 个 · 文件名 ${bySource.filename} 个 · 文件修改时间 ${bySource.mtime} 个`,
  )
  if (bySource.mtime) lines.push('（文件修改时间不准，只作兜底；有 GPS 的场次更好判断）')
  if (truncated) lines.push(`（文件太多，只扫了前 ${total} 个）`)
  lines.push('')

  sessions.forEach((session, index) => {
    const range = formatRange(session.start, session.end)
    const gps = session.gps ? ` · GPS ${session.gps.lat},${session.gps.lon}` : ' · 无 GPS'
    lines.push(`[${index + 1}] ${range} · ${session.photos.length} 张${gps}`)

    const shown = detail ? session.photos : session.photos.slice(0, limitPerSession)
    for (const photo of shown) {
      const t = String(photo.takenAt || '').slice(11, 16)
      const extra = photo.timeSource === 'exif' ? '' : `（时间来自${photo.timeSource === 'filename' ? '文件名' : '文件属性'}）`
      lines.push(`  - ${t}  ${photo.path}${extra}`)
    }
    if (!detail && session.photos.length > shown.length) {
      lines.push(`  - …还有 ${session.photos.length - shown.length} 张（需要完整清单就再调一次，detail=true）`)
    }

    if (session.candidates?.length) {
      for (const c of session.candidates) {
        const dist = c.km !== null ? `，相距 ${c.km}km` : ''
        const level = { high: '高置信', medium: '中置信', low: '低置信' }[c.confidence]
        lines.push(`  可能相关的已有记录：${c.title}（event_id ${c.eventId}，${c.date}${dist}）← ${level}`)
      }
    } else {
      lines.push('  可能相关的已有记录：（没有）')
    }
    lines.push('')
  })

  if (skipped.length) {
    lines.push(`跳过的 ${skipped.length} 项：${skipped.slice(0, 5).join('；')}`)
    if (skipped.length > 5) lines.push('（其余略）')
  }
  return lines.join('\n').trim()
}

function formatRange(start, end) {
  const s = String(start || '')
  const e = String(end || '')
  const date = s.slice(0, 10) || '未知日期'
  const from = s.slice(11, 16)
  const to = e.slice(11, 16)
  if (!from) return date
  if (!to || to === from) return `${date} ${from}`
  if (e.slice(0, 10) !== date) return `${s.replace('T', ' ')} ~ ${e.replace('T', ' ')}`
  return `${date} ${from} ~ ${to}`
}
