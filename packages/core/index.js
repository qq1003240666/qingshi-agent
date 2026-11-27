// 青史 × DSH —— 让 Harness 能读/写用户自己的日记与族谱记录。
//
// 三步结构：
//   1. 登录：qingshi_login 起一个本机小页面（127.0.0.1 随机端口）让用户输手机号+验证码，
//      页面把请求交给插件，插件转给青史后端 —— token 不经过对话。
//   2. 工作区：两个 token 落在 workspace 目录的 auth.json（0600），见 lib/workspace.js。
//   3. 请求层：复刻小程序端 utils/request.js 的 httpRequest，见 lib/request.js。
//
// 安全底线：access_token / refresh_token 绝不作为工具参数，也绝不写进工具输出。
// 宿主可以是 DSH（有 @deepseek-ai/dsh-tools），也可以是 MCP server 这种没有它的环境。
// 没有就把 defineTool 退化成恒等函数：工具定义本来就只是一个普通对象。
let defineTool = (spec) => spec
let dshHost = false
try {
  ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  dshHost = true
} catch {
  // 非 DSH 环境：保持恒等实现
}
import { createWorkspace } from './lib/workspace.js'
import { pickHomeDir, describeHomeDir, migrateLegacy, shouldMigrate } from './lib/paths.js'
import { formatDate } from './lib/format.js'
import { createRequest } from './lib/request.js'
import { createDraftStore } from './lib/drafts.js'
import { createUploader } from './lib/upload.js'
import { launchApp, attach, findBrowser } from './lib/browser.js'
import { launchShell, findElectron } from './lib/electron-shell.js'
import { startLoginServer } from './lib/login-server.js'
import { openInWindow } from './lib/open-browser.js'
import { PAGES, findPages, pageUrl, pageBrief } from './lib/pages-map.js'
import { installWindowBar } from './lib/window-bar.js'
import { createCareerApi } from './lib/career-api.js'
import { scanMedia, formatScan, formatBytes } from './lib/photo-scan.js'
import { createPhoneUpload } from './lib/phone-upload.js'
import { createGeocoder } from './lib/geo.js'
import { createUserCache } from './lib/users.js'
import { setHost, setClientInfo, resolveClientLabel, appendAttribution } from './lib/attribution.js'
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// 记下「我在谁家跑」，写记录时署名要用（DSH / MCP 客户端 / 独立运行）
setHost(dshHost ? 'dsh' : 'standalone')
if (process.env.QINGSHI_CLIENT_NAME) setClientInfo(process.env.QINGSHI_CLIENT_NAME)

// 随包分发的技能目录：源码在 packages/core/skills，构建后与 index.js 同级
const SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'docs', 'org-entry')

// /edit_event 的字段中文名与展示方式（改完要给用户看「什么变成了什么」）
const FIELD_LABELS_PLUGIN = {
  title: '标题',
  content: '正文',
  start_date: '开始时间',
  end_date: '结束时间',
  is_Stage: '阶段事件',
  event_tag: '标签',
  location: '地点',
  media_list: '图片',
}

function showEditable(fields, key) {
  const value = fields?.[key]
  if (key === 'location') {
    if (!value || (!value.name && !value.address)) return '（无）'
    const coords = value.latitude || value.longitude ? ' ' + value.latitude + ',' + value.longitude : ''
    const address = value.address && value.address !== value.name ? '（' + value.address + '）' : ''
    return String((value.name || '') + address + coords).trim() || '（无）'
  }
  if (key === 'media_list') return Array.isArray(value) && value.length ? value.length + ' 张图' : '（无图）'
  if (key === 'is_Stage') return value ? '是' : '否'
  const text = String(value ?? '').trim()
  if (key === 'content' && text.length > 60) return text.slice(0, 60) + '…'
  return text || '（空）'
}

export const inject = ['tools', 'systemPrompt']

const textOut = (value) => [{ type: 'text', text: String(value ?? '') }]

const outputSpec = {
  schema: { type: 'string' },
  render: (_args, value) => textOut(value),
}

// 用户所在时区的「今天」，YYYY-MM-DD。青史的 start_date 是必填的。
function todayText() {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

const NL = String.fromCharCode(10)

// 按生日算到今天的岁数（有忌日就算享年）；只到年，不做虚岁
function ageOf(birthday, deathday) {
  const b = String(birthday || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b)) return null
  const [by, bm, bd] = b.split('-').map(Number)
  const endRaw = String(deathday || '').slice(0, 10)
  const end = /^\d{4}-\d{2}-\d{2}$/.test(endRaw) ? new Date(endRaw + 'T00:00:00') : new Date()
  let age = end.getFullYear() - by
  const passed = end.getMonth() + 1 > bm || (end.getMonth() + 1 === bm && end.getDate() >= bd)
  if (!passed) age -= 1
  if (age < 0 || age > 130) return null
  return age
}

function ageText(birthday, deathday) {
  const age = ageOf(birthday, deathday)
  if (age === null) return ''
  const ended = String(deathday || '').slice(0, 10)
  return ended ? '享年 ' + age + ' 岁' : age + ' 岁'
}

// 青史后端的体验用户 uid（H5 没登录时会自动发一个体验身份，别把它当真实账号）
const EXPERIENCE_UID = '100000000000000000'

