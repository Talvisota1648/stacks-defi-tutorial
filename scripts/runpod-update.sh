#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Uses the already installed RunPod conda environment; does not modify system Python.
if [ -f /workspace/miniforge3/etc/profile.d/conda.sh ]; then
  source /workspace/miniforge3/etc/profile.d/conda.sh
  conda activate osc
fi
python -m pip install -r backend/requirements.txt
node scripts/init-env.cjs
node scripts/presentation-access.cjs
(cd backend && python -m osc.download_model)
(cd frontend && npm ci && CIRCLE_NODE_TOTAL=2 NODE_OPTIONS=--max-old-space-size=1536 NEXT_TELEMETRY_DISABLED=1 npm run build)
(cd backend && python -m osc.control restart --replace --public)
