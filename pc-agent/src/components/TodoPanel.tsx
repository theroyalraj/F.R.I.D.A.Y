import React, { useState, useEffect, useCallback } from 'react';
import styles from '../styles/listen.module.css';

interface Todo {
  id: string;
  title: string;
  done: boolean;
  detail?: string;
  priority?: string;
  pinned?: boolean;
  silentRemind?: boolean;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface TodoPanelProps {
  authHeaders?: () => Record<string, string>;
  theme?: 'light' | 'dark';
}

const PRIORITY_COLORS: Record<string, { dot: string }> = {
  high:   { dot: '#ef4444' },
  medium: { dot: '#f59e0b' },
  low:    { dot: '#22c55e' },
};

const TodoPanel: React.FC<TodoPanelProps> = ({ authHeaders, theme = 'dark' }) => {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [newTodo, setNewTodo] = useState('');
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);

  const headers = useCallback(() => authHeaders ? authHeaders() : {}, [authHeaders]);

  useEffect(() => {
    const loadTodos = async () => {
      try {
        setLoading(true);
        const response = await fetch('/todos', { headers: headers() });
        if (response.ok) {
          const data = await response.json();
          setTodos(data.todos || []);
        }
      } catch (err) {
        console.error('Failed to load todos:', err);
      } finally {
        setLoading(false);
      }
    };
    loadTodos();
    const onRefresh = () => {
      void loadTodos();
    };
    window.addEventListener('openclaw:todos-refresh', onRefresh);
    return () => window.removeEventListener('openclaw:todos-refresh', onRefresh);
  }, [headers]);

