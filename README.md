# Prana

Prana is an AI-assisted personal air-exposure planning prototype. It has a React/Vite frontend and one FastAPI backend. The backend integrates Open-Meteo Air Quality API PM2.5 series from the CAMS Global model and can use Amazon Bedrock to explain already-computed results. AWS deployment is not configured.

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

## Optional Bedrock explanations

Bedrock calls run only in the backend. When either model or region configuration is absent, illustrative data is in use, or the provider fails, the API returns a deterministic explanation instead. The frontend never receives AWS credentials.

Set backend process environment variables before starting FastAPI:

```powershell
$env:AWS_REGION = "your-bedrock-region"
$env:BEDROCK_MODEL_ID = "your-converse-compatible-model-id"
```

The AWS SDK uses its standard credential chain (for example, a local AWS profile or an assigned runtime role). Do not commit credentials. The caller needs `bedrock:InvokeModel` permission for the selected model, and some model providers require account access setup. On-demand calls are billed by the selected model and token usage. Plan edits and scenario comparisons can trigger explanation requests; illustrative mode does not call Bedrock. See the [Bedrock inference prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-prereq.html), [model access requirements](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html), and [current pricing](https://aws.amazon.com/bedrock/pricing/).

The explanation request contains calculated summary values, source/model metadata, activity times and categorical environment/flexibility constraints, plus missing-data and scenario statuses. It omits activity names, place labels, coordinates, and raw hourly history. Account-level Bedrock invocation logging settings may affect retention; review those settings before sending real user plans.

The model returns short text fields which FastAPI validates. Numeric claims and unsupported health/comparative language are rejected; inconclusive scenario language is set deterministically. Bedrock does not calculate or override numerical results.

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

Run backend tests (Open-Meteo and Bedrock calls are mocked):

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
- `backend/app/services/bedrock.py`: optional Bedrock explanation service, structured input/output validation and deterministic fallback.
- `backend/tests/`: API, deterministic calculation, failure handling and provider-adapter tests.
- `docs/`: concept and architecture references. `stitch reference/` is design reference material and was not edited during this integration.
