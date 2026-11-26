// 复刻青史的标准 OSS 上传链路（与小程序 / H5 的 utils/upload.js 完全一致）：
//   1. POST /get_oss_upload_signature
//      参数与前端一致：biz_type、of_uid、target_type、custom_object_key、
//                      file_name、file_size、content_type
//      后端在这一步校验 biz_type / 扩展名 / 文件大小 / 配额，并预占 reserved_bytes
//   2. multipart POST 到签名返回的 host（form_data + file，字段名固定为 file）
//   3. POST /confirm_oss_upload { upload_file_id, object_key }
//      后端把 upload_files 置为 active、结算配额、回写目标业务字段
//
// 和前端保持一致的几个细节（少一个都可能被后端拒）：
//   - file_name 必须带扩展名，且扩展名在该 biz_type 的白名单里
//   - file_size 必须大于 0
//   - content_type 统一小写；image / video 这种简写要归一
//   - 逐张上传，单张失败不影响其它张
//   - 返回的 upload_file_id / url 优先取 confirm 的结果
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { isHeicFile, convertHeicToJpeg, jpegNameFor } from './heic.js'

// 与后端 config.py 的默认白名单保持一致（部署时可能被环境变量改，这里只做前置友好校验）
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm'])
const FILE_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'zip', 'rar', '7z', 'gz', 'tar'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'amr', 'ogg'])

const CONTENT_TYPE_MAP = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  amr: 'audio/amr',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  zip: 'application/zip',
  rar: 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  tar: 'application/x-tar',
}

const EXT_BY_CONTENT_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-m4v': 'm4v',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
}

/** 某种 biz_type 允许的扩展名（与后端 get_allowed_upload_extensions 对齐）。 */
export function allowedExtensions(bizType = 'career_media') {
  const type = String(bizType || '').trim().toLowerCase()
  if (['avatar', 'tmp_avatar', 'family_image', 'engraving', 'homepage', 'ai_avatar_icon'].includes(type)) {
    return IMAGE_EXTENSIONS
  }
  if (['career_media', 'time_capsule'].includes(type)) {
    return new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS])
  }
  if (type === 'ai_avatar_voice') return AUDIO_EXTENSIONS
  if (type === 'attachment') return FILE_EXTENSIONS
  return new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...FILE_EXTENSIONS])
}

function extensionOf(name) {
  const text = String(name || '').trim()
  const index = text.lastIndexOf('.')
  if (index <= 0 || index === text.length - 1) return ''
  return text.slice(index + 1).toLowerCase()
}

function contentTypeByExtension(ext) {
  return CONTENT_TYPE_MAP[String(ext || '').toLowerCase()] || 'application/octet-stream'
}

function normalizeContentType(contentType, ext) {
  const safe = String(contentType || '').trim().toLowerCase()
  if (safe.includes('/')) return safe
  if (safe === 'image') return 'image/jpeg'
  if (safe === 'video') return 'video/mp4'
  return contentTypeByExtension(ext)
}

/** 文件名必须有扩展名；没有就按 content_type 补一个（与前端 ensureFileExtension 一致）。 */
function ensureExtension(fileName, contentType) {
  const name = String(fileName || '').trim()
  if (!name) return ''
  if (extensionOf(name)) return name
  const ext = EXT_BY_CONTENT_TYPE[String(contentType || '').trim().toLowerCase()] || 'jpg'
  return `${name}.${ext}`
}

/**
 * 上传前归一化：文件名补扩展名、校验扩展名白名单、读文件大小、归一 content_type。
 * 返回 { filePath, fileName, fileExt, contentType, fileSize }。
 */
export async function normalizeUploadFile(filePath, { contentType, fileName, bizType = 'career_media' } = {}) {
  const path = String(filePath || '').trim()
  if (!path) throw new Error('文件路径为空')

  const info = await stat(path)
  if (!info.isFile()) throw new Error('不是文件：' + path)
  if (info.size <= 0) throw new Error('文件大小必须大于 0：' + path)

  const rawName = String(fileName || basename(path) || '').trim()
  const normalizedName = ensureExtension(rawName, contentType)
  const fileExt = extensionOf(normalizedName)
  if (!fileExt) throw new Error('文件名没有扩展名，无法上传：' + rawName)

  const allowed = allowedExtensions(bizType)
  if (!allowed.has(fileExt)) {
    throw new Error(
      `不支持的文件类型：.${fileExt}（${bizType} 允许 ${[...allowed].join(' / ')}）`,
    )
  }

  return {
    filePath: path,
    fileName: normalizedName,
    fileExt,
    contentType: normalizeContentType(contentType, fileExt),
    fileSize: info.size,
  }
}

