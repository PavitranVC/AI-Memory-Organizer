// A tiny HAND-WRITTEN set in LongMemEval's file format, for tests only. It is not LongMemEval data: the people
// and chats are invented. It contains the awkward cases found in the real oracle file: sessions listed out of
// date order, a knowledge-update question, an abstention question (id ends in "_abs") and a numeric answer.
module.exports = () => [
  {
    question_id: 'q-update-1',
    question_type: 'knowledge-update',
    question: 'Where does Asha live now?',
    answer: 'Pune',
    question_date: '2023/06/20 (Tue) 09:30',
    // Not in date order on purpose: the 1 June session comes first in the file but is the oldest
    haystack_dates: ['2023/06/10 (Sat) 18:05', '2023/06/01 (Thu) 08:00', '2023/06/10 (Sat) 18:05'],
    haystack_session_ids: ['s-move', 's-first', 's-tie'],
    answer_session_ids: ['s-first', 's-move'],
    haystack_sessions: [
      [
        { role: 'user', content: 'I moved to Pune last week.', has_answer: true },
        { role: 'assistant', content: 'Congratulations on the move!' },
      ],
      [
        { role: 'user', content: 'I live in Mumbai, near the sea.', has_answer: true },
        { role: 'assistant', content: 'Sounds lovely.', has_answer: false },
        { role: 'user', content: 'It is humid though.' },
      ],
      [{ role: 'user', content: 'Unrelated chat that shares the minute of s-move.' }],
    ],
  },
  {
    question_id: 'q-count-2',
    question_type: 'single-session-user',
    question: 'How many cats does Ben have?',
    answer: 2,
    question_date: '2023/07/01 (Sat) 12:00',
    haystack_dates: ['2023/06/30 (Fri) 20:15'],
    haystack_session_ids: ['s-cats'],
    answer_session_ids: ['s-cats'],
    haystack_sessions: [[{ role: 'user', content: 'I have 2 cats at home.', has_answer: true }, { role: 'assistant', content: 'What are their names?' }]],
  },
  {
    question_id: 'q-missing-3_abs',
    question_type: 'single-session-user',
    question: 'What is the name of Ben\'s dog?',
    answer: 'The information provided is not enough. You mentioned cats but not a dog.',
    question_date: '2023/07/02 (Sun) 12:00',
    haystack_dates: ['2023/06/30 (Fri) 20:15'],
    haystack_session_ids: ['s-cats'],
    answer_session_ids: ['s-cats'],
    haystack_sessions: [[{ role: 'user', content: 'I have 2 cats at home.', has_answer: true }]],
  },
  {
    question_id: 'q-time-4',
    question_type: 'temporal-reasoning',
    question: 'Which did Chen do first, the course or the trip?',
    answer: 'The course',
    question_date: '2023/08/01 (Tue) 10:00',
    haystack_dates: ['2023/07/01 (Sat) 10:00', '2023/07/15 (Sat) 10:00'],
    haystack_session_ids: ['s-course', 's-trip'],
    answer_session_ids: ['s-course', 's-trip'],
    haystack_sessions: [
      [{ role: 'user', content: 'I just finished my pottery course.', has_answer: true }],
      [{ role: 'user', content: 'I am back from my trip to Goa.', has_answer: true }],
    ],
  },
];
