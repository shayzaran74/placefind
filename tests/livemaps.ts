import { MapsScraperProvider } from '../src/providers/mapsScraper.provider';
import { searchPlaces } from '../src/providers';
import { config } from '../src/config';

/**
 * Opt-in live probe against Google Maps. Not part of `npm test` — it depends on
 * Google being reachable and unthrottled from this machine.
 *
 *   npx ts-node tests/livemaps.ts "Kadıköy kafe" [lat] [lng] [radius] [max]
 */
async function main(): Promise<void> {
  const [query = 'Kadıköy kafe', lat = '40.9876', lng = '29.0234', radius = '2000', max = '5'] =
    process.argv.slice(2);

  console.log(`Query    : ${query}`);
  console.log(`Centre   : ${lat},${lng} r=${radius}m  max=${max}`);
  console.log(`Provider : ${config.placesProvider} (fallbacks: ${config.placesFallbackProviders.join(', ') || 'none'})`);
  console.log(`Chromium : ${config.playwrightExecutablePath || 'default'}\n`);

  const started = Date.now();
  const result = await searchPlaces({
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    radius: parseInt(radius, 10),
    query,
    maxResults: parseInt(max, 10),
  });

  console.log(`→ provider=${result.provider} source=${result.source} blocked=${Boolean(result.blocked)}`);
  if (result.warning) console.log(`→ warning: ${result.warning}`);
  for (const attempt of result.attempted || []) {
    console.log(`→ tried ${attempt.provider}: ${attempt.reason}`);
  }
  console.log(`→ ${result.places.length} places in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

  for (const place of result.places) {
    console.log(`── ${place.name}`);
    console.log(`   id      : ${place.place_id}`);
    console.log(`   coords  : ${place.geometry?.location.lat}, ${place.geometry?.location.lng}`);
    console.log(`   address : ${place.formatted_address || '—'}`);
    console.log(`   parts   : ${JSON.stringify(place.address_parts || {})}`);
    console.log(`   rating  : ${place.rating ?? '—'} (${place.user_ratings_total ?? 0} reviews)`);
    console.log(`   phone   : ${place.formatted_phone_number || '—'}`);
    console.log(`   website : ${place.website || '—'}`);
    console.log(`   category: ${(place.categories || []).join(', ') || '—'}`);
    console.log(`   hours   : ${place.opening_hours?.weekday_text?.length || 0} rows`);
    console.log(`   photo   : ${place.photos?.[0]?.direct_url ? 'yes' : 'no'}`);
  }

  process.exit(result.blocked ? 1 : 0);
}

main().catch((error) => {
  console.error('livemaps failed:', error.message);
  process.exit(1);
});
