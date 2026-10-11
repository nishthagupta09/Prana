export function localDate(now?: Date): string
export function loadStoredState(raw: string | null, today: string, starterBlocks: any[]): any
export function selectPlanDate(state: any, date: string): any
export function stateForStorage(state: any): any
export function analysisRequestKey(planDate: string, blocks: any[], dataMode: string): string
export function analysisForRequest(record: any, requestKey: string, pending?: boolean): any | null
export function comparableScenarioDifference(status: string | undefined, baselineMean: number | null, alternativeMean: number | null): number | null
export function defaultScenarioSelection(): 'earlier'
export function comparisonRequestKey(planDate: string, dataMode: string, scenario: string, targetBlockId: string | null | undefined, shifted: any, blocks: any[]): string
export function explanationRequestKey(planDate: string, dataMode: string, blocks: any[], scenario?: any): string
export function classifyApiFailure(error: any): string | null
export function derivePlanFinding(input: { analysis: any; blocks: any[]; dataMode: string; busy: boolean; error: string }): { headline: string; body: string; state: string }
export function timeGreeting(now?: Date): string
export function calculateShiftedWindow(start: string, end: string): { start: string; end: string }
export function applyScenarioToState(state: any, targetBlockId: string, scenarioUpdates: any): { success: boolean; error?: string; state: any }
