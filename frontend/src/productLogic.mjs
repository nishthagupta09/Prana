export function localDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  return `${parts.find(part => part.type === 'year')?.value}-${parts.find(part => part.type === 'month')?.value}-${parts.find(part => part.type === 'day')?.value}`
}

function activePlan(state) {
  return {
    blocks: state.blocks ?? [],
    feedback: state.feedback ?? '',
    followed: state.followed ?? '',
  }
}

export function loadStoredState(raw, today, starterBlocks) {
  const initial = {
    blocks: starterBlocks,
    page: 'Today',
    feedback: '',
    followed: '',
    dataMode: 'live',
    planDate: today,
    lastSeenLocalDate: today,
    plansByDate: {},
    needsDateReview: false,
  }
  if (!raw) {
    initial.plansByDate[today] = activePlan(initial)
    return initial
  }

  try {
    const saved = JSON.parse(raw)
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return initial

    // Migrate the former single-plan format without dropping its user data.
    if (!saved.planDate || !saved.plansByDate || typeof saved.plansByDate !== 'object') {
      const migrated = { ...initial, ...saved, planDate: today, lastSeenLocalDate: today, plansByDate: {}, needsDateReview: true }
      migrated.plansByDate[today] = activePlan(migrated)
      return migrated
    }

    const plansByDate = { ...saved.plansByDate }
    plansByDate[saved.planDate] ??= activePlan(saved)
    const previousCurrentDate = saved.lastSeenLocalDate ?? saved.planDate
    const advancesWithCalendar = saved.planDate === previousCurrentDate && previousCurrentDate !== today
    const selectedDate = advancesWithCalendar ? today : saved.planDate
    const targetPlan = plansByDate[selectedDate] ?? { blocks: [], feedback: '', followed: '' }
    plansByDate[selectedDate] = targetPlan
    return {
      ...initial,
      ...saved,
      ...targetPlan,
      planDate: selectedDate,
      lastSeenLocalDate: today,
      plansByDate,
    }
  } catch {
    return initial
  }
}

export function selectPlanDate(state, date) {
  const plansByDate = { ...state.plansByDate, [state.planDate]: activePlan(state) }
  const selectedPlan = plansByDate[date] ?? { blocks: [], feedback: '', followed: '' }
  plansByDate[date] = selectedPlan
  return { ...state, ...selectedPlan, planDate: date, plansByDate }
}

export function stateForStorage(state) {
  return {
    ...state,
    plansByDate: { ...state.plansByDate, [state.planDate]: activePlan(state) },
  }
}

export function analysisRequestKey(planDate, blocks, dataMode) {
  return JSON.stringify([planDate, dataMode, blocks])
}

export function analysisForRequest(record, requestKey, pending = false) {
  return !pending && record?.requestKey === requestKey ? record.result : null
}

export function comparableScenarioDifference(status, baselineMean, alternativeMean) {
  if (status !== 'inconclusive' || !Number.isFinite(baselineMean) || !Number.isFinite(alternativeMean)) return null
  return baselineMean - alternativeMean
}

export function defaultScenarioSelection() {
  return 'earlier'
}

export function comparisonRequestKey(planDate, dataMode, scenario, targetBlockId, shifted, blocks) {
  return JSON.stringify([planDate, dataMode, scenario, targetBlockId, shifted, blocks])
}

export function explanationRequestKey(planDate, dataMode, blocks, scenario = null) {
  return JSON.stringify([planDate, dataMode, blocks, scenario])
}

export function classifyApiFailure(error) {
  if (error?.name === 'AbortError') return null
  if (error?.name === 'TypeError') return 'Could not connect to the Prana API. Check that FastAPI is running and VITE_API_URL is correct.'
  if (Number.isInteger(error?.status)) return `The Prana API rejected the analysis request (HTTP ${error.status}). Check the plan and API response.`
  return 'The Prana API returned an unreadable analysis response. Try again.'
}

