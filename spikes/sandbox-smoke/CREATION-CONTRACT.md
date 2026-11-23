# OpenSandbox creation contract smoke

`run-creation-contract-docker.ps1` runs a bounded real-service probe against the configured OpenSandbox deployment. It uses a unique metadata tag and cleans every sandbox it discovers by ID.

The probe records four observations. It attempts repeated creates with the same metadata, lists matching resources through the SDK's paginated metadata filter, repeats deletion and confirms 404 after deletion, and aborts one client-side create request before checking for a matching resource.

The result deliberately distinguishes observed behavior from a provider guarantee. OpenSandbox SDK 1.2.1 exposes no creation idempotency key and no server-side create-termination receipt. A client abort therefore cannot prove that the server stopped creating. A repeated metadata value is a discovery label, not an idempotency contract.

Run from PowerShell with a configured `OPEN_SANDBOX_API_KEY`. The report is written to `.runtime/sandbox-smoke/creation-contract-smoke.json` and contains no API key.
