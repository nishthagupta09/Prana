import { useEffect, useMemo, useState } from 'react'
import { Activity, ArrowDownRight, ArrowRight, CalendarDays, Check, ChevronRight, CircleHelp, Clock3, CloudSun, Compass, Droplets, HeartPulse, Info, Leaf, MapPin, Plus, RefreshCw, SlidersHorizontal, Sparkles, Sun, Wind, X } from 'lucide-react'
import { analysisForRequest, analysisRequestKey, classifyApiFailure, comparableScenarioDifference, derivePlanFinding, loadStoredState, localDate, selectPlanDate, stateForStorage } from './productLogic.mjs'

type Screen = 'Today' | 'Simulator' | 'Impact' | 'Insights'
type DataMode = 'live' | 'illustrative'
type Environment = 'Outdoor' | 'Indoor' | 'Mixed' | 'Unknown'
type Block = { id: string; title: string; start: string; end: string; location: string; environment: Environment; flexibility: 'Fixed' | 'Flexible' | 'Limited'; pm25: number | null }
type Stored = { blocks: Block[]; page: Screen; feedback: string; followed: string; dataMode: DataMode; planDate: string; lastSeenLocalDate: string; plansByDate: Record<string, { blocks: Block[]; feedback: string; followed: string }>; needsDateReview: boolean }
type Explanation = { headline: string; explanation: string; next_step: string; scenario_explanation: string | null; scenario_status: string | null; provider: 'bedrock' | 'deterministic_fallback'; status: 'generated' | 'fallback' }
const starterBlocks: Block[] = [
  { id: 'commute', title: 'Metro commute', start: '08:30', end: '09:30', location: 'To college', environment: 'Mixed', flexibility: 'Limited', pm25: 82 },
  { id: 'college', title: 'College & co-working', start: '10:00', end: '16:00', location: 'Central campus', environment: 'Indoor', flexibility: 'Fixed', pm25: null },
  { id: 'run', title: 'Evening run', start: '17:30', end: '18:30', location: 'Lodhi Gardens', environment: 'Outdoor', flexibility: 'Flexible', pm25: 185 },
  { id: 'dinner', title: 'Dinner with friends', start: '19:30', end: '21:00', location: 'Connaught Place', environment: 'Indoor', flexibility: 'Flexible', pm25: null },
]
const nav: { name: Screen; icon: typeof Sun }[] = [{ name: 'Today', icon: Sun }, { name: 'Simulator', icon: SlidersHorizontal }, { name: 'Impact', icon: Leaf }, { name: 'Insights', icon: Sparkles }]
const API = (import.meta as any).env?.VITE_API_URL as string | undefined

function load(): Stored {
  try { return loadStoredState(localStorage.getItem('prana:v1'), localDate(), starterBlocks) }
  catch { return loadStoredState(null, localDate(), starterBlocks) }
}

function analysisPayload(blocks: Block[], dataMode: DataMode, planDate: string) { return { date: planDate, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, location_label: 'New Delhi', data_mode: dataMode, blocks: blocks.map(b => ({ ...b, pm25: dataMode === 'illustrative' ? b.pm25 : null, environment: b.environment.toLowerCase(), flexibility: b.flexibility.toLowerCase() })) } }
function estimateFor(block: Block, analysis: any, dataMode: DataMode) { return dataMode === 'illustrative' ? block.pm25 : analysis?.blocks?.find((item: any) => item.block_id === block.id)?.mean_pm25_ug_m3 ?? null }
function explanationPayload(analysis: any, blocks: Block[], scenario?: any) {
  return {
    analysis: {
      status: analysis.status,
      data_mode: analysis.data_mode,
      summary: { concentration_time_index: analysis.summary.concentration_time_index ?? null, evaluated_blocks: analysis.summary.evaluated_blocks, excluded_blocks: analysis.summary.excluded_blocks, planned_hours: analysis.summary.planned_hours, outdoor_planned_hours: analysis.summary.outdoor_planned_hours, supported_hours: analysis.summary.supported_hours, coverage_fraction: analysis.summary.coverage_fraction },
      blocks: (analysis.blocks ?? []).map((item: any) => ({ block_id: item.block_id, mean_pm25_ug_m3: item.mean_pm25_ug_m3 ?? null, estimated_hours: item.estimated_hours, missing_hours: item.missing_hours ?? 0, coverage_fraction: item.coverage_fraction })),
      excluded: (analysis.excluded ?? []).map((item: any) => ({ block_id: item.block_id, reason: item.reason })),
      recommendations: (analysis.recommendations ?? []).map((item: any) => ({ kind: item.kind, status: item.status })),
      provenance: { provider: analysis.provenance.provider, model: analysis.provenance.model ?? null, evidence_type: analysis.provenance.evidence_type, data_classification: analysis.provenance.data_classification, spatial_resolution_km: analysis.provenance.spatial_resolution_km ?? null, native_temporal_resolution_hours: analysis.provenance.native_temporal_resolution_hours ?? null, is_station_observation: analysis.provenance.is_station_observation ?? false },
    },
    activities: blocks.map(b => ({ block_id: b.id, start: b.start, end: b.end, environment: b.environment.toLowerCase(), flexibility: b.flexibility.toLowerCase() })),
    scenario: scenario ? { status: scenario.status, difference_ug_h_m3: scenario.difference_ug_h_m3 ?? null } : null,
  }
}

