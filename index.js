require('dotenv').config();
const mongoose = require('mongoose');

const app = require('./app');
const models = [
  require('./models/User'),
  require('./models/Category'),
  require('./models/Conversation'),
  require('./models/Message'),
  require('./models/Memory'),
  require('./models/AuditLog'),
];

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';

// The placeholder from .env.example must not survive into production
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change-me')) {
  console.error('Set JWT_SECRET to a long random value in production (for example: openssl rand -hex 32)');
  process.exit(1);
}

mongoose
  .connect(MONGO_URI)
  .then(async () => {
    console.log(`MongoDB connected -> ${MONGO_URI}`);
    // Mongoose builds indexes in the background and swallows failures. A database created before Stage 1
    // still has the old text index, which blocks the new one, so say so instead of failing silently.
    const built = await Promise.allSettled(models.map((Model) => Model.init()));
    built.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.warn(`Could not build the indexes of "${models[i].modelName}": ${result.reason.message}`);
        console.warn('If this database was created before Stage 1, run "npm run migrate" once.');
      }
    });
    // Every change to a memory runs in a transaction, which a standalone mongod cannot do. Reads still work,
    // so start anyway, but say clearly why writes will fail.
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName) {
      console.warn('WARNING: MongoDB is not running as a replica set, so creating, updating or deleting memories will fail.');
      console.warn('See "Run MongoDB as a replica set" in the README (one-time setup).');
    }
    app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