  const addTodo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTodo.trim()) return;
    try {
      const response = await fetch('/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers() },
        body: JSON.stringify({ title: newTodo, priority: 'medium' }),
      });
      if (response.ok) {
        const data = await response.json();
        setTodos((prev) => [data.todo, ...prev]);
        setNewTodo('');
      }
    } catch (err) {
      console.error('Failed to add todo:', err);
    }
  };

  const toggleTodo = async (id: string, done: boolean) => {
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, done: !done } : t)));
    try {
      const response = await fetch(`/todos/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers() },
        body: JSON.stringify({ done: !done }),
      });
      if (!response.ok) {
        setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, done } : t)));
      }
    } catch {
      setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, done } : t)));
    }
  };

  const deleteTodo = async (id: string) => {
    const prev = todos;
    setTodos((t) => t.filter((x) => x.id !== id));
    try {
      const response = await fetch(`/todos/${id}`, {
        method: 'DELETE',
        headers: headers(),
      });
      if (!response.ok) setTodos(prev);
    } catch {
      setTodos(prev);
    }
  };

  const toggleSilentRemind = async (todo: Todo, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const next = !todo.silentRemind;
    setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, silentRemind: next } : t)));
    try {
      const response = await fetch(`/todos/${todo.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers() },
        body: JSON.stringify({ silentRemind: next }),
      });
      if (!response.ok) {
        setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, silentRemind: todo.silentRemind } : t)));
      }
    } catch {
      setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, silentRemind: todo.silentRemind } : t)));
    }
  };

  const activeTodos = todos.filter((t) => !t.done);
  const completedTodos = todos.filter((t) => t.done);

  return (
    <div className={`${styles['todo-panel']} ${styles[`todo-panel-${theme}`]}`}>
      <div className={styles['todo-header']} onClick={() => setExpanded(!expanded)}>
        <div className={styles['todo-header-left']}>
          <span className={styles['todo-header-icon']}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
            </svg>
          </span>
          <h3 className={styles['todo-title']}>Tasks</h3>
          {activeTodos.length > 0 && (
            <span className={styles['todo-badge']}>{activeTodos.length}</span>
          )}
        </div>
        <span className={`${styles['todo-chevron']} ${expanded ? styles['todo-chevron-open'] : ''}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </div>

      {expanded && (
        <div className={styles['todo-body']}>
          <form onSubmit={addTodo} className={styles['todo-input-form']}>
            <input
              type="text"
              placeholder="What needs to be done?"
              value={newTodo}
              onChange={(e) => setNewTodo(e.target.value)}
              className={styles['todo-input']}
              disabled={loading}
            />
            <button
              type="submit"
              className={styles['todo-add-btn']}
              disabled={!newTodo.trim() || loading}
              aria-label="Add task"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </form>

          <div className={styles['todo-list']}>
            {activeTodos.length === 0 && completedTodos.length === 0 ? (
              <div className={styles['todo-empty']}>
                <div className={styles['todo-empty-icon']}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.35">
                    <rect x="3" y="3" width="18" height="18" rx="3" />
                    <path d="M9 12l2 2 4-4" />
                  </svg>
                </div>
                <div className={styles['todo-empty-text']}>All clear</div>
                <div className={styles['todo-empty-sub']}>Add your first task above</div>
              </div>
            ) : (
              <>
                {activeTodos.map((todo) => {
                  const pc = PRIORITY_COLORS[todo.priority || 'medium'] || PRIORITY_COLORS.medium;
                  return (
                    <div key={todo.id} className={styles['todo-item']}>
                      <button
                        className={styles['todo-check-btn']}
                        onClick={() => toggleTodo(todo.id, todo.done)}
                        aria-label="Complete task"
                      >
                        <span className={styles['todo-check-ring']} />
                      </button>
                      <div className={styles['todo-item-content']}>
                        <span className={styles['todo-text']}>{todo.title}</span>
                        {todo.detail && (
                          <span className={styles['todo-detail']}>{todo.detail}</span>
                        )}
                      </div>
                      <span
                        className={styles['todo-priority-dot']}
                        style={{ background: pc.dot }}
                        title={`${todo.priority || 'medium'} priority`}
                      />
                      <button
                        type="button"
                        className={`${styles['todo-silent-btn']} ${todo.silentRemind ? styles['todo-silent-on'] : ''}`}
                        onClick={(e) => toggleSilentRemind(todo, e)}
                        title={
                          todo.silentRemind
                            ? 'Quiet: omitted from spoken task reminders'
                            : 'Included when you trigger spoken task reminders'
                        }
                        aria-label={
                          todo.silentRemind ? 'Mark task as spoken on reminders' : 'Mark task quiet for reminders'
                        }
                      >
                        {todo.silentRemind ? (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <path d="M9 9a3 3 0 015.83 1c0 2-3 3-3 3" />
                            <path d="M12 17h.01" />
                            <path d="M4.5 4.5l15 15" />
                            <path d="M18.36 18.36A9 9 0 113.64 5.64" />
                          </svg>
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
                            <path d="M13.73 21a2 2 0 01-3.46 0" />
                          </svg>
                        )}
                      </button>
                      <button
                        className={styles['todo-delete-btn']}
                        onClick={() => deleteTodo(todo.id)}
                        aria-label="Delete task"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
                {completedTodos.length > 0 && (
                  <div className={styles['todo-completed-section']}>
                    <div className={styles['todo-completed-label']}>
                      <span className={styles['todo-completed-line']} />
                      <span>{completedTodos.length} done</span>
                      <span className={styles['todo-completed-line']} />
                    </div>
                    {completedTodos.slice(0, 3).map((todo) => (
                      <div key={todo.id} className={`${styles['todo-item']} ${styles['todo-item-done']}`}>
                        <button
                          className={`${styles['todo-check-btn']} ${styles['todo-check-btn-done']}`}
                          onClick={() => toggleTodo(todo.id, todo.done)}
                          aria-label="Undo complete"
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </button>
                        <span className={`${styles['todo-text']} ${styles['todo-text-done']}`}>
                          {todo.title}
                        </span>
                        <button
                          className={styles['todo-delete-btn']}
                          onClick={() => deleteTodo(todo.id)}
                          aria-label="Delete task"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {todos.length > 0 && (
            <div className={styles['todo-footer']}>
              <span>{activeTodos.length} remaining</span>
              <span className={styles['todo-footer-dot']}>·</span>
              <span>{completedTodos.length} done</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default TodoPanel;