function App() {
  const [state, setState] = useState<Stored>(load)
  const [scenario, setScenario] = useState<'earlier' | 'indoor'>('earlier')
  const [confirm, setConfirm] = useState(false)
  const [editor, setEditor] = useState<Block | null | 'new'>(null)
  const [analysisRecord, setAnalysisRecord] = useState<{ requestKey: string; result: any } | null>(null)
  const [requestState, setRequestState] = useState<{ requestKey: string; busy: boolean; error: string }>({ requestKey: '', busy: true, error: '' })
  const [explanation, setExplanation] = useState<Explanation | null>(null)
  const [notice, setNotice] = useState(state.needsDateReview ? 'This plan was saved before Prana stored plan dates. It has been assigned to the current local date; select another date if needed.' : '')
  const requestKey = useMemo(() => analysisRequestKey(state.planDate, state.blocks, state.dataMode), [state.planDate, state.blocks, state.dataMode])
  const busy = requestState.requestKey !== requestKey || requestState.busy
  const analysis = analysisForRequest(analysisRecord, requestKey, busy)
  const apiError = requestState.requestKey === requestKey ? requestState.error : ''
  useEffect(() => { localStorage.setItem('prana:v1', JSON.stringify(stateForStorage(state))) }, [state])
  useEffect(() => {
    if (!API) {
      setAnalysisRecord(null)
      setRequestState({ requestKey, busy: false, error: 'VITE_API_URL is not configured for this frontend.' })
      return
    }
    const abort = new AbortController()
    setRequestState({ requestKey, busy: true, error: '' })
    fetch(`${API}/api/day/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(analysisPayload(state.blocks, state.dataMode, state.planDate)), signal: abort.signal })
      .then(async response => {
        if (!response.ok) throw Object.assign(new Error('Analysis request failed'), { status: response.status })
        return response.json()
      })
      .then(result => {
        if (abort.signal.aborted) return
        setAnalysisRecord({ requestKey, result })
        setRequestState({ requestKey, busy: false, error: '' })
      })
      .catch(error => {
        if (abort.signal.aborted) return
        setAnalysisRecord(null)
        setRequestState({ requestKey, busy: false, error: classifyApiFailure(error) ?? '' })
      })
    return () => abort.abort()
  }, [requestKey, state.blocks, state.dataMode, state.planDate])
  useEffect(() => {
    if (!API || !analysis) { setExplanation(null); return }
    const abort = new AbortController()
    setExplanation(null)
    fetch(`${API}/api/explanations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(explanationPayload(analysis, state.blocks)), signal: abort.signal })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Explanation request failed (${r.status})`)))
      .then(result => setExplanation(result))
      .catch(() => { if (!abort.signal.aborted) setExplanation({ headline: 'Plan summary', explanation: 'Prana calculated this result from the source and coverage information shown here.', next_step: 'Review the source details before comparing options.', scenario_explanation: null, scenario_status: null, provider: 'deterministic_fallback', status: 'fallback' }) })
    return () => abort.abort()
  }, [analysis, state.blocks])
  const projected = useMemo(() => analysis?.summary?.concentration_time_index ?? null, [analysis])
  const update = (patch: Partial<Stored>) => setState(current => {
    const next = { ...current, ...patch }
    return { ...next, plansByDate: { ...current.plansByDate, [next.planDate]: { blocks: next.blocks, feedback: next.feedback, followed: next.followed } } }
  })
  const changePlanDate = (date: string) => setState(current => ({ ...selectPlanDate(current, date), needsDateReview: false }))
  const updateBlock = (item: Block) => { const conflict = state.blocks.find(b => b.id !== item.id && item.start < b.end && b.start < item.end); if (conflict) { setNotice(`This activity overlaps “${conflict.title}”. Adjust the time before saving.`); return } const exists = state.blocks.some(b => b.id === item.id); update({ blocks: exists ? state.blocks.map(b => b.id === item.id ? item : b) : [...state.blocks, item].sort((a, b) => a.start.localeCompare(b.start)) }); setEditor(null); setNotice('Plan updated. Estimates for the affected blocks are being refreshed.') }
  const applyScenario = () => { const run = state.blocks.find(b => b.id === 'run'); if (!run) return; updateBlock({ ...run, start: scenario === 'earlier' ? '16:00' : run.start, end: scenario === 'earlier' ? '17:00' : run.end, title: scenario === 'indoor' ? 'Indoor treadmill' : run.title, location: scenario === 'indoor' ? 'Indoor alternative' : run.location, environment: scenario === 'indoor' ? 'Indoor' : 'Outdoor', pm25: state.dataMode === 'illustrative' && scenario === 'earlier' ? 110 : null }); setConfirm(false); update({ page: 'Today' }) }
  return <div className={`app-shell ${state.dataMode === 'live' ? 'live-mode' : ''}`}>
    <header className="topbar"><a className="brand" onClick={() => update({ page: 'Today' })}><span className="brand-mark"><Droplets size={20}/></span><span><b>Prana</b><small><MapPin size={12}/> New Delhi</small></span></a><div className="header-tools"><label className="plan-date-control"><CalendarDays size={15}/><span>Plan date</span><input aria-label="Plan date" type="date" value={state.planDate} onChange={e => { if (e.target.value) changePlanDate(e.target.value) }}/></label><label className="mode-select-label"><span>DATA</span><select aria-label="Environmental data mode" value={state.dataMode} onChange={e => update({ dataMode: e.target.value as DataMode })}><option value="live">Open-Meteo modeled</option><option value="illustrative">Illustrative demo</option></select></label></div></header>
    <div className="workspace"><aside className="side-nav"><div className="nav-label">YOUR DAY</div>{nav.map(({name, icon: Icon}) => <button key={name} className={`nav-item ${state.page === name ? 'active' : ''}`} onClick={() => update({ page: name })}><Icon size={19}/>{name}{state.page === name && <span className="nav-dot"/>}</button>)}<div className="sidebar-note"><CloudSun size={18}/><b>Air quality context</b><span>{state.dataMode === 'live' ? 'Modeled regional estimates; not station measurements.' : 'Sample values are for interface demonstration only.'}</span></div></aside>
    <main className="main-content"><div className="mobile-kicker"><MapPin size={13}/> NEW DELHI <span>•</span> {state.dataMode === 'live' ? (analysis?.provenance?.data_classification?.replaceAll('_', ' ').toUpperCase() ?? 'MODELED AIR DATA') : 'ILLUSTRATIVE DEMO'}</div>{notice && <div className="notice"><Check size={16}/>{notice}<button onClick={() => { setNotice(''); if (state.needsDateReview) update({ needsDateReview: false }) }} aria-label="Dismiss notice"><X size={15}/></button></div>}{apiError && <div className="api-warning" role="status"><Info size={15}/>{apiError}</div>}{analysis?.status === 'unavailable' && <div className="api-warning" role="status"><Info size={15}/><span>Live estimates unavailable ({analysis.provenance?.error_code ?? 'provider_error'}). {analysis.provenance?.message ?? 'No provider estimates are available for this date.'} No illustrative values were substituted.</span></div>}
      {state.page === 'Today' && <Today blocks={state.blocks} planDate={state.planDate} projected={projected} busy={busy} analysis={analysis} explanation={explanation} dataMode={state.dataMode} onEdit={setEditor} onNavigate={page => update({ page })}/>}
      {state.page === 'Simulator' && <Simulator blocks={state.blocks} planDate={state.planDate} scenario={scenario} setScenario={setScenario} dataMode={state.dataMode} onApply={() => setConfirm(true)} onReject={() => { update({ page: 'Today' }); setNotice('Scenario rejected. Your existing day plan is unchanged.') }}/>} 
      {state.page === 'Impact' && <Impact state={state} update={update} projected={projected} blocks={state.blocks} planDate={state.planDate} dataMode={state.dataMode}/>}
      {state.page === 'Insights' && <Insights blocks={state.blocks} planDate={state.planDate} analysis={analysis} explanation={explanation} dataMode={state.dataMode} busy={busy} error={apiError} onNavigate={page => update({ page })}/>}
    </main></div>
    <nav className="mobile-nav">{nav.map(({name, icon: Icon}) => <button key={name} className={state.page === name ? 'selected' : ''} onClick={() => update({ page: name })}><Icon size={20}/><span>{name}</span></button>)}</nav>
    {editor && <ActivityEditor block={editor === 'new' ? null : editor} existing={state.blocks} onClose={() => setEditor(null)} onSave={updateBlock} onDelete={id => { update({ blocks: state.blocks.filter(b => b.id !== id) }); setEditor(null) }}/>} 
    {confirm && <div className="modal-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true"><span className="dialog-icon"><CalendarDays size={21}/></span><h2>Apply this scenario?</h2><p>This will update your actual day plan. You can still edit the activity afterward.</p><div className="dialog-actions"><button className="button secondary" onClick={() => setConfirm(false)}>Keep original</button><button className="button primary" onClick={applyScenario}>Apply to day plan</button></div></section></div>}
  </div>
}

function duration(start: string, end: string) { const [sh, sm] = start.split(':').map(Number); const [eh, em] = end.split(':').map(Number); return Math.max(0, (eh * 60 + em - sh * 60 - sm) / 60) }
function clock(time: string) { const [h, m] = time.split(':').map(Number); return `${String(h % 12 || 12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}` }
function dateLabel(date: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${date}T12:00:00`)) }
function titleBlock(title: string, sub: string, icon: typeof Wind = Wind) { const Icon = icon; return <div className="section-heading"><div><div className="eyebrow">{title}</div><h2>{sub}</h2></div><Icon size={19} className="heading-icon"/></div> }
function Disclosure({children}: {children: React.ReactNode}) { return <div className="disclosure"><Info size={15}/><span>{children}</span></div> }

