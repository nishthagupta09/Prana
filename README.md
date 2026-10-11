# Prana

Prana is an AI-assisted personal air-exposure planning prototype. It has a React/Vite frontend and one FastAPI backend. The backend integrates Open-Meteo Air Quality API PM2.5 series from the CAMS Global model and can use Gemini to explain already-computed results. AWS remains the deployment target; the backend reads Gemini credentials from its runtime environment.

## Local development

Requirements: Python 3.13 and Node.js/npm.

Install dependencies from the repository root:

```powershell
py -3.13 -m pip install -r backend/requirements.txt
cd frontend
npm.cmd ci
```

Start the backend in one PowerShell terminal:

```powershell
cd backend
py -3.13 -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8010
```

Start Vite in another terminal:

```powershell
cd frontend
npm.cmd run dev
```

The development frontend reads `VITE_API_URL` from `frontend/.env.development`, which targets `http://127.0.0.1:8010`. Copy `frontend/.env.example` to `frontend/.env.local` to override it; Vite loads `.env.local` with higher priority. Set `VITE_API_URL` in the frontend build environment when producing a build that should call a deployed API. This URL is public frontend configuration, so do not put provider credentials in Vite variables. The backend allows the Vite origins `localhost:5173` and `127.0.0.1:5173`.

## Optional Gemini explanations

Gemini calls run only in the backend. When the API key is absent, illustrative data is in use, or the provider fails or returns invalid content, the API returns a deterministic explanation instead. The frontend never receives the Gemini key.

Set the backend process environment variables before starting FastAPI. `GEMINI_MODEL` defaults to `gemini-3.8-flash` and can be changed without rebuilding the frontend:

```powershell
$env:GEMINI_API_KEY = "your-key-from-google-ai-studio"
$env:GEMINI_MODEL = "gemini-3.8-flash"
```

Do not commit the key, put it in a `VITE_` variable, or send it to the browser. For AWS hosting, provide it to the backend runtime from a managed secret store or protected Lambda environment configuration. Gemini API usage may be subject to quotas and charges for the selected model.

The explanation request to Gemini contains aggregate plan coverage, source classification, deterministic recommendation status, aggregate missing-data reasons, and scenario status. It omits PM2.5 values, concentration-time indices, activity IDs/names/times, coordinates, personal identifiers, and raw hourly history.

The model returns short structured text fields which FastAPI validates. Numeric claims and unsupported health/comparative language are rejected; inconclusive scenario language is set deterministically. Gemini does not calculate or override numerical results or scheduling recommendations. See Google's [Gemini model list](https://ai.google.dev/gemini-api/docs/models) and [Python SDK documentation](https://googleapis.github.io/python-genai/).

## Data behavior and limits

- The default mode is **Open-Meteo modeled**. The frontend sends schedule requests to FastAPI; only the backend calls Open-Meteo. Provider failures are shown as unavailable and do not silently fall back to demo values.
- Choose **Illustrative demo** in the header to use fixtures. Those values are examples only, not live Delhi observations.
- The initial coordinates are New Delhi city center (`28.6139, 77.2090`). Activity location names are labels only: they are not geocoded, and every activity uses the same city-center coordinate. This is a regional estimate, not a route or park measurement.
- Requests pin the CAMS Global domain. The provider describes its native resolution as approximately 45 km and 3-hourly. The response is a modeled forecast, or an archived forecast for past dates; it is not a CPCB station measurement. The API supports a bounded past/future date window, and requests outside it are unavailable.
- The calculation engine is deterministic Python. It integrates supported outdoor PM2.5 intervals as an ambient concentration-time index (`µg·h/m³`). It excludes indoor, mixed, unknown and missing intervals. Missing values and uncovered time are not counted as zero.
- AQI and PM2.5 concentration are distinct. Ambient concentration is not personal inhaled dose or individual health risk. Scenario differences remain inconclusive because model uncertainty is not quantified.
- Cigarette-equivalent output remains disabled until its methodology is validated.
- Day plans, feedback selections and follow-through are stored in browser localStorage by selected local date. A new date starts with a blank plan; saved plans remain available by choosing their date. Existing single-plan data from the previous version is preserved and assigned the current local date because its original date was not stored; the UI asks you to verify that date. The API does not retain impact history, so the Impact screen is a current-plan feedback form, not a seven-day history.

## Validation

Run backend tests (Open-Meteo and Gemini calls are mocked):

```powershell
cd backend
py -3.13 -m unittest discover -s tests -v
```

Run frontend logic regression tests:

```powershell
cd frontend
npm.cmd test
```

Build the frontend:

```powershell
cd frontend
npm.cmd run build
```

## Structure

- `frontend/src/App.tsx`: shared local plan state, four screens, API calls and reusable UI components.
- `frontend/src/styles.css`: responsive styling based on the approved Stitch `DESIGN.md` and screenshots.
- `backend/app/main.py`: FastAPI schemas, deterministic calculations and API operations.
- `backend/app/services/open_meteo.py`: bounded, cached CAMS Global PM2.5 adapter and response validation.
- `backend/app/services/gemini.py`: optional Gemini explanation service, structured input/output validation and deterministic fallback.
- `backend/tests/`: API, deterministic calculation, failure handling and provider-adapter tests.
- `docs/`: concept and architecture references. `stitch reference/` is design reference material and was not edited during this integration.
