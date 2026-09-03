import { GooglePlacesService } from '../services/googlePlaces.service';
import { IPlaceProvider, IProviderResult, IProviderSearchParams } from './types';
import { IGooglePlaceRaw } from '../services/googlePlaces.service';

/**
 * Official Google Places API. Kept as an opt-in provider (PLACES_PROVIDER=places_api)
 * — it is no longer the default because it requires a billed API key.
 */
export class PlacesApiProvider implements IPlaceProvider {
  public readonly name = 'places_api' as const;

  public isConfigured(): boolean {
    return GooglePlacesService.isLive;
  }

  public async search(params: IProviderSearchParams): Promise<IProviderResult> {
    const result = params.query
      ? await GooglePlacesService.textSearch({ query: params.query, maxResults: params.maxResults })
      : await GooglePlacesService.nearbySearch({
          lat: params.lat,
          lng: params.lng,
          radius: params.radius,
          keyword: params.keyword,
          maxResults: params.maxResults,
        });

    return {
      places: result.places,
      source: result.source,
      provider: result.source === 'mock' ? 'mock' : this.name,
      warning: result.warning,
    };
  }

  public async getDetails(place: IGooglePlaceRaw): Promise<IGooglePlaceRaw | null> {
    return GooglePlacesService.getPlaceDetails(place.place_id);
  }
}
