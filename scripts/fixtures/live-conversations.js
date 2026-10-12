// Three short conversations for the live smoke test (npm run test:live).
// dataset: synthetic. Hand-written for a smoke test of the pipeline; not real user data and never reported as
// an evaluation result.
module.exports = {
  dataset: 'synthetic',
  conversations: [
    {
      title: 'Moving city',
      messages: [
        { role: 'user', content: 'Hi! I live in Pune since 2020 and I work at Infosys as a data analyst.' },
        { role: 'assistant', content: 'Nice to meet you! How can I help today?' },
        { role: 'user', content: 'Big news: I moved to Mumbai in March 2025 for a new job at Tata Steel.' },
      ],
    },
    {
      title: 'Dinner ideas',
      messages: [
        { role: 'user', content: 'Can you suggest a quick dinner? I am vegetarian and allergic to peanuts.' },
        { role: 'assistant', content: 'Sure, how about a paneer stir-fry without any peanut oil?' },
        { role: 'user', content: 'Sounds great, thanks! What is the weather usually like in July?' },
      ],
    },
    {
      title: 'Study plans',
      messages: [
        { role: 'user', content: "I'm learning German because I start a master's in Berlin next year." },
        { role: 'assistant', content: 'Viel Erfolg! Do you want a study plan?' },
        { role: 'user', content: 'Yes please. Also, I love trekking on weekends, so keep evenings light.' },
      ],
    },
  ],
};
