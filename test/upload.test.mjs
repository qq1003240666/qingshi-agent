// 标准上传链路的回归测试：字段、顺序、返回值必须和
// 小程序 / H5 的 核心代码/utils/upload.js 一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createUploader, normalizeUploadFile } from '../packages/core/lib/upload.js'

const tmp = (name) => mkdtemp(join(tmpdir(), `qingshi-upload-${name}-`))

test('三步上传：签名字段与前端一致，返回 confirm 的 id/url', async () => {
  const dir = await tmp('ok')
  const file = join(dir, 'IMG_20230815_090000.jpg')
  await writeFile(file, Buffer.alloc(1024, 7))

  const calls = []
  const authed = async (path, body) => {
    calls.push([path, body])
    if (path === '/get_oss_upload_signature') {
      return {
        code: 200,
        data: {
          host: 'https://oss.example.com/',
          object_key: 'career/2023/1.jpg',
          upload_file_id: 'sig-id',
          form_data: {
            key: 'career/2023/1.jpg',
            policy: 'policy',
            OSSAccessKeyId: 'ak',
            signature: 'sig',
            success_action_status: '200',
          },
        },
      }
    }
    if (path === '/confirm_oss_upload') {
      return {
        code: 200,
        data: {
          upload_file_id: 'confirmed-id',
          url: 'https://cdn.example.com/career/2023/1.jpg',
          file_info: { content_type: 'image/jpeg' },
        },
      }
    }
    throw new Error('unexpected path: ' + path)
  }

  const originalFetch = globalThis.fetch
  let hosted = null
  globalThis.fetch = async (url, init) => {
    hosted = { url, init }
    return { ok: true, status: 200, text: async () => '' }
  }

  try {
    const upload = createUploader()
    const result = await upload(authed, file, { uid: 'u1' })

    // 1. 签名请求的字段集合必须和前端完全一致
    const [signPath, signBody] = calls[0]
    assert.equal(signPath, '/get_oss_upload_signature')
    assert.deepEqual(Object.keys(signBody).sort(), [
      'biz_type',
      'content_type',
      'custom_object_key',
      'file_name',
      'file_size',
      'of_uid',
      'target_type',
    ])
    assert.equal(signBody.biz_type, 'career_media')
    assert.equal(signBody.of_uid, 'u1')
    assert.equal(signBody.target_type, 'user_profile')
    assert.equal(signBody.custom_object_key, '')
    assert.equal(signBody.file_name, 'IMG_20230815_090000.jpg')
    assert.equal(signBody.file_size, 1024)
    assert.equal(signBody.content_type, 'image/jpeg')

    // 2. 直传 OSS：multipart，字段名固定 file
    assert.equal(hosted.url, 'https://oss.example.com')
    assert.equal(hosted.init.method, 'POST')
    assert.ok(hosted.init.body instanceof FormData)
    assert.ok(hosted.init.body.has('file'))
    assert.equal(hosted.init.body.get('key'), 'career/2023/1.jpg')

    // 3. 确认入库
    assert.equal(calls[1][0], '/confirm_oss_upload')
    assert.deepEqual(calls[1][1], { upload_file_id: 'sig-id', object_key: 'career/2023/1.jpg' })

    // 4. 返回值优先取 confirm 的结果
    assert.equal(result.upload_file_id, 'confirmed-id')
    assert.equal(result.url, 'https://cdn.example.com/career/2023/1.jpg')
    assert.equal(result.content_type, 'image/jpeg')
  } finally {
    globalThis.fetch = originalFetch
    await rm(dir, { recursive: true, force: true })
  }
})

test('扩展名白名单：career_media 拒绝 exe', async () => {
  const dir = await tmp('bad')
  const file = join(dir, 'evil.exe')
  await writeFile(file, Buffer.from([1]))
  try {
    await assert.rejects(() => normalizeUploadFile(file, { bizType: 'career_media' }), /不支持的文件类型/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('没有扩展名时按 content_type 补全', async () => {
  const dir = await tmp('noext')
  const file = join(dir, 'noext')
  await writeFile(file, Buffer.from([1, 2, 3]))
  try {
    const info = await normalizeUploadFile(file, { contentType: 'image/png' })
    assert.equal(info.fileName, 'noext.png')
    assert.equal(info.contentType, 'image/png')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('空文件拒绝', async () => {
  const dir = await tmp('empty')
  const file = join(dir, 'empty.jpg')
  await writeFile(file, Buffer.alloc(0))
  try {
    await assert.rejects(() => normalizeUploadFile(file), /必须大于 0/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
