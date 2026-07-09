import { useState } from "react";

export interface Question {
  questionId: string;
  question: string;
  options?: string[];
}

export function QuestionCard({
  question,
  onAnswer,
}: {
  question: Question;
  onAnswer: (questionId: string, answer: string) => void;
}) {
  const [custom, setCustom] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const submit = (answer: string) => {
    if (!answer.trim() || submitted) return;
    setSubmitted(true);
    onAnswer(question.questionId, answer.trim());
  };

  return (
    <div className={`questioncard${submitted ? " submitted" : ""}`}>
      <div className="question-label">Clarifying question</div>
      <div className="question-text">{question.question}</div>
      {question.options && question.options.length > 0 ? (
        <div className="question-options">
          {question.options.map((opt) => (
            <button
              key={opt}
              className="question-option"
              onClick={() => submit(opt)}
              disabled={submitted}
            >
              {opt}
            </button>
          ))}
          <div className="question-custom">
            <input
              type="text"
              placeholder="Or type your own answer…"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit(custom);
              }}
              disabled={submitted}
            />
            <button onClick={() => submit(custom)} disabled={submitted || !custom.trim()}>
              Send
            </button>
          </div>
        </div>
      ) : (
        <div className="question-custom open">
          <input
            type="text"
            placeholder="Your answer…"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit(custom);
            }}
            autoFocus
            disabled={submitted}
          />
          <button onClick={() => submit(custom)} disabled={submitted || !custom.trim()}>
            Send
          </button>
        </div>
      )}
      {submitted && <div className="question-waiting">Answer sent — waiting for the agent…</div>}
    </div>
  );
}
