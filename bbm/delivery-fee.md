# Delivery fee calculation

How staff quote a delivery fee on a booking. Save as `docs/delivery-fee.md` in the repo.

## Data sources

Four DB tables + one RPC + one API route own everything.

| Where | What |
|---|---|
| `delivery_settings` (single row, id=1) | HQ coords (`hq_latitude`, `hq_longitude`, `hq_address`). Origin for all road-distance calculations. |
| `delivery_area_presets` | The clickable pill list (Airport, Uluwatu, Ubud, Seminyak, Canggu, Kuta, Pererenan, Sanur). Columns: `area_name`, `fee`, `sort_order`, `active`, optional `latitude`/`longitude`. |
| `delivery_km_rates` | The km formula parameters per plan tier (`daily`, `weekly`, `fortnight`, `monthly`, `biannual`). Columns: `base_fee`, `free_km_per_way`, `per_km_rate`, `round_trip_multiplier`. |
| `delivery_lookups` | Cache of address → coords + road distance. Populated on first Google Maps hit; served from here on repeat. Reset with `TRUNCATE delivery_lookups`. |
| RPC `calculate_delivery_fee(p_km_one_way, p_rental_days) → integer` | Pure math. No side effects. Used by frontend + API route. Chatbot-ready. |
| Route `POST /api/delivery/estimate` | Address in, fee out. Calls Google Geocoding → Distance Matrix → RPC. Caches result. |

## The math

```
plan_tier =  daily      if rental_days ≤ 6
             weekly     if rental_days ≤ 13
             fortnight  if rental_days ≤ 29
             monthly    if rental_days ≤ 179
             biannual   otherwise

rate = delivery_km_rates[plan_tier]

excess_km = max(0, km_one_way - rate.free_km_per_way)

fee = rate.base_fee + excess_km × rate.round_trip_multiplier × rate.per_km_rate
```

**Worked example:** delivery to Buleleng (80 km one way), monthly rental
- Plan tier: `monthly` (base 0)
- Excess: `max(0, 80 − 30) = 50 km` per way
- Round-trip: `50 × 2 = 100 km`
- Excess fee: `100 × 6,000 = Rp 600,000`
- Total: `0 + 600,000 = Rp 600,000`

**Worked example:** delivery to Canggu (~5 km), daily rental
- Plan tier: `daily` (base 100,000)
- Excess: `max(0, 5 − 30) = 0`
- Total: `Rp 100,000`

## Three input paths (staff's view of the form)

All three paths land at the same RPC and produce the same fee output. Staff picks whichever is fastest for the case.

### 1. Preset pill click
- Staff clicks one of the 8 area pills → the fee input is filled with that preset's flat amount → done.
- **Use when:** delivery destination matches a named area we quote a flat fee for.
- **Pros:** one click, zero API cost, works offline.
- **Bypasses the RPC** — the preset's `fee` column is the whole answer.

### 2. Address lookup (Google Maps)
- Staff types the delivery address in the "Delivery address" textarea → clicks **"+ From km" → "🗺 From address"**.
- The `/api/delivery/estimate` route runs:
  1. Auth check
  2. Normalize address (lowercase, single-space)
  3. Cache check on `delivery_lookups`
  4. On miss: **Google Geocoding API** (address → lat/lng) then **Google Distance Matrix API** (HQ → destination → road distance)
  5. Insert into `delivery_lookups`
  6. `calculate_delivery_fee(km, rental_days)` RPC → fee
- Response `{ km, fee, formatted_address, latitude, longitude, cached }` fills the km input and displays the fee.
- Staff clicks **Apply** to write it into the delivery-fee field.
- **Use when:** destination is a hotel/villa/address, not a named preset area.
- **Cost:** ~$0.01 first lookup (2 Google API calls). Cached forever after.

### 3. Manual km entry
- Staff clicks **"+ From km"** → types the distance in the km input → sees a live fee preview → clicks Apply.
- **Use when:** address doesn't geocode well, staff already knows the km, or Google is down.
- **Cost:** zero.

## Failure modes and diagnostics

- **`GOOGLE_MAPS_API_KEY not set`** — env var missing from `.env.local` and/or deploy platform.
- **`google_status: REQUEST_DENIED`** — usually one of: API key not enabled for Geocoding/Distance Matrix, HTTP referrer restriction blocking server-side calls (server has no `Referer` header), or billing account not attached.
- **`google_status: ZERO_RESULTS`** — Google couldn't resolve the address. Add district and "Bali, Indonesia".
- **`google_status: OVER_QUERY_LIMIT`** — you've exhausted the free tier. Extremely unlikely at this app's scale.
- **Preset pills or km panel missing** — check `delivery_area_presets` and `delivery_km_rates` RLS policies. Both need SELECT policies for `authenticated`. Fix in migration 014.

## Editing the config

Until an `/admin/delivery` page ships, edit these tables via Supabase Table Editor. Changes take effect on the next new-booking page load. No deploy needed.

- **Add or remove a preset area:** insert/delete from `delivery_area_presets`. Set `active = false` to hide without deleting.
- **Change the per-km rate:** update `per_km_rate` on `delivery_km_rates`. Applies to all future quotes.
- **Change plan-tier base fee:** update `base_fee` on the affected row.
- **Move HQ:** update `hq_latitude`/`hq_longitude` on `delivery_settings`. **Then** `TRUNCATE delivery_lookups` to force fresh Google lookups (the cached distances were measured from the old HQ).
- **Refresh a specific address:** `DELETE FROM delivery_lookups WHERE address_normalized = '<normalized>'`.

## Extending

- **Precomputed preset km:** populate `latitude`/`longitude` on `delivery_area_presets` (one-time, from Google Maps). Then the preset pill can show "Airport · Rp 100,000 · 12 km" and the km panel can auto-fill when the preset is clicked.
- **`/admin/delivery` page:** small CRUD UI for the three config tables so staff doesn't need Supabase Table Editor.
- **Chatbot integration:** the chatbot's quote endpoint calls the same `/api/delivery/estimate` route. Same math, same cache, no duplicate logic to keep in sync.

## Migration references

- `012_delivery_config_tables.sql` — tables + seeds + RPC
- `013_delivery_lookups_cache.sql` — address cache
- `014_delivery_rls_policies.sql` — RLS SELECT policies (must not skip; otherwise the form fetches empty arrays)