function Today({ blocks, planDate, projected, busy, analysis, explanation, dataMode, onEdit, onNavigate }: { blocks: Block[]; planDate: string; projected: number | null; busy: boolean; analysis: any; explanation: Explanation | null; dataMode: DataMode; onEdit: (b: Block | 'new') => void; onNavigate: (p: Screen) => void }) {
  const rec = analysis?.recommendations?.[0]
  const recBlock = blocks.find(b => b.id === rec?.block_id)
  const firstResult = analysis?.blocks?.[0]
  const firstBlock = blocks.find(block => block.id === firstResult?.block_id)
  return <><div className="page-intro"><div className="eyebrow">PLAN FOR {dateLabel(planDate).toUpperCase()} <span className="live-dot"/> <span className={`sample-inline ${dataMode === 'live' ? 'live-label' : ''}`}>{dataMode === 'live' ? 'OPEN-METEO CAMS GLOBAL' : 'ILLUSTRATIVE DEMO'}</span></div><h1>Your day plan</h1><p>Review your schedule and the environmental estimates available for it.</p></div>
    <section className="air-summary card"><div className="air-icon"><Wind size={20}/></div><div className="air-main"><b>{firstBlock ? `${firstBlock.title} · ${clock(firstBlock.start)}–${clock(firstBlock.end)}` : 'No supported outdoor block'}</b><span>{firstResult ? `Mean PM2.5 concentration across ${Number(firstResult.estimated_hours).toFixed(1)} supported hour(s) · ${dataMode === 'live' ? 'modeled city-center estimate' : 'illustrative value'}` : 'No outdoor block estimate is available for this plan.'}</span></div><div className="air-reading"><strong>{firstResult?.mean_pm25_ug_m3 == null ? '—' : Number(firstResult.mean_pm25_ug_m3).toFixed(1)}</strong><span>µg/m³</span></div><span className={`badge ${dataMode === 'live' ? 'blue' : 'amber'}`}>{dataMode === 'live' ? 'Modeled' : 'Sample'}</span></section>
    {rec && <section className="recommendation"><div className="rec-symbol"><Clock3 size={21}/></div><div className="rec-body"><div className="eyebrow">{dataMode === 'live' ? 'OPTIONAL SCHEDULE COMPARISON' : 'ILLUSTRATIVE COMPARISON'}</div><h2>{dataMode === 'live' ? `Compare times for ${recBlock?.title ?? 'a flexible outdoor activity'}` : `Explore an example time comparison for ${recBlock?.title ?? 'this activity'}`}</h2><p>{rec.reason}</p><button className="button primary" onClick={() => onNavigate('Simulator')}>Explore in Simulator <ArrowRight size={17}/></button></div></section>}
    <div className="section-title-row"><div><div className="eyebrow">YOUR PLAN <span className="count-pill">{blocks.length} activities</span></div><h2>Schedule for {dateLabel(planDate)}</h2></div><button className="button secondary compact" onClick={() => onEdit('new')}><Plus size={16}/> Add activity</button></div>
    <section className="timeline card">{blocks.map((b, i) => { const value = estimateFor(b, analysis, dataMode); return <article className="activity-row" key={b.id}><div className={`timeline-dot dot-${b.environment.toLowerCase()}`}/><div className="activity-time">{clock(b.start)} – {clock(b.end)}</div><div className="activity-details"><div><h3>{b.title}</h3><span className="activity-place">{b.location} · {b.environment}</span></div><span className={`badge ${b.environment === 'Outdoor' ? 'amber' : 'neutral'}`}>{b.flexibility}</span></div>{value != null ? <div className="block-value"><b>{Number(value).toFixed(0)}</b><span>µg/m³{dataMode === 'illustrative' ? '*' : ''}</span></div> : <div className="block-value unknown">{b.environment !== 'Outdoor' ? 'Not estimated' : busy ? 'Updating…' : 'Unavailable'}</div>}<button className="row-edit" onClick={() => onEdit(b)} aria-label={`Edit ${b.title}`}>Edit</button>{i < blocks.length - 1 && <div className="timeline-line"/>}</article> })}</section>
    <section className="summary-row"><div className="summary-card"><div className="eyebrow">WHOLE-PLAN AMBIENT CONCENTRATION-TIME INDEX</div><div className="summary-value">{projected == null ? '—' : Math.round(projected)} <small>µg·h/m³</small></div><span>{busy ? 'Refreshing analysis…' : analysis?.summary?.coverage_fraction != null ? `${Math.round(analysis.summary.coverage_fraction * 100)}% outdoor interval coverage` : 'No estimate available'}</span></div><div className="optimal-card"><span className="round-icon"><Leaf size={18}/></span><div><b>Compare a flexible activity</b><p>See whether the source has estimates for another time window. A modeled difference is not a personal exposure result.</p></div><ChevronRight size={18}/></div></section>
    <Disclosure>{explanation ? `${explanation.headline}. ${explanation.explanation} ${explanation.next_step} ` : ''}{dataMode === 'live' ? `${analysis?.provenance?.model ?? 'CAMS Global modeled forecast'} · approx. 45 km native grid and 3-hourly resolution. Not a station observation. Indoor and missing intervals are excluded.` : 'Illustrative sample values, not live Delhi observations. Demo mode uses fixture data only.'} Ambient concentration-time index is not personal inhaled dose.</Disclosure>
  </>
}