const pick = (obj, ...keys) => {
  for (const key of keys) {
    const value = obj?.[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return ''
}

// 青史的 24 个事件标签（跟后端 SYSTEM_PROMPT 里的「生涯事件类型表」一致）
const TAG_LABELS = {
  record: '记录',
  birthday: '生日',
  happy: '开心',
  family: '家庭',
  friend: '朋友',
  party: '聚会',
  festival: '节日',
  work: '工作',
  study: '学习',
  growth: '成长',
  achievement: '成就',
  challenge: '挑战',
  idea: '想法',
  memorial: '纪念',
  summary: '总结',
  travel: '旅行',
  scenery: '风景',
  food: '美食',
  memory: '回忆',
  sad: '伤心',
  love: '爱情',
  consume: '消费',
  save: '储蓄',
  turning: '转折',
  // 线上真实数据里还出现过这些写法（后端 service.py 的提示词用的是另一套名字）
  hobby: '爱好',
  spending: '消费',
  savings: '储蓄',
  turning_point: '转折',
}

// 写记录时给用户的标签清单（顺序与后端 EVENT_TAG_VALUES 一致）
const TAG_ORDER = [
  'record', 'birthday', 'happy', 'family', 'friend', 'party', 'festival',
  'work', 'study', 'growth', 'achievement', 'challenge', 'idea', 'memorial',
  'summary', 'travel', 'scenery', 'food', 'memory', 'sad', 'love',
  'consume', 'save', 'turning',
]
const TAG_HINTS = {
  record: '日常里想留下的一件事',
  birthday: '谁的生日',
  happy: '开心的一天',
  family: '和家人有关',
  friend: '和朋友有关',
  party: '聚会、饭局',
  festival: '节日',
  work: '工作上的事',
  study: '学习、考试、读书',
  growth: '自己的变化',
  achievement: '做成了什么',
  challenge: '难熬、撑过去的事',
  idea: '突然想到的念头',
  memorial: '怀念、祭奠',
  summary: '一段时间的总结',
  travel: '出门旅行',
  scenery: '看到的风景',
  food: '吃到的东西',
  memory: '回忆过去',
  sad: '难过的事',
  love: '感情',
  consume: '花了一笔钱',
  save: '存下、攒下了',
  turning: '人生转折',
}

const tagLabel = (tag) => (TAG_LABELS[tag] ? `${TAG_LABELS[tag]}(${tag})` : tag || '记录')

// 同一类事件在线上有过两种写法，比较/统计时先归一
const TAG_ALIASES = { spending: 'consume', savings: 'save', turning_point: 'turning' }
const canonicalTag = (tag) => {
  const key = String(tag || '').trim()
  return TAG_ALIASES[key] || key || 'record'
}


// 后端 /get_career_list 的 event_list 元素字段名做了兼容取值
function normalizeEvent(item) {
  const rawLocation = item?.location
  return {
    eventId: String(pick(item, 'event_id', 'eventId', 'id')),
    title: String(pick(item, 'title')) || '(无标题)',
    content: String(pick(item, 'content')),
    contentFullLength: Number(pick(item, 'content_full_length')) || 0,
    contentTruncated: item?.content_truncated === true,
    startDate: String(pick(item, 'start_date', 'startDate')),
    endDate: String(pick(item, 'end_date', 'endDate')),
    eventTag: String(pick(item, 'event_tag', 'eventTag')) || 'record',
    isStage: Boolean(pick(item, 'is_stage', 'isStage')),
    locationName: String(
      typeof rawLocation === 'string' ? rawLocation : pick(rawLocation, 'name') || '',
    ),
    locationAddress: String(
      typeof rawLocation === 'string' ? '' : pick(rawLocation, 'address') || '',
    ),
    // 事件带的图片：保留 url 和 upload_file_id
    media: (Array.isArray(item?.media_list) ? item.media_list : [])
      .map((m) => ({
        url: String(pick(m, 'url') || ''),
        contentType: String(pick(m, 'content_type', 'contentType') || 'image/jpeg'),
        uploadFileId: String(pick(m, 'upload_file_id', 'uploadFileId') || ''),
      }))
      .filter((m) => m.url),
  }
}

// 关键词同时匹配标题、正文、地点名和地址 —— "我有没有去过沈阳" 靠地点也能命中
function eventText(item) {
  return [item.title, item.content, item.locationName, item.locationAddress]
    .join(' ')
    .toLowerCase()
}

export function apply(ctx, config = {}) {
  // 数据目录：显式配置 > QINGSHI_HOME > ~/qingshi-plugin。
  // 老版本在 %APPDATA%\qingshi、~/Library/Application Support/qingshi、~/.config/qingshi、
  // ~/.dsh/qingshi-workspace 或当前目录的一次性搬过来，登录态不用重来。
  const picked = pickHomeDir(config)
  const dataDir = picked.dir
  if (shouldMigrate(config)) migrateLegacy(dataDir)
  const cfg = {
    apiBaseUrl: String(config.apiBaseUrl || 'https://api.iyouwc.cn').replace(/\/+$/, ''),
    workspaceDir: dataDir,
    allowFamilyWrite: config.allowFamilyWrite === true,
    autoOpenBrowser: config.autoOpenBrowser !== false,
    openLoginWindow: config.openLoginWindow !== false,
    // 后端按 X-Client-Platform 隔离 refresh_token 行（uid + platform 一行）。
    // 插件用自己的标识，就不会和微信小程序/h5 互相顶号。
    clientPlatform: String(config.clientPlatform || 'plugin').trim() || 'plugin',
    // 署名用：写记录时在正文末尾加「—— 本条由 <名字> 协助录入」
    clientName: String(config.clientName || '').trim(),
    // 登录时给后端的平台标记：留空 = 不拦截（后端会记成 h5/unknown）
    requestPlatform: String(config.requestPlatform === undefined ? 'plugin' : config.requestPlatform || '').trim(),
    autoRecord: ['off', 'suggest', 'auto'].includes(String(config.autoRecord || ''))
      ? String(config.autoRecord)
      : 'suggest',
    // 真 H5 站点（截图/浏览/自动化都打这个）
    webBaseUrl: String(config.webBaseUrl || 'https://qingshi.iyouwc.cn').replace(/\/+$/, ''),
    // 浏览器 profile 目录（登录态靠它跨会话保留；端口由 Chrome 自己挑，从 DevToolsActivePort 读回来）
    browserProfileDir: String(config.browserProfileDir || join(dataDir, 'browser-profile')),
    // 窗口形态（默认 app：用系统 Chrome/Edge 的 --app 模式，零安装）：
    //   app      = Chrome/Edge --app=<url>，无地址栏和标签页的独立窗口，推荐，免安装
    //   kiosk    = Chrome/Edge 无边框全屏（按 Esc 退出，自绘标题条）
    //   electron = 自带 Electron 外壳（需要单独安装，随包附带 ~230MB，只有用户显式指定才用）
    windowMode: (() => {
      const raw = String(config.windowMode || 'app').toLowerCase()
      return ['app', 'kiosk', 'electron'].includes(raw) ? raw : 'app'
    })(),
    // Electron 外壳的 userData（登录态、CDP 端口都在这）。
    // 注意：DSH 的受限令牌只对「会话工作区」可写，~/.dsh 与 %TEMP% 都会被拒，
    // 所以默认放工作区；electron-shell 里还会再探一次可写性做兜底。
    electronProfileDir: String(config.electronProfileDir || join(dataDir, 'electron-profile')),
    // 窗口固定尺寸，形如 "1180x880"
    windowSize: (() => {
      const raw = String(config.windowSize || '1180x880').toLowerCase().replace(new RegExp('\\s+', 'g'), '')
      const m = raw.match(new RegExp('^(\\d{3,4})[x*](\\d{3,4})$'))
      return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1180, height: 880 }
    })(),
  }

  const workspace = createWorkspace(cfg.workspaceDir)
  const request = createRequest({
    apiBaseUrl: cfg.apiBaseUrl,
    workspace,
    clientPlatform: cfg.clientPlatform,
    logger: (line) => ctx.logger?.debug?.(line),
  })

  // 复刻的 httpRequest 默认 needAccessToken=false（跟小程序端一致），
  // 业务接口统一走这个包装，自动带上 Bearer access_token。
  /**
   * 给「当前这份凭证」拍个快照，用来判断别的窗口有没有换过 token。
   * 只比较尾部和时间戳，不打印完整 token。
   */
  async function authSnapshot() {
    const info = await workspace.info().catch(() => ({}))
    const token = String(info.accessToken || '')
    return {
      stamp: [info.savedAt || '', token ? token.slice(-8) : ''].join('|'),
      savedAt: info.savedAt || '',
    }
  }

  /**
   * 带登录态的请求。
   * 401/403 时不急着让用户重新登录：页面自己会续期，窗口里可能已经有新的 token，
   * 先从窗口捞一次再重试，捞不到才把「登录已失效」往上抛。
   */
  const authed = async (api, body = {}, options = {}) => {
    const opts = { needAccessToken: true, ...options }
    const before = await authSnapshot()
    const first = await request.httpRequest(api, body, opts)
    if (first.code !== 401 && first.code !== 403) return first

    // ① 另一个对话窗口可能刚登录过/刚续过期：auth.json 是所有窗口共用的，
    //    文件变了就直接用新的再试，不要让他重复登录（重复登录会顶掉对方那行 RT）。
    const after = await authSnapshot()
    if (after.stamp !== before.stamp) return request.httpRequest(api, body, opts)

    // ② 对方可能正在写文件：等一秒再比一次
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const later = await authSnapshot()
    if (later.stamp !== before.stamp) return request.httpRequest(api, body, opts)

    // ③ 窗口里的页面也许已经自己续过期了
    if (!options.noRetryFromPage) {
      const session = (await liveBrowser()) || (await attachExistingWindow())
      if (session) {
        const synced = await syncTokenFromBrowser(session).catch(() => null)
        if (synced?.ok) return request.httpRequest(api, body, opts)
      }
    }
    return first
  }

  // 本地草稿箱（发布时才上传云端）
  const drafts = createDraftStore(cfg.workspaceDir)
  const uploadMedia = createUploader({ logger: (line) => ctx.logger?.debug?.(line) })
  // 经纬度 → 地名（高德配了 key 就用高德，否则用 Photon；都失败就只显示坐标）
  const geocoder = createGeocoder({ logger: (line) => ctx.logger?.debug?.(line) })
  // 生涯事件的读写（/get_event、/edit_event、/delete_event、/get_career_list、族谱）
  const careerApi = createCareerApi({
    authed,
    workspaceDir: cfg.workspaceDir,
    logger: (line) => ctx.logger?.debug?.(line),
  })
  // 手机扫码上传：临时桶只暂存，下载回本地后仍走标准三步上传
  const phoneUpload = createPhoneUpload({
    workspaceDir: cfg.workspaceDir,
    authed,
    openWindow: (url, options) => openInWindow(url, options),
    logger: (line) => ctx.logger?.debug?.(line),
  })
  // 族谱接口只回 uid + 称呼，昵称/生日要另查 /get_userinfo（24h 缓存）。
  const users = createUserCache({
    workspaceDir: cfg.workspaceDir,
    request,
    logger: (line) => ctx.logger?.debug?.(line),
  })
  // 真 H5 的浏览器会话（一次只留一个）
  let browserSession = null
  let browserPid = 0

  // ---------- 真 H5 浏览器（qingshi.iyouwc.cn） ----------
  async function liveBrowser() {
    if (!browserSession) return null
    try {
      await browserSession.evaluate('1')
      return browserSession
    } catch {
      browserSession = null
      return null
    }
  }

  /**
   * DSH 重启后青史窗口可能还开着：先试着连回它，免得又开一个。
   * Electron 外壳会把自己的调试端口写进 <profile>/DevToolsActivePort。
   */
  // 所有 DSH 会话共用一个青史窗口：开窗时把 pid/端口/profile 写进工作区，
  // 别的会话调用工具时先来认领这个窗口，认领不到才自己开新的。
  const windowRegistryFile = () => join(cfg.workspaceDir, 'browser-window.json')

  async function readWindowRegistry() {
    try {
      const data = JSON.parse(await readFile(windowRegistryFile(), 'utf8'))
      return data && typeof data === 'object' ? data : null
    } catch {
      return null
    }
  }

  async function writeWindowRegistry(info) {
    try {
      const payload = { ...info, updatedAt: new Date().toISOString() }
      await writeFile(windowRegistryFile(), JSON.stringify(payload, null, 2) + NL, { mode: 0o600 })
    } catch (error) {
      ctx.logger?.debug?.('写窗口注册表失败：' + (error?.message || String(error)))
    }
  }

  /** 这个端口上还有没有活着的页面（顺带确认是不是青史站点）。 */
  async function portAlive(port) {
    if (!port) return false
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version', {
        signal: AbortSignal.timeout(1200),
      })
      return Boolean(res?.ok)
    } catch {
      return false
    }
  }

  const profileMemoFile = () => join(cfg.workspaceDir, 'browser-profile.json')

  async function readLastProfileDir() {
    try {
      const text = await readFile(profileMemoFile(), 'utf8')
      const data = JSON.parse(text)
      return typeof data?.profileDir === 'string' ? data.profileDir : ''
    } catch {
      return ''
    }
  }

  async function rememberProfileDir(dir) {
    if (!dir) return
    try {
      await writeFile(profileMemoFile(), JSON.stringify({ profileDir: dir, savedAt: new Date().toISOString() }, null, 2) + NL, { mode: 0o600 })
    } catch (error) {
      ctx.logger?.debug?.('记 profile 目录失败：' + (error?.message || String(error)))
    }
  }

  async function attachExistingWindow() {
    // ① 先认领注册表里那个（别的会话开过的）窗口——这就是「全局共用一个窗口」
    const registry = await readWindowRegistry()
    if (registry?.port && (await portAlive(registry.port))) {
      try {
        const session = await attach({ port: registry.port, hint: 'qingshi.iyouwc.cn' })
        browserSession = session
        if (registry.pid) browserPid = registry.pid
        if (registry.profileDir) await rememberProfileDir(registry.profileDir)
        const currentUrl = await session.currentUrl().catch(() => '')
        if (!/^https?:/i.test(String(currentUrl || ''))) {
          await session.goto(pageUrl(cfg.webBaseUrl, '/pages/career/career')).catch(() => {})
        }
        return session
      } catch {
        /* 认领失败就继续往下找 */
      }
    }

    // ② 再按 profile 目录里的 DevToolsActivePort 找（兼容老版本开的窗口）
    let port = 0
    const candidates = []
    const saved = await readLastProfileDir()
    if (saved) candidates.push(saved)
    if (cfg.electronProfileDir) candidates.push(cfg.electronProfileDir)
    // Chrome/Edge 应用窗口用的是这个 profile，以前漏掉了 → 才会又开一个新窗口
    if (cfg.browserProfileDir) candidates.push(cfg.browserProfileDir)
    candidates.push(join(process.env.DSH_WORKSPACE || process.cwd(), '.qingshi-electron-profile'))
    for (const dir of candidates) {
      try {
        const text = await readFile(join(dir, 'DevToolsActivePort'), 'utf8')
        const value = Number(String(text).split(/\r?\n/)[0]) || 0
        if (value) { port = value; break }
      } catch {}
    }
    if (!port) return null
    if (!port) return null
    try {
      const alive = await fetch('http://127.0.0.1:' + port + '/json/version', {
        signal: AbortSignal.timeout(1500),
      })
      if (!alive.ok) return null
    } catch {
      return null
    }
    try {
      const session = await attach({ port, hint: 'qingshi.iyouwc.cn' })
      browserSession = session
      // 复用到的是刚起来的空窗口（about:blank）时，先把它导航到首页
      const currentUrl = await session.currentUrl().catch(() => '')
      if (!/^https?:/i.test(String(currentUrl || ''))) {
        await session.goto(pageUrl(cfg.webBaseUrl, '/pages/career/career')).catch(() => {})
      }
      return session
    } catch {
      return null
    }
  }

  /** 复用或启动真 H5 窗口；给了 route 就导航过去。 */
  /**
   * 把本地工作区里的 token 注入浏览器 localStorage，让任何新窗口一打开就是登录态。
   * 这样换 profile / 缓存被清 / 换机器（拷了 auth.json）都不用重新扫码登录。
   */
  async function hydrateBrowserAuth(session, route) {
    try {
      const info = await workspace.info()
      const accessToken = await workspace.getAccessToken()
      const refreshToken = await workspace.getRefreshToken()
      if (!info.loggedIn || !accessToken) return false
      const current = await session.storage().catch(() => null)
      if (current && current.access_token === accessToken) return true
      const payload = {
        access_token: accessToken,
        refresh_token: refreshToken || '',
        my_uid: String(info.uid || ''),
      }
      await session.evaluate(
        `(() => {
          const p = ${JSON.stringify(payload)};
          Object.keys(p).forEach((k) => { if (p[k]) localStorage.setItem(k, p[k]) });
          return true;
        })()`,
      )
      await session.goto(pageUrl(cfg.webBaseUrl, route || '/pages/career/career')).catch(() => {})
      await new Promise((r) => setTimeout(r, 1200))
      return true
    } catch (error) {
      ctx.logger?.debug?.('把 token 注入窗口失败：' + (error?.message || String(error)))
      return false
    }
  }

  /**
   * 登录态双向对账：
   *   ① 窗口里已经登录了 → 把 token 抄回工作区（用户刚在窗口里登完，这一步必须做，
   *      否则插件这边一直以为没登录、每次都催他再登一次）；
   *   ② 工作区有 token、窗口里没有 → 注入回去（换 profile / 清了缓存也不用重登）。
   */
  async function reconcileAuth(session, route) {
    const synced = await syncTokenFromBrowser(session).catch((error) => ({
      ok: false,
      reason: error?.message || String(error),
    }))
    if (synced?.ok) return synced
    await hydrateBrowserAuth(session, route)
    return synced
  }

  /**
   * 数据类工具的统一入口。
   * 用户在窗口里刚登录完、插件还没同步时，这里会先问窗口要一次 token，
   * 而不是直接甩一句「尚未登录」让他再登一遍。
   */
  /** 拿一次最便宜的后端调用，确认手上的 token 服务端还认。返回 response code。 */
  async function probeToken(uid) {
    const probe = await authed('/get_career_list', {
      of_type: 'user',
      of_id: uid,
      content_preview_limit: 1,
    }).catch(() => ({ code: 0 }))
    return Number(probe.code) || 0
  }

  /**
   * 弹「插件自己的」登录小窗，等用户登完，凭证自动落盘。返回 {ok, uid, message}。
   * 这是全插件唯一的登录入口：qingshi_login 和 ensureLoggedIn 都走它。
   */
  // 这台机器能不能弹窗：有 Electron 外壳，或者有可用的 Chrome/Edge。
  function canOpenWindow() {
    try {
      if (findElectron()) return true
    } catch {
      /* 探不到就当没有 */
    }
    try {
      if (findBrowser()) return true
    } catch {
      /* 同上 */
    }
    return false
  }

  // 文字登录（MCP / 远程环境）：短信发送后把手机号记在这里，等用户回一条验证码。
  const pendingLogin = { phone: '', sentAt: 0, ttlMs: 10 * 60 * 1000 }

  function maskPhone(phone) {
    const text = String(phone || '')
    if (text.length < 7) return text
    return text.slice(0, 3) + '****' + text.slice(-4)
  }

  function pendingValid() {
    return Boolean(pendingLogin.phone) && Date.now() - pendingLogin.sentAt < pendingLogin.ttlMs
  }

  // 登录闸门：只在「确认凭证失效」之后、且用户点头之后，才弹窗。
  // kind = 'expired'（服务端 401/403，凭证真的失效了）| 'missing'（这台机器从来没登过）
  const loginConsent = { at: 0, kind: '', ttlMs: 5 * 60 * 1000 }

  function grantConsent(kind) {
    loginConsent.at = Date.now()
    loginConsent.kind = String(kind || 'expired')
  }

  function consentValid(kind) {
    return loginConsent.kind === kind && Date.now() - loginConsent.at < loginConsent.ttlMs
  }

  function clearConsent() {
    loginConsent.at = 0
    loginConsent.kind = ''
  }

  /**
   * 弹窗之前先说的那句话。expired 用「我本来要帮你查，但认证过期了」的口径，
   * missing 用「第一次用得先绑定手机号」的口径——两者别混。
   */
  function expiredNoticeText(kind, phoneFlow) {
    if (kind === 'missing') {
      if (phoneFlow) {
        return [
          '我这台机器上还没有青史的登录凭证，所以现在读不到你的记录。',
          '第一次用的话：微信搜小程序「青史永存」→ 注册时绑定手机号。',
          '绑好之后把手机号发我，我发验证码，你报一下 6 位数字就能接上。',
        ].join(NL)
      }
      return [
        '我这台机器上还没有青史的登录凭证，所以现在读不到你的记录。',
        '第一次用的话：微信搜小程序「青史永存」→ 注册时绑定手机号 → 回来我弹个登录窗，用同一个手机号登一次。',
        '现在要我打开登录窗吗？',
      ].join(NL)
    }
    if (phoneFlow) {
      return [
        '我可以从「青史永存」里拉取你的记录，但发现你的身份认证已经过期了（服务端返回 403）。',
        '这台机器没法弹窗，把手机号发我，我发验证码，你报一下 6 位数字就能重新接上。',
      ].join(NL)
    }
    return [
      '我可以从「青史永存」里拉取你的记录，但发现你的身份认证已经过期了（服务端返回 403）。',
      '重新登录一次就能继续——现在要我打开登录窗吗？（也可以直接把手机号发我，我用短信验证码帮你登。）',
    ].join(NL)
  }

  // 未登录时给模型的话术：优先用上面带「为什么」的那段。
  function needLoginText(info) {
    if (info && info.notice) return info.notice
    if (info && info.phoneFlow) {
      return [
        '还没登录青史（这台机器没有可用的窗口，走短信验证码登录）。',
        '先问用户的手机号，调 qingshi_login 传 phone；用户收到短信后，把 6 位验证码传 code，就能登进去。',
      ].join(NL)
    }
    return '登录已过期，我这边会弹一个小登录窗，你在里面用手机号登一次就行，登完自动接上（不用去小程序、也不用点任何按钮）。'
  }

  async function openLoginWindowAndWait({ waitSeconds = 120, reason = '' } = {}) {
    const seconds = Number(waitSeconds) > 0 ? Number(waitSeconds) : 120
    const server = await startLoginServer({
      sendCode: sendLoginCode,
      submitLogin,
      isLoggedIn: async () => (await workspace.info()).loggedIn,
      logger: (line) => ctx.logger?.debug?.(line),
      timeoutMs: seconds * 1000,
    })

    // 登录窗优先走 Electron 外壳：它是 Harness 的子进程，DSH 一退就跟着关。
    const LOGIN_WIDTH = 470
    const LOGIN_HEIGHT = 640
    let openedShell = null
    if (cfg.openLoginWindow) {
      try {
        openedShell = await launchShell({
          url: server.url,
          width: LOGIN_WIDTH,
          height: LOGIN_HEIGHT,
          userDataDir: join(cfg.workspaceDir, 'login-window-profile'),
          logger: (line) => ctx.logger?.debug?.(line),
        })
      } catch (error) {
        ctx.logger?.debug?.('登录窗走外壳失败，退回浏览器窗口：' + error.message)
      }
      if (!openedShell && findBrowser()) {
        const opened = openInWindow(server.url, { width: LOGIN_WIDTH, height: LOGIN_HEIGHT, title: '登录青史' })
        if (!opened || opened.opened === false) {
          ctx.logger?.debug?.('打开登录窗口失败：' + ((opened && opened.error) || '未知原因'))
        }
      }
    }

    ctx.logger?.debug?.('登录页已打开 ' + server.url + (reason ? '（' + reason + '）' : ''))
    const result = await server.done
    if (!result.ok) {
      server.close()
      return {
        ok: false,
        uid: '',
        message:
          '登录窗口没等到完成（' +
          (result.reason === 'timeout' ? '超时' : '被关掉了') +
          '）。登录页地址：' +
          server.url,
      }
    }

    // 登录成功：把新凭证注入青史窗口，省掉「再点一次确认」
    try {
      const opened = await ensureBrowser('/pages/career/career')
      if (!opened.error) await hydrateBrowserAuth(opened.session)
    } catch (error) {
      ctx.logger?.debug?.('登录后同步窗口失败：' + (error?.message || String(error)))
    }

    return { ok: true, uid: String(result.uid || '') }
  }

  /**
   * 数据类工具的统一入口：先验 token，过期就自己弹登录窗，登完继续。
   * 用户不需要去小程序登录、也不需要回对话点「我已登录」。
   */
  async function ensureLoggedIn({ allowLogin = true, confirm = false } = {}) {
    let info = await workspace.info()
    let kind = info.loggedIn ? '' : 'missing'

    // 工作区没凭证时，先问还开着的窗口要一次（用户可能刚在里面登过）
    if (!info.loggedIn) {
      const session = (await liveBrowser()) || (await attachExistingWindow())
      if (session) {
        const synced = await syncTokenFromBrowser(session).catch(() => null)
        if (synced?.ok) {
          info = await workspace.info()
          kind = info.loggedIn ? '' : 'missing'
        }
      }
    }

    if (info.loggedIn) {
      const code = await probeToken(info.uid)
      if (code === 200) return { ...info, validated: true }
      // 401/403 = 服务端明确不认了（authed 内部已经试过 refresh）→ 这才是「确认失效」
      if (code !== 401 && code !== 403) return { ...info, validated: false }
      ctx.logger?.debug?.(`token 已失效（${code}），等待用户确认后再登录`)
      info = { loggedIn: false, uid: '' }
      kind = 'expired'
    }

    const windowable = cfg.openLoginWindow && canOpenWindow()
    const phoneFlow = !windowable
    const notice = expiredNoticeText(kind, phoneFlow)

    // 用户还没点头：只把「为什么需要登录」说清楚，不弹窗、不发短信。
    if (!allowLogin || (!confirm && !consentValid(kind))) {
      if (confirm) grantConsent(kind)
      return {
        loggedIn: false,
        uid: '',
        needLogin: true,
        awaitingConsent: true,
        expired: kind === 'expired',
        phoneFlow,
        notice,
      }
    }

    clearConsent()

    if (phoneFlow) {
      // 没有窗口的机器：让模型去要手机号 + 验证码，登完再回来
      return { loggedIn: false, uid: '', needLogin: true, phoneFlow: true, notice }
    }

    const result = await openLoginWindowAndWait({
      waitSeconds: 120,
      reason: kind === 'expired' ? '身份认证已过期' : '第一次登录',
    })
    if (!result.ok) {
      return {
        loggedIn: false,
        uid: '',
        needLogin: true,
        phoneFlow: true,
        loginMessage: result.message,
        notice,
      }
    }
    const next = await workspace.info()
    return { ...next, validated: true }
  }

  // 刚拉起的窗口常常停在 about:blank，等它真正落到青史页再继续
  async function waitHttpPage(session, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs
    let url = ''
    while (Date.now() < deadline) {
      url = String((await session.currentUrl().catch(() => '')) || '')
      if (url.startsWith('http')) return url
      await new Promise((r) => setTimeout(r, 300))
    }
    return url
  }

  // 页面自己把族谱卡片、画布位置等都存在 localStorage 里（换 profile 就没了），
  // 这里把整份 localStorage 快照到工作区，下次开新 profile 时再写回去。
  const storageFile = () => join(cfg.workspaceDir, 'browser-storage.json')

  async function readStorageSnapshot() {
    try {
      return JSON.parse(await readFile(storageFile(), 'utf8'))
    } catch {
      return null
    }
  }

  async function saveStorageSnapshot(session) {
    try {
      const data = await session.storage()
      if (!data || !Object.keys(data).length) return { ok: false, reason: 'empty' }
      await writeFile(storageFile(), JSON.stringify(data), 'utf8')
      return { ok: true, keys: Object.keys(data).length }
    } catch (error) {
      ctx.logger?.debug?.('保存页面状态失败：' + (error?.message || String(error)))
      return { ok: false, reason: String(error?.message || error) }
    }
  }

  async function restoreStorageSnapshot(session) {
    const snapshot = await readStorageSnapshot()
    if (!snapshot) return { ok: false, reason: 'no-snapshot' }
    const current = await session.storage().catch(() => ({}))
    // 这个 profile 已经有页面数据（比如一直用同一个 profile），就别覆盖它
    if (current && Object.keys(current).length > 8) return { ok: false, reason: 'already-has-data' }
    const result = await session.restoreStorage(snapshot).catch(() => ({ written: 0 }))
    return { ok: result.written > 0, written: result.written }
  }

  /**
   * 让窗口里的登录请求带上平台头（后端据此把 refresh_token 记成 plugin，
   * 不再和网页/小程序那一行互相顶掉）。只改登录相关请求，别的一律不碰。
   */
  async function armRequestPlatform(session) {
    if (!session || !cfg.requestPlatform) return { enabled: false }
    try {
      return await session.setRequestPlatform(cfg.requestPlatform)
    } catch (error) {
      ctx.logger?.debug?.('挂平台请求头失败：' + (error?.message || String(error)))
      return { enabled: false }
    }
  }

  async function ensureBrowser(route) {
    let session = await liveBrowser()
    if (!session) {
      session = await attachExistingWindow()
    }
    // 复用一个还活着的窗口时，也把尺寸钉回去（否则会沿用上次的大小）
    if (session && cfg.windowMode !== 'kiosk') {
      await session
        .setWindowSize({ width: cfg.windowSize.width, height: cfg.windowSize.height })
        .catch(() => {})
    }
    if (!session) {
      const startUrl = pageUrl(cfg.webBaseUrl, route || '/pages/career/career')

      // ① 自带桌面外壳（Electron）：无边框窗口 + 自绘标题栏，只有 ✕
      //    需要用户显式指定 windowMode=electron，且 shell/ 里有 Electron 可执行文件；
      //    否则默认走 ② Chrome --app 模式（零安装）。
      if (cfg.windowMode === 'electron') {
        try {
          const launched = await launchShell({
            url: startUrl,
            width: cfg.windowSize.width,
            height: cfg.windowSize.height,
            userDataDir: cfg.electronProfileDir,
            port: 0,
            logger: (line) => ctx.logger?.debug?.(line),
          })
          browserPid = launched.pid
          if (launched.userDataDir) await rememberProfileDir(launched.userDataDir)
          await writeWindowRegistry({
            pid: launched.pid,
            port: launched.port,
            profileDir: launched.userDataDir,
            mode: 'electron',
          })
          session = await attach({ port: launched.port, hint: 'qingshi.iyouwc.cn' })
          browserSession = session
          await waitHttpPage(session)
          const restored = await restoreStorageSnapshot(session)
          if (restored.ok) await session.goto(pageUrl(cfg.webBaseUrl, route || '/pages/career/career'))
          await reconcileAuth(session, route)
          await waitHttpPage(session)
          await armRequestPlatform(session)
          return { session }
        } catch (error) {
          // Electron 没装或起不来就给个清晰提示，别让用户卡在那里
          const msg = error?.message || String(error)
          if (!findBrowser()) {
            return { error: 'Electron 没起起来（' + msg + '），而且系统里也没装 Chrome 或 Edge。装一个浏览器，或用 windowMode=app。' }
          }
          ctx.logger?.warn?.('Electron 外壳启动失败，退回 Chrome --app 窗口：' + msg)
        }
      }

      if (!findBrowser()) {
        return { error: '没找到 Chrome 或 Edge。装一个，或用环境变量 QINGSHI_BROWSER 指定可执行文件路径。' }
      }
      try {
        const launched = await launchApp({
          url: startUrl,
          port: 0,
          profileDir: cfg.browserProfileDir,
          width: cfg.windowSize.width,
          height: cfg.windowSize.height,
          kiosk: cfg.windowMode === 'kiosk',
          logger: (line) => ctx.logger?.debug?.(line),
        })
        browserPid = launched.pid
        await writeWindowRegistry({
          pid: launched.pid,
          port: launched.port,
          profileDir: launched.profileDir || cfg.browserProfileDir,
          mode: cfg.windowMode === 'kiosk' ? 'kiosk' : 'chrome',
        })
        session = await attach({ port: launched.port, hint: 'qingshi.iyouwc.cn' })
        browserSession = session
        await waitHttpPage(session)
        if (cfg.windowMode === 'kiosk') {
          // 无标题栏模式下，页面顶部由我们画一条只有「青史 + ✕」的标题条
          const bar = await installWindowBar(session)
          if (!bar.ok) ctx.logger?.debug?.('自绘标题条没装上：' + (bar.reason || 'unknown'))
        } else {
          // 应用窗口：把尺寸钉死（复用旧窗口时启动参数不生效，这里兜一层）
          const sized = await session.setWindowSize({
            width: cfg.windowSize.width,
            height: cfg.windowSize.height,
          })
          if (!sized.ok) ctx.logger?.debug?.('窗口尺寸没设上：' + (sized.reason || 'unknown'))
        }
      } catch (error) {
        return { error: '启动浏览器失败：' + (error?.message || String(error)) }
      }
    }
    const restoredHere = await restoreStorageSnapshot(session)
    if (restoredHere.ok) await waitHttpPage(session)
    await reconcileAuth(session, route)
    if (route) {
      const want = pageUrl(cfg.webBaseUrl, route)
      const current = await session.currentUrl()
      if (!current.includes('#' + route)) await session.goto(want)
    }
    await armRequestPlatform(session)
    return { session }
  }

  /** 把 H5 里登录后的 token 同步进本地工作区（token 只落文件，不进对话）。 */
  async function syncTokenFromBrowser(session) {
    let store = {}
    try {
      store = await session.storage()
    } catch {
      return { ok: false, reason: '读不到页面存储' }
    }
    const accessToken = String(store.access_token || '').trim()
    const refreshToken = String(store.refresh_token || '').trim()
    const uid = String(store.my_uid || '').trim()
    if (!accessToken) return { ok: false, reason: '页面里还没有 access_token，先在这个窗口里登录' }
    // 体验用户的 token 不能覆盖真实账号（H5 未登录时会自动发一个体验身份，uid 固定）
    if (uid === EXPERIENCE_UID) {
      return { ok: false, uid, reason: '这个窗口现在是「体验用户」（还没登录真实账号），点页面右上角的登录入口登一次' }
    }
    await workspace.save({ uid, accessToken, refreshToken, clientPlatform: cfg.clientPlatform })
    const probe = await authed('/get_career_list', { of_type: 'user', of_id: uid, content_preview_limit: 1 })
    if (probe.code !== 200) {
      return { ok: false, uid, reason: 'token 拿到了但后端不认：' + probe.code + ' ' + (probe.message || '') }
    }
    const raw = probe.event_list || probe.career_list || []
    return { ok: true, uid, count: Array.isArray(raw) ? raw.length : 0 }
  }

  const describePage = (page, { textLimit = 1200 } = {}) => {
    const lines = []
    lines.push('当前页：' + (page.title || '(无标题)'))
    lines.push('地址：' + page.url)
    if (page.inputs?.length) {
      lines.push('输入框：' + page.inputs.map((item, index) => `[${index}] ${item.placeholder || item.type}`).join(' / '))
    }
    if (page.buttons?.length) lines.push('可点：' + page.buttons.join(' | '))
    lines.push('')
    lines.push('页面文字：')
    lines.push(String(page.text || '').slice(0, textLimit))
    return lines.join('\n')
  }

  // 页面/工具用的只读数据：一次取全量，本地筛

  // ---------- 自动记录策略（写进系统提示词，由模型每轮自己判断） ----------
  // 不在插件里另起一个抽取模型：模型本来就读得到这段对话，多一次调用只会更贵更不准。
  const POLICY = {
    off: [
      '不要主动提议记录，也不要自动写入。只有用户明确说“记下来/记一笔/帮我记”时，才调用 qingshi_draft。',
    ],
    suggest: [
      '默认策略是“先问一句再写”：判断用户刚讲的事值得记时，先用一句话确认（例如“要不要把刚才去青龙峡这件事记进青史？”），',
      '用户同意后再调用 qingshi_draft；用户没回应、说不用、只是在提问技术问题，就都不写。',
      '同一段对话里最多提议一次；用户说过“别记”之后，本会话不再提议。',
    ],
    auto: [
      '默认策略是“判断为经历就直接记”：判定值得记时直接调用 qingshi_draft，不先问，',
      '然后在回复末尾用一行说明已存到本地草稿，例如“已存到本地草稿：青龙峡徒步（draft_id: …）”。',
      '用户说过“别记了/不要记”之后，本会话立刻停止自动写入，只在他明确要求时再写。',
    ],
  }[cfg.autoRecord]

  const policyText = [
    '',
    '## 触发词（用户说这三个词之一就必须介入）',
    '用户提到「青史」「青灵」「青灵助手」时，意味着他要用到青史的能力。按下面 6 个域匹配，命中即介入，不命中就问用户要做什么。',
    '',
    '## 域 1：登录与身份',
    '精确触发：需要拿到身份凭证、首次使用、登录过期',
    '- 插件自动处理登录（弹窗 + 验证码），不要让用户去小程序/H5 手动登；',
    '- 登录态本地缓存（auth.json），Token 过期自动续；',
    '- 工具链：qingshi_login（首次）→ qingshi_me（每次工具调用前自动校验）。',
    '',
    '## 域 2：查询（只读，不写入）',
    '精确触发：用户要「查、看、读、了解、讲讲、分析」某人/某段经历/资料',
    '- **查自己**：我是谁/多大/去过哪里/总结 2024 → qingshi_profile + qingshi_find_experience',
    '- **查他人（通过称谓）**：我妈是谁/我奶奶有啥经历 → qingshi_kinship(term="妈") 反查 uid，再 qingshi_find_experience 拉生涯',
    '- **查他人（通过真名）**：张建国的经历/小明的资料 → qingshi_manageable_users(keyword="张建国") 模糊匹配，再 qingshi_find_experience',
    '- **看族谱**：看看族谱/我奶奶是谁（只是看，不改结构）→ qingshi_family 或 qingshi_family_all 直接读真实关系数据',
    '⚠️ 本域只读，绝对不要碰任何修改类工具（family_add / family_invite / edit / delete）',
    '',
    '## 域 3：记录/写入生涯事件',
    '精确触发：用户要「记、录、写、存、帮我写一条、帮我妈写一条」经历',
    '- 归属人查询（必须先做）：',
    '  · **称谓**（妈妈/爸/爷爷…）→ qingshi_kinship(term="妈") 反查 uid + 名字',
    '  · **真名**（张建国）→ qingshi_manageable_users(keyword="张建国") 模糊匹配',
    '  · 把候选列出来让用户确认"是 XXX 吗"，确认后 targetUid 贯穿后续所有工具',
    '  · ⚠️ **唯一合法工具只有 qingshi_kinship 和 qingshi_manageable_users**——qingshi_family / family_expand / family_layout / family_add / family_invite / qingshi_skill 这些**绝对禁止用于查归属人**',
    '- 写入流程：',
    '  · 用户说"帮我记一下""帮我存一条"→ qingshi_draft 暂存本地，用户确认后 qingshi_publish 或 qingshi_record(confirm=true) 写入云端',
    '  · 用户说"直接存、不用确认"→ qingshi_record(confirm=true) 直接写',
    '  · 用户说"帮我润色一下再存"→ qingshi_prepare_event 预填 H5 页面，让用户自己点发布',
    '- 改/删已有记录：qingshi_event 读原文 → qingshi_edit / qingshi_delete，删之前必须 confirm=true',
    '- 隐私设置：qingshi_set_privacy 改可见权限（all / private / selected）',
    '- ⚠️ 本域**绝对不要调 qingshi_skill**（组织管理 skill 只在域 5/6 用）',
    '',
    '## 域 4：照片整理与手机上传',
    '精确触发：用户说「整理照片、帮我整理相册、手机上传、扫码传照片、帮我归类照片」',
    '- 前置确认：先问"需要青灵助手帮您整理进青史吗？"用户明确同意后再开始',
    '- 归属人查询（必须先做）：**和域 3 完全相同的逻辑**——称谓走 kinship，真名走 manageable_users，⚠️ 绝对不要调 qingshi_family / family_add / qingshi_skill',
    '- 照片整理流程（本地相册目录）：',
    '  ① qingshi_photo_scan 扫描 → 按拍摄时间 + GPS + 内容分组',
    '  ② 逐组起标题、写正文（开头 100 字内描述画面）、选标签',
    '  ③ 每组在对话里展示让用户确认：标题 / 时间 / 地点 / 标签 / 正文 / 分类依据 / 本地路径',
    '  ④ 用户确认 → qingshi_photo_save（先不传 confirm 拿预览，再 confirm=true 真正上传）',
    '  ⑤ 存完回报每组 event_id',
    '- 手机上传流程：',
    '  ① qingshi_phone_upload_start 开二维码',
    '  ② qingshi_phone_upload_status（等传完）',
    '  ③ qingshi_phone_upload_pick（读元信息）',
    '  ④ 按时间段 + GPS + 内容分组 + 起标题写正文',
    '  ⑤ qingshi_phone_upload_preview 推 planned_events → H5 渲染分类工作台（**这一步绝对不能省**）',
    '  ⑥ 告诉用户"已分好 X 组，手机/电脑窗口能看到预览"',
    '  ⑦ 等用户在 H5 或对话里调整（对话改了再调一次 preview 覆盖）',
    '  ⑧ 用户确认 → 问要不要无损压缩 → qingshi_phone_upload_compress（只压要存的）',
    '  ⑨ 逐组 qingshi_photo_save 写入（废弃桶跳过）',
    '  ⑩ qingshi_phone_upload_finish 收尾（done 状态后窗口 3 分钟自动关；completed/importing 保持打开）',
    '- 中途放弃 → qingshi_phone_upload_finish(cancel=true)',
    '- ⚠️ 本域**绝对不要调 qingshi_skill**',
    '',
    '## 域 5：族谱血缘关系修改',
    '精确触发（**必须同时满足**）：① 用户明确说了「族谱」或「血缘」二字；② 要改结构（加节点/删关系/改父子关系/加爷爷的爷爷）',
    '- 前置（只有满足精确触发才进入本域，否则去域 2/3/4）',
    '- 流程：用 qingshi_skill 读 docs/org-entry/SKILL.md → 按「族谱血缘」章节操作',
    '- 工具：qingshi_family_all / qingshi_family_add / qingshi_family_invite',
    '- 必须确认：虚拟用户(tmp) 还是现有用户(created)、挂到哪个 family_id、关系类型(man/woman/child)',
    '',
    '## 域 6：组织管理（虚拟人物节点/历史人物录入）',
    '精确触发（**必须同时满足**）：① 用户明确说了「组织管理」「组织树」或「历史人物」；② 要建虚拟人物节点或历史人物批量录入',
    '- 前置（只有满足精确触发才进入本域，否则去域 2/3/4）',
    '- 流程：用 qingshi_skill 读 docs/org-entry/SKILL.md → 按「动手前必问」操作',
    '- 工具：用 scripts/qs.mjs 直连后端 API',
    '- 必须确认：虚拟用户(tmp) 还是真实用户、组织名称（验证权限）、挂到哪个节点下',
    '',
    '## 跨域绝对禁止规则',
    '1. **查归属人绝对不用 family/skill**：找归属人只有 kinship(称谓) + manageable_users(真名) 两条路，family/skill/family_add 全部禁止',
    '2. **skill 只在域 5/6 用**：用户没说"族谱/组织/血缘/虚拟人物/历史人物"就绝对不要调 qingshi_skill',
    '3. **域 2/3/4 绝对不碰修改类工具**：family_add / family_invite / edit / delete 只在用户明确要求改时才用',
    '',
    '## 硬规则',
    '1. 查询类必须真的调工具拿数据，绝对不许编造',
    '2. 时间只认用户明说的：没说年份就留空或写今天，不要自己算',
    '3. event_id、uid、路由地址是内部用的：你自己记着，回复里不写（除非用户明确要）',
    '4. 数据为空就直说没有，并引导他去记一条',
    '5. 回复用口语化中文，不要 markdown 标题、表格、代码块',
    '6. 改和删都是动云端数据：改之前先核对，删之前必须两步（预览 + confirm=true）',
    '7. 新记录默认「所有人可见」，写完主动提一句要不要改隐私',
    '',
    '## 怎么说人话',
    '像一个看过他日记的朋友在聊天，不是控制台打印返回值：',
    '- 不要贴 event_id、uid、JSON、字段名',
    '- 不要提工具名和"我调用了…"',
    '- 不要复述工具输出，直接说人话结果',
    '- 引用记录用他的说法指代："去年九寨沟那次""2024 年终总结那条"',
    '',
    '## 青灵助手自称',
    '插件以「青史」「青灵」「青灵助手」自称。用户说这三个关键词表示需要插件介入。',
    '',
    '## 青史 H5 兜底',
    '站点 qingshi.iyouwc.cn。页面操作只在没有领域工具时用：qingshi_open_h5 开窗口 → qingshi_ui_read/click/type。领域操作一律用领域工具。',
  ].join('\n')

  ctx.systemPrompt?.section?.({
    name: 'qingshi:auto-record',
    order: 900,
    text: policyText,
  })

  async function requireAuth() {
    const info = await workspace.info()
    if (!info.loggedIn) return { ok: false, info }
    return { ok: true, info }
  }

  // ---------- 草稿发布 ----------
  async function publishDraft(id) {
    const draft = await drafts.get(String(id || ''))
    if (!draft) return { error: '草稿不存在' }
    if (draft.status === 'published') {
      return { error: `这条已经发布过了（event_id: ${draft.eventId || '未知'}）` }
    }
    const info = await workspace.info()
    if (!info.loggedIn) return { error: '还没登录青史，先在对话里说一句「登录青史」' }

    // 图片在这一刻才上传：先传会在云端留下没人引用的文件，也会提前泄露时间线
    const mediaList = []
    for (const item of draft.media || []) {
      const file = await drafts.mediaPath(draft.id, item.storedName)
      if (!file) continue
      mediaList.push(await uploadMedia(authed, file, { uid: info.uid, contentType: item.contentType }))
    }

    const payload = {
      of_type: 'user',
      of_id: draft.targetUid || info.uid,
      title: draft.title,
      content: appendAttribution(draft.content, resolveClientLabel(cfg)),
      start_date: draft.startDate,
      event_tag: draft.eventTag || 'record',
    }
    // 后端字段名是大写 S 的 is_Stage
    if (draft.isStage) {
      payload.is_Stage = true
      if (draft.endDate) payload.end_date = draft.endDate
    }
    if (draft.location && (draft.location.name || draft.location.address)) {
      payload.location = {
        name: draft.location.name || '',
        address: draft.location.address || '',
        latitude: Number(draft.location.latitude) || 0,
        longitude: Number(draft.location.longitude) || 0,
      }
    }
    if (mediaList.length) payload.media_list = mediaList

    const result = await authed('/add_event', payload)
    if (result.code !== 200) {
      return { error: `发布失败：${result.code} ${result.message || ''}` }
    }
    const eventId = String(
      result.event_id || result.data?.event_id || result.data?.eventId || '',
    )
    const saved = await drafts.markPublished(draft.id, eventId)
    ctx.logger?.debug?.(`青史草稿已发布 ${draft.id} → ${eventId}`)
    return { ok: true, eventId, draft: saved }
  }

  // 一个人 = 昵称 + 头像 + 标签 + 生日（复刻 userCache.js，缓存 24 小时）
  // ---------- qingshi_login ----------
  // 方案 B：登录页由插件自己出（lib/login-page.js + lib/login-server.js），
  // 请求从本地发出，所以能带 X-Client-Platform: plugin；登完直接落盘 + 注入窗口，
  // 用户不需要回到对话里再点一次「我已登录」。
  const PLATFORM = String(cfg.requestPlatform || 'plugin').trim() || 'plugin'
  const platformHeader = () => ({ 'X-Client-Platform': PLATFORM })

  async function sendLoginCode(phone) {
    const res = await request.httpRequest(
      '/login/sms_send',
      { phone, scene: 'login', client_platform: PLATFORM },
      { needAccessToken: false, header: platformHeader() },
    )
    if (res.code !== 200) throw new Error(res.message || '验证码发送失败')
    return res
  }

  async function submitLogin(phone, code) {
    const res = await request.httpRequest(
      '/login/sms_login',
      { phone, code, client_platform: PLATFORM },
      { needAccessToken: false, header: platformHeader() },
    )
    const data = res.data || res
    if (res.code !== 200 || !data.access_token) throw new Error(res.message || '登录失败')
    await workspace.save({
      uid: data.uid,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || '',
      clientPlatform: PLATFORM,
      savedAt: new Date().toISOString(),
    })
    return { uid: String(data.uid || '') }
  }

  ctx.tools.register(
    defineTool({
      name: 'qingshi_login',
      description:
        '登录青史。能弹窗的机器（有 Electron 或 Chrome/Edge）会弹一个插件自己的登录窗口，' +
        '用户在里面输手机号 + 验证码，登完自动保存凭证、自动关窗。' +
        '不能弹窗的机器（MCP、远程、无浏览器）走短信验证码：先传 phone 发码，' +
        '用户把收到的 6 位码告诉你，再传 code 完成登录。凭证还有效时直接报已登录（除非传 force）。' +
        '注意：只有在「用户已经同意重新登录」之后才调用本工具——工具返回「身份认证已过期」时，' +
        '先把原因说清楚并问一句「要我现在打开登录窗吗」，得到同意再来调；用户说要自己弄就先别调。',
      parameters: {
        phone: { type: 'string', description: '手机号（无窗口时用：传它就发验证码）' },
        code: { type: 'string', description: '短信里的 6 位验证码（无窗口时用：传它完成登录）' },
        force: { type: 'boolean', description: '有凭证也强制重新登录，默认 false' },
        waitSeconds: { type: 'number', description: '窗口登录最多等多久，默认 120 秒' },
      },
      output: outputSpec,
      async execute(args) {
        const info = await workspace.info()
        const force = args?.force === true
        const phone = String(args?.phone || '').trim()
        const code = String(args?.code || '').trim()

        if (force && info.loggedIn) await workspace.clear()
        if (!force && info.loggedIn) {
          const probe = await authed('/get_career_list', { of_type: 'user', of_id: info.uid, content_preview_limit: 1 })
          if (probe.code === 200) {
            const raw = probe.event_list || probe.career_list || []
            return [
              '已经是登录状态了，云端能读到 ' + (Array.isArray(raw) ? raw.length : 0) + ' 条记录。',
              '要给用户看界面就调 qingshi_open_h5（可带 route）；想换账号再传 force: true。',
            ].join(NL)
          }
        }

        // ---------- 文字登录：给验证码就完成登录 ----------
        if (code) {
          const target = phone || (pendingValid() ? pendingLogin.phone : '')
          if (!target) {
            return [
              '要先用手机号发一次验证码：把用户的手机号传给 qingshi_login 的 phone 参数。',
              '拿到验证码后再传 code。',
            ].join(NL)
          }
          try {
            const { uid } = await submitLogin(target, code)
            pendingLogin.phone = ''
            pendingLogin.sentAt = 0
            try {
              const opened = await ensureBrowser('/pages/career/career')
              if (!opened.error) await hydrateBrowserAuth(opened.session)
            } catch (error) {
              ctx.logger?.debug?.('登录后同步窗口失败：' + (error?.message || String(error)))
            }
            let count = 0
            try {
              const probe = await authed('/get_career_list', { of_type: 'user', of_id: uid, content_preview_limit: 1 })
              if (probe.code === 200) {
                const raw = probe.event_list || probe.career_list || []
                count = Array.isArray(raw) ? raw.length : 0
              }
            } catch {
              /* 数不到就数不到 */
            }
            return [
              '登录成功，凭证已经存在本机（' + maskPhone(target) + '）。',
              '现在能读到 ' + count + ' 条记录，之后不用再登。',
            ].join(NL)
          } catch (error) {
            return [
              '验证码没通过：' + (error?.message || String(error)),
              '可以让用户看一眼短信再试一次；要重发就说一声，我再发一条。',
            ].join(NL)
          }
        }

        // ---------- 文字登录：给手机号就发验证码 ----------
        if (phone) {
          if (!/^1[3-9]\d{9}$/.test(phone)) return '手机号看着不太对，要 11 位、以 1 开头。再确认一下？'
          try {
            await sendLoginCode(phone)
          } catch (error) {
            return '短信没发出去：' + (error?.message || String(error))
          }
          pendingLogin.phone = phone
          pendingLogin.sentAt = Date.now()
          return [
            '验证码已经发到 ' + maskPhone(phone) + ' 了（10 分钟内有效）。',
            '让用户把收到的 6 位数字发给你，再调 qingshi_login 传 code 就能登进去。',
          ].join(NL)
        }

        // ---------- 没参数：能弹窗就弹窗，不能就引导文字登录 ----------
        if (!cfg.openLoginWindow || !canOpenWindow()) {
          return [
            '这台机器上没有可用的窗口（没装 Electron，也没找到 Chrome/Edge），改成短信验证码登录：',
            '第 1 步：问用户的手机号，然后调 qingshi_login 传 phone（会发一条短信）。',
            '第 2 步：用户把收到的 6 位验证码告诉你，再调 qingshi_login 传 code。',
            '两步都做完凭证会存到本机，之后不用再登。',
          ].join(NL)
        }

        const waitSeconds = Number(args?.waitSeconds) > 0 ? Number(args.waitSeconds) : 120
        const result = await openLoginWindowAndWait({ waitSeconds, reason: '手动登录' })
        if (!result.ok) {
          return [
            result.message,
            '如果这台机器打不开窗口，也可以改用文字登录：先传 phone 发验证码，再传 code 完成登录。',
          ].join(NL)
        }
        const hydrated = '已同步到青史窗口，直接就是登录态。'

        let count = 0
        try {
          const probe = await authed('/get_career_list', { of_type: 'user', of_id: result.uid, content_preview_limit: 1 })
          if (probe.code === 200) {
            const raw = probe.event_list || probe.career_list || []
            count = Array.isArray(raw) ? raw.length : 0
          }
        } catch {
          /* 数不到就数不到 */
        }

        return [
          '登录成功，凭证已经存在本机（不用再点确认）。' + hydrated,
          '现在能读到 ' + count + ' 条记录。',
        ].join(NL)
      },
    }),
  )

  // ---------- qingshi_me ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_save_login',
      description:
        '把「当前青史窗口里已经登录的 token」保存到本地工作区——用户在窗口里输完手机号/验证码、' +
        '或者点完页面上的登录之后，用这个工具落地。不需要再让他登录一次，只要读窗口里现有的 token。' +
        '用户在对话里点「我已登录，保存凭证」按钮、或者说「我登好了」时调用它。',
      parameters: {},
      output: outputSpec,
      async execute() {
        const session = (await liveBrowser()) || (await attachExistingWindow())
        if (!session) {
          return '现在没有开着的青史窗口。先调用 qingshi_open_h5 打开窗口，在里面登录一次，再来保存。'
        }
        await armRequestPlatform(session)
        const synced = await syncTokenFromBrowser(session).catch((error) => ({
          ok: false,
          reason: error?.message || String(error),
        }))
        if (!synced?.ok) {
          return (
            '窗口里还没读到可用的登录凭证：' + (synced?.reason || '未知原因') + NL +
            '如果页面还停在登录页，请先在窗口里用手机号登一次，然后再点一次「我已登录」。'
          )
        }
        return (
          '凭证已保存（云端 ' + (synced.count || 0) + ' 条记录能读到）。以后打开窗口直接就是登录态，不用再登。'
        )
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qingshi_where',
      description:
        '报告青史的数据存在这台机器的哪个目录、能不能写、里面已经有哪些文件。' +
        '用户在别的 AI 客户端里遇到「EPERM / 不让写」、或者问「我的登录凭证存哪了」时用它。',
      parameters: {},
      output: outputSpec,
      async execute() {
        const info = describeHomeDir(config)
        const why = {
          config: '插件配置里指定的目录',
          env: '环境变量 QINGSHI_HOME',
          home: '用户目录下的 qingshi-plugin',
          cwd: '默认位置不可写，退到了当前工作目录/.qingshi-plugin',
          tmp: '默认位置和当前目录都不可写，退到了系统临时目录（重启可能被清）',
        }[info.source] || info.source
        const lines = [
          '数据目录：' + info.dir,
          '为什么在这里：' + why,
          '能写吗：' + (info.writable ? '能' : '不能（这个环境把这个目录锁住了）'),
        ]
        if (info.files.length) lines.push('已有的文件：' + info.files.join('、'))
        else lines.push('已有的文件：还没有（第一次用）')
        if (!info.writable) {
          lines.push(
            '办法：把 QINGSHI_HOME 指到一个能写的地方再重开客户端，例如 QINGSHI_HOME=' +
              join(process.cwd(), '.' + 'qingshi-plugin'),
          )
        }
        return lines.join(NL)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qingshi_me',
      description:
        '【先确认能不能查】用户问到任何跟本人 / 家人 / 过往经历有关的事，但你还不确定青史是否可用（或刚装好、刚登录完）时，先调这个看登录态与数据能不能读到。查看当前青史登录状态，并顺手真打一次后端接口验证。（不返回 token、uid、路径；' +
        '用户刚在登录页登完，用这个确认是否真的生效；回复时也别把 uid 说给用户。）',
      parameters: {},
      output: outputSpec,
      async execute() {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)

        // 先真打一次接口再下结论：本地有 token 不等于服务端还认（refresh_token 可能已被顶掉）
        const result = await authed('/get_career_list', {
          of_type: 'user',
          of_id: info.uid,
          content_preview_limit: 1,
        })
        if (result.code === 200) {
          const count = Array.isArray(result.event_list)
            ? result.event_list.length
            : Array.isArray(result.career_list)
              ? result.career_list.length
              : 0
          return '已登录青史，云端连通正常，能读到 ' + count + ' 条生涯记录。'
        }
        if (result.code === 401 || result.code === 403) {
          return [
            '本地存着凭证，但服务端已经不认了（续期也失败）。',
            '说一句「打开青史」，在窗口里登一次，然后点对话里的「我已登录，保存凭证」——之后就不用再登了。',
          ].join(NL)
        }
        return '连云端时返回了异常：' + (result.message || result.code) + '。稍后再试，或者打开青史窗口看看页面能不能用。'
      },
    }),
  )

  // ---------- qingshi_search ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_search',
      description:
        '在「青史」里快速检索日记/生涯记录，每条只回 300 字摘要。用户问“我某年某月写过什么”' +
        '“我关于 XX 记过什么”“我家人最近有什么记录”时用它。只读，不修改任何数据。' +
        '如果要按时间范围（2020–2023）、地点、标签做多维筛选，或者要读正文全文、要统计汇总，' +
        '改用 qingshi_find_experience。',
      parameters: {
        keyword: { type: 'string', description: '关键词，匹配标题和正文；不给则按时间倒序返回' },
        year: { type: 'integer', description: '按年份过滤，如 2024' },
        month: { type: 'integer', description: '按月份过滤，1-12；需配合 year' },
        eventTag: {
          type: 'string',
          description:
            '事件标签：record/birthday/happy/family/friend/party/festival/work/study/growth/achievement/challenge/idea/memorial/summary/travel/scenery/food/memory/sad/love/consume/save/turning',
        },
        targetUid: { type: 'string', description: '要看谁的记录；不填就是用户自己' },
        limit: { type: 'integer', description: '返回条数，默认 20，最大 50' },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)

        const targetUid = String(args?.targetUid || info.uid || '').trim()
        const result = await authed('/get_career_list', {
          of_type: 'user',
          of_id: targetUid,
          content_preview_limit: 300,
        })
        if (result.code !== 200) return `检索失败：${result.code} ${result.message || ''}`

        const raw = result.event_list || result.career_list || []
        let list = Array.isArray(raw) ? raw.map(normalizeEvent) : []

        const keyword = String(args?.keyword || '').trim().toLowerCase()
        const year = Number(args?.year) || 0
        const month = Number(args?.month) || 0
        const eventTag = String(args?.eventTag || '').trim()
        const limit = Math.min(Number(args?.limit) || 20, 50)

        if (keyword) {
          list = list.filter(
            (it) =>
              it.title.toLowerCase().includes(keyword) || it.content.toLowerCase().includes(keyword),
          )
        }
        if (year) list = list.filter((it) => it.startDate.startsWith(String(year)))
        if (year && month) {
          list = list.filter((it) => it.startDate.slice(5, 7) === String(month).padStart(2, '0'))
        }
        if (eventTag) list = list.filter((it) => canonicalTag(it.eventTag) === canonicalTag(eventTag))

        list.sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)))
        const selected = list.slice(0, limit)

        if (selected.length === 0) {
          return targetUid === info.uid ? '没有检索到符合条件的记录。' : '对方的记录里没有符合条件的，或者你没有查看权限。'
        }

        const rows = selected.map((it, i) => {
          const head = `[${i + 1}] ${it.startDate}${it.endDate ? `~${it.endDate}` : ''} ${it.title}`
          const meta = [it.eventTag, it.isStage ? '阶段' : ''].filter(Boolean).join(' · ')
          const body = it.content.replace(/\s+/g, ' ').slice(0, 300)
          return `${head}${meta ? `  (${meta})` : ''}${body ? `\n${body}` : ''}`
        })

        return `共 ${list.length} 条匹配，显示前 ${selected.length} 条：\n\n${rows.join('\n\n')}`
      },
    }),
  )

  // ---------- qingshi_find_experience ----------
  // 复刻青史后端 SYSTEM_PROMPT 里「查东西 / 总结分析」那套语义：
  //   "看看我 2020 到 2023 年的工作经历"、"我今年去过哪些地方旅行"、
  //   "我有没有去过沈阳"、"总结一下我的 2024 年"。
  // 后端 /get_career_list 本身只按 of_id 倒出全部事件，筛选放在插件这边做。
  ctx.tools.register(
    defineTool({
      name: 'qingshi_find_experience',
      description:
        '【关于「我经历过什么」的问题先看这里】用户问「我去过哪里」「我去过哪些地方」「我去过哪里你知道吗」「我以前做过什么」「我的经历」「给我讲讲我的故事」「我这些年都干了什么」，都调这个工具取真实记录，不要凭印象编。在「青史」里查找一段经历（生涯事件），支持关键词、时间范围（startYear~endYear）、单年/单月、' +
        '事件标签、地点、以及查谁的经历。这是「查看生涯记录」和「总结生涯」两个场景取真实数据的入口。' +
        '用户说“看看我 2024 年的工作经历”“我 2020 到 2023 年都在哪”' +
        '“我今年去过哪些地方旅行”“我有没有去过沈阳”“帮我找九寨沟的照片”时用它。' +
        'mode=summary 返回按年份/标签/地点的统计汇总，适合“总结、回顾、分析”；' +
        'mode=list（默认）逐条列出，适合“具体写过什么、有没有记过某件事”，fullContent=true 时带正文全文。' +
        '只读，不修改任何数据。',
      parameters: {
        query: {
          type: 'string',
          description: '关键词，同时匹配标题、正文、地点名和地址；不给则不按关键词过滤',
        },
        startYear: { type: 'integer', description: '起始年份（含），如 2020；配 endYear 表示一段时期' },
        endYear: { type: 'integer', description: '结束年份（含），如 2023' },
        year: { type: 'integer', description: '只查某一年，如 2024' },
        month: { type: 'integer', description: '只查某个月 1-12，需配合 year' },
        eventTag: {
          type: 'string',
          description:
            '事件标签：record/birthday/happy/family/friend/party/festival/work/study/growth/achievement/challenge/idea/memorial/summary/travel/scenery/food/memory/sad/love/consume/save/turning',
        },
        location: { type: 'string', description: '地点关键词，匹配地点名和地址，如“沈阳”“九寨沟”' },
        targetUid: { type: 'string', description: '查谁的记录；不填就是用户自己' },
        mode: {
          type: 'string',
          description: 'list=逐条列出（默认）；summary=只给统计汇总（按年份/标签/地点）',
        },
        limit: { type: 'integer', description: 'list 模式最多返回几条，默认 10，最大 50' },
        fullContent: {
          type: 'boolean',
          description: 'true=每条带完整正文；默认 false，每条只带前 400 字',
        },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)

        const targetUid = String(args?.targetUid || info.uid || '').trim()
        const query = String(args?.query || '').trim()
        const location = String(args?.location || '').trim()
        const eventTag = String(args?.eventTag || '').trim()
        const year = Number(args?.year) || 0
        const month = Number(args?.month) || 0
        const startYear = Number(args?.startYear) || 0
        const endYear = Number(args?.endYear) || 0
        const mode = String(args?.mode || 'list').toLowerCase() === 'summary' ? 'summary' : 'list'
        const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 50)

        // 一次取全量（正文上限 5000 字/条），筛选在本地做
        const result = await authed('/get_career_list', {
          of_type: 'user',
          of_id: targetUid,
          content_preview_limit: 5000,
        })
        if (result.code !== 200) return `查找失败：${result.code} ${result.message || ''}`

        const raw = result.event_list || result.career_list || []
        let list = (Array.isArray(raw) ? raw : []).map(normalizeEvent).filter((it) => it.startDate)

        const total = list.length

        if (query) {
          const needle = query.toLowerCase()
          list = list.filter((it) => eventText(it).includes(needle))
        }
        if (location) {
          const needle = location.toLowerCase()
          list = list.filter(
            (it) =>
              it.locationName.toLowerCase().includes(needle) ||
              it.locationAddress.toLowerCase().includes(needle),
          )
        }
        if (eventTag) list = list.filter((it) => canonicalTag(it.eventTag) === canonicalTag(eventTag))
        if (year) list = list.filter((it) => it.startDate.startsWith(String(year)))
        if (year && month) {
          list = list.filter((it) => it.startDate.slice(5, 7) === String(month).padStart(2, '0'))
        }
        if (startYear) list = list.filter((it) => Number(it.startDate.slice(0, 4)) >= startYear)
        if (endYear) list = list.filter((it) => Number(it.startDate.slice(0, 4)) <= endYear)

        const conditions = []
        if (query) conditions.push(`关键词「${query}」`)
        if (location) conditions.push(`地点「${location}」`)
        if (eventTag) conditions.push(`标签 ${tagLabel(eventTag)}`)
        if (year) conditions.push(month ? `${year} 年 ${month} 月` : `${year} 年`)
        else if (startYear || endYear) conditions.push(`${startYear || '最早'}–${endYear || '至今'}`)
        const whoText = targetUid === info.uid ? '' : '（别人名下的，可能看不到）'
        const scope = [`查到 ${list.length} 条${whoText}`]
        if (conditions.length) scope.push('条件：' + conditions.join('、'))
        else scope.push('一共记了 ' + total + ' 条')

        list.sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)))

        if (list.length === 0) {
          return [
            scope.join('；') + '。',
            '',
            total === 0 ? '这个账号下还没有任何生涯记录。' : '没有符合条件的记录，可以换个关键词或放宽时间范围。',
          ].join('\n')
        }

        if (mode === 'summary') {
          const countBy = (keyOf) => {
            const map = new Map()
            for (const it of list) {
              const key = keyOf(it)
              if (!key) continue
              map.set(key, (map.get(key) || 0) + 1)
            }
            return [...map.entries()].sort((a, b) => b[1] - a[1])
          }

          const years = countBy((it) => it.startDate.slice(0, 4)).sort((a, b) =>
            String(b[0]).localeCompare(String(a[0])),
          )
          const tags = countBy((it) => canonicalTag(it.eventTag))
          const places = countBy((it) => it.locationName)
          const chars = list.reduce(
            (sum, it) => sum + (it.contentFullLength || it.content.length),
            0,
          )
          const earliest = [...list].sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)))[0]
          const latest = list[0]

          const lines = [scope.join('，') + '。', '']
          lines.push(`时间跨度：${earliest.startDate} ～ ${latest.startDate}`)
          lines.push(`按年份：${years.map(([y, n]) => `${y} 年 ${n} 条`).join('、')}`)
          lines.push(`按标签：${tags.slice(0, 6).map(([t, n]) => `${tagLabel(t)} ${n} 条`).join('、')}`)
          if (places.length) {
            lines.push(`按地点：${places.slice(0, 6).map(([p, n]) => `${p} ${n} 条`).join('、')}`)
          }
          lines.push(`正文合计约 ${chars} 字`)
          lines.push(`最近一条：${latest.startDate} ${latest.title}`)
          return lines.join('\n')
        }

        const selected = list.slice(0, limit)
        const rows = selected.map((it, i) => {
          const meta = [tagLabel(it.eventTag), it.isStage ? '阶段事件' : ''].filter(Boolean).join(' · ')
          const idTag = it.eventId ? `  ·  ${it.eventId}` : ''
          const head = `[${i + 1}] ${it.startDate}${it.endDate ? ` ～ ${it.endDate}` : ''}  ${it.title}${idTag}`
          const place = it.locationName
            ? `地点：${it.locationName}${it.locationAddress && it.locationAddress !== it.locationName ? `（${it.locationAddress}）` : ''}`
            : ''
          const fullLength = it.contentFullLength || it.content.length
          const body = it.content.replace(/\s+/g, ' ').trim()
          const shown = args?.fullContent ? body : body.slice(0, 400)
          const cut = shown.length < body.length ? `…（正文共 ${fullLength} 字）` : ''
          return [`${head}   (${meta})`, place, shown ? `${shown}${cut}` : '']
            .filter(Boolean)
            .join('\n')
        })

        const tail =
          list.length > selected.length
            ? `\n\n（还有 ${list.length - selected.length} 条没显示，加大 limit 或用 mode=summary 看总览）`
            : ''

        return `${scope.join('，')}。\n\n${rows.join('\n\n')}${tail}`
      },
    }),
  )

  // ---------- qingshi_record ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_record',
      description:
        '往「青史」云端直接写入一条生涯记录（跳过本地草稿，等于**永久保存**，内容会过审核）。' +
        '用户明确说“直接记到云端”“不用先存草稿”时才用；一般先用 qingshi_draft 让他确认。' +
        '写之前先用一两句话确认要记的内容，避免把闲聊记成日记。' +
        '记在本人名下直接写；代家人写默认关闭，需要用户在插件配置里打开 allowFamilyWrite。',
      parameters: {
        title: { type: 'string', required: true, description: '标题，简短' },
        content: { type: 'string', required: true, description: '正文' },
        startDate: { type: 'string', description: '发生日期 YYYY-MM-DD；不填默认今天' },
        endDate: { type: 'string', description: '结束日期 YYYY-MM-DD，仅阶段事件需要' },
        isStage: { type: 'boolean', description: '是否是跨时间段的阶段事件，默认 false' },
        eventTag: { type: 'string', description: '标签，见 qingshi_search，默认 record' },
        location: { type: 'string', description: '地点名称' },
        targetUid: { type: 'string', description: '给谁记；不填就是用户自己' },
        confirm: {
          type: 'boolean',
          description:
            '必须先把标题/正文/标签报给用户确认、并问清要不要加图片或确认地址；' +
            '用户明确同意“就这样记”之后才传 true 真正写入。不传只返回待确认的预览。',
        },
        privacy: {
          type: 'string',
          description: '可见性：all 所有人可见（默认）/ private 仅自己可见 / selected 指定人可见',
        },
        designatedUids: {
          type: 'array',
          items: { type: 'string' },
          description: 'privacy=selected 时给哪些人看',
        },
      },
      output: outputSpec,
      async execute(args) {
        const title = String(args?.title || '').trim()
        const content = String(args?.content || '').trim()
        if (!title) return '标题不能为空。'
        if (!content) return '正文不能为空，否则这条记录没有意义。'

        const startDate = String(args?.startDate || '').trim() || todayText()
        const eventTag = String(args?.eventTag || 'record').trim() || 'record'
        const locationText = String(args?.location || '').trim()

        // 第一次调用（没传 confirm）只给预览，不写云端：
        // 让用户先看到标题/正文/标签，并且先把「要不要加图片、要不要确认地址」问清楚。
        if (args?.confirm !== true) {
          return [
            '要记的这条（还没写进云端）：',
            '标题：' + title,
            '内容：' + content,
            '标签：' + tagLabel(eventTag),
            '时间：' + startDate + (args?.endDate ? ' ～ ' + String(args.endDate).trim() : ''),
            locationText ? '地点：' + locationText : '',
            '',
            '两个问题：',
            '1）要不要上传图片、或者在地图上确认一下地址？要就说一声，我打开「添加生涯事件」页面让你补，补完你自己点发布。',
            '2）不用图片和地址的话，就直接说「就这样记」，我马上写进云端。',
            '',
            '写进云端之后是永久保存，默认「所有人可见」，要只自己看可以告诉我。',
          ]
            .filter((line) => line !== '')
            .join('\n')
        }

        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)

        const targetUid = String(args?.targetUid || '').trim() || info.uid
        const isSelf = !targetUid || targetUid === info.uid
        if (!isSelf && !cfg.allowFamilyWrite) {
          return [
            '已拒绝：代家人写记录默认关闭（allowFamilyWrite = false）。',
            `要写到 uid: ${targetUid}，需要用户在插件配置里打开“允许代家人记录”，或改为记在本人名下。`,
          ].join('\n')
        }
        const payload = {
          of_type: 'user',
          of_id: targetUid,
          title,
          // 正文末尾署名：这条是哪个 AI 工具帮着录的
          content: appendAttribution(content, resolveClientLabel(cfg)),
          start_date: startDate,
          event_tag: eventTag,
        }
        if (args?.endDate) payload.end_date = String(args.endDate).trim()
        // 后端字段名是大写 S 的 is_Stage，写成 is_stage 会被当成普通事件
        if (args?.isStage) payload.is_Stage = true
        if (args?.location) payload.location = String(args.location).trim()

        const result = await authed('/add_event', payload)
        if (result.code !== 200) return `写入失败：${result.code} ${result.message || ''}`

        const eventId =
          result.event_id || pick(result.data, 'event_id', 'eventId') || ''

        // 可见性：/add_event 不带这个字段，需要单独调一次
        let privacyLine = ''
        const wantedPrivacy = String(args?.privacy || '').trim()
        if (wantedPrivacy && eventId) {
          const privacy = await careerApi.setPrivacy(eventId, wantedPrivacy, {
            designatedUids: args?.designatedUids || [],
          })
          privacyLine = privacy.ok
            ? NL + '可见性已设为：' + privacy.label + '。'
            : NL + '可见性没设成（' + (privacy.message || '未知原因') + '），现在还是默认的「所有人可见」。'
        } else if (eventId) {
          privacyLine = NL + '注意：这条现在是「所有人可见」。要改成仅自己可见就说一声。'
        }

        return `已记入青史：${title}${eventId ? `（event_id: ${eventId}）` : ''}${privacyLine}`
      },
    }),
  )

  // ---------- qingshi_tags ----------
  // 写记录前要先跟用户对齐「标签用哪个」，这个工具把 24 个标签连同示例一次给出，
  // 不用模型自己回忆、也不会编出不存在的标签。
  ctx.tools.register(
    defineTool({
      name: 'qingshi_tags',
      description:
        '【写记录前先看标签】返回青史支持的全部事件标签（24 个）和一句话示例，' +
        '用户问「有哪些标签」「不知道该选哪个」或者你要在确认框里报标签时调用。不需要登录。',
      parameters: {},
      output: outputSpec,
      async execute() {
        const lines = ['青史的事件标签一共 24 种，写的时候挑最贴的一个：']
        for (const key of TAG_ORDER) {
          lines.push('· ' + TAG_LABELS[key] + '(' + key + ')  ' + (TAG_HINTS[key] || ''))
        }
        lines.push('')
        lines.push('线上老数据里还有 hobby(爱好)、spending(消费)、savings(储蓄)、turning_point(转折) 这几种旧写法，')
        lines.push('读的时候会自动归一，写的时候请用上面 24 个里的。')
        return lines.join(NL)
      },
    }),
  )

  // ---------- qingshi_about_me ----------
  // 一句话问答的入口：「我是谁」「我去过哪里」这类问题不用模型自己拼三个工具，
  // 一次调用就把身份 + 记录概况 + 最近几条 + 家人数拿回来。
  ctx.tools.register(
    defineTool({
      name: 'qingshi_about_me',
      description:
        '【一句话了解这个人】用户问「我是谁」「你知道我是谁吗」「我去过哪里」「我去过哪里你知道吗」' +
        '「我以前做过什么」「我从哪里来」「给我讲讲我的故事」「你了解我吗」这类**既没提青史、也没说清要查什么**的问题时，' +
        '先调这个工具：它会一次返回本人资料（昵称/性别/年龄/标签/简介）、一共记了多少条经历与年份跨度、最近几条的标题、以及家人数量。' +
        '拿到之后再决定要不要用 qingshi_find_experience / qingshi_family 深挖。' +
        '**不要说「我不知道你的信息」「我没法知道你的过去」——先查。**',
      parameters: {},
      output: outputSpec,
      async execute() {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)

        const person = await users.get(info.uid)
        const lines = []
        if (person && person.nickname) {
          const bits = [person.nickname]
          if (person.genderText) bits.push(person.genderText)
          if (person.birthday) {
            bits.push(person.birthday)
            const age = ageText(person.birthday, person.deathday)
            if (age) bits.push(age)
          }
          lines.push('这是我：' + bits.join(' · '))
          if (person.tags && person.tags.length) lines.push('标签：' + person.tags.join('、'))
          if (person.bio) lines.push('简介：' + person.bio)
        } else {
          lines.push('还没读到本人资料。')
        }

        const list = await careerApi.listEvents(info.uid, { previewLimit: 120 })
        if (!list.ok) {
          lines.push('记录这次没读到：' + (list.message || '后端返回异常'))
          return lines.join(NL)
        }
        const events = (Array.isArray(list.events) ? list.events : []).map(normalizeEvent)
        if (!events.length) {
          lines.push('青史里还没记过经历。')
        } else {
          const years = events
            .map((e) => String(e.startDate || '').slice(0, 4))
            .filter((y) => /^\d{4}$/.test(y))
            .sort()
          const span = years.length ? years[0] + '–' + years[years.length - 1] : ''
          lines.push('一共记了 ' + events.length + ' 条经历' + (span ? '（' + span + '）' : '') + '。')

          const plainTag = (tag) => String(tagLabel(tag) || '').replace(/\(.*\)$/, '') || '其他'
          const byTag = new Map()
          for (const e of events) {
            const label = plainTag(e.eventTag)
            byTag.set(label, (byTag.get(label) || 0) + 1)
          }
          const top = Array.from(byTag.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4)
          if (top.length) lines.push('主要类型：' + top.map(([k, n]) => k + ' ' + n).join('、'))

          const recent = events
            .slice()
            .sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')))
            .slice(0, 3)
          if (recent.length) {
            lines.push('最近的几条：')
            for (const e of recent) {
              const tag = plainTag(e.eventTag)
              lines.push('· ' + formatDate(e.startDate) + '  ' + (e.title || '（没写标题）') + (tag && tag !== '其他' ? '（' + tag + '）' : ''))
            }
          }
        }

        try {
          const fam = await careerApi.familyLayer({ uid: info.uid, type: 'parent', displaySiblings: true })
          if (fam.ok && fam.layer) {
            const root = fam.layer
            const kids = Array.isArray(root.childs) ? root.childs : []
            const has = (node) => Boolean(node && (node.uid || node.appellation))
            const seen = new Set()
            let relatives = 0
            for (const node of [root.man, root.woman, ...kids]) {
              if (!has(node)) continue
              const key = String(node.uid || node.appellation || '')
              if (seen.has(key)) continue
              seen.add(key)
              relatives += 1
            }
            if (relatives > 0) {
              lines.push('族谱里能直接看到的家人有 ' + relatives + ' 位（要具体问谁用 qingshi_family 或 qingshi_kinship）。')
            }
          }
        } catch {
          /* 族谱读不到不影响主流程 */
        }

        return lines.join(NL)
      },
    }),
  )

  // ---------- qingshi_profile ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_profile',
      description:
        '【关于「我」的问题先看这里】用户问「我是谁」「你知道我是谁吗」「我多大」「我是什么样的人」「我从哪里来」「你知道我的故事吗」，或任何需要先确认「他是谁」才能回答的问题，都先调这个工具拿真实资料——不要凭空猜、也不要说「我不知道你的信息」。读青史里的人资料：昵称、性别、生日（换算成岁数）、个性标签、简介。' +
        '当你要知道“用户是谁 / 我多大 / 我是男是女 / 我是什么样的人 / 该怎么称呼他”时用它，不要凭空猜。' +
        '不传 uid 就是用户自己；查家人时传 targetUid。',
      parameters: {
        targetUid: { type: 'string', description: '查谁；不填就是用户自己' },
        refresh: { type: 'boolean', description: 'true = 跳过 24 小时缓存重新拉' },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)

        const uid = String(args?.targetUid || '').trim() || info.uid
        const person = await users.get(uid, { force: Boolean(args?.refresh) })
        if (!person || !person.nickname) {
          return '青史里没读到这个人的资料（可能是 uid 不对，或者这个人没建过资料）。'
        }

        const genderText = person.gender === 1 ? '男' : person.gender === 2 ? '女' : '未填'
        const age = ageOf(person.birthday, person.deathday)
        const lines = []
        lines.push((uid === info.uid ? '本人：' : '') + person.nickname + ' · ' + genderText + (age === null ? '' : ' · ' + ageText(person.birthday, person.deathday)))
        if (person.birthday) lines.push('生日：' + person.birthday)
        if (person.labels.length) lines.push('标签：' + person.labels.join('、'))
        if (person.bio) lines.push('简介：' + person.bio)
        return lines.join(NL)
      },
    }),
  )

  // ---------- qingshi_set_privacy ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_set_privacy',
      description:
        '改某条生涯记录的可见性。后端字段是 privacy_setting：all 所有人可见 / private 仅自己可见 / ' +
        'selected 指定人可见（配 designatedUids）。写记录时没设过的话，新记录默认是「所有人可见」，' +
        '所以用户在意隐私时要主动提醒、并用这个工具改过来。',
      parameters: {
        eventId: { type: 'string', required: true, description: '要改的那条记录的 eventId' },
        privacy: {
          type: 'string',
          required: true,
          description: 'all 所有人可见 / private 仅自己可见 / selected 指定人可见',
        },
        designatedUids: {
          type: 'array',
          items: { type: 'string' },
          description: 'privacy=selected 时给哪些人看',
        },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)

        const eventId = String(args?.eventId || '').trim()
        if (!eventId) return '缺少 eventId（要改哪一条？可以先用 qingshi_find_experience 查出来）。'

        const result = await careerApi.setPrivacy(eventId, args?.privacy, {
          designatedUids: args?.designatedUids || [],
        })
        if (!result.ok) return '没改成：' + (result.message || '未知原因')
        return '好了，这条现在是「' + result.label + '」。'
      },
    }),
  )

  // ---------- qingshi_photo_scan ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_photo_scan',
      description:
        '扫描本机一批照片/视频，按拍摄时间聚成「经历事件」，给出每张的拍摄时间、GPS、文件路径；' +
        '已登录时还会列出与已有生涯记录重合的候选（日期接近 / 地点相近）。' +
        '只读，不移动、不上传、不改任何文件。' +
        '典型用法：用户丢来一堆照片或一个相册目录，说“帮我整理这些照片”“这些都是那次旅行拍的”，' +
        '先调它拿到时间和经历事件分组，你自己看几张有代表性的照片确认内容，再决定挂到已有记录还是新建记录。',
      parameters: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: '照片文件夹或单个文件的路径，可以传多个；文件夹会递归扫描',
        },
        maxPhotos: { type: 'number', description: '每页最多扫描多少个文件，默认 300，上限 2000' },
        offset: {
          type: 'number',
          description: '从第几个文件开始扫（分页用）。上一次返回里出现「还有更多照片没扫」时，把它给的 offset 传回来',
        },
        gapMinutes: {
          type: 'number',
          description: '相邻两张间隔超过多少分钟就算新的经历事件，默认 180（三小时）',
        },
        matchEvents: {
          type: 'boolean',
          description: '是否和已有生涯记录比对，默认 true；没登录时自动跳过',
        },
        detail: {
          type: 'boolean',
          description: '是否列出每个经历事件的所有照片；默认每个经历事件只列前 20 张',
        },
        withPlace: {
          type: 'boolean',
          description: '是否把 GPS 反查成地名（默认 true，最多查前 12 个经历事件；离线时自动只用坐标）',
        },
      },
      output: outputSpec,
      async execute(args) {
        const paths = Array.isArray(args?.paths)
          ? args.paths.map((item) => String(item || '').trim()).filter(Boolean)
          : []
        if (!paths.length) return '请给至少一个照片文件夹或文件的路径（可以传多个）。'

        const toInt = (value, min, max, fallback) => {
          const n = Number(value)
          if (!Number.isFinite(n)) return fallback
          return Math.min(max, Math.max(min, Math.round(n)))
        }
        const maxMedia = toInt(args?.maxPhotos, 1, 2000, 300)
        const offset = toInt(args?.offset, 0, 1000000, 0)
        const gapMinutes = toInt(args?.gapMinutes, 5, 24 * 60, 180)
        const resolvePlace =
          args?.withPlace === false ? null : (lat, lon) => geocoder.reverse(lat, lon)

        let events = []
        let tail = ''
        if (args?.matchEvents !== false) {
          const info = await workspace.info()
          if (info.loggedIn) {
            const list = await careerApi.listEvents(info.uid, { previewLimit: 200 })
            if (list.ok) events = list.events
            else tail = `\n（读生涯列表失败：${list.message || list.code}，这次只按时间聚类）`
          } else {
            tail = '\n（还没登录青史：只按时间聚类，没法和已有记录比对；登录后再扫一次可以匹配）'
          }
        }

        const result = await scanMedia(paths, { maxMedia, offset, gapMinutes, events, resolvePlace })
        return formatScan(result, { detail: args?.detail === true }) + tail
      },
    }),
  )

  // ---------- qingshi_storage ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_storage',
      description:
        '查看青史云空间额度：总量 / 已用 / 预留 / 剩余 / 使用率。' +
        '上传照片前先调它确认还剩多少；传 requiredBytes 时直接回答「这次够不够」。',
      parameters: {
        requiredBytes: {
          type: 'number',
          description: '这次准备上传多少字节（照片总大小）；传了就顺带判断够不够',
        },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)
        const quota = await careerApi.getStorageQuota()
        if (!quota.ok) return `读取存储额度失败：${quota.code} ${quota.message || ''}`

        const lines = [
          `云空间：已用 ${formatBytes(quota.used)} / 总量 ${formatBytes(quota.limit)}（${quota.usagePercent}%）`,
          `剩余可用：${formatBytes(quota.remaining)}` +
            (quota.reserved ? `（另有 ${formatBytes(quota.reserved)} 正在上传占用）` : ''),
        ]
        const need = Number(args?.requiredBytes) || 0
        if (need > 0) {
          lines.push(
            need <= quota.remaining
              ? `这次要传 ${formatBytes(need)}：够。`
              : `这次要传 ${formatBytes(need)}：不够，还差 ${formatBytes(need - quota.remaining)}。可以少选一些照片，或先在青史「存储相册 / 扩容」里购买或兑换额度。`,
          )
        }
        if (quota.limit === 0) lines.push('注意：当前账户还没有可用空间额度，需要先扩容才能上传图片。')
        return lines.join('\n')
      },
    }),
  )

  // ---------- qingshi_photo_save ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_photo_save',
      description:
        '把整理好的照片分组写入青史：一组 = 一条生涯记录（标题/正文/时间/地点/标签 + 图片）。' +
        '必须分两步：① 先不传 confirm 调一次，拿到预览（每组标题、时间、张数、总大小、额度是否够）给用户确认；' +
        '② 用户明确同意后再传 confirm=true，这时才真正上传图片并写入。' +
        '上传前会自动核对云空间额度，不够就整体拒绝，不会传一半。会遍历所有分组，逐组报告结果。',
      parameters: {
        items: {
          type: 'array',
          required: true,
          description: '照片分组；每一组生成一条生涯记录',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', required: true, description: '标题（按照片内容起名）' },
              content: { type: 'string', description: '正文（按照片内容写，保留用户的说法）' },
              startDate: { type: 'string', description: '拍摄日期，YYYY-MM-DD 或 YYYY-MM-DD HH:mm' },
              eventTag: { type: 'string', description: '事件标签，默认 record' },
              locationName: { type: 'string', description: '地点名称' },
              locationAddress: { type: 'string', description: '地点地址' },
              latitude: { type: 'number', description: '纬度' },
              longitude: { type: 'number', description: '经度' },
              imagePaths: {
                type: 'array',
                items: { type: 'string' },
                description: '这一组要上传的图片绝对路径',
              },
            },
          },
        },
        confirm: {
          type: 'boolean',
          description: '只有用户明确确认「保存」之后才传 true；不传或 false 只返回预览',
        },
        targetUid: {
          type: 'string',
          description: '照片归属谁；不填就是登录用户自己。用户说"存到我爸那""给我妈写一条"时：称谓（妈妈/爸爸/爷爷…）→ qingshi_kinship(term="妈")反查uid；真名（张建国）→ qingshi_manageable_users(keyword="张建国")模糊匹配。**绝对禁止用 qingshi_family / family_expand / family_layout 找归属人**——那些是族谱查看工具，不是人员检索。',
        },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)

        const targetUid = String(args?.targetUid || '').trim() || info.uid
        const isSelf = targetUid === info.uid
        if (!isSelf && info.flags && info.flags.disableFamilyAct) {
          return `这次要写到 uid: ${targetUid}，但当前账号关闭了"允许代家人记录"。请让插件配置里打开，或改为记在本人名下。`
        }

        const rawItems = Array.isArray(args?.items) ? args.items : []
        if (!rawItems.length) return '没有要保存的分组。'

        const items = []
        const problems = []
        for (const [index, raw] of rawItems.entries()) {
          const item = raw && typeof raw === 'object' ? raw : {}
          const title = String(item.title || '').trim()
          if (!title) {
            problems.push(`第 ${index + 1} 组没有标题，已跳过。`)
            continue
          }
          const imagePaths = Array.isArray(item.imagePaths)
            ? item.imagePaths.map((file) => String(file || '').trim()).filter(Boolean)
            : []
          let bytes = 0
          const usable = []
          for (const file of imagePaths) {
            try {
              const fileStat = await stat(file)
              if (!fileStat.isFile()) throw new Error('不是文件')
              bytes += fileStat.size
              usable.push(file)
            } catch (error) {
              problems.push(`${title}：图片 ${file} 读不到（${error.code || error.message}），已跳过这张`)
            }
          }
          items.push({
            title,
            content: String(item.content || '').trim(),
            startDate: String(item.startDate || '').trim(),
            eventTag: String(item.eventTag || 'record').trim() || 'record',
            location: {
              name: String(item.locationName || '').trim(),
              address: String(item.locationAddress || '').trim(),
              latitude: Number(item.latitude) || 0,
              longitude: Number(item.longitude) || 0,
            },
            imagePaths: usable,
            bytes,
          })
        }
        if (!items.length) return ['没有可保存的分组。', ...problems].join('\n')

        const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0)
        const quota = await careerApi.getStorageQuota()
        const quotaLine = quota.ok
          ? `云空间：剩余 ${formatBytes(quota.remaining)}，这次要传 ${formatBytes(totalBytes)}`
          : `云空间额度读取失败（${quota.code} ${quota.message || ''}）`

        // 第一步：预览
        if (args?.confirm !== true) {
          const lines = [`（预览，还没上传、没写入）准备写 ${items.length} 条记录：`]
          items.forEach((item, index) => {
            const date = item.startDate || '（未给时间，会记为今天）'
            lines.push(
              `\n[${index + 1}] ${item.title} · ${date} · 标签 ${item.eventTag} · ${item.imagePaths.length} 张 / ${formatBytes(item.bytes)}`,
            )
            if (item.location.name || item.location.address) {
              lines.push(`    地点：${item.location.name}${item.location.address && item.location.address !== item.location.name ? '（' + item.location.address + '）' : ''}`)
            }
            const brief = item.content ? item.content.slice(0, 120) + (item.content.length > 120 ? '…' : '') : '（空）'
            lines.push(`    正文：${brief}`)
            if (item.imagePaths.length) {
              lines.push('    图片清单（本地路径，可点击打开）：')
              item.imagePaths.forEach((p, i) => {
                const fileName = p.split(/[\\/]/).pop()
                lines.push(`      ${i + 1}. ${fileName}`)
                lines.push(`         ${p}`)
              })
            }
          })
          lines.push('', quotaLine)
          if (quota.ok && totalBytes > quota.remaining) {
            lines.push(`额度不够：还差 ${formatBytes(totalBytes - quota.remaining)}，这时不能保存。`)
          }
          if (problems.length) lines.push('', ...problems)
          lines.push('', '用户确认后，再调一次 qingshi_photo_save，这次传 confirm=true。')
          return lines.join('\n')
        }

        // 第二步：真正写入，先卡额度
        if (!quota.ok) {
          return `上传前必须先确认存储额度，但现在读不到：${quota.code} ${quota.message || ''}。先修好再试。`
        }
        if (totalBytes > quota.remaining) {
          return [
            `已拒绝上传：这次要传 ${formatBytes(totalBytes)}，但云空间只剩 ${formatBytes(quota.remaining)}，还差 ${formatBytes(totalBytes - quota.remaining)}。`,
            '没有上传任何文件。可以少选一些照片，或先在青史的「存储相册 / 扩容」里购买或兑换额度。',
          ].join('\n')
        }

        const results = []
        for (const [index, item] of items.entries()) {
          const media = []
          const failed = []
          for (const file of item.imagePaths) {
            try {
              media.push(await uploadMedia(authed, file, { uid: info.uid }))
            } catch (error) {
              failed.push(`${file}（${error.message}）`)
            }
          }

          const payload = {
            of_type: 'user',
            of_id: targetUid,
            title: item.title,
            content: appendAttribution(item.content, resolveClientLabel(cfg)),
            start_date: item.startDate || todayText(),
            event_tag: item.eventTag,
          }
          if (item.location.name || item.location.address) payload.location = item.location
          if (media.length) payload.media_list = media

          const added = await authed('/add_event', payload)
          if (added.code === 200) {
            const eventId = added.event_id || pick(added.data, 'event_id', 'eventId') || ''
            results.push(
              `[${index + 1}] 已写入：${item.title}${eventId ? `（event_id: ${eventId}）` : ''} · ${media.length} 张`,
            )
            if (failed.length) results.push(`    有 ${failed.length} 张没传成功：${failed.join('；')}`)
          } else {
            results.push(`[${index + 1}] 写入失败：${item.title} · ${added.code} ${added.message || ''}`)
          }
        }

        return [
          `已处理 ${items.length} 组：`,
          ...results,
          '',
          quotaLine,
          '注意：这些记录默认是「所有人可见」。要改成仅自己可见，可以用 qingshi_set_privacy。',
        ].join('\n')
      },
    }),
  )

  // ---------- 手机扫码上传 ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_phone_upload_start',
      description:
        '用户说「手机上传」「用手机传照片」「扫码传照片」时用：在电脑上生成这个账号专属的上传二维码，' +
        '并打开一个本机确认窗（手机传了哪些、传了多少会实时显示）。' +
        '照片只先暂存在临时桶，不占配额、不进正式相册；等电脑下载回本地后才走标准上传。' +
        '已有一个没超时的上传会话时会直接复用，不会重复建。',
      parameters: {
        openReview: {
          type: 'boolean',
          description: '是否自动打开本机确认窗，默认 true；无窗口环境传 false',
        },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)
        const result = await phoneUpload.start({ openReview: args?.openReview !== false })
        if (!result.ok) return result.message
        const lines = [
          result.reused ? '已经有一个进行中的手机上传会话，二维码已刷新。' : '手机上传二维码已生成。',
          result.window?.opened
            ? '本机确认窗已经打开，让用户用手机上的相机/微信扫一下，选好照片后点「完成」。'
            : '这台机器没能自动弹窗。把下面的上传地址给用户，用手机浏览器打开（不要发到公开的地方）：',
        ]
        if (!result.window?.opened) lines.push(result.uploadUrl)
        if (!result.hasQr) lines.push('（二维码图片生成失败，通常不影响上传，直接用上面的地址也可以。）')
        lines.push('', '手机传完之后，调 qingshi_phone_upload_status 查看收到多少张。')
        return lines.join(NL)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qingshi_phone_upload_status',
      description:
        '查看手机扫码上传的进度：手机上已经传了多少张、每张的拍摄时间和大小、还剩多久有效。' +
        '状态到 completed 就说明手机那边点过「完成」，可以进入下载和归档；' +
        '需要等手机传完时可以带 waitSeconds，让它在工具内部轮询而不是反复调用。',
      parameters: {
        sessionId: { type: 'string', description: '上传会话 id；不填就用本地记录里当前这次' },
        waitSeconds: {
          type: 'number',
          description: '最多等多少秒（每 2 秒查一次），默认 0 只查一次；用户说「传完了」时可以给 30~60',
        },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)
        const result = await phoneUpload.status({
          sessionId: String(args?.sessionId || '').trim(),
          waitSeconds: Number(args?.waitSeconds) || 0,
        })
        if (!result.ok) return result.message

        const statusText = {
          waiting: '手机还没开始传（二维码还没扫，或者还没选照片）',
          uploading: '手机正在上传',
          completed: '手机已传完',
          importing: '已进入电脑整理阶段',
          done: '已归档完成',
          expired: '会话已过期',
          canceled: '会话已取消',
        }[result.status] || result.status

        const lines = [`手机上传状态：${statusText}（已收到 ${result.files.length} 张，共 ${formatBytes(result.totalBytes)}）`]
        result.files.slice(0, 40).forEach((item, index) => {
          const when = item.taken_at ? ` · ${item.taken_at}` : ''
          lines.push(`${index + 1}. ${item.file_name || '未命名'}${when} · ${formatBytes(item.file_size || 0)}`)
        })
        if (result.files.length > 40) lines.push(`……还有 ${result.files.length - 40} 张未列出`)
        if (result.expiresIn > 0) lines.push('', `二维码还有约 ${Math.ceil(result.expiresIn / 60)} 分钟有效。`)

        if (result.status === 'completed' || result.status === 'importing') {
          lines.push('', '下一步：先问用户「无损压缩还是原图」，再调 qingshi_phone_upload_pick。')
        } else if (result.status === 'waiting') {
          lines.push('', '让用户在手机上扫码选照片，选完点「完成」。')
        } else if (result.status === 'uploading') {
          lines.push('', '手机还在传，等它点「完成」或再查一次。')
        }
        return lines.join(NL)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qingshi_phone_upload_pick',
      description:
        '把手机已经传完的照片下载回这台电脑，落到本地暂存目录，并读出每张的拍摄时间和 GPS。' +
        '下载完成后，按拍摄时间/GPS分组、写标题正文，用 qingshi_phone_upload_preview 推到后端让 H5 显示分类预览；' +
        '用户确认后，**在调 qingshi_photo_save 之前**，再调 qingshi_phone_upload_compress 对要存的照片做无损压缩。' +
        '这样可以只压缩确定要存的照片，废弃桶里的跳过。HEIC 会在这一步转成 JPG（正式桶不支持 HEIC）。',
      parameters: {
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)
        const result = await phoneUpload.pick({ compression: 'original', allowInstall: false })
        if (!result.ok) return result.message

        const lines = [`已把 ${result.files.length} 张照片下载到本机：${result.localDir}`]
        result.files.slice(0, 60).forEach((item, index) => {
          const when = item.takenAt ? ` · ${item.takenAt}` : ' · （没有拍摄时间）'
          const gps = item.gps && item.gps.latitude ? ` · ${item.gps.latitude},${item.gps.longitude}` : ''
          lines.push(`${index + 1}. ${item.fileName}${when} · ${formatBytes(item.bytes)}${gps}`)
          lines.push(`   本地路径：${item.localPath}`)
        })
        if (result.files.length > 60) lines.push(`……还有 ${result.files.length - 60} 张未列出`)
        if (result.notes?.length) lines.push('', ...result.notes.slice(0, 10))
        if (result.problems?.length) lines.push('', '有这些没处理成功：', ...result.problems.slice(0, 10))
        lines.push(
          '',
          '下一步：按拍摄时间/GPS分组、起标题写正文 → 调 qingshi_phone_upload_preview 推 planned_events 到后端 → 告诉用户去 H5 看 → 等用户确认 → 再调 qingshi_phone_upload_compress（如果要无损）→ qingshi_photo_save 写入。',
          '这样压缩只作用于确定要存的照片，废弃桶里的跳过。',
        )
        return lines.join(NL)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qingshi_phone_upload_compress',
      description:
        '对 phone_upload_pick 下载的照片做无损压缩（JPEG→jpegtran、PNG→oxipng）。' +
        '必须在 AI 分类完成、用户确认后、photo_save 之前调用——这样只压缩确定要存的照片，废弃桶里的跳过。' +
        '压缩**不会丢 EXIF/GPS 元数据**（jpegtran 默认 -copy all、oxipng 保留 text chunks）。' +
        '工具缺失时先返回提示，用户同意后带 allowInstall=true 重调。',
      parameters: {
        sessionId: { type: 'string', description: '上传会话 id（phone_upload_start 返回）' },
        filePaths: {
          type: 'array',
          items: { type: 'string' },
          description: '要压缩的本地文件绝对路径列表。传分组后每组确定要存的那些图片路径，废弃桶的不要传。',
        },
        allowInstall: {
          type: 'boolean',
          description: '工具缺失时用户明确同意后传 true，才会下载安装',
        },
      },
      required: ['sessionId', 'filePaths'],
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)
        const { optimizeImageInPlace, toolsDir } = await import('../lib/lossless-tools.js')

        const paths = Array.isArray(args?.filePaths) ? args.filePaths.map(String).filter(Boolean) : []
        if (!paths.length) return 'filePaths 不能为空'

        const lines = [`准备对 ${paths.length} 张照片做无损压缩（不会丢 EXIF/GPS）：`]
        let totalSaved = 0
        let needConsent = false
        const problems = []

        for (const p of paths) {
          try {
            const result = await optimizeImageInPlace(p, {
              workspaceDir: phoneUpload.workspaceDir || process.cwd(),
              allowInstall: args?.allowInstall === true,
            })
            if (result.needConsent) needConsent = true
            if (result.bytesAfter > 0 && result.bytesAfter < result.bytesBefore) {
              totalSaved += result.bytesBefore - result.bytesAfter
              lines.push(`  ✓ ${basename(p)}: ${formatBytes(result.bytesBefore)} → ${formatBytes(result.bytesAfter)} (${result.tool || '?'})`)
            } else if (result.note && !result.needConsent) {
              lines.push(`  • ${basename(p)}: ${result.note}`)
            }
          } catch (error) {
            problems.push(`${basename(p)}: ${error.message}`)
          }
        }

        if (totalSaved > 0) lines.push('', `共省了 ${formatBytes(totalSaved)}。`)
        if (problems.length) lines.push('', `有 ${problems.length} 张没成功：`, ...problems.slice(0, 10))

        if (needConsent) {
          lines.push(
            '',
            `这台电脑还没有无损压缩工具。要我现在下载安装到 ${toolsDir(phoneUpload.workspaceDir || process.cwd())} 吗？（只装本地，不动系统目录）`,
            '用户同意后，用 allowInstall=true 再调一次 qingshi_phone_upload_compress。',
          )
        } else {
          lines.push('', `下一步：调 qingshi_photo_save 把这些照片写入青史永存的生涯记录。`)
        }
        return lines.join(NL)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qingshi_phone_upload_preview',
      description:
        'AI 分类完成后把 planned_events 推到后端，手机/电脑 H5 预览页会立即显示完整分类工作台。' +
        '必须在 phone_upload_pick 拿到文件列表并按经历事件分组后调用，H5 靠这个接口拿到 planned_events 轮询渲染。',
      parameters: {
        sessionId: { type: 'string', description: '上传会话 id（phone_upload_start 返回）' },
        plannedEvents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '事件标题，如"2025 端午故宫游"' },
              content: { type: 'string', description: '正文描述，开头 100 字内尽量带画面描述' },
              eventTag: { type: 'string', description: '标签，从 25 个标准标签里选：record/happy/sad/memory/memorial/love/birthday/family/friend/party/festival/work/study/growth/achievement/challenge/turning_point/idea/summary/travel/scenery/food/hobby/spending/savings' },
              startDate: { type: 'string', description: '日期 YYYY-MM-DD' },
              location: { type: 'object', description: '{name:"", address:""}' },
              classification_basis: { type: 'string', description: '分类依据，如"按时间段+地点：同一天都在故宫"' },
              file_keys: { type: 'array', items: { type: 'string' }, description: '这一组包含的 oss object_key 列表（从 pick 返回的 files 里拿 object_key 字段）' },
              discard: { type: 'boolean', description: 'true = 这一组放到废弃桶' },
              merge_to_event_id: { type: 'string', description: '如果要合并到已有事件，填那个事件的 id' },
              photos: { type: 'array', items: { type: 'object' }, description: '每张图的 ai_analysis 和 keep 标记，如 [{file_key, ai_analysis, keep:true}]' },
            },
            required: ['title', 'file_keys'],
          },
          description: 'AI 分好的待录入事件列表（至少一条；废弃桶的那条要带 discard:true）',
        },
      },
      required: ['sessionId', 'plannedEvents'],
      execute: async (args, ctx) => {
        const { sessionId, plannedEvents } = args
        const api = phoneUploadApi(ctx)
        const res = await api.post('/phone_upload/preview', {
          session_id: sessionId,
          planned_events: plannedEvents,
        })
        return formatResponse(res, '预览已推送，H5 页面正在刷新分类结果')
      },
    },
    {
      name: 'qingshi_phone_upload_finish',
      description:
        '手机上传的收尾：照片已经写入生涯后调用，登记导入结果并删除临时桶里的整个目录；' +
        '用户中途放弃时传 cancel=true 也能清空临时区。' +
        '不要在还没保存成功时调用，否则临时区的原图会被删掉。',
      parameters: {
        eventIds: {
          type: 'array',
          items: { type: 'string' },
          description: '这次由手机照片生成 / 追加的生涯事件 id，可传多个',
        },
        cancel: {
          type: 'boolean',
          description: 'true = 放弃这次上传并清空临时区',
        },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)
        const result = await phoneUpload.finish({
          eventIds: Array.isArray(args?.eventIds) ? args.eventIds : [],
          cancel: args?.cancel === true,
        })
        if (!result.ok) return result.message
        if (result.canceled) return '已取消这次手机上传，临时区清空了。'
        return `收尾完成：登记了 ${result.eventCount} 条生涯记录，临时区删除了 ${result.removed} 个文件。`
      },
    }),
  )

  // ---------- qingshi_draft ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_draft',
      description:
        '把一件事先记成本地草稿：只写在这台机器的青史工作区里（drafts.json + 图片），**不算保存到云端**、不需要登录。' +
        '用户说“先帮我记下来”“记在本地”“回头再发”，或者只是讲了一段经历想留个底时用它。' +
        '要真正永久保存到云端，必须再调到云端用 qingshi_publish。',
      parameters: {
        title: { type: 'string', required: true, description: '标题，简短' },
        content: { type: 'string', description: '正文，保留用户自己的说法' },
        startDate: { type: 'string', description: '开始时间 YYYY-MM-DD 或 YYYY-MM-DD HH:mm；不填就是今天' },
        endDate: { type: 'string', description: '结束时间，仅阶段事件需要' },
        isStage: { type: 'boolean', description: '是否阶段事件，默认 false' },
        eventTag: { type: 'string', description: '事件标签，默认 record' },
        locationName: { type: 'string', description: '地点名称' },
        locationAddress: { type: 'string', description: '地点地址' },
        latitude: { type: 'number', description: '纬度，没有就不填' },
        longitude: { type: 'number', description: '经度，没有就不填' },
        targetUid: { type: 'string', description: '给谁记；不填就是用户自己' },
        imagePaths: {
          type: 'array',
          items: { type: 'string' },
          description: '本机图片的绝对路径，会复制进草稿的图片目录',
        },
      },
      output: outputSpec,
      async execute(args) {
        const title = String(args?.title || '').trim()
        if (!title) return '标题不能为空。'

        const draft = await drafts.save({
          title,
          content: String(args?.content || '').trim(),
          startDate: String(args?.startDate || '').trim(),
          endDate: String(args?.endDate || '').trim(),
          isStage: Boolean(args?.isStage),
          eventTag: String(args?.eventTag || 'record').trim(),
          location: {
            name: String(args?.locationName || '').trim(),
            address: String(args?.locationAddress || '').trim(),
            latitude: Number(args?.latitude) || 0,
            longitude: Number(args?.longitude) || 0,
          },
          targetUid: String(args?.targetUid || '').trim(),
          media: [],
        })

        const warnings = []
        const paths = Array.isArray(args?.imagePaths) ? args.imagePaths : []
        if (paths.length) {
          const media = []
          for (const file of paths) {
            try {
              const imported = await drafts.importMedia(draft.id, String(file))
              media.push({
                name: imported.name,
                storedName: imported.storedName,
                contentType: imported.contentType,
              })
            } catch (error) {
              warnings.push(`图片 ${file} 没导入：${error.message}`)
            }
          }
          if (media.length) {
            const merged = await drafts.save({ ...draft, media: [...draft.media, ...media] })
            Object.assign(draft, merged)
          }
        }

        return [
          `已存到本地草稿：${draft.title}（draft_id: ${draft.id}）`,
          `时间：${draft.startDate}${draft.isStage && draft.endDate ? ` ～ ${draft.endDate}` : ''}`,
          `标签：${tagLabel(draft.eventTag)}`,
          draft.location?.name ? `地点：${draft.location.name}` : '',
          draft.media.length ? `图片：${draft.media.length} 张（还在本地，发布时才上传）` : '',
          '这条现在只在本地，没有上传云端。要发布就说“发布第 N 条”，要改就去 qingshi_open_h5 打开的真 H5 窗口里改。',
          ...warnings,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),
  )

  // ---------- qingshi_publish ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_publish',
      description:
        '把一条本地草稿发布到青史云端：先上传图片到 OSS，再调 /add_event 落库，这一步才是**永久保存**。' +
        '发布后云端那条不能用插件撤回，所以调用前先跟用户核对标题和正文，并且不要重复发布同一条。' +
        '只有用户明确说“发布第 N 条 / 把这条发出去 / 上传到云端”时才调用；不传 id 就只列出草稿清单。',
      parameters: {
        id: { type: 'string', description: '草稿 id；也可以只传 index（从 1 开始）' },
        index: { type: 'number', description: '草稿序号，按本地草稿清单顺序，从 1 开始（不传 id 会列出清单）' },
      },
      output: outputSpec,
      async execute(args) {
        const all = await drafts.list()
        // 序号只数还没发布的，已发布的留着但不再参与“第几条”
        const pending = all.filter((d) => d.status !== 'published')
        let id = String(args?.id || args?.draftId || args?.draft_id || '').trim()
        const index = Number(args?.index) || 0
        if (!id && index > 0) id = pending[index - 1]?.id || ''

        if (!id) {
          if (!pending.length) {
            return all.length
              ? `本地 ${all.length} 条草稿都已经发布到云端了。`
              : '本地还没有草稿。先在对话里说一句要记的事，我调 qingshi_draft 存下来。'
          }
          return [
            `本地待发布草稿 ${pending.length} 条：`,
            ...pending.map((d, i) => {
              return `${i + 1}. ${d.title}  ${d.startDate}  ${tagLabel(d.eventTag)}  (id: ${d.id})`
            }),
            '',
            '要发哪条？说“发布第 N 条”即可。',
          ].join('\n')
        }

        const result = await publishDraft(id)
        if (result.error) return result.error
        const media = result.draft?.media?.length || 0
        return [
          `已发布到云端：${result.draft?.title || id}（event_id: ${result.eventId || '未知'}）`,
          media ? `带上了 ${media} 张图片。` : '',
          '本地草稿保留着，只是标成了已发布。',
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),
  )

  // ---------- 真 H5：浏览器自动化工具 ----------
  const routeParam = {
    route: {
      type: 'string',
      description: '页面路由，比如 /pages/career/career、/pages/familytree/familytree、/pages/profile/profile；不给就停在当前页',
    },
  }

  ctx.tools.register(
    defineTool({
      name: 'qingshi_open_h5',
      description:
        '打开（或复用）青史真 H5 的独立桌面窗口（qingshi.iyouwc.cn），并顺带把登录态同步回本地工作区。' +
        '用户说「打开青史」「把青史打开」「打开那个窗口」时，直接调用这个工具，不要先解释或先查项目。' +
        '这才是用户手机里那个应用的完整界面：生涯、族谱、发现、AI 助手、时光胶囊、个人中心都在这里。' +
        '想让用户看某个页面时直接传 route。',
      parameters: routeParam,
      output: outputSpec,
      async execute(args) {
        const { session, error } = await ensureBrowser(args?.route)
        if (error) return error
        const page = await session.readPage({ maxText: 200 })
        const sync = await syncTokenFromBrowser(session)
        const lines = [
          '已经打开青史 H5 窗口（独立窗口，不是标签页）。',
          '当前页：' + (page.title || '(加载中)') + '  ' + page.url,
        ]
        if (sync.ok) lines.push('登录态已同步：云端 ' + sync.count + ' 条记录。')
        else {
          // 窗口里没 token：让插件自己走一次标准登录（弹登录小窗），不再让用户手动去登
          const session = await ensureLoggedIn({ allowLogin: true }).catch(() => null)
          if (session?.loggedIn) {
            const again = await syncTokenFromBrowser(session).catch(() => ({ ok: false }))
            lines.push(again?.ok ? '登录态已同步：云端 ' + again.count + ' 条记录。' : '登录刚完成，页面稍后刷新就是登录态。')
          } else {
            lines.push('这个窗口还没登录，登录小窗没等到完成；把上面那个本机地址给用户，让他登完再说一声。')
          }
        }
        lines.push('', '接下来可以让用户点，也可以我用 qingshi_ui_* 直接操作这个窗口。')
        return lines.join('\n')
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qingshi_ui_read',
      description: '读当前青史窗口里这一页：标题、地址、输入框、可点元素、可见文字。想确认页面长相或找按钮时先用它。',
      parameters: {},
      output: outputSpec,
      async execute() {
        const { session, error } = await ensureBrowser()
        if (error) return error
        const page = await session.readPage()
        return describePage(page)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qingshi_ui_goto',
      description: '在青史窗口里跳到某个页面（路由见 qingshi_pages）。',
      parameters: {
        route: { type: 'string', required: true, description: '例如 /pages/familytree/familytree' },
      },
      output: outputSpec,
      async execute(args) {
        const route = String(args?.route || '').trim()
        if (!route) return '要给一个路由，比如 /pages/career/career'
        const { session, error } = await ensureBrowser(route)
        if (error) return error
        const page = await session.readPage({ maxText: 300 })
        return describePage(page, { textLimit: 300 })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qingshi_ui_click',
      description: '在青史窗口里点一下：给 text（按钮文字，优先）或 selector。点完返回新的页面状态。',
      parameters: {
        text: { type: 'string', description: '要点的文字，例如「族谱」「添加」「保存」' },
        selector: { type: 'string', description: 'CSS 选择器，text 找不到时用它' },
      },
      output: outputSpec,
      async execute(args) {
        const { session, error } = await ensureBrowser()
        if (error) return error
        const result = await session.click({ text: String(args?.text || '').trim(), selector: String(args?.selector || '').trim() })
        if (!result?.ok) return '没点成：' + (result?.reason || '未知原因')
        await new Promise((resolve) => setTimeout(resolve, 1200))
        const page = await session.readPage({ maxText: 600 })
        return '点了「' + (result.text || args?.text || args?.selector) + '」\n\n' + describePage(page, { textLimit: 600 })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qingshi_ui_type',
      description:
        '在青史窗口里往输入框写内容：按 placeholder 找（推荐），或按下标 index。会派发 input 事件，uni-app 的 v-model 能收到。',
      parameters: {
        placeholder: { type: 'string', description: '输入框提示文字的一部分，例如「手机号」「验证码」' },
        index: { type: 'number', description: '第几个输入框（从 0 开始），没给 placeholder 时用' },
        value: { type: 'string', required: true, description: '要写进去的内容' },
      },
      output: outputSpec,
      async execute(args) {
        const { session, error } = await ensureBrowser()
        if (error) return error
        const placeholder = String(args?.placeholder || '').trim()
        const index = Number.isFinite(Number(args?.index)) ? Number(args.index) : -1
        const value = String(args?.value ?? '')
        // 页面刚跳过来时输入框可能还没渲染，重试几秒
        let result = null
        for (let i = 0; i < 12; i += 1) {
          result = await session.type({ placeholder, index, value })
          if (result?.ok) break
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
        if (!result?.ok) {
          return (
            '没写成：' + (result?.reason || '没找到输入框') +
            (typeof result?.count === 'number' ? `（当前页面可输入框 ${result.count} 个）` : '') +
            '。先用 qingshi_ui_read 看一眼当前页，或用 index 指定第几个输入框。'
          )
        }
        return '已写入「' + (result.placeholder || '输入框 ' + index) + '」：' + result.value
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qingshi_ui_tap',
      description:
        '在青史窗口里按屏幕坐标点一下（x、y 是页面像素）。族谱这种无限画布页面，' +
        '节点和菜单没有稳定的文字时用这个最可靠；点完记得 qingshi_ui_shot 或 qingshi_ui_read 看一眼结果。',
      parameters: {
        x: { type: 'number', required: true, description: '横坐标（页面像素）' },
        y: { type: 'number', required: true, description: '纵坐标（页面像素）' },
      },
      output: outputSpec,
      async execute(args) {
        const { session, error } = await ensureBrowser()
        if (error) return error
        const point = await session.tap({ x: args?.x, y: args?.y })
        await new Promise((r) => setTimeout(r, 400))
        await saveStorageSnapshot(session)
        return '已经在 (' + point.x + ', ' + point.y + ') 点了一下。' + NL + NL + (await describePage(await session.readPage({ maxText: 600 })))
      },
    }),
  )

  // ---------- qingshi_ui_shot ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_ui_shot',
      description: '给当前青史窗口截一张图，返回本地文件路径（可以再用图片工具打开看）。',
      parameters: {
        name: { type: 'string', description: '文件名（不含扩展名），默认按时间戳' },
      },
      output: outputSpec,
      async execute(args) {
        const { session, error } = await ensureBrowser()
        if (error) return error
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const safe = String(args?.name || '').trim().replace(/[^\w\u4e00-\u9fa5-]/g, '') || stamp
        const file = join(cfg.workspaceDir, 'shots', safe + '.png')
        await session.screenshot(file)
        return '截图已存：' + file
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qingshi_pages',
      description: '青史 H5 有哪些页面、每个页面能干什么（能力地图）。不确定某个功能在哪一页时先查这个。',
      parameters: {
        query: { type: 'string', description: '关键词，比如「族谱」「时光胶囊」「存储」；不给就列全部' },
      },
      output: outputSpec,
      async execute(args) {
        const keyword = String(args?.query || '').trim()
        const list = findPages(keyword)
        if (!list.length) return '没找到匹配「' + keyword + '」的页面。可用的分组：生涯 / 族谱 / AI / 发现 / 组织 / 时光胶囊 / 个人主页 / 消息 / 个人中心。'
        if (!keyword) return '青史 H5 共 ' + PAGES.length + ' 个页面：\n\n' + pageBrief()
        return list.map((page) => '- ' + page.title + '（' + page.route + '）：' + page.desc).join('\n')
      },
    }),
  )

  // ---------- qingshi_event ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_event',
      description:
        '读取「青史」里某一条生涯记录的完整内容：标题、正文全文、起止时间、是否阶段事件、标签、地点、图片、' +
        '可见性设置。当 qingshi_find_experience 只给了摘要、需要看全文或核对细节时用它。只读，不改任何东西。',
      parameters: {
        eventId: {
          type: 'string',
          required: true,
          description: '事件 id，就是 qingshi_find_experience 结果里每条的 event_id',
        },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)
        const eventId = String(args?.eventId || '').trim()
        if (!eventId) return '缺少 eventId。'
        const found = await careerApi.getEvent(eventId)
        if (!found.ok) return '读取失败：' + found.code + ' ' + (found.message || '')
        const event = found.event
        const it = normalizeEvent(event)
        const spanText =
          it.isStage && it.endDate ? it.startDate + ' ～ ' + it.endDate : it.startDate + '（单日）'
        const lines = [
          '标题：' + it.title,
          '时间：' + spanText,
          '标签：' + tagLabel(it.eventTag),
          it.locationName
            ? '地点：' + it.locationName + (it.locationAddress ? '（' + it.locationAddress + '）' : '')
            : '',
          it.media.length ? '图片：' + it.media.length + ' 张' : '',
          event.privacy_setting && event.privacy_setting !== 'all' ? '可见性：' + event.privacy_setting : '',
          'event_id：' + it.eventId,
          '',
          it.content ? it.content : '（这条没有正文）',
        ]
        return lines.filter((line) => line !== '').join('\n')
      },
    }),
  )

  // ---------- qingshi_edit ----------
  // 后端 /edit_event 是整条覆盖，所以这里走「先读原文档 → 合并改动 → 发完整字段」，
  // 只把用户要改的那几项换掉，其余（含图片）原样带回。dryRun 只算不写。
  ctx.tools.register(
    defineTool({
      name: 'qingshi_edit',
      description:
        '修改「青史」里已经存在的一条生涯记录（改标题/正文/时间/标签/地点/阶段事件/图片）。' +
        '只传要改的字段，其余保持不变——插件会先读原记录再合并后整体回写，所以不会清空正文或图片。' +
        '这是**修改云端已有数据**，不是新记录；用户说“把那条改成…”“时间写错了改一下”时用。' +
        'dryRun=true 时只返回“会变成什么”，不真写，适合先给用户看一眼。',
      parameters: {
        eventId: { type: 'string', required: true, description: '要改的事件 id' },
        title: { type: 'string', description: '新标题；不改就不传' },
        content: { type: 'string', description: '新正文（整段替换，不是追加）；不改就不传' },
        startDate: { type: 'string', description: '新的开始时间，YYYY-MM-DD 或 YYYY-MM-DD HH:mm' },
        endDate: { type: 'string', description: '新的结束时间；阶段事件才需要' },
        isStage: { type: 'boolean', description: 'true=改成跨时间的阶段事件；false=改回单日' },
        eventTag: {
          type: 'string',
          description:
            '新的事件标签：record/birthday/happy/family/friend/party/festival/work/study/growth/achievement/challenge/idea/memorial/summary/travel/scenery/food/memory/sad/love/consume/save/turning',
        },
        location: {
          type: 'object',
          additionalProperties: true,
          description: '新地点 { name, address, latitude, longitude }；name 和 address 都空等于清掉地点',
        },
        dryRun: { type: 'boolean', description: 'true=只预览会变成什么，不真的写入' },
        imagePaths: {
          type: 'array',
          items: { type: 'string' },
          description:
            '要追加到这条记录的图片（本机绝对路径）。会和原有图片合并，不会清掉已上传的；' +
            '只有图片、不传其它字段也可以。dryRun 时不上传。',
        },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)
        const eventId = String(args?.eventId || '').trim()
        if (!eventId) return '缺少 eventId。'
        const patch = {}
        for (const key of ['title', 'content', 'startDate', 'endDate', 'isStage', 'eventTag']) {
          if (args?.[key] !== undefined) patch[key] = args[key]
        }
        if (args?.location !== undefined) patch.location = args.location
        const imagePaths = Array.isArray(args?.imagePaths)
          ? args.imagePaths.map((item) => String(item || '').trim()).filter(Boolean)
          : []
        if (Object.keys(patch).length === 0 && !imagePaths.length) {
          return '没给要改的字段。至少要传 title/content/startDate/endDate/isStage/eventTag/location/imagePaths 之一。'
        }

        const dryRun = args?.dryRun === true
        const warnings = []

        // 图片是「追加」语义：读出现有 media_list，上传新的，再整体回写
        if (imagePaths.length && !dryRun) {
          const found = await careerApi.getEvent(eventId)
          if (!found.ok) return '读不到原记录：' + found.code + ' ' + (found.message || '')
          const existing = Array.isArray(found.event?.media_list) ? found.event.media_list : []
          const added = []
          for (const file of imagePaths) {
            try {
              const uploaded = await uploadMedia(authed, file, { uid: info.uid })
              added.push({
                upload_file_id: uploaded.upload_file_id,
                url: uploaded.url,
                content_type: uploaded.content_type,
              })
            } catch (error) {
              warnings.push(`图片 ${file} 没上传成功：${error.message}`)
            }
          }
          patch.mediaList = [
            ...existing
              .filter((item) => item && item.upload_file_id && item.url)
              .map((item) => ({
                upload_file_id: String(item.upload_file_id),
                url: String(item.url),
                content_type: String(item.content_type || '').toLowerCase(),
              })),
            ...added,
          ]
        }

        if (dryRun && Object.keys(patch).length === 0 && imagePaths.length) {
          return [
            '（预览，还没写入）这条记录会追加 ' + imagePaths.length + ' 张图片，其它字段不变：',
            ...imagePaths.map((file) => '- ' + file),
            '',
            '确认没问题就再调一次 qingshi_edit，这次 dryRun=false 或不传。',
          ].join('\n')
        }
        const result = await careerApi.updateEvent(eventId, patch, { dryRun })
        if (!result.ok) {
          return '修改失败：' + result.code + ' ' + (result.message || '')
        }
        const lines = []
        if (dryRun) lines.push('（预览，还没写入）这条记录会变成：')
        else lines.push('已修改 event_id ' + eventId + '：')
        for (const key of result.changed) {
          const before = showEditable(result.before, key)
          const after = showEditable(result.after, key)
          lines.push('- ' + FIELD_LABELS_PLUGIN[key] + '：' + before + ' → ' + after)
        }
        if (dryRun) lines.push('', '确认没问题就再调一次 qingshi_edit，这次 dryRun=false 或干脆不传。')
        if (warnings.length) lines.push('', ...warnings.map((text) => '注意：' + text))
        return lines.join('\n')
      },
    }),
  )

  // ---------- qingshi_delete / qingshi_restore ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_delete',
      description:
        '删除「青史」云端的一条生涯记录。后端**没有回收站**，删了就真没了，所以：' +
        '① 先不传 confirm 调一次，插件会返回这条记录的摘要让你核对；② 用户明确说“删”之后，' +
        '再带 confirm=true 调一次才真正删除。删除前插件会把整条记录快照存到本地 workspace/trash/，' +
        '可以用 qingshi_restore 重新写回云端。',
      parameters: {
        eventId: { type: 'string', required: true, description: '要删的事件 id' },
        confirm: {
          type: 'boolean',
          description: '只有用户明确确认删除时才传 true；不传或 false 只做核对预览',
        },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)
        const eventId = String(args?.eventId || '').trim()
        if (!eventId) return '缺少 eventId。'
        const found = await careerApi.getEvent(eventId)
        if (!found.ok) return '读取失败：' + found.code + ' ' + (found.message || '')
        const it = normalizeEvent(found.event)
        const brief = [
          '标题：' + it.title,
          '时间：' + it.startDate + (it.endDate ? ' ～ ' + it.endDate : ''),
          '标签：' + tagLabel(it.eventTag),
          '正文：' + (it.content ? it.content.replace(/\s+/g, ' ').slice(0, 80) : '（空）'),
        ].join('\n')

        if (args?.confirm !== true) {
          return (
            '要删的是这一条（云端没有回收站，删了就真没了）：\n\n' +
            brief +
            '\n\n确认要删的话，让我再调一次 qingshi_delete 并带 confirm=true。'
          )
        }
        const result = await careerApi.deleteEvent(eventId)
        if (!result.ok) return '删除失败：' + result.code + ' ' + (result.message || '') + (result.snapshot ? '\n（本地快照已留在 ' + result.snapshot + '）' : '')
        return (
          '已删除「' + it.title + '」（' + it.startDate + '）。\n' +
          '本地快照：' + result.snapshot + '\n' +
          '想恢复就说一声，我用 qingshi_restore 重新写回云端（会生成新的 event_id）。'
        )
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qingshi_restore',
      description:
        '把 qingshi_delete 存下来的本地快照重新写回青史云端。不传 eventId 时列出所有可恢复的快照（含删除时间与标题）。' +
        '恢复是新建一条记录，会拿到新的 event_id，原 event_id 不会回来。',
      parameters: {
        eventId: { type: 'string', description: '要恢复的事件 id（就是当初删掉的那个）；不传则只列出快照' },
      },
      output: outputSpec,
      async execute(args) {
        const info = await workspace.info()
        const trash = await careerApi.listTrash()
        const target = String(args?.eventId || '').trim()

        if (!target) {
          if (!trash.rows.length) return '本地没有可恢复的快照（' + trash.dir + ' 是空的）。'
          const rows = trash.rows.map((row) => {
            const it = normalizeEvent(row.event)
            return '- ' + it.title + '（' + it.startDate + '）· 删除于 ' + String(row.deletedAt).slice(0, 19).replace('T', ' ') + ' · event_id ' + it.eventId
          })
          return '本地可恢复的记录 ' + trash.rows.length + ' 条：\n\n' + rows.join('\n') + '\n\n要恢复哪条就把它的 event_id 传给我。'
        }

        if (!info.loggedIn) return '尚未登录青史，请先调用 qingshi_login。'
        const row = trash.rows.find((item) => String(item.event?.event_id || '') === target)
        if (!row) return '本地没找到 event_id ' + target + ' 的快照。'
        const it = normalizeEvent(row.event)
        const payload = {
          of_type: 'user',
          of_id: info.uid,
          title: it.title,
          content: it.content,
          start_date: it.startDate || todayText(),
          end_date: it.endDate,
          is_Stage: it.isStage,
          event_tag: canonicalTag(it.eventTag),
          location: {
            name: it.locationName,
            address: it.locationAddress,
            latitude: Number(row.event?.location?.latitude) || 0,
            longitude: Number(row.event?.location?.longitude) || 0,
          },
        }
        const created = await authed('/add_event', payload)
        if (created.code !== 200) return '恢复失败：' + created.code + ' ' + (created.message || '')
        const newId = created.event_id || created.data?.event_id || ''
        await careerApi.dropTrashFile(row.file)
        return '已恢复「' + it.title + '」，新的 event_id 是 ' + newId + '（旧快照已从本地清掉）。'
      },
    }),
  )

  // ---------- qingshi_family ----------
  // 族谱在 H5 里是「点节点弹出浮动菜单再展开」，脚本点不稳；这里直接走
  // /family_tree/get_family_data 一层层取真实关系。
  // 族谱节点本身只有 uid + 称呼，昵称/生日要去 /get_userinfo 补（带 24h 缓存）。
  async function withProfiles(nodes) {
    const list = Array.isArray(nodes) ? nodes.filter((node) => node && typeof node === 'object') : []
    const out = []
    for (const node of list) {
      const uid = String(pick(node, 'uid', 'user_id') || '').trim()
      let profile = {}
      if (uid) {
        try {
          profile = (await users.get(uid)) || {}
        } catch (error) {
          logger('查用户资料失败 ' + uid + '：' + error.message)
        }
      }
      out.push({ ...node, profile })
    }
    return out
  }

  function familyNodeText(node, overrideAppellation) {
    if (!node || typeof node !== 'object') return ''
    const profile = node.profile && typeof node.profile === 'object' ? node.profile : {}
    const appellation = String(overrideAppellation || pick(node, 'appellation') || '').trim()
    const name = String(profile.nickname || pick(node, 'nickname', 'username', 'name') || '').trim()
    const birthday = String(profile.birthday || pick(node, 'birthday', 'birth_date') || '').trim()
    const genderRaw = profile.gender ?? node.gender
    const gender = genderRaw === 1 || genderRaw === '1' ? '男' : genderRaw === 2 || genderRaw === '2' ? '女' : ''
    const uid = String(pick(node, 'uid', 'user_id') || '').trim()
    const head = appellation && appellation !== '我' ? appellation + '：' : ''
    const parts = [head + (name || '(未录入名字)')]
    if (gender) parts.push(gender)
    if (birthday) parts.push(birthday)
    const age = ageText(birthday, profile.deathday)
    if (age) parts.push(age)
    if (!name && uid) parts.push('uid ' + uid)
    return parts.join(' · ')
  }

  // 同辈：称呼放在括号里（族谱里 API 给的称呼是相对父母的，直接当前缀会读成「弟弟：二妹王君」）
  function siblingNodeText(node) {
    if (!node || typeof node !== 'object') return ''
    const profile = node.profile && typeof node.profile === 'object' ? node.profile : {}
    const name = String(profile.nickname || pick(node, 'nickname', 'username', 'name') || '').trim() || '(未录入名字)'
    const kinship = String(pick(node, 'appellation') || '').trim()
    const birthday = String(profile.birthday || '').trim()
    const g = profile.gender ?? node.gender
    const gender = g === 1 || g === '1' ? '男' : g === 2 || g === '2' ? '女' : ''
    const parts = [name + (kinship && kinship !== '我' ? '（' + kinship + '）' : '')]
    if (gender) parts.push(gender)
    if (birthday) parts.push(birthday)
    const age = ageText(birthday, profile.deathday)
    if (age) parts.push(age)
    return parts.join(' · ')
  }

  // 往上第几代该怎么称呼：level 是距离（1=父母），side 是父系/母系
  function upGeneration(level, side) {
    const maternal = side === 'mother'
    if (level === 1) return { title: '父母', man: '父亲', woman: '母亲' }
    if (level === 2) {
      return maternal
        ? { title: '外公外婆', man: '外公', woman: '外婆' }
        : { title: '爷爷奶奶', man: '爷爷', woman: '奶奶' }
    }
    if (level === 3) {
      return maternal
        ? { title: '外曾祖辈', man: '外曾祖父', woman: '外曾祖母' }
        : { title: '曾祖辈', man: '曾祖父', woman: '曾祖母' }
    }
    return maternal
      ? { title: '外高祖辈', man: '外高祖父', woman: '外高祖母' }
      : { title: '高祖辈', man: '高祖父', woman: '高祖母' }
  }

  const familyNodesOf = (layer) => {
    const list = []
    if (layer?.man) list.push({ key: 'man', node: layer.man })
    if (layer?.woman) list.push({ key: 'woman', node: layer.woman })
    return list
  }

  // ---------- 称谓 → 关系链 ----------
  // 中文亲戚称呼本质是「从自己出发走几步」：
  //   up   往上取父母（gender 1=父系/男，2=母系/女）
  //   sib  同辈兄弟姐妹（先取父母层，再排除自己）
  //   down 取子女
  // 表侄 = 妈妈 → 兄弟姐妹 → 他们的孩子 → 再下一代的孩子
  const KIN_TERMS = {
    父亲: [{ op: 'up', gender: 1 }],
    爸爸: [{ op: 'up', gender: 1 }],
    母亲: [{ op: 'up', gender: 2 }],
    妈妈: [{ op: 'up', gender: 2 }],
    爷爷: [{ op: 'up', gender: 1 }, { op: 'up', gender: 1 }],
    奶奶: [{ op: 'up', gender: 1 }, { op: 'up', gender: 2 }],
    外公: [{ op: 'up', gender: 2 }, { op: 'up', gender: 1 }],
    外婆: [{ op: 'up', gender: 2 }, { op: 'up', gender: 2 }],
    姥姥: [{ op: 'up', gender: 2 }, { op: 'up', gender: 2 }],
    曾祖父: [{ op: 'up', gender: 1 }, { op: 'up', gender: 1 }, { op: 'up', gender: 1 }],
    曾祖母: [{ op: 'up', gender: 1 }, { op: 'up', gender: 1 }, { op: 'up', gender: 2 }],
    哥哥: [{ op: 'sib', gender: 1, older: true }],
    弟弟: [{ op: 'sib', gender: 1, older: false }],
    姐姐: [{ op: 'sib', gender: 2, older: true }],
    妹妹: [{ op: 'sib', gender: 2, older: false }],
    儿子: [{ op: 'down', gender: 1 }],
    女儿: [{ op: 'down', gender: 2 }],
    孙子: [{ op: 'down', gender: 1 }, { op: 'down', gender: 1 }],
    孙女: [{ op: 'down', gender: 1 }, { op: 'down', gender: 2 }],
    外孙: [{ op: 'down', gender: 2 }, { op: 'down', gender: 1 }],
    外孙女: [{ op: 'down', gender: 2 }, { op: 'down', gender: 2 }],
    侄子: [{ op: 'sib', gender: 1 }, { op: 'down', gender: 1 }],
    侄女: [{ op: 'sib', gender: 1 }, { op: 'down', gender: 2 }],
    外甥: [{ op: 'sib', gender: 2 }, { op: 'down', gender: 1 }],
    外甥女: [{ op: 'sib', gender: 2 }, { op: 'down', gender: 2 }],
    舅舅: [{ op: 'up', gender: 2 }, { op: 'sib', gender: 1 }],
    舅父: [{ op: 'up', gender: 2 }, { op: 'sib', gender: 1 }],
    姨妈: [{ op: 'up', gender: 2 }, { op: 'sib', gender: 2 }],
    姨: [{ op: 'up', gender: 2 }, { op: 'sib', gender: 2 }],
    姑姑: [{ op: 'up', gender: 1 }, { op: 'sib', gender: 2 }],
    姑妈: [{ op: 'up', gender: 1 }, { op: 'sib', gender: 2 }],
    叔叔: [{ op: 'up', gender: 1 }, { op: 'sib', gender: 1 }],
    伯伯: [{ op: 'up', gender: 1 }, { op: 'sib', gender: 1 }],
    堂哥: [{ op: 'up', gender: 1 }, { op: 'sib', gender: 1 }, { op: 'down', gender: 1 }],
    堂弟: [{ op: 'up', gender: 1 }, { op: 'sib', gender: 1 }, { op: 'down', gender: 1 }],
    堂姐: [{ op: 'up', gender: 1 }, { op: 'sib', gender: 1 }, { op: 'down', gender: 2 }],
    堂妹: [{ op: 'up', gender: 1 }, { op: 'sib', gender: 1 }, { op: 'down', gender: 2 }],
    表哥: [{ op: 'up', gender: 2 }, { op: 'sib' }, { op: 'down', gender: 1 }],
    表弟: [{ op: 'up', gender: 2 }, { op: 'sib' }, { op: 'down', gender: 1 }],
    表姐: [{ op: 'up', gender: 2 }, { op: 'sib' }, { op: 'down', gender: 2 }],
    表妹: [{ op: 'up', gender: 2 }, { op: 'sib' }, { op: 'down', gender: 2 }],
    表侄: [{ op: 'up', gender: 2 }, { op: 'sib' }, { op: 'down' }, { op: 'down', gender: 1 }],
    表侄子: [{ op: 'up', gender: 2 }, { op: 'sib' }, { op: 'down' }, { op: 'down', gender: 1 }],
    表侄女: [{ op: 'up', gender: 2 }, { op: 'sib' }, { op: 'down' }, { op: 'down', gender: 2 }],
    堂侄: [{ op: 'up', gender: 1 }, { op: 'sib', gender: 1 }, { op: 'down' }, { op: 'down', gender: 1 }],
    堂侄女: [{ op: 'up', gender: 1 }, { op: 'sib', gender: 1 }, { op: 'down' }, { op: 'down', gender: 2 }],
  }

  const KIN_ALIASES = {
    爸爸: '父亲', 妈妈: '母亲', 爹: '父亲', 娘: '母亲', 老爷子: '父亲',
    爷爷: '爷爷', 外公: '外公', 姥姥: '外婆',
    表哥: '表哥', 表兄: '表哥', 表姐: '表姐', 表姊: '表姐',
    表侄儿: '表侄子', 侄儿: '侄子', 外甥儿: '外甥',
    姑姑: '姑姑', 姑: '姑姑', 舅舅: '舅舅', 姨: '姨妈', 叔叔: '叔叔', 小叔: '叔叔',
  }

  const KIN_STEP_TEXT = {
    'up-1': '父亲', 'up-2': '母亲',
    sib: '兄弟姐妹', 'sib-1': '兄弟', 'sib-2': '姐妹',
    down: '子女', 'down-1': '儿子', 'down-2': '女儿',
  }

  function kinStepText(step) {
    if (step.op === 'up') return step.gender === 1 ? '父亲' : '母亲'
    if (step.op === 'sib') {
      const base = step.gender === 1 ? '兄弟' : step.gender === 2 ? '姐妹' : '兄弟姐妹'
      return step.older === true ? base + '（年长）' : step.older === false ? base + '（年幼）' : base
    }
    return step.gender === 1 ? '儿子' : step.gender === 2 ? '女儿' : '子女'
  }

  function normalizeKinTerm(raw) {
    const text = String(raw || '').trim().replace(/[的\s]/g, '')
    if (!text) return ''
    const key = KIN_ALIASES[text] || text
    return KIN_TERMS[key] ? key : ''
  }

  async function layerOf(uid, type) {
    const result = await careerApi.familyLayer({ uid, type, displaySiblings: true })
    if (!result.ok) return { ok: false, message: result.message, layer: null }
    return { ok: true, layer: result.layer || {} }
  }

  function childNodesOf(layer) {
    return Array.isArray(layer?.childs) ? layer.childs : []
  }

  // 族谱节点大多只有 uid + 称呼，gender 常常是空的；
  // 按称谓筛人（舅舅=男、姨妈=女）必须先把性别补齐，否则会误判成「这一层没有兄弟」。
  async function genderOf(node) {
    const direct = Number(node?.gender)
    if (direct === 1 || direct === 2) return direct
    try {
      const profile = await users.get(String(node?.uid || ''))
      const g = Number(profile?.gender)
      if (g === 1 || g === 2) return g
    } catch (error) {
      logger('补性别失败：' + error.message)
    }
    return 0
  }

  // 走一步：输入一批人，输出走到的人 + 这一步是否断了
  async function walkKinStep(people, step) {
    const next = []
    const broken = []
    for (const person of people) {
      if (step.op === 'up') {
        const got = await layerOf(person.uid, 'parent')
        if (!got.ok) {
          broken.push({ person, reason: got.message || '取父母层失败' })
          continue
        }
        const target = step.gender === 1 ? got.layer.man : got.layer.woman
        if (target && target.uid) next.push({ uid: target.uid, node: target })
        else broken.push({ person, reason: '没有录入' + kinStepText(step) })
        continue
      }
      if (step.op === 'sib') {
        const got = await layerOf(person.uid, 'parent')
        if (!got.ok) {
          broken.push({ person, reason: got.message || '取父母层失败' })
          continue
        }
        const same = childNodesOf(got.layer).filter((node) => node && node.uid && node.uid !== person.uid)
        const picked = []
        for (const node of same) {
          if (!step.gender) { picked.push(node); continue }
          const g = await genderOf(node)
          // 性别查不到就别硬筛掉，宁可多列出来让用户自己认
          if (g === 0 || g === step.gender) picked.push(node)
        }
        if (!picked.length) {
          broken.push({
            person,
            reason: same.length
              ? '这一层有 ' + same.length + ' 位，但没有性别对得上「' + kinStepText(step) + '」的人'
              : '这一层没有' + kinStepText(step),
            available: same,
          })
        }
        for (const node of picked) next.push({ uid: node.uid, node })
        continue
      }
      // down
      const got = await layerOf(person.uid, 'child')
      if (!got.ok) {
        broken.push({ person, reason: got.message || '取子女层失败' })
        continue
      }
      const kids = []
      for (const node of childNodesOf(got.layer)) {
        if (!node || !node.uid) continue
        if (!step.gender) { kids.push(node); continue }
        const g = await genderOf(node)
        if (g === 0 || g === step.gender) kids.push(node)
      }
      if (!kids.length) {
        const all = childNodesOf(got.layer).filter((node) => node && node.uid)
        broken.push({
          person,
          reason: all.length
            ? '这一层有 ' + all.length + ' 位，但没有性别对得上「' + kinStepText(step) + '」的人'
            : '这一层没有' + kinStepText(step),
          available: all,
        })
      }
      for (const node of kids) next.push({ uid: node.uid, node })
    }
    return { people: next, broken }
  }

  // 按称谓走完整条链
  async function resolveKin(startUid, steps) {
    let people = [{ uid: startUid, node: { uid: startUid } }]
    const trail = []
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i]
      const walked = await walkKinStep(people, step)
      trail.push({
        step,
        peopleBefore: people,
        peopleAfter: walked.people,
        from: people.length,
        got: walked.people.length,
        broken: walked.broken,
      })
      if (!walked.people.length) {
        return { ok: false, stopAt: i, trail, people: [] }
      }
      people = walked.people
    }
    return { ok: true, stopAt: -1, trail, people }
  }

  ctx.tools.register(
    defineTool({
      name: 'qingshi_manageable_users',
      description:
        '【我可以管理哪些人】返回当前登录用户**可以管理的全部用户**列表（包含正式账号和虚拟/临时用户），每个人带 uid、名字、性别、生日。' +
        '当你需要帮**别人**录入生涯时（用户说"归我爸""给我妈存""帮我老板整理"），用这个工具拿到可管理的候选名单，' +
        '按用户说的名字模糊匹配，确认后把匹配到的 uid 传给 photo_save/record/draft 等工具的 targetUid 参数。' +
        '注意：这和 qingshi_family（族谱树往上3代往下3代）完全不同——族谱是血缘关系，这个是"我有权管理的人"。',
      parameters: {
        keyword: {
          type: 'string',
          description: '可选，按名字过滤；不填返回全部',
        },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)
        const keyword = String(args?.keyword || '').trim()
        const listRes = await authed('/get_manageable_tmp_user_list', {})
        if (listRes.code !== 200) return `查询失败：${listRes.code} ${listRes.message || ''}`
        // 后端已返回完整用户对象（uid/nickname/gender/birthday/avatar/label 等），无需二次请求
        const list = (listRes.data && listRes.data.list) || []
        if (!Array.isArray(list) || !list.length) {
          return '你目前没有可管理的其他用户，只能归到自己名下。'
        }
        const lines = [`你可以管理的用户共 ${list.length} 人：`]
        const results = []
        for (const item of list) {
          if (!item || !item.uid) continue
          const uid = String(item.uid)
          const name = item.nickname || item.username || '未命名'
          if (!name) continue
          const gender = item.gender === 1 ? '男' : item.gender === 2 ? '女' : ''
          const birthday = String(item.birthday || '').slice(0, 10)
          const bit = `${name}（uid: ${uid}${gender ? ' · ' + gender : ''}${birthday ? ' · ' + birthday : ''}）`
          if (!keyword || name.includes(keyword)) {
            results.push({ uid, name })
            lines.push(`  · ${bit}`)
          }
        }
        if (keyword && !results.length) {
          lines.push(`（没有名字包含"${keyword}"的；上面是全部可管理用户）`)
        }
        lines.push(
          '',
          results.length
            ? `要归到其中哪位？说名字或直接用 uid。确认后把 targetUid 传给后续工具。`
            : '上面全部可管理用户，请确认归到哪一位。',
        )
        return lines.join(NL)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qingshi_family',
      description:
        '【谁是我家人】用户问「我爸妈是谁」「我爷爷叫什么」「我家几代人」「我家有谁」，调这个。直接读「青史」族谱的真实关系数据（不走页面点击）。默认从用户自己往上取 3 代，' +
        '也可以选择往下取子女，或上下都取。用户说“帮我看看族谱”“我家几代人”“我父母/爷爷奶奶是谁”时用它；' +
        '想看族谱页面本身再配合 qingshi_open_h5 + qingshi_ui_shot。',
      parameters: {
        direction: {
          type: 'string',
          description: 'all=上下都取（默认）；up=只往祖辈取；down=只往子女取',
        },
        depth: { type: 'integer', description: '往上/往下最多取几代，默认 3，最大 4' },
        displaySiblings: { type: 'boolean', description: '是否带上同一层的兄弟姐妹（默认 true）' },
        targetUid: { type: 'string', description: '看谁的族谱；不填就是用户自己' },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)
        const startUid = String(args?.targetUid || info.uid || '').trim()
        if (!startUid) return '拿不到 uid，先调用 qingshi_me 看看登录状态。'
        const rawDirection = String(args?.direction || 'all').toLowerCase()
        const direction = ['all', 'up', 'down'].includes(rawDirection) ? rawDirection : 'all'
        const depth = Math.min(Math.max(Number(args?.depth) || 3, 1), 4)
        const displaySiblings = args?.displaySiblings !== false

        const lines = []
        const seen = new Set()

        // 第一行永远是本人：问「我多少岁」时不至于只列出父母
        try {
          const me = await users.get(startUid)
          const meBirthday = String(me?.birthday || '').slice(0, 10)
          const meAge = ageText(meBirthday, me?.deathday)
          const g = me?.gender
          const gender = g === 1 || g === '1' ? '男' : g === 2 || g === '2' ? '女' : ''
          const bits = [String(me?.nickname || me?.username || '本人')]
          if (gender) bits.push(gender)
          if (meBirthday) bits.push(meBirthday)
          if (meAge) bits.push(meAge)
          lines.push('本人：' + bits.join(' · '))
        } catch (error) {
          logger('查本人资料失败：' + error.message)
        }

        if (direction === 'all' || direction === 'up') {
          let currentUid = startUid
          let side = ''
          for (let level = 1; level <= depth; level += 1) {
            const layer = await careerApi.familyLayer({ uid: currentUid, type: 'parent', displaySiblings })
            if (!layer.ok) {
              if (level === 1) lines.push('（往上一代：' + layer.message + '）')
              break
            }
            const gen = upGeneration(level, side)
            const parents = (await withProfiles(familyNodesOf(layer.layer).map((item) => item.node))).map((node, i) => ({
              node,
              key: i === 0 ? 'man' : 'woman',
            }))
            if (!parents.length) {
              if (level === 1) lines.push('本人这一层之上没有录入父母。')
              break
            }
            const title = '第 ' + level + ' 代（' + gen.title + '）'
            const rows = parents
              .map((item) => familyNodeText(item.node, item.key === 'man' ? gen.man : gen.woman))
              .filter(Boolean)
            const childs = Array.isArray(layer.layer?.childs) ? layer.layer.childs : []
            const siblingNodes = await withProfiles(
              childs.filter((node) => {
                const itemUid = String(pick(node, 'uid', 'user_id') || '').trim()
                return itemUid && itemUid !== currentUid && itemUid !== startUid
              }),
            )
            const siblings = siblingNodes.map((node) => ({ node }))
            const siblingText = displaySiblings && siblings.length
              ? '\n  同辈：' + siblings.map((item) => siblingNodeText(item.node)).filter(Boolean).join('；')
              : ''
            lines.push(title + '：' + rows.join('；') + siblingText)
            for (const item of parents) seen.add(String(pick(item.node, 'uid', 'user_id') || ''))
            const nextUid = String(pick(parents[0].node, 'uid', 'user_id') || '').trim()
            if (!nextUid || seen.has('up:' + nextUid)) break
            seen.add('up:' + nextUid)
            currentUid = nextUid
            if (level === 1) side = parents[0].key === 'man' ? 'father' : 'mother'
          }
        }

        if (direction === 'all' || direction === 'down') {
          const queue = [{ uid: startUid, level: 1 }]
          let printed = false
          while (queue.length) {
            const { uid, level } = queue.shift()
            if (level > depth) break
            const layer = await careerApi.familyLayer({ uid, type: 'child', displaySiblings })
            if (!layer.ok) {
              lines.push('（往下' + level + ' 代：' + layer.message + '）')
              break
            }
            const childs = Array.isArray(layer.layer?.childs) ? layer.layer.childs : []
            if (!childs.length) {
              if (!printed && level === 1) lines.push('名下没有录入子女。')
              break
            }
            printed = true
            const childNodes = await withProfiles(childs)
            const rows = childNodes.map((node) => familyNodeText(node)).filter(Boolean)
            lines.push('往下第 ' + level + ' 代（子女）：' + rows.join('；'))
            for (const node of childNodes) {
              const childUid = String(pick(node, 'uid', 'user_id') || '').trim()
              if (childUid) queue.push({ uid: childUid, level: level + 1 })
            }
          }
        }

        const who = startUid === info.uid ? '你的族谱' : '这个人的族谱'
        return who + '：' + NL + NL + lines.join(NL)
      },
    }),
  )

  // ---------- qingshi_kinship ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_kinship',
      description:
        '【用称呼问亲戚】用户说「我表侄子是谁」「我舅舅叫啥」「我有几个堂哥」这类带称呼的问法，调这个；别回「没找到」。按**称谓**查亲属：把「表侄」「堂哥」「舅舅」「外婆」「外甥女」这类称呼拆成关系链，' +
        '（妈妈 → 她的兄弟姐妹 → 他们的孩子 → 再下一代）再沿着真实族谱一层层走，走到哪层断了就说清断在哪' +
        '，而不是直接回“没找到”。用户用称呼问亲戚（“我表侄子是谁”“我舅舅叫啥”“我有几个堂哥”）时用它；' +
        '只想看整棵族谱用 qingshi_family。',
      parameters: {
        term: { type: 'string', required: true, description: '称谓，例如 表侄、堂哥、舅舅、外婆、外甥女、孙子' },
        targetUid: { type: 'string', description: '从谁出发算；不填就是用户自己' },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return needLoginText(info)
        const startUid = String(args?.targetUid || info.uid || '').trim()
        const rawTerm = String(args?.term || '').trim()
        if (!rawTerm) return '要查哪个称呼？比如「表侄」「舅舅」「外婆」。'
        const term = normalizeKinTerm(rawTerm)
        if (!term) {
          const known = Object.keys(KIN_TERMS).slice(0, 24).join('、')
          return (
            '我还认不出「' + rawTerm + '」这个称呼。现在能认的有：' + known + '。' +
            '如果你想查的是整棵族谱，用 qingshi_family。'
          )
        }

        const steps = KIN_TERMS[term]
        const chainText = steps.map((step) => kinStepText(step)).join(' → ')
        const result = await resolveKin(startUid, steps)

        if (result.ok) {
          const people = await withProfiles(result.people.map((item) => item.node).filter((node) => node && node.uid))
          const rows = people
            .map((node) => familyNodeText(node, term))
            .filter(Boolean)
          const unique = Array.from(new Set(rows))
          if (!unique.length) {
            return '按「' + term + '」这条链（' + chainText + '）走到头了，但这几个人还没在族谱里录入名字。'
          }
          return (
            '你说的「' + term + '」是这条链：' + chainText + '。' + NL + NL +
            unique.join(NL) + NL + NL +
            (unique.length > 1 ? '一共 ' + unique.length + ' 位。' : '')
          ).trim()
        }

        // 断了：说清走到哪、那一层有什么
        const stop = result.stopAt
        const stopStep = steps[stop]
        const fromPeople = result.trail[stop].peopleBefore || []
        const broken = result.trail[stop].broken || []
        const fromProfiles = fromPeople.length
          ? await withProfiles(fromPeople.map((item) => item.node).filter((node) => node && node.uid))
          : []
        const fromText = fromProfiles
          .map((node) => familyNodeText(node))
          .filter(Boolean)
          .join('、')

        const reasons = Array.from(new Set(broken.map((item) => item.reason))).filter(Boolean)
        const availableNodes = Array.from(
          new Map(
            broken
              .flatMap((item) => (Array.isArray(item.available) ? item.available : []))
              .filter((node) => node && node.uid)
              .map((node) => [node.uid, node]),
          ).values(),
        )
        const availableText = availableNodes.length
          ? (await withProfiles(availableNodes)).map((node) => familyNodeText(node)).filter(Boolean).join('、')
          : ''
        const firstBrokenPerson = broken[0]?.person?.node
        const who = firstBrokenPerson
          ? (await withProfiles([firstBrokenPerson]).then((list) => familyNodeText(list[0])))
          : ''

        return (
          '你说的「' + term + '」要这样走：' + chainText + '。' + NL +
          '走到「' + kinStepText(stopStep) + '」这一步断了。' +
          (who ? NL + '卡在：' + who : '') +
          (reasons.length ? NL + '原因：' + reasons.join('；') : '') +
          (/性别对得上/.test(reasons.join('；')) ? NL + '（如果其中有人的性别其实不是这样，那多半是族谱里性别录错了，改过来我就能查对）' : '') +
          (availableText ? NL + '这一层的其他人：' + availableText : (fromText ? NL + '这一层目前有：' + fromText : '')) +
          NL + NL +
          '也就是说族谱里还没录到这一层，需要你在青史的族谱页把关系补上（比如先给这位舅舅加上他的孩子），补完再问我就能查到。'
        ).trim()
      },
    }),
  )

  // ---------- qingshi_open_event ----------
  // 用户想「看当时那条记录」时，直接把 H5 的事件详情页打开，比让模型念一遍正文更符合直觉。
  ctx.tools.register(
    defineTool({
      name: 'qingshi_open_event',
      description:
        '在青史窗口里打开某一条生涯记录的详情页（用户在页面上能看到正文、图片、时间、地点）。' +
        '用户说“打开那条记录看看”“我想看当时的照片”“给我看看 2024 年那条”时用它；只想读文字用 qingshi_event。',
      parameters: {
        eventId: { type: 'string', required: true, description: '事件 id，来自 qingshi_find_experience / qingshi_event 的结果' },
      },
      output: outputSpec,
      async execute(args) {
        const eventId = String(args?.eventId || '').trim()
        if (!eventId) return '缺少 eventId。'
        const route = '/pages/career/sub/eventDetail?event_id=' + encodeURIComponent(eventId)
        const { session, error } = await ensureBrowser(route)
        if (error) return '打不开青史窗口：' + error
        const page = await session.readPage({ maxText: 600 })
        const text = String(page.text || '')
        if (/缺少 event_id|事件不存在|加载失败/.test(text)) {
          return '打开详情页失败：' + (text.match(/缺少 event_id|事件不存在|加载失败/)?.[0] || '未知原因')
        }
        return '已在青史窗口打开这条记录的详情页：' + NL + NL + describePage(page, { textLimit: 500 })
      },
    }),
  )

  // ---------- qingshi_prepare_event ----------
  // 用户口述完故事 → 打开「添加生涯事件」页并把内容预填进去，由用户自己点「发布」。
  // eventEdit 页面本来就读 uni 存储里的 aiPreFillData（这是它给 AI 助手留的入口），
  // 所以这里不碰页面 DOM，只往存储里写一份再跳过去。
  ctx.tools.register(
    defineTool({
      name: 'qingshi_prepare_event',
      description:
        '把一段故事**预填**进青史「添加生涯事件」页面，然后打开窗口让用户自己检查、补图片和地点、点「发布」。' +
        '这是把聊天里的故事变成记录、又保留用户最终确认权的方式。' +
        '用户说“记下来吧”“帮我记录这个”并且已经确认要记时用它；纯本地暂存用 qingshi_draft，直接写云端用 qingshi_record。',
      parameters: {
        title: { type: 'string', required: true, description: '标题，最多 30 字' },
        content: { type: 'string', description: '正文，最多 500 字，尽量保留用户自己的说法' },
        startDate: { type: 'string', description: '开始日期 YYYY-MM-DD，不填默认今天' },
        endDate: { type: 'string', description: '结束日期，只有阶段事件才需要' },
        isStage: { type: 'boolean', description: '是否阶段事件（跨一段时间）' },
        eventTag: { type: 'string', description: '事件标签，例如 travel / work / family / record' },
        targetUid: { type: 'string', description: '给谁记；不填就是用户自己' },
      },
      output: outputSpec,
      async execute(args) {
        const info = await workspace.info()
        if (!info.loggedIn) return '尚未登录青史，请先调用 qingshi_open_h5 让用户在窗口里登录。'
        const title = String(args?.title || '').trim().slice(0, 30)
        const content = String(args?.content || '').trim().slice(0, 500)
        if (!title) return '标题不能空。'
        const uid = String(args?.targetUid || info.uid || '').trim()
        const startDate = String(args?.startDate || '').trim() || todayText()
        const prefill = {
          title,
          content: appendAttribution(content, resolveClientLabel(cfg)),
          start_date: startDate,
          end_date: String(args?.endDate || '').trim(),
          is_Stage: Boolean(args?.isStage),
          event_tag: String(args?.eventTag || 'record').trim() || 'record',
          target_uid: uid,
        }
        const query = [
          'uid=' + encodeURIComponent(uid),
          'selectedDate=' + encodeURIComponent(startDate),
          'eventTag=' + encodeURIComponent(prefill.event_tag),
          prefill.end_date ? 'endDate=' + encodeURIComponent(prefill.end_date) : '',
          prefill.is_Stage ? 'isStage=true' : '',
        ].filter(Boolean).join('&')
        const route = '/pages/career/sub/eventEdit?' + query
        const { session, error } = await ensureBrowser(route)
        if (error) return '打不开青史窗口：' + error

        // eventEdit 的 onLoad 里会读 uni 存储的 aiPreFillData 并立刻删除它，
        // 所以顺序必须是：先写存储 → 再进入页面（并带 _t 参数强制新建一次页面实例）。
        // uni-app H5 的 getStorageSync 读的是 {"type":"object","data":{...}} 这个信封，
        // 直接写裸 JSON 会被它当成字符串/解析不出对象，所以这里按它的格式写。
        const wrote = await session.evaluate(`(() => {
          try {
            const payload = ${JSON.stringify(prefill)}
            const envelope = JSON.stringify({ type: 'object', data: payload })
            localStorage.setItem('aiPreFillData', envelope)
            const back = JSON.parse(localStorage.getItem('aiPreFillData') || 'null')
            const title = back && back.data && back.data.title
            return { ok: !!title, title: title || '', via: 'localStorage-envelope' }
          } catch (e) { return { ok: false, reason: String(e && e.message || e) } }
        })()`)
        if (!wrote?.ok) return '预填没写进去：' + (wrote?.reason || '没读到回写的内容')

        // 先回到生涯页再进表单：uni H5 对同一路径的 hash 跳转不会重建页面，
        // 只有先离开再进来，eventEdit 的 onLoad 才会重新执行、才会读到刚写的 aiPreFillData。
        await session.goto(pageUrl(cfg.webBaseUrl, '/pages/career/career'))
        await new Promise((r) => setTimeout(r, 900))
        await session.goto(pageUrl(cfg.webBaseUrl, route + '&_t=' + Date.now()))
        await new Promise((r) => setTimeout(r, 2000))

        // 兜底：uni H5 有时会复用已缓存的页面实例、不吃 aiPreFillData，
        // 这里再直接把标题和正文写进表单（dispatch input，v-model 能收到）。
        let typed = false
        try {
          await session.type({ placeholder: '给这段经历起一个名字', value: title })
          if (content) await session.type({ placeholder: '记录这段经历的故事、片段与意义', value: content })
          typed = true
        } catch (error) {
          logger('直接写表单失败：' + error.message)
        }

        const page = await session.readPage({ maxText: 900 })
        const text = String(page.text || '')
        const filled = text.includes(title.slice(0, 8)) || typed

        return [
          '已打开「添加生涯事件」页面并预填内容：',
          '· 标题：' + title,
          '· 内容：' + (content ? content.slice(0, 40) + (content.length > 40 ? '…' : '') : '（空）'),
          '· 时间：' + startDate + (prefill.end_date ? ' ～ ' + prefill.end_date : '') + (prefill.is_Stage ? '（阶段事件）' : ''),
          '· 标签：' + prefill.event_tag,
          '',
          filled
            ? '页面里已经能看到这段内容了，请你补图片和地点，确认无误后自己点「发布」。'
            : '页面已打开，但没在页面文字里读到标题（可能还没渲染完）。请看一眼表单，内容不对就用「青灵润色」旁边的输入框改，确认后自己点「发布」。',
          '注意：发布之后才算永久保存，插件不会替你点。',
        ].join(NL)
      },
    }),
  )

  // ---------- 族谱排版：每个小家庭成一块 ----------
  // 卡片尺寸与页面常量一致（pages/familytree/constants.js 的 TREE_CARD_SIZE）
  const CARD_W = 90
  const CARD_H = 160
  const FAMILY_GAP_X = 32
  const FAMILY_LEVEL_GAP = 180
  const FAMILY_BLOCK_GAP = 96

  /**
   * 把卡片按「小家庭」重排：
   *   - 同一对父母的子女算一个块，横向排开；
   *   - 父母居中放在子女整块的上方；
   *   - 不同的小家庭之间留出更大的间距，不再是一整条横排。
   * 只改 x / y，不动任何关系字段。
   */
  function layoutFamilyCards(cards, options = {}) {
    const gapX = Number(options.gapX) || FAMILY_GAP_X
    const levelGap = Number(options.levelGap) || FAMILY_LEVEL_GAP
    const blockGap = Number(options.blockGap) || FAMILY_BLOCK_GAP
    const list = Array.isArray(cards) ? cards.filter((c) => c && c.uid) : []
    if (!list.length) return { cards: [], bounds: null, count: 0 }

    const index = new Map(list.map((c) => [String(c.uid), c]))
    // 展开方向决定这一层是往上还是往下：父家庭 → -1，子家庭 → +1，其余同层
    const deltaOf = (card) => {
      const dir = String(card.lastExpandDirection || 'root')
      if (dir === 'parent') return -1
      if (dir === 'child') return 1
      return 0
    }
    const sourcesOf = (card) =>
      (Array.isArray(card.parentCardExpandUidList) ? card.parentCardExpandUidList : [])
        .map((u) => String(u))
        .filter((u) => index.has(u) && u !== String(card.uid))

    // 层号：从根出发 BFS，按展开方向累加
    const level = new Map()
    const owner = new Map()
    const roots = list.filter((c) => !sourcesOf(c).length)
    const rootList = roots.length ? roots : [list[0]]
    const queue = []
    rootList.forEach((r) => {
      level.set(String(r.uid), 0)
      queue.push(r)
    })
    while (queue.length) {
      const card = queue.shift()
      const base = level.get(String(card.uid)) || 0
      list.forEach((other) => {
        const ou = String(other.uid)
        if (level.has(ou)) return
        if (!sourcesOf(other).includes(String(card.uid))) return
        level.set(ou, base + deltaOf(other))
        if (!owner.has(ou)) owner.set(ou, String(card.uid))
        queue.push(other)
      })
    }
    list.forEach((c) => {
      const cu = String(c.uid)
      if (!level.has(cu)) level.set(cu, 0)
      if (!owner.has(cu)) owner.set(cu, '')
    })

    // 真正挂在这个人下面的「下一代」：来源里有它、且层号比它大 1
    const kidsOf = (card) => {
      const cu = String(card.uid)
      const myLevel = level.get(cu)
      return list.filter((other) => {
        const ou = String(other.uid)
        if (ou === cu) return false
        if (owner.get(ou) !== cu) return false
        return level.get(ou) === myLevel + 1
      })
    }

    const widthMemo = new Map()
    const widthOf = (card) => {
      const key = String(card.uid)
      if (widthMemo.has(key)) return widthMemo.get(key)
      widthMemo.set(key, CARD_W)
      const kids = kidsOf(card)
      let width = CARD_W
      if (kids.length) {
        const sum = kids.reduce((acc, kid) => acc + widthOf(kid), 0) + gapX * (kids.length - 1)
        width = Math.max(CARD_W, sum)
      }
      widthMemo.set(key, width)
      return width
    }

    const placed = new Map()
    const visited = new Set()
    const place = (card, left) => {
      const key = String(card.uid)
      if (visited.has(key)) return
      visited.add(key)
      const width = widthOf(card)
      placed.set(key, { x: Math.round(left + (width - CARD_W) / 2), y: level.get(key) * levelGap })
      const kids = kidsOf(card)
      let cursor = left
      kids.forEach((kid, i) => {
        place(kid, cursor)
        const selfBlock = kidsOf(kid).length > 0
        cursor += widthOf(kid) + (i < kids.length - 1 ? (selfBlock ? blockGap : gapX) : 0)
      })
    }

    const primary = rootList[0]
    place(primary, 0)
    const primaryX = placed.get(String(primary.uid))?.x ?? 0
    const primaryLevel = level.get(String(primary.uid)) || 0
    let cursor = widthOf(primary) + blockGap
    rootList.slice(1).forEach((root, i) => {
      if (!kidsOf(root).length) {
        // 没有下一代的独立卡片（多半是配偶）：挨着主根，别甩到画布另一头
        placed.set(String(root.uid), { x: primaryX + (i + 1) * (CARD_W + gapX), y: primaryLevel * levelGap })
        visited.add(String(root.uid))
        return
      }
      place(root, cursor)
      cursor += widthOf(root) + blockGap
    })

    // 同层但没被连上的（例如兄弟姐妹），按来源顺序排在主根左右两侧的同一层
    const orphans = list.filter((c) => !placed.has(String(c.uid)))
    const laneCursor = new Map()
    orphans.forEach((card) => {
      const cu = String(card.uid)
      const lv = level.get(cu) || 0
      const used = laneCursor.get(lv) || 0
      placed.set(cu, { x: Math.round(primaryX + (CARD_W + gapX) * (used + 2)), y: lv * levelGap })
      laneCursor.set(lv, used + 1)
    })

    // 把整棵树平移到画布左上角附近（负坐标会被画布裁掉）
    const xs = list.map((c) => placed.get(String(c.uid))?.x ?? 0)
    const ys = list.map((c) => placed.get(String(c.uid))?.y ?? 0)
    const shiftX = Math.min(...xs)
    const shiftY = Math.min(...ys)
    const nextCards = list.map((card) => {
      const pos = placed.get(String(card.uid))
      if (!pos) return card
      return { ...card, x: pos.x - shiftX, y: pos.y - shiftY }
    })

    const nx = nextCards.map((c) => Number(c.x) || 0)
    const ny = nextCards.map((c) => Number(c.y) || 0)
    return {
      cards: nextCards,
      count: nextCards.length,
      bounds: {
        minX: Math.min(...nx),
        maxX: Math.max(...nx) + CARD_W,
        minY: Math.min(...ny),
        maxY: Math.max(...ny) + CARD_H,
      },
    }
  }

  // ---------- qingshi_family_expand ----------
  // 族谱是无限画布：正确的展开方式是「点某个人 → 点『展开父家庭』/『显示兄弟姐妹』/『展开子家庭』」，
  // 绝不能改根节点、也不能靠“换个 uid 重新打开族谱”来换视角。
  const FAMILY_ACTIONS = ['展开父家庭', '展开子家庭']
  const FAMILY_NOISE = /展开|收缩|切换|显示|查看|修改|隐私|AI|邀请|添加|快捷键|缩放|重置|主题|日历|按月|按年|返回|搜索|设置|删除|编辑/

  ctx.tools.register(
    defineTool({
      name: 'qingshi_family_expand',
      description:
        '在族谱页把关系一级级「点开」（点某位家人 → 展开父家庭 / 展开子家庭 / 显示兄弟姐妹），' +
        '用来回答“展开父亲这一支”“看看母亲那边”“把能展开的都展开”。' +
        '它只点卡片上的菜单，不会修改任何关系、不会换根节点。要看数据本身请用 qingshi_family / qingshi_kinship。',
      parameters: {
        displaySiblings: { type: 'boolean', description: '展开时是否同时显示兄弟姐妹（默认 true）' },
        rounds: { type: 'number', description: '最多展开几轮（默认 3，每轮会点开一层新出现的卡片）' },
        verbose: { type: 'boolean', description: '要不要把每一步动作列出来（默认 false，只回一行）' },
      },
      output: outputSpec,
      async execute(args) {
        const rounds = Math.max(1, Math.min(6, Number(args?.rounds) || 3))
        const displaySiblings = args?.displaySiblings !== false

        const opened = await ensureBrowser('/pages/familytree/familytree')
        if (opened.error) return opened.error
        const session = opened.session

        const tried = new Set()
        let expanded = 0
        const details = []

        for (let round = 0; round < rounds; round += 1) {
          const page = await session.readPage({ maxText: 1200 }).catch(() => ({ buttons: [] }))
          const names = (page.buttons || [])
            .map((b) => String(b.text || '').trim())
            .filter((t) => t && t.length <= 10 && !FAMILY_NOISE.test(t))
          const fresh = names.filter((n) => !tried.has(n))
          if (!fresh.length) break

          for (const name of fresh.slice(0, 8)) {
            tried.add(name)
            const clicked = await session.click({ text: name }).catch(() => null)
            if (!clicked?.ok) continue
            await new Promise((r) => setTimeout(r, 350))

            if (displaySiblings) {
              const sib = await session.click({ text: '显示兄弟姐妹' }).catch(() => null)
              if (sib?.ok) {
                details.push(name + '：开了兄弟姐妹')
                await new Promise((r) => setTimeout(r, 350))
              }
            }

            for (const action of FAMILY_ACTIONS) {
              const done = await session.click({ text: action }).catch(() => null)
              if (done?.ok) {
                expanded += 1
                details.push(name + '：' + action)
                await new Promise((r) => setTimeout(r, 700))
              }
            }
          }
        }

        await saveStorageSnapshot(session)
        const shot = await session.screenshot(join(cfg.workspaceDir, 'shots', 'family-expand.png')).catch(() => '')
        // 输出刻意压到一行：这些话会进对话上下文，展开一次几百字等于白烧钱。
        const head =
          expanded > 0
            ? '已经在族谱页点开 ' + expanded + ' 次关系（没改任何关系、没换根节点）。'
            : '没找到可点的展开菜单：可能已经全展开了，或者要改用 qingshi_ui_tap 按坐标点。'
        if (args?.verbose) {
          const lines = [head]
          if (details.length) lines.push('动作：' + details.slice(0, 20).join('；'))
          if (shot) lines.push('截图：' + shot)
          return lines.join(NL)
        }
        return head
      },
    }),
  )

  // ---------- qingshi_family_layout ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_family_layout',
      description:
        '把族谱页上的卡片按「小家庭」重新摆位置：同一对父母的孩子排成一组，父母居中放在这组孩子的上方，' +
        '不同小家庭之间留更大间距，一代一行。只改卡片的 x/y 位置，不碰任何关系数据。' +
        '用户说“排整齐一点”“按小家庭分块”“别都挤成一条横排”时用它。',
      parameters: {
        gapX: { type: 'number', description: '同一家兄弟姐妹之间的间距，默认 32' },
        levelGap: { type: 'number', description: '上下两代之间的行距，默认 180' },
        blockGap: { type: 'number', description: '两个小家庭之间的间距，默认 96' },
        fit: { type: 'boolean', description: '排完把视图缩放到能看全（默认 true）' },
      },
      output: outputSpec,
      async execute(args) {
        const opened = await ensureBrowser('/pages/familytree/familytree')
        if (opened.error) return opened.error
        const session = opened.session

        const found = await session
          .evaluate(
            "(() => { const k = Object.keys(localStorage).find((x) => x.includes('family-tree-card-list')); " +
              'if (!k) return null; return { key: k, payload: JSON.parse(localStorage.getItem(k)) } })()',
          )
          .catch(() => null)
        if (!found || !found.key) {
          return '还没读到族谱卡片：先在页面上点开你的卡片（展开父家庭 / 子家庭），再让我排版。'
        }
        const payload = found.payload
        const cards = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
        if (cards.length < 2) {
          return '页面上只有 ' + cards.length + ' 张卡片，先展开几个人再排版才有意义（可以先用 qingshi_family_expand）。'
        }

        const result = layoutFamilyCards(cards, {
          gapX: Number(args?.gapX) || undefined,
          levelGap: Number(args?.levelGap) || undefined,
          blockGap: Number(args?.blockGap) || undefined,
        })
        const envelope =
          payload && typeof payload === 'object' && !Array.isArray(payload) && 'data' in payload
            ? { ...payload, data: result.cards }
            : result.cards

        const writeExpr =
          '(() => { localStorage.setItem(' +
          JSON.stringify(found.key) +
          ', ' +
          JSON.stringify(JSON.stringify(envelope)) +
          '); return true })()'
        await session.evaluate(writeExpr)

        let fitNote = ''
        if (args?.fit !== false && result.bounds) {
          const size = await session
            .evaluate('({ w: window.innerWidth, h: window.innerHeight })')
            .catch(() => null)
          if (size?.w && size?.h) {
            const pad = 80
            const treeW = Math.max(1, result.bounds.maxX - result.bounds.minX)
            const treeH = Math.max(1, result.bounds.maxY - result.bounds.minY)
            const rawScale = Math.min((size.w - pad * 2) / treeW, (size.h - pad * 2) / treeH)
            const scale = Math.max(0.3, Math.min(1, Number(rawScale.toFixed(2)) || 1))
            const offsetX = Math.round((size.w - treeW * scale) / 2 - result.bounds.minX * scale)
            const offsetY = Math.round((size.h - treeH * scale) / 2 - result.bounds.minY * scale)
            const stateExpr =
              "(() => { const k = Object.keys(localStorage).find((x) => x.includes('family-tree-state')); " +
              'if (!k) return false; const raw = JSON.parse(localStorage.getItem(k)); ' +
              'const body = raw && raw.data ? raw.data : raw; ' +
              'const next = Object.assign({}, body, { offsetX: ' +
              offsetX +
              ', offsetY: ' +
              offsetY +
              ', scale: ' +
              scale +
              ' }); ' +
              'localStorage.setItem(k, JSON.stringify(raw && raw.data ? Object.assign({}, raw, { data: next }) : next)); ' +
              'return true })()'
            const ok = await session.evaluate(stateExpr).catch(() => false)
            if (ok) fitNote = '，缩放调到 ' + scale + ' 好让整棵树都在视野里'
          }
        }

        await session.goto(pageUrl(cfg.webBaseUrl, '/pages/familytree/familytree')).catch(() => {})
        await new Promise((r) => setTimeout(r, 2200))
        await saveStorageSnapshot(session)

        // 复核：重载后坐标是否真的保住了
        const after = await session
          .evaluate(
            "(() => { const k = Object.keys(localStorage).find((x) => x.includes('family-tree-card-list')); " +
              'if (!k) return -1; const raw = JSON.parse(localStorage.getItem(k)); ' +
              'const items = raw && raw.data ? raw.data : raw; ' +
              'return Array.isArray(items) ? items.filter((c) => Number(c.y) >= 0).length : -1 })()',
          )
          .catch(() => -1)

        const rows = result.bounds ? Math.round((result.bounds.maxY - result.bounds.minY) / (Number(args?.levelGap) || 180)) : 0
        return (
          '已按小家庭重新摆好 ' +
          result.count +
          ' 张卡片，分 ' +
          rows +
          ' 代' +
          fitNote +
          '（只改了位置，关系没动）。' +
          (after >= 0 ? '' : '页面重载后没读到卡片，可能刚才那一下没保存住，再说一声我重排一次。')
        )
      },
    }),
  )

  // ---------- qingshi_logout ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_logout',
      description: '清除本地工作区里的青史登录凭证。用户要求退出青史账号时使用。',
      parameters: {},
      output: outputSpec,
      async execute() {
        await workspace.clear()
        // 窗口里的 localStorage 也得一起清，否则下次打开会把它又同步回来
        try {
          const session = (await liveBrowser()) || (await attachExistingWindow())
          if (session) {
            await session.evaluate(
              "(() => { ['access_token','refresh_token','my_uid'].forEach((k) => localStorage.removeItem(k)); return true })()",
            )
            await session.goto(pageUrl(cfg.webBaseUrl, '/pages/profile/login/login')).catch(() => {})
          }
        } catch (error) {
          ctx.logger?.debug?.('清窗口登录态失败：' + (error?.message || String(error)))
        }
        return '已经退出青史账号（本地凭证和窗口里的登录态都清掉了）。'
      },
    }),
  )

  // ---------- qingshi_skill：读随包分发的操作技能 ----------
  ctx.tools.register(
    defineTool({
      name: 'qingshi_skill',
      description:
        '读取随包分发的青史操作技能文档。**只在用户明确说"组织管理""建族谱节点""往族谱加人""创建虚拟人物""历史人物录入"这类组织/族谱结构性操作时才调**，' +
        '读取 qingshi-org-entry 技能（不传参数就是它），并严格按技能里的「动手前必问」执行。' +
        '⚠️ **以下场景绝对不要调 qingshi_skill**（这些是主流程，走 kinship/manageable_users + photo_save/record/draft）：' +
        '帮我妈整理照片、给我爸存一条、代家人录生涯、手机上传照片到某某名下——这些都是「找归属人 → 写生涯/存照片」，归属人用 qingshi_kinship（称谓）或 qingshi_manageable_users（真名）查，' +
        '然后直接调 qingshi_photo_save / qingshi_record / qingshi_draft，**不要碰组织管理 skill**。',
      parameters: {
        name: { type: 'string', description: '技能名，默认 qingshi-org-entry（目前唯一一个）' },
        file: { type: 'string', description: '技能目录里的文件，默认 SKILL.md；配套脚本传 scripts/qs.mjs' },
      },
      output: outputSpec,
      async execute(args) {
        const name = String(args?.name || 'qingshi-org-entry').replace(/[^a-zA-Z0-9_-]/g, '') || 'qingshi-org-entry'
        const rel = String(args?.file || 'SKILL.md').replace(/\\/g, '/')
        if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) return '非法的文件路径。'
        const target = join(SKILLS_ROOT, name, rel)
        if (!target.startsWith(SKILLS_ROOT)) return '非法的文件路径。'
        try {
          return await readFile(target, 'utf8')
        } catch {
          const available = await readdir(SKILLS_ROOT).catch(() => [])
          return '没找到技能文件 ' + name + '/' + rel + '。已随包分发的技能：' + (available.join('、') || '（无）') + '。'
        }
      },
    }),
  )

  // ---------- 族谱血缘：添加家人 / 扫码邀请 / 全树读 ----------
  // 完整步骤见 skills/qingshi-org-entry/SKILL.md 的「族谱血缘」章节。
  const RELATIONSHIP_VALUES = { man: '父亲/男性角色', woman: '母亲/女性角色', child: '子女' }
  const FAMILY_TYPE_VALUES = { parent: '锚点人的父层（往上加）', child: '锚点人的子层（往下加）' }

  ctx.tools.register(
    defineTool({
      name: 'qingshi_family_add',
      description:
        '往「青史」族谱里添加血缘家庭成员（如给某人添加父亲、母亲、子女，从而补出「爷爷的爷爷」这条链）。' +
        '后端走 send_add_family_member，会自动尝试自审批；若提示需对方审批，说明本人不在审批人列表里。' +
        '调用前必须先问清用户：是否修改族谱血缘、给谁加什么关系、用哪种方式（虚拟用户/已有用户/扫码邀请）。',
      parameters: {
        fromUid: { type: 'string', description: '锚点人 uid——在他的父层或子层加人（qingshi_family 里读到的节点 uid）' },
        familyType: { type: 'string', description: 'parent=往锚点人的父层加（man=加父亲/woman=加母亲）；child=往锚点人的子层加' },
        relationship: { type: 'string', description: 'man=父亲/男性角色；woman=母亲/女性角色；child=子女' },
        familyId: {
          type: 'string',
          description:
            '目标家庭层 id（qingshi_family 读到的 family_id）。新层占位符：new_parent=新建父层，' +
            'new_child=新建子层，new_child_family=新建子家庭（配偶场景）',
        },
        mode: { type: 'string', description: 'tmp=创建虚拟用户（不占真实账号）；created=指定已有用户' },
        targetUid: { type: 'string', description: 'mode=created 时必填：已有用户的 uid（不要按昵称猜）' },
        tmpUser: {
          type: 'object',
          description: 'mode=tmp 时的虚拟人资料：{ nickname 必填, gender: 1男/2女, birthday: YYYY-MM-DD（公元前 -YYYY-MM-DD）, deathday 可空, username 可空默认=nickname }',
        },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return '登录已过期，我这边会弹一个小登录窗，你在里面用手机号登一次就行。'
        const fromUid = String(args?.fromUid || '').trim()
        const familyType = String(args?.familyType || '').trim().toLowerCase()
        const relationship = String(args?.relationship || '').trim().toLowerCase()
        const familyId = String(args?.familyId || '').trim()
        const mode = String(args?.mode || '').trim().toLowerCase()
        if (!fromUid || !familyId) return '缺少 fromUid（锚点人）或 familyId（目标家庭层），先用 qingshi_family 定位。'
        if (!FAMILY_TYPE_VALUES[familyType]) return 'familyType 只能是 parent 或 child。'
        if (!RELATIONSHIP_VALUES[relationship]) return 'relationship 只能是 man / woman / child。'
        if (mode !== 'tmp' && mode !== 'created') return 'mode 只能是 tmp（虚拟用户）或 created（已有用户）。'
        if (mode === 'created' && !String(args?.targetUid || '').trim()) {
          return 'mode=created 需要提供已有用户的 targetUid（让用户提供，或先搜索确认，不要按昵称猜）。'
        }
        if (mode === 'tmp' && !String(args?.tmpUser?.nickname || '').trim()) {
          return 'mode=tmp 需要提供 tmpUser.nickname。'
        }

        const payload = {
          send_uid: fromUid,
          from_uid: fromUid,
          family_type: familyType,
          from_family_type: familyType,
          add_role: relationship,
          relationship,
          family_id: familyId,
        }
        let modeText = ''
        if (mode === 'tmp') {
          const tmp = args.tmpUser
          const nickname = String(tmp.nickname || '').trim()
          payload.add_user_status = 'tmp'
          payload.target_uid = 'tmp:' + Date.now()
          payload.tmp_user_data = {
            username: String(tmp.username || '').trim() || nickname,
            nickname,
            gender: Number(tmp.gender) === 2 ? 2 : 1,
            birthday: String(tmp.birthday || '').trim(),
            deathday: String(tmp.deathday || '').trim(),
          }
          modeText = '创建虚拟用户「' + nickname + '」'
        } else {
          payload.add_user_status = 'created'
          payload.target_uid = String(args.targetUid).trim()
          modeText = '添加已有用户 ' + payload.target_uid
        }

        const sent = await careerApi.addFamilyMember(payload)
        if (!sent.ok) return '发送添加请求失败（' + sent.code + '）：' + sent.message
        if (!sent.messageId) {
          return '请求已受理但没返回审批消息编号，请用 qingshi_family 回读族谱确认是否已写入。'
        }
        const approved = await careerApi.approveFamilyMessage(sent.messageId)
        if (!approved.ok) {
          if (approved.message.includes('当前没有可处理的审批组')) {
            return '添加申请已发出（message_id ' + sent.messageId + '），但本人不在审批人列表里，需要对方（或对应家庭管理员）在消息中心同意后才生效。'
          }
          return '发送成功但审批失败（' + approved.code + '）：' + approved.message + '（message_id ' + sent.messageId + '）'
        }
        if (!approved.executeSuccess) {
          return modeText + '：审批已通过，但写入族谱失败——' + (approved.executeMessage || '后端未说明原因') + '。'
        }
        return modeText + ' 已加入族谱（family_id ' + familyId + '，' + FAMILY_TYPE_VALUES[familyType] + '）。' +
          '建议马上用 qingshi_family 回读确认层级和称谓。'
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qingshi_family_invite',
      description:
        '生成族谱「扫码添加家人」的邀请二维码（保存为 PNG 并返回文件路径与邀请标识）。' +
        '适合把真实亲人拉进族谱：对方用手机端青史扫码、确认后自己入谱。' +
        '生成前先问清给谁（anchorUid）加什么关系（familyType/relationship/familyId）。',
      parameters: {
        anchorUid: { type: 'string', description: '锚点人 uid——被邀请人将作为他的父亲/母亲/子女入谱' },
        familyType: { type: 'string', description: 'parent=父层；child=子层' },
        relationship: { type: 'string', description: 'man / woman / child' },
        familyId: { type: 'string', description: '目标家庭层 id；新层占位 new_parent / new_child / new_child_family' },
        clientPlatform: { type: 'string', description: '默认 mp-weixin' },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return '登录已过期，我这边会弹一个小登录窗，你在里面用手机号登一次就行。'
        const anchorUid = String(args?.anchorUid || '').trim()
        const familyType = String(args?.familyType || '').trim().toLowerCase()
        const relationship = String(args?.relationship || '').trim().toLowerCase()
        const familyId = String(args?.familyId || '').trim()
        if (!anchorUid || !familyId) return '缺少 anchorUid 或 familyId，先用 qingshi_family 定位。'
        if (!FAMILY_TYPE_VALUES[familyType]) return 'familyType 只能是 parent 或 child。'
        if (!RELATIONSHIP_VALUES[relationship]) return 'relationship 只能是 man / woman / child。'
        const qr = await careerApi.familyInviteQrcode({
          anchorUid, familyId, familyType, relationship,
          clientPlatform: String(args?.clientPlatform || 'mp-weixin').trim(),
        })
        if (!qr.ok) return '生成邀请二维码失败（' + qr.code + '）：' + qr.message
        if (!qr.qrBase64) {
          return '后端没有返回二维码图片（record_id ' + qr.recordId + '），请在手机端族谱页查看邀请。'
        }
        const base64 = qr.qrBase64.replace(/^data:image\/\w+;base64,/, '')
        const file = join(tmpdir(), 'qingshi-family-invite-' + (qr.recordId || Date.now()) + '.png')
        await writeFile(file, Buffer.from(base64, 'base64'))
        return '邀请二维码已生成：' + file +
          '（record_id ' + qr.recordId + '，为 ' + anchorUid + ' 的' + FAMILY_TYPE_VALUES[familyType] +
          '加' + RELATIONSHIP_VALUES[relationship] + '）。请把这张图发给对方，用手机端青史扫码并确认后即可入谱。'
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qingshi_family_all',
      description:
        '一次读全某人的完整族谱关系树（后端 get_all_family_data，需要当前用户对该成员有管理权限）。' +
        '做称谓递归匹配（如「爷爷的爷爷」「表姑」）时优先用它，比 qingshi_family 一层层走快得多；' +
        '没权限或输出太大时再退回 qingshi_family 分层导航。',
      parameters: {
        targetUid: { type: 'string', description: '看谁的完整族谱；不填就是用户自己' },
      },
      output: outputSpec,
      async execute(args) {
        const info = await ensureLoggedIn()
        if (!info.loggedIn) return '登录已过期，我这边会弹一个小登录窗，你在里面用手机号登一次就行。'
        const uid = String(args?.targetUid || info.uid || '').trim()
        if (!uid) return '拿不到 uid，先调用 qingshi_me 看看登录状态。'
        const all = await careerApi.allFamilyLayers(uid)
        if (!all.ok) {
          return '读取全量族谱失败（' + all.code + '）：' + all.message + '。若提示没权限，说明当前用户不是该成员的管理员，可用 qingshi_family 分层走。'
        }
        const text = JSON.stringify(all.data)
        if (text.length > 60000) {
          return '全量族谱太大（' + text.length + ' 字符，超出输出上限），请改用 qingshi_family 按方向分层导航。'
        }
        return text || '（空族谱）'
      },
    }),
  )
}
