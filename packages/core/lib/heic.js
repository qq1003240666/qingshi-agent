// HEIC/HEIF → JPEG 转换。
//
// 为什么要转：后端标准上传白名单只允许 jpg/jpeg/png/webp/gif，
// 而 iPhone 默认拍 HEIC。直接把 HEIC 传上去会被后端拒，
// 即使放开白名单，微信小程序和浏览器也显示不了。
//
// 所以插件在上传前把 HEIC 转成 JPG，之后走的仍是标准三步上传，
// 后端、小程序、H5 看到的都是普通 jpg，链路完全一致。
//
// 解码器优先级（都用系统自带能力，不引第三方依赖）：
//   macOS   sips（系统自带，最可靠）
//   Windows PowerShell + WIC（需要系统装了「HEIF 图像扩展」）
//   Linux   heif-convert / magick / ffmpeg（有哪个用哪个）
import { execFile } from 'node:child_process'
import { open, readFile, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

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
        return {
          path: output,
          strategy: strategy.name,
          cleanup: () => unlink(output).catch(() => {}),
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
