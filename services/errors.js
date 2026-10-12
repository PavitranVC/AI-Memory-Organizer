// One error type for everything a client can fix; the error handler in app.js
// turns it into a JSON response with the right status code.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = {
  HttpError,
  badRequest: (message) => new HttpError(400, message),
  unauthorized: (message = 'Authentication required') => new HttpError(401, message),
  forbidden: (message = 'You do not have permission to do that') => new HttpError(403, message),
  notFound: (message) => new HttpError(404, message),
  conflict: (message) => new HttpError(409, message),
};
