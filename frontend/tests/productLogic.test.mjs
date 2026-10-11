import test from 'node:test'
import assert from 'node:assert/strict'
import {
  analysisForRequest,
  analysisRequestKey,
  classifyApiFailure,
  comparableScenarioDifference,
  derivePlanFinding,
  loadStoredState,
  selectPlanDate,
  stateForStorage,
} from '../src/productLogic.mjs'

const starter = [{ id: 'run', title: 'Run' }]
const outdoor = [{ id: 'run', environment: 'Outdoor', flexibility: 'Flexible' }]

test('legacy plan is migrated without discarding it and receives a selected date', () => {
  const stored = loadStoredState(JSON.stringify({ blocks: [{ id: 'custom' }], page: 'Impact', feedback: 'Accepted', followed: '', dataMode: 'live' }), '2026-10-11', starter)
  assert.equal(stored.planDate, '2026-10-11')
  assert.deepEqual(stored.blocks, [{ id: 'custom' }])
  assert.deepEqual(stored.plansByDate['2026-10-11'].blocks, [{ id: 'custom' }])
  assert.equal(stored.feedback, 'Accepted')
  assert.equal(stored.needsDateReview, true)
})

test('date rollover archives the prior plan and does not reuse it for the new date', () => {
  const yesterday = {
    blocks: [{ id: 'yesterday' }], page: 'Today', feedback: 'Rejected', followed: 'Partially', dataMode: 'live',
    planDate: '2026-10-10', lastSeenLocalDate: '2026-10-10', plansByDate: {},
  }
  const nextDay = loadStoredState(JSON.stringify(stateForStorage(yesterday)), '2026-10-11', starter)
  assert.equal(nextDay.planDate, '2026-10-11')
  assert.deepEqual(nextDay.blocks, [])
  assert.equal(nextDay.feedback, '')
  assert.deepEqual(nextDay.plansByDate['2026-10-10'].blocks, [{ id: 'yesterday' }])
  const returned = selectPlanDate(nextDay, '2026-10-10')
  assert.deepEqual(returned.blocks, [{ id: 'yesterday' }])
  assert.equal(returned.feedback, 'Rejected')
})

test('an intentionally selected historical date remains selected after reload', () => {
  const selected = {
    blocks: [{ id: 'history' }], page: 'Insights', feedback: '', followed: '', dataMode: 'live',
    planDate: '2026-10-09', lastSeenLocalDate: '2026-10-11', plansByDate: { '2026-10-09': { blocks: [{ id: 'history' }], feedback: '', followed: '' } },
  }
  const reloaded = loadStoredState(JSON.stringify(stateForStorage(selected)), '2026-10-12', starter)
  assert.equal(reloaded.planDate, '2026-10-09')
  assert.deepEqual(reloaded.blocks, [{ id: 'history' }])
})

test('date and plan are part of the analysis key; stale results are hidden', () => {
  const firstKey = analysisRequestKey('2026-10-10', outdoor, 'live')
  const nextKey = analysisRequestKey('2026-10-11', outdoor, 'live')
  assert.notEqual(firstKey, nextKey)
  assert.equal(analysisForRequest({ requestKey: firstKey, result: { value: 42 } }, nextKey), null)
  assert.equal(analysisForRequest({ requestKey: firstKey, result: { value: 42 } }, firstKey, true), null)
  assert.deepEqual(analysisForRequest({ requestKey: nextKey, result: { value: 43 } }, nextKey), { value: 43 })
})

test('scenario difference is shown only for comparable inconclusive live results', () => {
  assert.equal(comparableScenarioDifference('inconclusive', 80, 70), 10)
  for (const status of ['unavailable', 'illustrative_only', 'unsupported', 'available', undefined]) {
    assert.equal(comparableScenarioDifference(status, 80, 70), null)
  }
  assert.equal(comparableScenarioDifference('inconclusive', null, 70), null)
})

test('Insights distinguish unavailable, insufficient, partial and supported data', () => {
  const unavailable = derivePlanFinding({ analysis: { status: 'unavailable', provenance: { message: 'Outside supported date window' } }, blocks: outdoor, dataMode: 'live', busy: false, error: '' })
  assert.equal(unavailable.state, 'unavailable')
  assert.match(unavailable.body, /No illustrative values were substituted/)

  const insufficient = derivePlanFinding({ analysis: { status: 'partial', summary: { evaluated_blocks: 0 } }, blocks: outdoor, dataMode: 'live', busy: false, error: '' })
  assert.equal(insufficient.state, 'insufficient')

  const nonePlanned = derivePlanFinding({ analysis: { status: 'available', summary: { evaluated_blocks: 0 } }, blocks: [], dataMode: 'live', busy: false, error: '' })
  assert.equal(nonePlanned.headline, 'No outdoor activity planned')

  const noConnection = derivePlanFinding({ analysis: null, blocks: outdoor, dataMode: 'live', busy: false, error: 'Could not connect to API' })
  assert.equal(noConnection.state, 'error')

  const illustrative = derivePlanFinding({ analysis: { status: 'illustrative', summary: { evaluated_blocks: 1 } }, blocks: outdoor, dataMode: 'illustrative', busy: false, error: '' })
  assert.equal(illustrative.state, 'illustrative')

  const partial = derivePlanFinding({ analysis: { status: 'partial', summary: { evaluated_blocks: 1, supported_hours: 0.5, outdoor_planned_hours: 1 } }, blocks: outdoor, dataMode: 'live', busy: false, error: '' })
  assert.equal(partial.state, 'partial')
  assert.match(partial.body, /0\.5 of 1\.0 planned outdoor hours/)

  const available = derivePlanFinding({ analysis: { status: 'available', summary: { evaluated_blocks: 1, supported_hours: 1, outdoor_planned_hours: 1 } }, blocks: outdoor, dataMode: 'live', busy: false, error: '' })
  assert.equal(available.state, 'available')
  assert.match(available.body, /not personal exposure measurements/)
})

test('Insights reports API connection failures distinctly from provider outages', () => {
  const connectionError = classifyApiFailure(new TypeError('fetch failed'))
  assert.match(connectionError, /Could not connect to the Prana API/)
  assert.match(classifyApiFailure(Object.assign(new Error('bad request'), { status: 422 })), /HTTP 422/)
  assert.equal(classifyApiFailure(Object.assign(new Error('cancelled'), { name: 'AbortError' })), null)
})
