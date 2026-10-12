const mongoose = require('mongoose');
const request = require('supertest');

const app = require('../app');
const User = require('../models/User');
const Category = require('../models/Category');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Memory = require('../models/Memory');
const { signToken, hashPassword } = require('../services/authService');

const MODELS = [User, Category, Conversation, Message, Memory];

// Each test file gets a clean database and all schema indexes built
async function connect() {
  await mongoose.connect(process.env.MONGO_URI_TEST);
  await mongoose.connection.dropDatabase();
  await Promise.all(MODELS.map((Model) => Model.init()));
}

async function disconnect() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

async function clear() {
  await Promise.all(MODELS.map((Model) => Model.deleteMany({})));
}

// Creates a user straight in the database (fast) and returns it with a valid token
async function createUser(overrides = {}) {
  const n = Math.random().toString(36).slice(2, 8);
  const user = await User.create({
    name: `User ${n}`,
    email: `user-${n}@example.com`,
    passwordHash: await hashPassword('Password123'),
    ...overrides,
  });
  return { user, token: signToken(user) };
}

const createAdmin = () => createUser({ role: 'admin' });
const createCategory = (name = `Category ${Math.random().toString(36).slice(2, 8)}`) => Category.create({ name });

// Authenticated supertest calls: api(token).get('/api/memories')
function api(token) {
  const auth = (req) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
  return {
    get: (url) => auth(request(app).get(url)),
    post: (url) => auth(request(app).post(url)),
    put: (url) => auth(request(app).put(url)),
    delete: (url) => auth(request(app).delete(url)),
  };
}

module.exports = { app, request, connect, disconnect, clear, createUser, createAdmin, createCategory, api, models: { User, Category, Conversation, Message, Memory } };
