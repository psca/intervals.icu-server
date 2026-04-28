#!/bin/bash
# Test candidate Phase 2 endpoints before implementation
# Usage: INTERVALS_API_KEY=your_key INTERVALS_ATHLETE_ID=your_id bash scripts/test-new-endpoints.sh

BASE="https://intervals.icu/api/v1"
AUTH="API_KEY:${INTERVALS_API_KEY}"
ID="${INTERVALS_ATHLETE_ID}"

if [[ -z "$INTERVALS_API_KEY" || -z "$INTERVALS_ATHLETE_ID" ]]; then
  echo "Usage: INTERVALS_API_KEY=xxx INTERVALS_ATHLETE_ID=yyy bash $0"
  exit 1
fi

check() {
  local label="$1"
  local url="$2"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" -u "$AUTH" "$url")
  if [[ "$status" == "200" ]]; then
    echo "✓ $label ($status)"
  else
    echo "✗ $label ($status)"
  fi
}

echo "Testing Phase 2 candidate endpoints..."
echo ""

check "get_athlete_profile      GET /athlete/{id}"                   "$BASE/athlete/$ID"
check "search_activities        GET /athlete/{id}/activities/search" "$BASE/athlete/$ID/activities/search?query=run&limit=1"
check "get_power_curves         GET /athlete/{id}/power-curves"      "$BASE/athlete/$ID/power-curves?oldest=2026-01-01&newest=2026-03-26"
check "get_pace_curves          GET /athlete/{id}/pace-curves"       "$BASE/athlete/$ID/pace-curves?oldest=2026-01-01&newest=2026-03-26"
check "get_hr_curves            GET /athlete/{id}/hr-curves"         "$BASE/athlete/$ID/hr-curves?oldest=2026-01-01&newest=2026-03-26"
check "get_gear                 GET /athlete/{id}/gear"              "$BASE/athlete/$ID/gear"

echo ""
echo "Done. Any 401/403 = access issue. 404 = wrong path. 400 = bad params."
