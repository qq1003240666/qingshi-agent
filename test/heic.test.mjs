// HEIC 上传：检测、转 JPG、再走标准三步。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isHeicFile, convertHeicToJpeg, jpegNameFor } from '../packages/core/lib/heic.js'
import { createUploader } from '../packages/core/lib/upload.js'

const tmp = (tag) => mkdtemp(join(tmpdir(), `qingshi-heic-${tag}-`))

// 一张「够真」的最小 JPEG：足够长，头是 FF D8 FF
function fakeJpeg() {
  const buffer = Buffer.alloc(2048, 0x11)
  buffer[0] = 0xff
  buffer[1] = 0xd8
  buffer[2] = 0xff
  buffer[buffer.length - 2] = 0xff
  buffer[buffer.length - 1] = 0xd9
  return buffer
}

// 带 HEIC brand 的假文件头
function fakeHeic() {
  const buffer = Buffer.alloc(64, 0)
  buffer.write('ftyp', 4, 'latin1')
  buffer.write('heic', 8, 'latin1')
  return buffer
}

test('HEIC 检测：扩展名和文件头都能识别', async () => {
  const dir = await tmp('detect')
  try {
    const byExt = join(dir, 'IMG_0001.HEIC')
    const byMagic = join(dir, 'noext.bin')
    const jpeg = join(dir, 'normal.jpg')
    await writeFile(byExt, fakeHeic())
    await writeFile(byMagic, fakeHeic())
    await writeFile(jpeg, fakeJpeg())

    assert.equal(await isHeicFile(byExt), true)
    assert.equal(await isHeicFile(byMagic), true)
    assert.equal(await isHeicFile(jpeg), false)
    assert.equal(jpegNameFor('IMG_0001.HEIC'), 'IMG_0001.jpg')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('HEIC 转换：校验输出必须是真 JPEG，并能清理临时文件', async () => {
  const dir = await tmp('convert')
  try {
    const input = join(dir, 'IMG_0001.heic')
    await writeFile(input, fakeHeic())
    let outputPath = ''
    const strategies = [
      {
        name: 'fake',
        run: async (_input, output) => {
          outputPath = output
          await writeFile(output, fakeJpeg())
        },
      },
    ]
    const converted = await convertHeicToJpeg(input, { strategies })
    assert.equal(converted.strategy, 'fake')
    assert.match(converted.path, /\.jpg$/)
    assert.equal((await readFile(converted.path)).length, 2048)

    await converted.cleanup()
    await assert.rejects(() => readFile(outputPath))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('HEIC 转换失败：给出可执行的提示', async () => {
  const dir = await tmp('fail')
  try {
    const input = join(dir, 'IMG_0002.heic')
    await writeFile(input, fakeHeic())
    const strategies = [
      { name: 'broken', run: async () => { throw new Error('codec missing') } },
    ]
    await assert.rejects(() => convertHeicToJpeg(input, { strategies }), /HEIC 解码器/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('上传 HEIC：转成 jpg 后仍走标准三步，字段与前端一致', async () => {
  const dir = await tmp('upload')
  const input = join(dir, 'IMG_0001.HEIC')
    await writeFile(input, fakeHeic())
    let convertedPath = ''
    const heicStrategies = [
      {
        name: 'fake',
        run: async (_input, output) => {
          convertedPath = output
          await writeFile(output, fakeJpeg())
        },
      },
    ]

    const calls = []
    const authed = async (path, body) => {
      calls.push([path, body])
      if (path === '/get_oss_upload_signature') {
        return {
          code: 200,
          data: {
            host: 'https://oss.example.com',
            object_key: 'career/2023/x.jpg',
            upload_file_id: 'sig-id',
            form_data: { key: 'career/2023/x.jpg', policy: 'p', success_action_status: '200' },
          },
        }
      }
      if (path === '/confirm_oss_upload') {
        return {
          code: 200,
          data: { upload_file_id: 'done-id', url: 'https://cdn/x.jpg', file_info: { content_type: 'image/jpeg' } },
        }
      }
      throw new Error('unexpected ' + path)
    }

    const originalFetch = globalThis.fetch
    let hostedFile = null
    globalThis.fetch = async (_url, init) => {
      hostedFile = init.body.get('file')
      return { ok: true, status: 200, text: async () => '' }
    }

    try {
      const upload = createUploader()
      const result = await upload(authed, input, { uid: 'u1', heicStrategies })

      // 签名里已经是 jpg，而不是 heic
      const signBody = calls[0][1]
      assert.equal(signBody.file_name, 'IMG_0001.jpg')
      assert.equal(signBody.content_type, 'image/jpeg')
      assert.equal(signBody.file_size, 2048)
      assert.equal(signBody.biz_type, 'career_media')

      // 直传的也是转换后的 jpg
      assert.equal(hostedFile.name, 'IMG_0001.jpg')
      assert.equal(hostedFile.type, 'image/jpeg')

      assert.equal(result.upload_file_id, 'done-id')
      assert.equal(result.converted_from, input)

      // 临时文件已经清掉
      await assert.rejects(() => readFile(convertedPath))
    } finally {
      globalThis.fetch = originalFetch
      await rm(dir, { recursive: true, force: true })
    }
})
