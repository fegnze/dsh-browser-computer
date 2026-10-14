import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHandler, HTTP_PREFIX, INTENT_HEADER } from '../src/http.mjs'

/** 假 req：GET 无体，POST 走 async iterable（handler 用 for await 读）。 */
function fakeReq({ method = 'GET', path = '/', headers = {}, body } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url: `${HTTP_PREFIX}${path}`,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
}

function fakeRes() {
  const captured = { status: undefined, headers: undefined, body: undefined }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(text) {
      captured.body = JSON.parse(text)
    },
  }
}

const okAdmit = () => ({ peer: { id: 'browser' } })
const refuseAdmit = () => ({ rejection: 401 })

function doctorStub() {
  const repairs = []
  return {
    repairs,
    check: async () => ({ stage: 'check', marker: 'check' }),
    test: async () => ({ stage: 'test', marker: 'test' }),
    fix: async () => ({ stage: 'fix' }),
    repair: async (options) => {
      repairs.push(options)
      return { stage: 'repair', ok: true }
    },
    openSettingsPanels: async () => ({ opened: [] }),
  }
}

const header = { [INTENT_HEADER]: '1' }

test('缺意图头一律 403，即使认证会通过', async () => {
  const res = fakeRes()
  await createHandler({ doctor: doctorStub(), admit: okAdmit })(fakeReq(), res)
  assert.equal(res.captured.status, 403)
  assert.equal(res.captured.body.error.code, 'forbidden')
})

test('connection.admit 拒绝时不放行', async () => {
  const res = fakeRes()
  await createHandler({ doctor: doctorStub(), admit: refuseAdmit })(fakeReq({ headers: header }), res)
  assert.equal(res.captured.status, 401)
})

test('没有 admit 实现（非 web profile）时也不放行', async () => {
  const res = fakeRes()
  await createHandler({ doctor: doctorStub(), admit: () => undefined })(fakeReq({ headers: header }), res)
  assert.equal(res.captured.status, 403)
})

test('GET /api/status 走只读体检', async () => {
  const res = fakeRes()
  await createHandler({ doctor: doctorStub(), admit: okAdmit })(fakeReq({ headers: header }), res)
  assert.equal(res.captured.status, 200)
  assert.equal(res.captured.body.value.marker, 'check')
  assert.equal(res.captured.headers['cache-control'], 'no-store')
})

test('POST /api/repair 默认开面板并验证连接', async () => {
  const doctor = doctorStub()
  const res = fakeRes()
  await createHandler({ doctor, admit: okAdmit })(
    fakeReq({ method: 'POST', path: '/api/repair', headers: header, body: {} }), res)
  assert.equal(res.captured.body.value.stage, 'repair')
  assert.deepEqual(doctor.repairs.at(-1), { openSettings: true, verify: true, force: false })
})

test('POST /api/repair 尊重调用方关掉面板/验证', async () => {
  const doctor = doctorStub()
  const handler = createHandler({ doctor, admit: okAdmit })
  await handler(fakeReq({
    method: 'POST', path: '/api/repair', headers: header,
    body: { openSettings: false, verify: false, force: true },
  }), fakeRes())
  assert.deepEqual(doctor.repairs.at(-1), { openSettings: false, verify: false, force: true })
})

test('未知路径 404，坏 JSON 走 500 且带出消息', async () => {
  const handler = createHandler({ doctor: doctorStub(), admit: okAdmit })

  const notFound = fakeRes()
  await handler(fakeReq({ path: '/api/nope', headers: header }), notFound)
  assert.equal(notFound.captured.status, 404)

  const badReq = fakeReq({ method: 'POST', path: '/api/repair', headers: header })
  badReq[Symbol.asyncIterator] = async function* () {
    yield Buffer.from('{not json')
  }
  const bad = fakeRes()
  await handler(badReq, bad)
  assert.equal(bad.captured.status, 500)
  assert.match(bad.captured.body.error.message, /JSON/)
})

test('doctor 抛错时如实变成错误响应，不吞掉', async () => {
  const doctor = { ...doctorStub(), check: async () => { throw new Error('体检炸了') } }
  const res = fakeRes()
  await createHandler({ doctor, admit: okAdmit })(fakeReq({ headers: header }), res)
  assert.equal(res.captured.status, 500)
  assert.match(res.captured.body.error.message, /体检炸了/)
})

test('未知接口的 404 说明里要带路径，不能只回一个裸路径', async () => {
  const res = fakeRes()
  await createHandler({ doctor: doctorStub(), admit: okAdmit })(
    fakeReq({ path: '/api/repair', headers: header }), res)
  assert.equal(res.captured.status, 404)
  assert.match(res.captured.body.error.message, /未知接口/)
  assert.match(res.captured.body.error.message, /\/api\/repair/)
})
