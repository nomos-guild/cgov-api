import app from '../src/index';
import request from 'supertest';

let server: any;

beforeAll((done) => {
  server = app.listen(0, () => {
    // Assign the server's port to the environment variable
    process.env.PORT = server.address().port.toString();
    done();
  });
});

afterAll((done) => {
  server.close(done);
  done()
});

// Export the supertest request function for use in tests
export const api = request(app);