function Simulator({ blocks, planDate, scenario, setScenario, dataMode, onApply, onReject }: { blocks: Block[]; planDate: string; scenario: 'earlier' | 'indoor'; setScenario: (v: 'earlier' | 'indoor') => void; dataMode: DataMode; onApply: () => void; onReject: () => void }) {
  const [comparisonRecord, setComparisonRecord] = useState<{ requestKey: string; result: any } | null>(null)
  const [comparisonErrorRecord, setComparisonErrorRecord] = useState<{ requestKey: string; error: string; busy: boolean }>({ requestKey: '', error: '', busy: true })
  const [scenarioExplanation, setScenarioExplanation] = useState<Explanation | null>(null)
  const run = blocks.find(b => b.id === 'run')
  const comparisonKey = useMemo(() => JSON.stringify([planDate, dataMode, scenario, blocks]), [planDate, dataMode, scenario, blocks])
  const comparisonPending = comparisonErrorRecord.requestKey !== comparisonKey || comparisonErrorRecord.busy
  const comparison = analysisForRequest(comparisonRecord, comparisonKey, comparisonPending)
  const comparisonError = comparisonErrorRecord.requestKey === comparisonKey ? comparisonErrorRecord.error : ''
  useEffect(() => {
    if (!API || !run) { setComparisonRecord(null); setComparisonErrorRecord({ requestKey: comparisonKey, error: '', busy: false }); return }
    const abort = new AbortController()
    setComparisonRecord(null)
    setComparisonErrorRecord({ requestKey: comparisonKey, error: '', busy: true })
    const alternative = { ...run, start: scenario === 'earlier' ? '16:00' : run.start, end: scenario === 'earlier' ? '17:00' : run.end, environment: scenario === 'indoor' ? 'indoor' : 'outdoor', pm25: dataMode === 'illustrative' && scenario !== 'indoor' ? 110 : null }
    const plan = (items: Block[]) => analysisPayload(items, dataMode, planDate)
    fetch(`${API}/api/scenarios/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseline: plan(blocks), alternatives: [plan(blocks.map(b => b.id === run.id ? alternative : b))] }), signal: abort.signal })
      .then(async response => {
        if (!response.ok) throw Object.assign(new Error('Scenario comparison failed'), { status: response.status })
        return response.json()
      })
      .then(result => {
        if (abort.signal.aborted) return
        setComparisonRecord({ requestKey: comparisonKey, result })
        setComparisonErrorRecord({ requestKey: comparisonKey, error: '', busy: false })
      })
      .catch(error => { if (!abort.signal.aborted) setComparisonErrorRecord({ requestKey: comparisonKey, error: classifyApiFailure(error) ?? '', busy: false }) })
    return () => abort.abort()
  }, [blocks, run, scenario, dataMode, planDate, comparisonKey])
  useEffect(() => {
    const scenarioResult = comparison?.alternatives?.[0]
    if (!API || !comparison?.baseline || !scenarioResult) { setScenarioExplanation(null); return }
    const abort = new AbortController()
    fetch(`${API}/api/explanations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(explanationPayload(comparison.baseline, blocks, scenarioResult)), signal: abort.signal })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Scenario explanation failed (${r.status})`)))
      .then(result => setScenarioExplanation(result))
      .catch(() => { if (!abort.signal.aborted) setScenarioExplanation(null) })
    return () => abort.abort()
  }, [comparison, blocks])
  const baseline = dataMode === 'illustrative' ? run?.pm25 ?? null : comparison?.baseline?.blocks?.find((b: any) => b.block_id === run?.id)?.mean_pm25_ug_m3 ?? null
  const proposed = scenario === 'indoor' ? null : dataMode === 'illustrative' ? 110 : comparison?.alternatives?.[0]?.result?.blocks?.find((b: any) => b.block_id === run?.id)?.mean_pm25_ug_m3 ?? null
  const scenarioStatus = comparison?.alternatives?.[0]?.status
  const activityMeanDifference = comparableScenarioDifference(scenarioStatus, baseline, proposed)
  return <><div className="page-intro"><div className="eyebrow"><span className="badge blue"><Compass size={13}/> WHAT-IF SIMULATOR</span></div><h1>Compare schedule changes</h1><p>Plan date: {dateLabel(planDate)}. Modeled differences remain inconclusive and do not establish personal exposure changes.</p></div>
    {!run && <div className="api-warning" role="status">The current plan has no simulator activity. The simulator is available for the starter evening-run activity.</div>}
    <section className="card scenario-card"><div className="scenario-top"><span className="round-icon"><Activity size={19}/></span><div><div className="eyebrow">MODIFYING ACTIVITY</div><h2>{run?.title ?? 'No supported activity selected'}</h2><span>{run?.location}</span></div></div><div className="eyebrow choice-label">SIMULATION OPTION</div><div className="choice-group"><button disabled={!run} className={`choice ${scenario === 'earlier' ? 'chosen' : ''}`} onClick={() => setScenario('earlier')}><Clock3 size={15}/> Shift window to 4:00 PM</button><button disabled={!run} className={`choice ${scenario === 'indoor' ? 'chosen' : ''}`} onClick={() => setScenario('indoor')}><Wind size={15}/> Indoor alternative</button></div></section>
    <div className="compare-grid"><div className="compare-card baseline"><span className="eyebrow">CURRENT ACTIVITY · MEAN PM2.5</span><span className="badge amber">Baseline</span><h3>{run ? clock(run.start) : '—'}</h3><strong>{baseline == null ? '—' : Number(baseline).toFixed(1)} <small>{baseline == null ? 'not estimated' : `µg/m³${dataMode === 'illustrative' ? '*' : ''}`}</small></strong><p>{dataMode === 'live' ? 'Modeled activity mean concentration.' : 'Illustrative activity mean concentration.'}</p></div><div className="compare-card proposed"><span className="eyebrow">PROPOSED ACTIVITY · MEAN PM2.5</span><span className="badge green">Scenario</span><h3>{scenario === 'earlier' ? '4:00 PM' : 'Indoor option'}</h3><strong>{proposed == null ? '—' : Number(proposed).toFixed(1)} <small>{proposed == null ? 'not estimated' : `µg/m³${dataMode === 'illustrative' ? '*' : ''}`}</small></strong><p>{proposed == null ? 'No indoor air-quality estimate is available.' : dataMode === 'live' ? 'Modeled activity mean concentration.' : 'Illustrative value only; not a live observation.'}</p></div></div>
    <section className="card comparison"><div className="section-heading"><div><div className="eyebrow">ACTIVITY CONCENTRATION COMPARISON</div><h2>{scenario === 'indoor' ? 'Indoor data unavailable' : 'Mean PM2.5 by activity time'}</h2></div><ArrowDownRight className="heading-icon"/></div>{scenario === 'earlier' && activityMeanDifference != null ? <><div className="bar-compare"><div><span>Current mean · {Number(baseline).toFixed(1)} µg/m³</span><div className="bar-track"><i style={{width:'100%'}}/></div></div><div><span>Proposed mean · {Number(proposed).toFixed(1)} µg/m³</span><div className="bar-track alt"><i style={{width:`${Math.round((baseline ? Number(proposed) / Number(baseline) * 100 : 0))}%`}}/></div></div></div><p className="muted">Difference between these activity mean concentrations: {activityMeanDifference.toFixed(1)} µg/m³. The API marks this live comparison inconclusive; it is not an exposure or health result.</p></> : <p className="muted">{comparisonError || (scenario === 'indoor' ? 'No indoor measurement or validated model is available. No numerical comparison is shown.' : comparison ? `No numerical difference is shown for API status “${scenarioStatus ?? 'unknown'}”; supported intervals are not comparable.` : 'Waiting for comparable API results. No numerical difference is shown while the request is pending.')}</p>}</section>
    <Disclosure>{dataMode === 'live' ? `CAMS Global modeled forecast · approximately 45 km grid and 3-hourly native resolution. API comparison status: ${scenarioStatus ?? 'updating'}. Differences do not establish personal exposure or health-risk changes.` : 'Illustrative values are examples, not live observations or validated forecasts. No numerical difference is presented for illustrative-only comparisons.'}</Disclosure>
    {dataMode === 'live' && <section className="card live-comparison"><div className="section-heading"><div><div className="eyebrow">WHOLE-PLAN CONCENTRATION-TIME INDEX</div><h2>Plan totals (not activity means)</h2></div><RefreshCw size={18} className="heading-icon"/></div><div className="live-index-row"><span>Baseline whole-plan index</span><b>{comparison?.baseline?.summary?.concentration_time_index ?? 'Unavailable'} <small>µg·h/m³</small></b></div><div className="live-index-row"><span>Alternative whole-plan index</span><b>{scenarioStatus === 'inconclusive' ? (comparison?.alternatives?.[0]?.result?.summary?.concentration_time_index ?? 'Unavailable') : 'Not comparable'} <small>{scenarioStatus === 'inconclusive' ? 'µg·h/m³' : ''}</small></b></div><p className="muted">{scenarioExplanation?.scenario_explanation ?? comparison?.alternatives?.[0]?.comparison_note ?? comparisonError ?? 'Waiting for the API response. No demo value is used in live mode.'}</p>{scenarioExplanation && <p className="muted">{scenarioExplanation.explanation}</p>}</section>}
    <div className="sim-actions"><button disabled={!run} className="button primary wide" onClick={onApply}><Check size={17}/> Apply to Day Plan</button><button className="button secondary wide" onClick={onReject}>Keep original schedule</button></div>
  </>
}

function Impact({ state, update, projected, blocks, planDate, dataMode }: { state: Stored; update: (p: Partial<Stored>) => void; projected: number | null; blocks: Block[]; planDate: string; dataMode: DataMode }) {
  const reportKey = useMemo(() => analysisRequestKey(planDate, blocks, dataMode), [planDate, blocks, dataMode])
  const [reportRecord, setReportRecord] = useState<{ requestKey: string; result: any } | null>(null)
  const [reportRequest, setReportRequest] = useState<{ requestKey: string; busy: boolean }>({ requestKey: '', busy: true })
  const reportBusy = reportRequest.requestKey !== reportKey || reportRequest.busy
  const report = analysisForRequest(reportRecord, reportKey, reportBusy)
  const flexibleOutdoor = blocks.find(block => block.environment === 'Outdoor' && block.flexibility !== 'Fixed')
  useEffect(() => {
    if (!API) { setReportRequest({ requestKey: reportKey, busy: false }); return }
    const abort = new AbortController()
    setReportRequest({ requestKey: reportKey, busy: true })
    fetch(`${API}/api/reports/end-of-day`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(analysisPayload(blocks, dataMode, planDate)), signal: abort.signal })
      .then(response => response.ok ? response.json() : null)
      .then(result => {
        if (abort.signal.aborted) return
        if (result) setReportRecord({ requestKey: reportKey, result })
        setReportRequest({ requestKey: reportKey, busy: false })
      })
      .catch(() => { if (!abort.signal.aborted) setReportRequest({ requestKey: reportKey, busy: false }) })
    return () => abort.abort()
  }, [blocks, dataMode, planDate, reportKey])
  const record = (choice: string, followThrough = 'unknown') => {
    if (!API || !flexibleOutdoor) return
    const decision = choice === 'Accepted' ? 'accepted' : choice === 'Modified' ? 'modified' : choice === 'Rejected' ? 'rejected' : 'kept'
    fetch(`${API}/api/impact/records`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recommendation_id: `compare-${flexibleOutdoor.id}`, decision, reason: null, follow_through: followThrough }) }).catch(() => undefined)
  }
  const options = ['Accepted', 'Modified', 'Rejected']
  const constrainedBlocks = blocks.filter(block => block.flexibility !== 'Flexible')
  return <><div className="page-intro"><div className="eyebrow">THIS PLAN’S FEEDBACK</div><h1>Plan feedback</h1><p>Record whether this schedule prompt fits your routine. Choices are self-reported and do not demonstrate a health outcome.</p></div>
    <section className="feedback-card"><div className="eyebrow">SCHEDULE PROMPT · {dateLabel(planDate).toUpperCase()}</div>{flexibleOutdoor ? <><h2>Would comparing another time for {flexibleOutdoor.title} work for you?</h2><p>Record whether comparing or changing the time fits your schedule.</p><div className="feedback-options">{options.map(x => <button key={x} className={`choice ${state.feedback === x ? 'chosen' : ''}`} onClick={() => { update({ feedback: x }); record(x) }}>{state.feedback === x && <Check size={14}/>} {x}</button>)}</div>{state.feedback && <div className="feedback-confirm"><Check size={15}/> This plan’s response is stored in this browser: {state.feedback.toLowerCase()}.</div>}</> : <><h2>No flexible outdoor activity in this plan</h2><p>There is no schedule comparison prompt to record for this date.</p></>}</section>
    <div className="section-title-row impact-title"><div><div className="eyebrow">CURRENT PLAN · {dateLabel(planDate).toUpperCase()}</div><h2>Recorded choices</h2></div><span className="badge neutral">Browser-local</span></div>
    <div className="stats-grid"><div className="stat-card"><span>Decision for this plan</span><strong>{state.feedback || 'None'}</strong></div><div className="stat-card"><span>Self-reported follow-through</span><strong>{state.followed || 'Not recorded'}</strong></div><div className="stat-card"><span>Plan ambient concentration-time index</span><strong>{projected == null ? '—' : Math.round(projected)}<small>µg·h/m³</small></strong></div></div>
    <section className="card follow-card"><div className="section-heading"><div><div className="eyebrow">SELF-REPORTED FOLLOW-THROUGH</div><h2>Did you make the change?</h2></div><HeartPulse size={20} className="heading-icon"/></div>{flexibleOutdoor ? <><p>This is a self-report, not a measurement or verification.</p><div className="feedback-options">{['Followed', 'Partially', 'Not followed'].map(x => <button key={x} className={`choice ${state.followed === x ? 'chosen' : ''}`} onClick={() => { update({ followed: x }); record(state.feedback || 'Kept', x === 'Followed' ? 'complete' : x === 'Partially' ? 'partial' : 'not_followed') }}>{x}</button>)}</div>{state.followed && <div className="feedback-confirm"><Check size={15}/> Self-reported as “{state.followed.toLowerCase()}”.</div>}</> : <p>No flexible outdoor activity is available to associate with a follow-through response.</p>}</section>
    <section className="card constraint-card"><div className="section-heading"><div><div className="eyebrow">SCHEDULE CONSTRAINTS</div><h2>Activities marked fixed or limited</h2></div><SlidersHorizontal size={19} className="heading-icon"/></div>{constrainedBlocks.length ? constrainedBlocks.map(block => <div className="constraint-row" key={block.id}><span className="constraint-icon"><Clock3 size={16}/></span><div><b>{block.title} · {clock(block.start)}–{clock(block.end)}</b><p>Constraint recorded in this plan.</p></div><span className={`badge ${block.flexibility === 'Fixed' ? 'blue' : 'amber'}`}>{block.flexibility}</span></div>) : <p className="muted">No activities are marked fixed or limited in this plan.</p>}</section>
    <section className="metric-card"><div className="metric-kicker">PLAN ESTIMATE SUMMARY <span className="badge neutral">{report?.report_status ?? 'Provisional'}</span></div><h2>Supported modeled intervals</h2><p>{report ? `${report.summary.evaluated_blocks} supported block(s), ${report.summary.excluded_blocks} excluded. Coverage: ${Math.round(report.summary.coverage_fraction * 100)}%.` : `${projected == null ? '—' : Math.round(projected)} µg·h/m³ ambient concentration-time index for this plan.`}</p><p>This is a plan estimate, not a record of completed activity. Cigarette-equivalent output remains disabled.</p><button className="text-button" onClick={() => update({ page: 'Insights' })}>Review data and assumptions <ArrowRight size={15}/></button></section>
    <Disclosure>Feedback choices are stored in this browser for the selected plan date. The API does not retain impact history. Self-reported follow-through is not verification of ambient conditions or personal exposure.</Disclosure>
  </>
}

function Insights({ blocks, planDate, analysis, explanation, dataMode, busy, error, onNavigate }: { blocks: Block[]; planDate: string; analysis: any; explanation: Explanation | null; dataMode: DataMode; busy: boolean; error: string; onNavigate: (p: Screen) => void }) {
  const outdoor = blocks.filter(b => b.environment === 'Outdoor')
  const finding = derivePlanFinding({ analysis, blocks, dataMode, busy, error })
  const chartSource = dataMode === 'illustrative' ? [] : (analysis?.hourly ?? []).map((point: any) => ({ label: new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(new Date(point.timestamp)), pm25_ug_m3: point.pm25_ug_m3 }))
  const chartStride = Math.max(1, Math.ceil(chartSource.length / 8))
  const chartPoints = chartSource.filter((_: any, index: number) => index % chartStride === 0).slice(0, 8)
  const chartMax = Math.max(1, ...chartPoints.map((point: any) => point.pm25_ug_m3 ?? 0))
  return <><div className="page-intro"><div className="eyebrow"><Sparkles size={14}/> EVIDENCE & CONTEXT</div><h1>Atmospheric insights</h1><p>Plan date: {dateLabel(planDate)}. Findings below reflect only the current plan and available estimates.</p></div>
    <section className="insight-feature"><div className="eyebrow"><span className="live-dot"/> {finding.state === 'available' || finding.state === 'partial' ? 'CURRENT PLAN SUMMARY' : finding.state.toUpperCase()}</div><h2>{finding.headline}</h2><p>{finding.body}</p>{finding.state !== 'error' && finding.state !== 'unavailable' && finding.state !== 'insufficient' && <button className="button secondary" onClick={() => onNavigate('Simulator')}>Compare in Simulator <ArrowRight size={16}/></button>}</section>
    <section className="card profile-card"><div className="section-heading"><div><div className="eyebrow">SCHEDULE DATA</div><h2>Outdoor blocks for {dateLabel(planDate)}</h2></div><CalendarDays size={19} className="heading-icon"/></div>{outdoor.length === 0 ? <p className="muted">No outdoor blocks in this plan date.</p> : outdoor.map(b => <div className="profile-row" key={b.id}><div><b>{b.title}</b><span>{clock(b.start)} · {b.location}</span></div><strong>{estimateFor(b, analysis, dataMode) == null ? '—' : Number(estimateFor(b, analysis, dataMode)).toFixed(1)}<small> {estimateFor(b, analysis, dataMode) == null ? 'not estimated' : 'µg/m³'}</small></strong></div>)}{chartPoints.length ? <div className="chart-placeholder"><div className="chart-grid"><span>{Math.round(chartMax)}</span><span>{Math.round(chartMax * .75)}</span><span>{Math.round(chartMax * .5)}</span><span>{Math.round(chartMax * .25)}</span></div><div className="chart-bars">{chartPoints.map((point: any, i: number) => <div key={i} className={`chart-bar-wrap ${point.pm25_ug_m3 == null ? 'missing' : ''}`}><div className="chart-bar" style={{height:`${point.pm25_ug_m3 == null ? 0 : point.pm25_ug_m3/chartMax*100}%`}}/><span>{point.label}</span></div>)}</div></div> : <p className="muted">{error || (busy ? 'Waiting for the current plan analysis.' : dataMode === 'live' ? 'No hourly series is available for this plan date.' : 'Illustrative mode does not provide a time series.')}</p>}<span className="chart-caption">{chartPoints.length ? `Open-Meteo modeled PM2.5 series in µg/m³ · ${analysis?.provenance?.data_classification?.replaceAll('_', ' ') ?? 'modeled'} · ${analysis?.provenance?.spatial_resolution_km ?? 45} km grid · all plan locations use the Delhi city-center coordinate` : 'No time series is shown without hourly source data.'}</span></section>
    <div className="insight-grid"><div className="mini-info"><Wind size={19}/><b>Source type</b><span>{analysis?.provenance?.model ?? (dataMode === 'illustrative' ? 'Illustrative mock data' : 'Unavailable')}</span></div><div className="mini-info"><Clock3 size={19}/><b>Retrieved</b><span>{analysis?.provenance?.retrieved_at ? new Date(analysis.provenance.retrieved_at).toLocaleString() : 'No provider response'}</span></div></div>
    <section className="card source-card"><div className="section-heading"><div><div className="eyebrow">ABOUT THE ESTIMATE</div><h2>What these numbers mean</h2></div><CircleHelp size={19} className="heading-icon"/></div><ul><li>PM2.5 concentration and AQI are different measures; this prototype shows PM2.5 only.</li><li>{dataMode === 'live' ? 'Open-Meteo values are modeled forecasts or archived forecasts, not Delhi station measurements.' : 'Illustrative values here are not live Delhi readings.'}</li><li>All activity labels currently use the same New Delhi city-center coordinate; locations are not geocoded.</li><li>Outdoor ambient concentration does not directly measure inhaled dose. Indoor blocks are not assumed equal to outdoor air.</li><li>Unsupported and missing intervals remain unknown rather than being counted as zero.</li></ul><Disclosure>{explanation ? `${explanation.headline}. ${explanation.explanation} ${explanation.next_step} ` : ''}{analysis ? `Analysis status: ${analysis.status}. Source: ${analysis.provenance?.model ?? analysis.provenance?.provider}.` : dataMode === 'live' ? 'Waiting for Open-Meteo response; live values are not substituted with fixtures.' : 'Illustrative fixtures are active; no provider values are used.'}</Disclosure></section>
  </>
}

function ActivityEditor({ block, existing, onClose, onSave, onDelete }: { block: Block | null; existing: Block[]; onClose: () => void; onSave: (b: Block) => void; onDelete: (id: string) => void }) {
  const [form, setForm] = useState<Block>(block ?? { id: crypto.randomUUID(), title: '', start: '12:00', end: '13:00', location: '', environment: 'Outdoor', flexibility: 'Flexible', pm25: null })
  const [error, setError] = useState('')
  const set = (key: keyof Block, value: any) => setForm(f => ({ ...f, [key]: value }))
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><form className="dialog editor-dialog" onSubmit={e => { e.preventDefault(); if (form.end <= form.start) { setError('End time must be later than start time.'); return } const overlap = existing.find(b => b.id !== form.id && form.start < b.end && b.start < form.end); if (overlap) { setError(`This activity overlaps “${overlap.title}”. Adjust the time before saving.`); return } setError(''); onSave(form) }}><div className="dialog-head"><div><div className="eyebrow">DAY PLAN</div><h2>{block ? 'Edit activity' : 'Add activity'}</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={18}/></button></div><label>Activity name<input required value={form.title} onChange={e => set('title', e.target.value)} placeholder="e.g. Outdoor walk"/></label><div className="form-grid"><label>Start<input type="time" required value={form.start} onChange={e => set('start', e.target.value)}/></label><label>End<input type="time" required value={form.end} onChange={e => set('end', e.target.value)}/></label></div><label>Location or area<input value={form.location} onChange={e => set('location', e.target.value)} placeholder="Approximate area is enough"/></label><div className="form-grid"><label>Environment<select value={form.environment} onChange={e => set('environment', e.target.value)}>{['Outdoor','Indoor','Mixed','Unknown'].map(x => <option key={x}>{x}</option>)}</select></label><label>Flexibility<select value={form.flexibility} onChange={e => set('flexibility', e.target.value)}>{['Fixed','Limited','Flexible'].map(x => <option key={x}>{x}</option>)}</select></label></div>{error && <p className="form-error">{error}</p>}<p className="form-hint"><Info size={14}/> Activity edits trigger updated analysis. Indoor concentrations are not inferred from outdoor values.</p><div className="dialog-actions">{block && <button type="button" className="button danger" onClick={() => onDelete(block.id)}>Remove</button>}<button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" type="submit">Save activity</button></div></form></div>
}

export default App
