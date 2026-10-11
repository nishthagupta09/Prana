import test from 'node:test'
import assert from 'node:assert/strict'
import {
  analysisForRequest,
  analysisRequestKey,
  applyScenarioToState,
  calculateShiftedWindow,
  classifyApiFailure,
  comparableScenarioDifference,
  comparisonRequestKey,
  defaultScenarioSelection,
  derivePlanFinding,
  explanationRequestKey,
  loadStoredState,
  selectPlanDate,
  stateForStorage,
  timeGreeting,
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

test('timeGreeting returns appropriate greeting based on local hour', () => {
  const morning = new Date(2026, 9, 11, 8, 30)
  const afternoon = new Date(2026, 9, 11, 14, 0)
  const evening = new Date(2026, 9, 11, 19, 45)
  const night = new Date(2026, 9, 11, 23, 10)
  assert.equal(timeGreeting(morning), 'Good morning')
  assert.equal(timeGreeting(afternoon), 'Good afternoon')
  assert.equal(timeGreeting(evening), 'Good evening')
  assert.equal(timeGreeting(night), 'Good evening')
})

test('calculateShiftedWindow preserves duration and calculates valid candidate window', () => {
  // 60 min evening window shifts earlier
  const eveningShift = calculateShiftedWindow('17:30', '18:30')
  assert.equal(eveningShift.start, '16:00')
  assert.equal(eveningShift.end, '17:00')

  // 45 min morning window shifts later
  const morningShift = calculateShiftedWindow('08:00', '08:45')
  assert.equal(morningShift.start, '11:00')
  assert.equal(morningShift.end, '11:45')

  // Exact duration preserved
  const [sh, sm] = morningShift.start.split(':').map(Number)
  const [eh, em] = morningShift.end.split(':').map(Number)
  assert.equal((eh * 60 + em) - (sh * 60 + sm), 45)
})

test('applyScenarioToState updates non-run activity, sorts chronologically, and updates date-keyed plans atomically', () => {
  const state = {
    planDate: '2026-10-11',
    page: 'Simulator',
    feedback: 'Accepted',
    followed: 'Followed',
    blocks: [
      { id: 'commute', title: 'Commute', start: '08:00', end: '09:00', location: 'Metro', environment: 'Outdoor', flexibility: 'Limited', pm25: 80 },
      { id: 'cycle', title: 'Cycling', start: '18:00', end: '19:00', location: 'Park', environment: 'Outdoor', flexibility: 'Flexible', pm25: 120 },
      { id: 'dinner', title: 'Dinner', start: '20:00', end: '21:00', location: 'Cafe', environment: 'Indoor', flexibility: 'Flexible', pm25: null },
    ],
    plansByDate: {
      '2026-10-11': {
        blocks: [
          { id: 'commute', title: 'Commute', start: '08:00', end: '09:00', location: 'Metro', environment: 'Outdoor', flexibility: 'Limited', pm25: 80 },
          { id: 'cycle', title: 'Cycling', start: '18:00', end: '19:00', location: 'Park', environment: 'Outdoor', flexibility: 'Flexible', pm25: 120 },
          { id: 'dinner', title: 'Dinner', start: '20:00', end: '21:00', location: 'Cafe', environment: 'Indoor', flexibility: 'Flexible', pm25: null },
        ],
        feedback: 'Accepted',
        followed: 'Followed',
      },
    },
  }

  // Update non-run activity 'cycle' to earlier window 16:00-17:00
  const result = applyScenarioToState(state, 'cycle', { start: '16:00', end: '17:00' })
  assert.equal(result.success, true)
  assert.equal(result.state.page, 'Today')

  // Chronological ordering preserved: commute (08:00), cycle (16:00), dinner (20:00)
  assert.deepEqual(result.state.blocks.map(b => b.id), ['commute', 'cycle', 'dinner'])
  assert.equal(result.state.blocks[1].start, '16:00')
  assert.equal(result.state.blocks[1].end, '17:00')

  // Date-keyed persistence updated atomically
  assert.deepEqual(result.state.plansByDate['2026-10-11'].blocks.map(b => b.id), ['commute', 'cycle', 'dinner'])
  assert.equal(result.state.plansByDate['2026-10-11'].blocks[1].start, '16:00')
  assert.equal(result.state.plansByDate['2026-10-11'].feedback, 'Accepted')

  // Unrelated activities preserved
  assert.equal(result.state.blocks[0].title, 'Commute')
  assert.equal(result.state.blocks[2].title, 'Dinner')
})

test('applyScenarioToState rejects schedule overlaps and reversed times without changing state', () => {
  const state = {
    planDate: '2026-10-11',
    page: 'Simulator',
    blocks: [
      { id: 'work', title: 'Work', start: '09:00', end: '17:00', location: 'Office', environment: 'Indoor', flexibility: 'Fixed', pm25: null },
      { id: 'walk', title: 'Walk', start: '18:00', end: '19:00', location: 'Park', environment: 'Outdoor', flexibility: 'Flexible', pm25: 60 },
    ],
    plansByDate: {},
  }

  // Overlap test: shift walk to 16:00-17:00 (overlaps Work 09:00-17:00)
  const overlapResult = applyScenarioToState(state, 'walk', { start: '16:00', end: '17:00' })
  assert.equal(overlapResult.success, false)
  assert.match(overlapResult.error, /overlaps “Work”/)
  assert.deepEqual(overlapResult.state, state)
  assert.equal(overlapResult.state.page, 'Simulator')

  // Reversed/invalid time test: start 19:00, end 18:00
  const invalidTimeResult = applyScenarioToState(state, 'walk', { start: '19:00', end: '18:00' })
  assert.equal(invalidTimeResult.success, false)
  assert.match(invalidTimeResult.error, /End time must be later than start time/)
  assert.deepEqual(invalidTimeResult.state, state)

  // Non-existent activity test
  const missingResult = applyScenarioToState(state, 'unknown-id', { start: '07:00', end: '08:00' })
  assert.equal(missingResult.success, false)
  assert.match(missingResult.error, /Activity not found/)
  assert.deepEqual(missingResult.state, state)
})

test('defaultScenarioSelection defaults to shifted-time option and indoor option remains selectable', () => {
  // Shifted-time ('earlier') is selected by default
  assert.equal(defaultScenarioSelection(), 'earlier')

  // Available options
  const options = ['earlier', 'indoor']
  assert.ok(options.includes(defaultScenarioSelection()))
  assert.ok(options.includes('indoor'))
})

test('switching activities, dates, scenarios, or modes produces distinct comparison keys preventing stale cache reuse', () => {
  const blocks = [
    { id: 'run', title: 'Run', start: '17:30', end: '18:30', environment: 'Outdoor', flexibility: 'Flexible', pm25: 185 },
    { id: 'walk', title: 'Walk', start: '07:00', end: '08:00', environment: 'Outdoor', flexibility: 'Flexible', pm25: 90 },
  ]
  const shiftedRun = calculateShiftedWindow('17:30', '18:30')
  const shiftedWalk = calculateShiftedWindow('07:00', '08:00')

  const baseKey = comparisonRequestKey('2026-10-11', 'live', 'earlier', 'run', shiftedRun, blocks)
  const differentDateKey = comparisonRequestKey('2026-10-12', 'live', 'earlier', 'run', shiftedRun, blocks)
  const differentActivityKey = comparisonRequestKey('2026-10-11', 'live', 'earlier', 'walk', shiftedWalk, blocks)
  const indoorScenarioKey = comparisonRequestKey('2026-10-11', 'live', 'indoor', 'run', shiftedRun, blocks)
  const illustrativeModeKey = comparisonRequestKey('2026-10-11', 'illustrative', 'earlier', 'run', shiftedRun, blocks)

  const keys = new Set([baseKey, differentDateKey, differentActivityKey, indoorScenarioKey, illustrativeModeKey])
  assert.equal(keys.size, 5, 'All keys must be mutually distinct')

  // analysisForRequest correctly rejects stale cached results across key boundaries
  const cachedComparison = { requestKey: baseKey, result: { difference_ug_h_m3: 15 } }
  assert.equal(analysisForRequest(cachedComparison, differentDateKey), null)
  assert.equal(analysisForRequest(cachedComparison, differentActivityKey), null)
  assert.equal(analysisForRequest(cachedComparison, indoorScenarioKey), null)
  assert.equal(analysisForRequest(cachedComparison, illustrativeModeKey), null)
  assert.deepEqual(analysisForRequest(cachedComparison, baseKey), { difference_ug_h_m3: 15 })
})

test('explanationRequestKey distinguishes dates, data modes, and plan blocks avoiding stale explanation caching', () => {
  const blocksA = [{ id: 'run', title: 'Run', start: '17:00', end: '18:00', environment: 'Outdoor' }]
  const blocksB = [{ id: 'walk', title: 'Walk', start: '08:00', end: '09:00', environment: 'Outdoor' }]

  const key1 = explanationRequestKey('2026-10-11', 'live', blocksA)
  const key2 = explanationRequestKey('2026-10-12', 'live', blocksA)
  const key3 = explanationRequestKey('2026-10-11', 'illustrative', blocksA)
  const key4 = explanationRequestKey('2026-10-11', 'live', blocksB)

  const keys = new Set([key1, key2, key3, key4])
  assert.equal(keys.size, 4, 'All explanation keys must be mutually distinct')

  const geminiExplanation = {
    headline: 'Plan estimate summary',
    explanation: 'Supported outdoor periods are summarized.',
    next_step: 'Review the source details.',
    provider: 'gemini',
    status: 'generated',
  }
  const cachedRecord = { requestKey: key1, result: geminiExplanation }

  assert.deepEqual(analysisForRequest(cachedRecord, key1), geminiExplanation)
  assert.equal(analysisForRequest(cachedRecord, key2), null)
  assert.equal(analysisForRequest(cachedRecord, key3), null)
  assert.equal(analysisForRequest(cachedRecord, key4), null)
  assert.equal(analysisForRequest(cachedRecord, key1, true), null, 'Pending explanation request must not return stale result')
})
