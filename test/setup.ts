import app from '../src/index';
import request from 'supertest';

// Export the supertest request function for use in tests
export const api = request(app);
