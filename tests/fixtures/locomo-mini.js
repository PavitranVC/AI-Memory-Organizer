// A tiny HAND-WRITTEN sample in LoCoMo's file format, for tests only. It is not LoCoMo data: the people and
// dialog are invented. It contains the awkward cases found in the real file: an image turn, sessions out of
// numeric order (10 before 2 as text), a date with no session, malformed evidence ids, a numeric answer and
// an adversarial question with no answer.
module.exports = () => [
  {
    sample_id: 'test-1',
    conversation: {
      speaker_a: 'Asha',
      speaker_b: 'Ben',
      session_1_date_time: '1:56 pm on 8 May, 2023',
      session_1: [
        { speaker: 'Asha', dia_id: 'D1:1', text: 'I started learning the violin last week!' },
        { speaker: 'Ben', dia_id: 'D1:2', text: 'Nice! Look at my new bike.', img_url: ['http://example.invalid/bike.jpg'], blip_caption: 'a red bicycle', query: 'red bike' },
        { speaker: 'Asha', dia_id: 'D1:3', text: 'I have 2 cats at home.' },
      ],
      session_10_date_time: '12:05 am on 3 January, 2024',
      session_10: [
        { speaker: 'Ben', dia_id: 'D10:1', text: 'Happy new year, Asha.' },
        { speaker: 'Asha', dia_id: 'D10:2', text: 'I gave up the violin and took up the cello.' },
      ],
      session_2_date_time: '12:30 pm on 25 May, 2023',
      session_2: [
        { speaker: 'Ben', dia_id: 'D2:1', text: 'I moved to Pune on Monday.' },
        { speaker: 'Asha', dia_id: 'D2:2', text: 'Congratulations on the move!' },
      ],
      session_3_date_time: '9:00 am on 1 June, 2023',
    },
    qa: [
      { question: 'What instrument did Asha start learning in May 2023?', answer: 'violin', evidence: ['D1:1'], category: 4 },
      { question: 'When did Ben move to Pune?', answer: 'The Monday before 25 May 2023', evidence: ['D2:1'], category: 2 },
      { question: 'How many cats does Asha have?', answer: 2, evidence: ['D1:3'], category: 4 },
      { question: 'Which instruments has Asha played?', answer: 'violin and cello', evidence: ['D1:1; D10:2'], category: 1 },
      { question: 'What colour is the bike?', answer: 'red', evidence: ['D:1:02'], category: 4 },
      { question: 'What did Ben say about his piano?', adversarial_answer: 'it is out of tune', evidence: ['D9:9', 'D'], category: 5 },
      { question: 'Would Asha enjoy a concert?', answer: 'Likely yes', evidence: [], category: 3 },
    ],
  },
  {
    sample_id: 'test-2',
    conversation: {
      speaker_a: 'Chen',
      speaker_b: 'Dana',
      session_1_date_time: '7:55 pm on 9 June, 2023',
      session_1: [
        { speaker: 'Chen', dia_id: 'D1:1', text: 'I am allergic to peanuts.' },
        { speaker: 'Dana', dia_id: 'D1:2', text: 'Good to know for the party.' },
      ],
    },
    qa: [{ question: 'What is Chen allergic to?', answer: 'peanuts', evidence: ['D1:1'], category: 4 }],
  },
];
