import type { TodoItem } from "../lib/events";

const STATUS_ICON: Record<TodoItem["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
};

const STATUS_LABEL: Record<TodoItem["status"], string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
};

export function TaskList({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="tasklist">
      <div className="tasklist-head">
        <span className="tasklist-title">Tasks</span>
        <span className="tasklist-count">
          {done}/{todos.length}
        </span>
      </div>
      <ul className="tasklist-items">
        {todos.map((t, i) => (
          <li
            key={i}
            className={`taskitem ${t.status}${t.status === "in_progress" ? " active" : ""}`}
            title={STATUS_LABEL[t.status]}
          >
            <span className="taskicon">{STATUS_ICON[t.status]}</span>
            <span className="tasktext">{t.content}</span>
            {t.priority && t.status !== "completed" && (
              <span className={`taskprio ${t.priority}`}>{t.priority}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