export function derivePlanFinding({ analysis, blocks, dataMode, busy, error }) {
  if (error) return { headline: 'Analysis service unavailable', body: error, state: 'error' }
  if (busy || !analysis) return { headline: 'Waiting for plan analysis', body: 'Current plan estimates will appear when analysis finishes.', state: 'loading' }
  if (analysis.status === 'unavailable') {
    const message = analysis.provenance?.message ?? 'No provider estimates are available for this date.'
    return { headline: 'Live estimates unavailable', body: `${message} No illustrative values were substituted.`, state: 'unavailable' }
  }
  if (dataMode === 'illustrative') {
    const count = analysis.summary?.evaluated_blocks ?? 0
    return count
      ? { headline: 'Illustrative values in this plan', body: `${count} outdoor activity block(s) have example values. They do not describe current local conditions.`, state: 'illustrative' }
      : { headline: 'No illustrative outdoor estimates', body: 'This plan has no outdoor blocks with example values.', state: 'insufficient' }
  }

  const outdoorCount = blocks.filter(block => block.environment === 'Outdoor').length
  const evaluated = analysis.summary?.evaluated_blocks ?? 0
  if (outdoorCount === 0) {
    return { headline: 'No outdoor activity planned', body: 'This plan has no outdoor blocks to estimate.', state: 'insufficient' }
  }
  if (evaluated === 0) {
    return { headline: 'No supported outdoor estimates', body: 'The available source data do not cover an outdoor block in this plan. Missing periods remain unknown.', state: 'insufficient' }
  }
  const summary = analysis.summary
  const supported = Number(summary?.supported_hours ?? 0).toFixed(1)
  const planned = Number(summary?.outdoor_planned_hours ?? 0).toFixed(1)
  const body = `Modeled estimates cover ${supported} of ${planned} planned outdoor hours across ${evaluated} block(s). These regional estimates are not personal exposure measurements.`
  return analysis.status === 'partial'
    ? { headline: 'Partial data coverage for this plan', body: `${body} Other intervals remain unknown.`, state: 'partial' }
    : { headline: 'Supported outdoor estimates for this plan', body, state: 'available' }
}

export function timeGreeting(now = new Date()) {
  const hour = now.getHours()
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 17) return 'Good afternoon'
  return 'Good evening'
}

export function calculateShiftedWindow(start, end) {
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const startMins = sh * 60 + sm
  const endMins = eh * 60 + em
  const durMins = Math.max(15, endMins - startMins)

  let candidateStartMins
  if (startMins >= 16 * 60) {
    candidateStartMins = Math.max(6 * 60, startMins - 90)
  } else if (startMins < 12 * 60) {
    candidateStartMins = Math.min(20 * 60, startMins + 180)
  } else {
    candidateStartMins = startMins >= 14 * 60 ? startMins - 120 : startMins + 120
  }

  const candidateEndMins = candidateStartMins + durMins
  const formatTime = (mins) => {
    const h = Math.floor(mins / 60) % 24
    const m = mins % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }

  return {
    start: formatTime(candidateStartMins),
    end: formatTime(candidateEndMins),
  }
}

export function applyScenarioToState(state, targetBlockId, scenarioUpdates) {
  const targetBlock = state.blocks?.find(b => b.id === targetBlockId)
  if (!targetBlock) {
    return { success: false, error: 'Activity not found in current plan.', state }
  }

  const proposed = { ...targetBlock, ...scenarioUpdates }
  if (proposed.end <= proposed.start) {
    return { success: false, error: 'End time must be later than start time.', state }
  }

  const conflict = state.blocks.find(b => b.id !== targetBlockId && proposed.start < b.end && b.start < proposed.end)
  if (conflict) {
    return { success: false, error: `This activity overlaps “${conflict.title}”. Adjust the time before applying.`, state }
  }

  const nextBlocks = state.blocks.map(b => b.id === targetBlockId ? proposed : b)
  nextBlocks.sort((a, b) => a.start.localeCompare(b.start))

  const currentPlan = state.plansByDate?.[state.planDate] ?? {}
  const plansByDate = {
    ...state.plansByDate,
    [state.planDate]: {
      ...currentPlan,
      blocks: nextBlocks,
      feedback: state.feedback ?? '',
      followed: state.followed ?? '',
    },
  }

  const nextState = {
    ...state,
    blocks: nextBlocks,
    plansByDate,
    page: 'Today',
  }

  return { success: true, state: nextState }
}