export function createUploader({ logger } = {}) {
  /**
   * 上传单个文件（标准三步）。
   * @param authed  已带 token 的请求函数
   * @param filePath 本机文件路径
   * @param options { uid, contentType, fileName, bizType, targetType, customObjectKey }
   * @returns { upload_file_id, url, content_type, object_key }
   */
  return async function uploadMedia(authed, filePath, options = {}) {
    const {
      uid,
      contentType,
      fileName,
      bizType = 'career_media',
      targetType = 'user_profile',
      customObjectKey = '',
      heicStrategies,
    } = options

    // HEIC：始终先转成 JPG 再走标准三步。
    // 后端现在已经允许 heic，但微信小程序和浏览器显示不了 HEIC，
    // 所以插件这边仍然默认转成 jpg，让三端看到的都是普通图片。
    let cleanup = null
    let preparedPath = filePath
    let preparedName = fileName
    let preparedType = contentType
    let convertedFrom = ''
    if (await isHeicFile(filePath)) {
      const converted = await convertHeicToJpeg(
        filePath,
        heicStrategies ? { strategies: heicStrategies } : undefined,
      )
      cleanup = converted.cleanup
      preparedPath = converted.path
      preparedName = jpegNameFor(fileName || filePath)
      preparedType = 'image/jpeg'
      convertedFrom = filePath
      logger?.(`HEIC 已转 JPG（${converted.strategy}）：${filePath}`)
    }

    try {
      const file = await normalizeUploadFile(preparedPath, {
        contentType: preparedType,
        fileName: preparedName,
        bizType,
      })

      // 1. 申请签名（字段与前端 uploadFilesWithOss 完全一致）
      const sign = await authed('/get_oss_upload_signature', {
        biz_type: bizType,
        of_uid: uid,
        target_type: targetType,
        custom_object_key: customObjectKey,
        file_name: file.fileName,
        file_size: file.fileSize,
        content_type: file.contentType,
      })
      if (!sign || sign.code !== 200) {
        throw new Error(`申请上传签名失败：${sign?.code ?? '未知'} ${sign?.message || ''}`.trim())
      }

      const data = sign.data || {}
      const host = String(data.host || '').replace(/\/+$/, '')
      const objectKey = String(data.object_key || '')
      const uploadFileId = String(data.upload_file_id || '')
      if (!host) throw new Error('上传签名里没有 host')
      if (!objectKey || !uploadFileId) throw new Error('上传签名缺少 object_key / upload_file_id')

      // 2. 直传 OSS：form_data 原样带上，文件字段名固定 file
      const raw = await readFile(file.filePath)
      const form = new FormData()
      for (const [key, value] of Object.entries(data.form_data || {})) {
        form.append(key, String(value))
      }
      form.append('file', new Blob([raw], { type: file.contentType }), file.fileName)

      const putResponse = await fetch(host, { method: 'POST', body: form })
      if (!putResponse.ok) {
        const text = await putResponse.text().catch(() => '')
        throw new Error(`上传到 OSS 失败：${putResponse.status} ${text.slice(0, 200)}`.trim())
      }

      // 3. 确认入库（这一步才会把 upload_files 置 active、结算配额）
      const confirmed = await authed('/confirm_oss_upload', {
        upload_file_id: uploadFileId,
        object_key: objectKey,
      })
      if (!confirmed || confirmed.code !== 200) {
        throw new Error(`确认上传失败：${confirmed?.code ?? '未知'} ${confirmed?.message || ''}`.trim())
      }

      const result = confirmed.data || {}
      const finalUrl = String(result.url || data.public_url || data.url || '')
      const finalId = String(result.upload_file_id || uploadFileId)
      const finalType = String(
        result.file_info?.content_type || result.content_type || file.contentType,
      ).toLowerCase()

      logger?.(`媒体上传完成 ${finalId} → ${finalUrl}`)
      return {
        upload_file_id: finalId,
        url: finalUrl,
        content_type: finalType || 'image/jpeg',
        object_key: String(result.object_key || objectKey),
        file_name: file.fileName,
        file_size: file.fileSize,
        converted_from: convertedFrom || undefined,
      }
    } finally {
      if (cleanup) await cleanup()
    }
  }
}

/**
 * 批量上传（顺序执行，单张失败不影响其它张），返回结构与前端 buildUploadResult 对齐。
 */
export async function uploadMediaList(authed, files = [], options = {}) {
  const items = []
  let successCount = 0
  const uploadOne = createUploader(options)

  for (const [index, file] of files.entries()) {
    const filePath = typeof file === 'string' ? file : file?.path || file?.filePath || ''
    try {
      const uploaded = await uploadOne(authed, filePath, {
        ...options,
        contentType: typeof file === 'object' ? file.contentType : options.contentType,
        fileName: typeof file === 'object' ? file.fileName : options.fileName,
      })
      successCount += 1
      items.push({ code: 200, message: '上传成功', tempFilePath: filePath, ...uploaded })
    } catch (error) {
      items.push({
        code: 500,
        message: error.message || '上传失败',
        tempFilePath: filePath,
        upload_file_id: '',
        url: '',
        content_type: '',
      })
    }
    if (typeof options.onProgress === 'function') {
      options.onProgress(Math.round(((index + 1) / files.length) * 100), index, files.length)
    }
  }

  const failCount = files.length - successCount
  return {
    success: successCount > 0,
    message: files.length ? `成功${successCount}个，失败${failCount}个` : '无文件',
    data: items,
    successList: items.filter((item) => item.code === 200).map((item) => item.url),
    failCount,
  }
}
