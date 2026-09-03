import { Router } from 'express';
import { VenueController } from '../controllers/venue.controller';

const router = Router();

// Collection-level scanning & querying
router.post('/search', VenueController.searchAndEnrichVenues);
router.post('/ingest', VenueController.ingestUrls);
router.post('/within', VenueController.findWithin);
router.get('/nearby', VenueController.findNearby);
router.get('/stats', VenueController.getStats);
router.get('/export', VenueController.exportAll);
router.get('/jobs/:jobId', VenueController.getJobStatus);
router.get('/', VenueController.listVenues);

// Document-level routes come last so literal paths above are not shadowed by /:id
router.get('/:id', VenueController.getVenueById);
router.get('/:id/export', VenueController.exportVenue);
router.post('/:id/refresh', VenueController.refreshVenue);
router.delete('/:id', VenueController.deleteVenue);

export default router;
