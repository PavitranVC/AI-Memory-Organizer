/**
 * Seeder for the AI Memory Organizer database.
 * Clears every collection, then inserts 3 users, 4 categories, 5 conversations and 55 memories.
 *
 * Run with:  npm run seed   (or: node seed.js)
 */
require('dotenv').config();
const mongoose = require('mongoose');

const User = require('./models/User');
const Category = require('./models/Category');
const Conversation = require('./models/Conversation');
const Memory = require('./models/Memory');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';

// ---------------------------------------------------------------------------
// Users (3)
// ---------------------------------------------------------------------------
const users = [
  { key: 'aarav', name: 'Aarav Mehta', email: 'aarav.mehta@example.com', occupation: 'Computer Science student' },
  { key: 'priya', name: 'Priya Nair', email: 'priya.nair@example.com', occupation: 'UX designer' },
  { key: 'daniel', name: 'Daniel Fernandes', email: 'daniel.fernandes@example.com', occupation: 'Chartered accountant' },
];

// ---------------------------------------------------------------------------
// Categories (4)
// ---------------------------------------------------------------------------
const categories = [
  { name: 'Learning', description: 'Skills being learned, study goals and preferred learning style' },
  { name: 'Personal', description: 'Work, family, travel plans and personal preferences' },
  { name: 'Health', description: 'Allergies, fitness, diet, sleep and medical notes' },
  { name: 'Hobbies', description: 'Leisure activities, interests and creative pursuits' },
];

