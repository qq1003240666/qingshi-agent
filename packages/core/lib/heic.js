// HEIC/HEIF → JPEG 转换。
//
// 为什么要转：后端不支持 heic/heif（收到会返回「请先转成 JPG」），
// 微信小程序和浏览器也显示不了 HEIC。
// 插件在上传前把 HEIC 转成 JPG；转换时先按文件名识别拍摄时间，
// 写进 JPG 的 EXIF 和文件修改时间，再走标准三步上传。
//
// 所以插件在上传前把 HEIC 转成 JPG，之后走的仍是标准三步上传，
// 后端、小程序、H5 看到的都是普通 jpg，链路完全一致。
//
// 解码器优先级（都用系统自带能力，不引第三方依赖）：
//   macOS   sips（系统自带，最可靠）
//   Windows PowerShell + WIC（需要系统装了「HEIF 图像扩展」）
//   Linux   heif-convert / magick / ffmpeg（有哪个用哪个）
import { execFile } from 'node:child_process'
import { open, readFile, writeFile, unlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { readMeta, dateFromName } from './exif.js'

const HEIC_EXTENSIONS = new Set(['.heic', '.heif'])
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'])

/** 先看扩展名，不是再看文件头 ftyp brand。 */
export async function isHeicFile(filePath) {
  if (HEIC_EXTENSIONS.has(extname(String(filePath)).toLowerCase())) return true
  let fh
  try {
    fh = await open(filePath, 'r')
    const head = Buffer.alloc(12)
    await fh.read(head, 0, 12, 0)
    if (head.toString('latin1', 4, 8) !== 'ftyp') return false
    return HEIC_BRANDS.has(head.toString('latin1', 8, 12).toLowerCase())
  } catch {
    return false
  } finally {
    if (fh) await fh.close()
  }
}

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 120000 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${command} 失败：${String(stderr || error.message).trim().slice(0, 300)}`))
      else resolve()
    })
  })
}

const WINDOWS_SCRIPT = `param([string]$InPath,[string]$OutPath,[int]$Quality)
Add-Type -AssemblyName PresentationCore
$inputStream = [System.IO.File]::OpenRead($InPath)
try {
  $decoder = [System.Windows.Media.Imaging.BitmapDecoder]::Create($inputStream, 'None', 'OnLoad')
  $frame = $decoder.Frames[0]
  $encoder = New-Object System.Windows.Media.Imaging.JpegBitmapEncoder
  $encoder.QualityLevel = $Quality
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($frame))
  $outputStream = [System.IO.File]::Create($OutPath)
  try { $encoder.Save($outputStream) } finally { $outputStream.Dispose() }
} finally { $inputStream.Dispose() }
`

/** 平台默认策略：每个策略负责把 inPath 写成一张真 JPEG 到 outPath。 */
export function defaultStrategies(quality = 88) {
  return [
    {
      name: 'sips',
      run: (input, output) =>
        execFileAsync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), input, '--out', output]),
    },
    {
      name: 'windows-wic',
      run: async (input, output) => {
        const scriptPath = join(tmpdir(), `qingshi-heic-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`)
        await writeFile(scriptPath, WINDOWS_SCRIPT, 'utf8')
        try {
          await execFileAsync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptPath,
            '-InPath',
            input,
            '-OutPath',
            output,
            '-Quality',
            String(quality),
          ])
        } finally {
          await unlink(scriptPath).catch(() => {})
        }
      },
    },
    {
      name: 'heif-convert',
      run: (input, output) => execFileAsync('heif-convert', ['-q', String(quality), input, output]),
    },
    {
      name: 'magick',
      run: (input, output) => execFileAsync('magick', [input, '-quality', String(quality), output]),
    },
    {
      name: 'ffmpeg',
      run: (input, output) =>
        execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, '-frames:v', '1', '-q:v', '3', output]),
    },
  ]
}

/** 输出必须真的是 JPEG（防止某些工具写出 0 字节或别的格式）。 */
async function isRealJpeg(filePath) {
  try {
    const buffer = await readFile(filePath)
    return buffer.length > 1024 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  } catch {
    return false
  }
}

/** 把 ISO 本地时间写成 EXIF 的 "YYYY:MM:DD HH:MM:SS"。 */
function exifDateText(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(String(iso || ''))
  if (!match) return ''
  return `${match[1]}:${match[2]}:${match[3]} ${match[4]}:${match[5]}:${match[6]}`
}

/**
 * 在 JPEG 的 SOI 之后插入一个最小 APP1(Exif) 段，
 * 只写 DateTime(0x0132) 和 DateTimeOriginal(0x9003)，不碰像素、不碰别的元数据。
 * 用于「转换出来的 JPG 没有 EXIF 时间，但文件名里有时间」的情况。
 */
export function injectJpegDateTime(jpegBuffer, iso) {
  if (!Buffer.isBuffer(jpegBuffer) || jpegBuffer[0] !== 0xff || jpegBuffer[1] !== 0xd8) return jpegBuffer
  const text = exifDateText(iso)
  if (!text) return jpegBuffer

  const stamp = Buffer.from(text + '\0', 'latin1') // 20 字节，含结尾 \0
  const tiff = Buffer.alloc(96)

  tiff.write('II', 0, 'latin1')
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4) // IFD0 从第 8 字节开始
  tiff.writeUInt16LE(2, 8) // IFD0 有 2 项
  // 0x0132 DateTime（ASCII 20，数据放到 38）
  tiff.writeUInt16LE(0x0132, 10)
  tiff.writeUInt16LE(2, 12)
  tiff.writeUInt32LE(20, 14)
  tiff.writeUInt32LE(38, 18)
  // 0x8769 指向 Exif 子 IFD（偏移 58）
  tiff.writeUInt16LE(0x8769, 22)
  tiff.writeUInt16LE(4, 24)
  tiff.writeUInt32LE(1, 26)
  tiff.writeUInt32LE(58, 30)
  tiff.writeUInt32LE(0, 34) // 没有下一个 IFD
  stamp.copy(tiff, 38)
  // Exif 子 IFD：只有 0x9003 DateTimeOriginal（数据放到 76）
  tiff.writeUInt16LE(1, 58)
  tiff.writeUInt16LE(0x9003, 60)
  tiff.writeUInt16LE(2, 62)
  tiff.writeUInt32LE(20, 64)
  tiff.writeUInt32LE(76, 68)
  tiff.writeUInt32LE(0, 72)
  stamp.copy(tiff, 76)

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const header = Buffer.alloc(4)
  header.writeUInt16BE(0xffe1, 0)
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([jpegBuffer.subarray(0, 2), header, payload, jpegBuffer.subarray(2)])
}

/**
 * 转换后确定这张图的拍摄时间：
 *   1. 转换器已经带出 EXIF 时间 → 直接用（sips 等会保留）
 *   2. 否则从原文件名读（IMG_20230815_091233.HEIC、mmexport1692000000000…）
 *   3. 都没有就用文件时间
 * 第 2 种会把时间写进 JPG 的 EXIF，并把文件修改时间也设成拍摄时间。
 */
async function applyTakenAt(jpegPath, originalPath) {
  const meta = await readMeta(jpegPath).catch(() => null)
  if (meta && meta.timeSource === 'exif' && meta.takenAt) {
    return { takenAt: meta.takenAt, timeSource: 'exif' }
  }

  const fromName = dateFromName(basename(String(originalPath || '')))
  const takenAt = fromName || meta?.takenAt || null
  if (!takenAt) return { takenAt: null, timeSource: meta?.timeSource || 'unknown' }

  try {
    if (fromName) {
      const buffer = await readFile(jpegPath)
      await writeFile(jpegPath, injectJpegDateTime(buffer, fromName))
    }
    const epoch = Date.parse(String(takenAt).replace(' ', 'T'))
    if (!Number.isNaN(epoch)) {
      const date = new Date(epoch)
      await utimes(jpegPath, date, date)
    }
    return { takenAt, timeSource: fromName ? 'filename' : meta?.timeSource || 'mtime' }
  } catch {
    return { takenAt, timeSource: 'filename' }
  }
}

/**
 * 把 HEIC 转成临时 JPEG。
 * @returns { path, cleanup, strategy }
 */
export async function convertHeicToJpeg(filePath, { quality = 88, strategies = defaultStrategies(quality) } = {}) {
  const output = join(
    tmpdir(),
    `qingshi-heic-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
  )
  const failures = []

  for (const strategy of strategies) {
    try {
      await strategy.run(filePath, output)
      if (await isRealJpeg(output)) {
        const timing = await applyTakenAt(output, filePath)
        return {
          path: output,
          strategy: strategy.name,
          cleanup: () => unlink(output).catch(() => {}),
          ...timing,
        }
      }
      failures.push(`${strategy.name}：输出不是有效 JPEG`)
    } catch (error) {
      failures.push(`${strategy.name}：${error.message}`)
    }
    await unlink(output).catch(() => {})
  }

  throw new Error(
    [
      '这台机器没有可用的 HEIC 解码器，无法把照片转成 JPG。',
      '可以这样做：',
      '  · Windows：在 Microsoft Store 安装「HEIF 图像扩展」（免费），再试一次',
      '  · macOS：系统自带 sips，正常不需要额外安装',
      '  · 或者先用手机/看图软件把照片导出成 JPG 再上传',
      failures.length ? `尝试过：${failures.join('；')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

/** 转换后的文件名：原文件名换成 .jpg，避免把 heic 后缀带进 OSS。 */
export function jpegNameFor(filePath) {
  const name = basename(String(filePath || ''))
  const index = name.lastIndexOf('.')
  return (index > 0 ? name.slice(0, index) : name) + '.jpg'
}