// ---------------------------------------------------------------------------
// Conversations (5), with messages embedded as sub-documents
// ---------------------------------------------------------------------------
const conversations = [
  {
    key: 'reactPrep',
    user: 'aarav',
    title: 'React bugs and placement prep',
    messages: [
      { role: 'user', content: "My useEffect keeps firing in an infinite loop and I honestly don't get why. Also placements start in December and I'm panicking about DSA." },
      { role: 'assistant', content: "That loop usually happens when an object or function in the dependency array is recreated on every render. Let's fix that first, then build a DSA plan around your classes." },
      { role: 'user', content: 'Okay. Just so you know, I can only study after 9 PM because of lectures and my TA job in the C programming lab.' },
      { role: 'assistant', content: "Got it. I'll plan 90-minute evening sessions: an hour of DSA and 30 minutes on your MERN expense tracker." },
    ],
  },
  {
    key: 'berlinTrip',
    user: 'aarav',
    title: 'Planning the Berlin trip',
    messages: [
      { role: 'user', content: "I'm going to Berlin next summer for my cousin's wedding and want to stay two extra weeks to travel. I'd love to speak basic German by then." },
      { role: 'assistant', content: 'Very doable: with daily practice you can reach A2 in a year. Shall I draft a study schedule and a rough route?' },
      { role: 'user', content: "Yes please, but keep it cheap since I'm paying for it myself. Also I'm allergic to peanuts, so I have to be careful with food." },
      { role: 'assistant', content: "Noted. I'll favour trains and budget hostels, and add German phrases for asking about allergens in restaurants." },
    ],
  },
  {
    key: 'marathon',
    user: 'priya',
    title: 'Half-marathon training plan',
    messages: [
      { role: 'user', content: 'I signed up for the Bengaluru half marathon in January. My left knee starts hurting after about 10 km though.' },
      { role: 'assistant', content: "Let's build a 16-week plan with a gradual mileage increase and two strength sessions a week to protect that knee." },
      { role: 'user', content: "Sounds good. I'm vegetarian and I keep skipping breakfast because of early stand-ups, so I need help with food too." },
      { role: 'assistant', content: "We'll target around 70 g of protein a day with paneer, dal and curd, plus overnight oats you can prep the night before." },
    ],
  },
  {
    key: 'weekends',
    user: 'priya',
    title: 'Getting my weekends back',
    messages: [
      { role: 'user', content: 'Work has been exhausting lately. I want my weekends back, maybe restart pottery, and I just bought a second-hand film camera!' },
      { role: 'assistant', content: 'Protecting your weekends sounds like a great goal. Want me to find pottery class slots and suggest a few photo walks around the city?' },
      { role: 'user', content: 'Yes! And please remind me to call my parents in Kochi on Sundays, I keep forgetting.' },
    ],
  },
  {
    key: 'careerSwitch',
    user: 'daniel',
    title: 'Moving from accounting to data analytics',
    messages: [
      { role: 'user', content: "I've been an accountant for six years and want to move into data analytics. I'm great with Excel but SQL is new to me." },
      { role: 'assistant', content: "Your Excel skills are a strong foundation. Let's start with SQL joins and aggregations, then move on to Power BI and Python." },
      { role: 'user', content: "Time is tight, I'm 38 with two kids. My doctor also said my blood sugar is borderline, so I need to fit exercise in somehow." },
      { role: 'assistant', content: 'Early mornings can be your study slot, and cycling to work a couple of days a week would build exercise into your routine.' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Memories (55), grouped by the conversation they were extracted from.
// The owning user comes from the conversation, so the references stay consistent.
// "Archived" memories are facts that are no longer true or relevant.
// ---------------------------------------------------------------------------
const memoriesByConversation = {
  // Aarav: 11 memories
  reactPrep: [
    { category: 'Learning', importance: 5, status: 'Active', tags: ['react', 'hooks', 'frontend'],
      content: 'User is struggling with React hooks, especially useEffect dependency arrays that trigger infinite re-renders.' },
    { category: 'Learning', importance: 5, status: 'Active', tags: ['dsa', 'leetcode', 'placements'],
      content: 'User has campus placements starting in December and wants to solve 250 LeetCode problems before then.' },
    { category: 'Learning', importance: 4, status: 'Active', tags: ['mern', 'portfolio'],
      content: 'User is building a MERN-stack expense tracker to showcase in placement interviews.' },
    { category: 'Learning', importance: 3, status: 'Active', tags: ['learning-style'],
      content: 'User learns best from short video tutorials followed by hands-on coding, and finds long documentation pages overwhelming.' },
    { category: 'Learning', importance: 3, status: 'Archived', tags: ['operating-systems', 'exams'],
      content: 'User is preparing for the Operating Systems mid-semester exam and needs help with page replacement algorithms.' },
    { category: 'Personal', importance: 4, status: 'Active', tags: ['college', 'work'],
      content: 'User is a third-year Computer Science student who works part-time as a teaching assistant in the first-year C programming lab.' },
    { category: 'Personal', importance: 3, status: 'Active', tags: ['schedule'],
      content: 'User can only study after 9 PM on weekdays because of lectures and TA duties.' },
    { category: 'Personal', importance: 2, status: 'Archived', tags: ['housing'],
      content: 'User is looking for PG accommodation within walking distance of campus.' },
    { category: 'Health', importance: 3, status: 'Active', tags: ['sleep', 'stress'],
      content: 'User has been sleeping only about five hours a night during placement prep and often feels drained in morning classes.' },
    { category: 'Hobbies', importance: 3, status: 'Active', tags: ['guitar', 'music'],
      content: 'User plays acoustic guitar and is learning fingerstyle covers of old Bollywood songs.' },
    { category: 'Hobbies', importance: 1, status: 'Archived', tags: ['gaming'],
      content: 'User plays Valorant almost every night to unwind after classes.' },
  ],

  // Aarav: 9 memories
  berlinTrip: [
    { category: 'Learning', importance: 5, status: 'Active', tags: ['german', 'language'],
      content: 'User wants to learn German before their trip to Berlin next summer and is aiming for A2 level.' },
    { category: 'Learning', importance: 3, status: 'Active', tags: ['german', 'duolingo'],
      content: 'User practises German on Duolingo every morning and is proud of their 64-day streak.' },
    { category: 'Health', importance: 5, status: 'Active', tags: ['allergy', 'food'],
      content: 'User is allergic to peanuts and must check ingredients carefully when eating out, especially while travelling.' },
    { category: 'Health', importance: 2, status: 'Active', tags: ['travel', 'motion-sickness'],
      content: 'User gets motion sickness on long bus rides and prefers trains for intercity travel.' },
    { category: 'Personal', importance: 5, status: 'Active', tags: ['travel', 'family'],
      content: "User is travelling to Berlin next summer for their cousin's wedding and plans to stay two extra weeks to explore Europe." },
    { category: 'Personal', importance: 4, status: 'Active', tags: ['budget', 'travel'],
      content: 'User is paying for the Europe trip themselves and wants to keep the total budget under 2.5 lakh rupees.' },
    { category: 'Personal', importance: 3, status: 'Archived', tags: ['passport', 'travel'],
      content: 'User needs to renew their passport before booking flights to Germany.' },
    { category: 'Hobbies', importance: 3, status: 'Active', tags: ['photography', 'travel'],
      content: "User enjoys street photography on their phone and wants to shoot Berlin's murals at the East Side Gallery." },
    { category: 'Hobbies', importance: 2, status: 'Active', tags: ['football'],
      content: 'User is a die-hard Bayern Munich fan and hopes to catch a match at the Allianz Arena during the trip.' },
  ],

  // Priya: 10 memories
  marathon: [
    { category: 'Health', importance: 5, status: 'Active', tags: ['running', 'fitness'],
      content: 'User is training for the Bengaluru half marathon in January and runs four times a week.' },
    { category: 'Health', importance: 5, status: 'Active', tags: ['knee', 'injury'],
      content: 'User gets pain in their left knee after runs longer than 10 km and was advised to add strength training.' },
    { category: 'Health', importance: 4, status: 'Active', tags: ['diet', 'vegetarian', 'protein'],
      content: 'User is vegetarian and is trying to reach 70 grams of protein a day from paneer, dal, curd and sprouts.' },
    { category: 'Health', importance: 3, status: 'Active', tags: ['caffeine'],
      content: 'User drinks three to four cups of coffee a day and wants to cut down to one.' },
    { category: 'Health', importance: 3, status: 'Archived', tags: ['diet', 'breakfast'],
      content: 'User often skips breakfast because of 8:30 AM stand-up meetings.' },
    { category: 'Health', importance: 2, status: 'Archived', tags: ['injury', 'running'],
      content: 'User is recovering from a mild ankle sprain and has paused running for three weeks.' },
    { category: 'Learning', importance: 3, status: 'Active', tags: ['running', 'technique'],
      content: 'User is studying running form from YouTube coaches and wants to raise their cadence to 170 steps per minute.' },
    { category: 'Personal', importance: 4, status: 'Active', tags: ['work', 'career'],
      content: 'User works as a UX designer at a fintech startup in Bengaluru.' },
    { category: 'Personal', importance: 3, status: 'Active', tags: ['preferences', 'notifications'],
      content: 'User prefers workout reminders in the morning and does not want any notifications after 10 PM.' },
    { category: 'Hobbies', importance: 1, status: 'Active', tags: ['podcasts'],
      content: 'User listens to true-crime podcasts to stay motivated on long runs.' },
  ],

  // Priya: 8 memories
  weekends: [
    { category: 'Personal', importance: 5, status: 'Active', tags: ['burnout', 'work-life-balance'],
      content: 'User feels burnt out from work and wants to keep weekends completely free of office emails and Slack.' },
    { category: 'Personal', importance: 4, status: 'Active', tags: ['family', 'reminders'],
      content: "User's parents live in Kochi, and the user wants a reminder to call them every Sunday evening." },
    { category: 'Hobbies', importance: 4, status: 'Active', tags: ['pottery', 'art'],
      content: 'User is getting back into pottery and wants to book weekend wheel-throwing classes in Indiranagar.' },
    { category: 'Hobbies', importance: 4, status: 'Active', tags: ['photography', 'film'],
      content: 'User recently bought a second-hand Pentax K1000 film camera and is learning to shoot in full manual mode.' },
    { category: 'Hobbies', importance: 1, status: 'Archived', tags: ['music', 'ukulele'],
      content: 'User is teaching themselves the ukulele through online lessons.' },
    { category: 'Learning', importance: 3, status: 'Active', tags: ['frontend', 'career'],
      content: 'User wants to learn basic HTML, CSS and React so they can collaborate better with developers.' },
    { category: 'Learning', importance: 2, status: 'Active', tags: ['reading', 'habits'],
      content: "User is reading 'Atomic Habits' and wants to use habit stacking to build a calmer morning routine." },
    { category: 'Learning', importance: 3, status: 'Archived', tags: ['ux', 'certification'],
      content: 'User is working through the Google UX Design Certificate and has finished four of the seven courses.' },
  ],

  // Daniel: 17 memories
  careerSwitch: [
    { category: 'Learning', importance: 5, status: 'Active', tags: ['sql', 'career-change'],
      content: 'User is moving from accounting into data analytics and is currently learning SQL joins and window functions.' },
    { category: 'Learning', importance: 4, status: 'Active', tags: ['power-bi', 'dashboard'],
      content: 'User plans to learn Power BI after SQL and wants to build a sales dashboard as their first portfolio project.' },
    { category: 'Learning', importance: 4, status: 'Active', tags: ['learning-style', 'excel'],
      content: 'User learns best by rebuilding their existing Excel reports in SQL and Python, because the data is already familiar.' },
    { category: 'Learning', importance: 3, status: 'Active', tags: ['statistics'],
      content: 'User finds statistics concepts like p-values and confidence intervals confusing and prefers real-world business examples.' },
    { category: 'Learning', importance: 2, status: 'Archived', tags: ['python', 'r'],
      content: 'User is undecided between learning Python or R for data analysis.' },
    { category: 'Personal', importance: 5, status: 'Active', tags: ['career', 'excel'],
      content: 'User has worked as a chartered accountant for six years and is highly skilled in advanced Excel.' },
    { category: 'Personal', importance: 4, status: 'Active', tags: ['family', 'schedule'],
      content: 'User is 38, married with two kids aged 6 and 9, so study time is limited to early mornings before work.' },
    { category: 'Personal', importance: 4, status: 'Active', tags: ['career', 'goals'],
      content: 'User wants to land a data analyst role within 12 months without taking more than a 15% pay cut.' },
    { category: 'Personal', importance: 2, status: 'Archived', tags: ['career', 'mba'],
      content: 'User is considering an MBA in finance as their next career move.' },
    { category: 'Health', importance: 5, status: 'Active', tags: ['blood-sugar', 'diet'],
      content: 'User was told by their doctor that their blood sugar is borderline and is cutting back on sweets and white rice.' },
    { category: 'Health', importance: 4, status: 'Active', tags: ['back-pain', 'posture'],
      content: 'User has lower back pain from long hours at a desk and is looking for a better chair and a daily stretching routine.' },
    { category: 'Health', importance: 3, status: 'Active', tags: ['cycling', 'exercise'],
      content: 'User has started cycling to work twice a week to fit exercise into a busy schedule.' },
    { category: 'Health', importance: 2, status: 'Archived', tags: ['diet', 'sugar'],
      content: 'User drinks sweetened chai four times a day.' },
    { category: 'Hobbies', importance: 3, status: 'Active', tags: ['chess'],
      content: 'User plays online chess in the evenings and is trying to cross a 1500 rating on Lichess.' },
    { category: 'Hobbies', importance: 3, status: 'Active', tags: ['cooking'],
      content: 'User loves cooking Goan food on weekends, especially fish curry and chicken xacuti, and lets the kids help.' },
    { category: 'Hobbies', importance: 2, status: 'Active', tags: ['birdwatching', 'family'],
      content: 'User and their kids have started birdwatching on Sunday mornings and keep a shared notebook of sightings.' },
    { category: 'Hobbies', importance: 1, status: 'Archived', tags: ['cricket', 'sports'],
      content: 'User plays cricket with an office team every Saturday morning.' },
  ],
};

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------
async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}`);

  // Make sure the collections and schema indexes exist before inserting
  await Promise.all([User.init(), Category.init(), Conversation.init(), Memory.init()]);

  // 1) Clear the database
  await Promise.all([
    User.deleteMany({}),
    Category.deleteMany({}),
    Conversation.deleteMany({}),
    Memory.deleteMany({}),
  ]);
  console.log('Cleared existing data');

  // 2) Users
  const userDocs = await User.insertMany(users.map(({ key, ...user }) => user));
  const userIds = Object.fromEntries(users.map((u, i) => [u.key, userDocs[i]._id]));

  // 3) Categories
  const categoryDocs = await Category.insertMany(categories);
  const categoryIds = Object.fromEntries(categoryDocs.map((c) => [c.name, c._id]));

  // 4) Conversations
  const conversationDocs = await Conversation.insertMany(
    conversations.map(({ key, user, ...conversation }) => ({ ...conversation, userId: userIds[user] }))
  );
  const conversationsByKey = Object.fromEntries(conversations.map((c, i) => [c.key, conversationDocs[i]]));

  // 5) Memories
  const memories = Object.entries(memoriesByConversation).flatMap(([conversationKey, list]) =>
    list.map(({ category, ...memory }) => ({
      ...memory,
      userId: conversationsByKey[conversationKey].userId,
      conversationId: conversationsByKey[conversationKey]._id,
      categoryId: categoryIds[category],
    }))
  );
  await Memory.insertMany(memories);

  // Summary
  const counts = {
    users: await User.countDocuments(),
    categories: await Category.countDocuments(),
    conversations: await Conversation.countDocuments(),
    memories: await Memory.countDocuments(),
  };
  counts.total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  console.log('\nSeed complete:');
  console.table(counts);

  console.log('User IDs (use one as "userId" in POST /api/memories):');
  userDocs.forEach((u) => console.log(`  ${u.name.padEnd(18)} ${u._id}`));

  const indexes = await Memory.collection.indexes();
  console.log(`\nIndexes on "memories": ${indexes.map((i) => i.name).join(', ')}`);
}

seed()
  .catch((err) => {
    console.error('Seeding failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
