import React, { useState, useEffect } from 'react';
import styles from '../styles/listen.module.css';

interface Todo {
  id: string;
  title: string;
  completed: boolean;
  priority?: string;
}

interface TodoPanelProps {
  authHeaders?: () => Record<string, string>;
  theme?: 'light' | 'dark';
}

const TodoPanel: React.FC<TodoPanelProps> = ({ authHeaders, theme = 'dark' }) => {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [newTodo, setNewTodo] = useState('');
  const [loading, setLoading] = useState(false);

  // Load todos on mount
  useEffect(() => {
    const loadTodos = async () => {
      try {
        setLoading(true);
        const headers = authHeaders ? authHeaders() : {};
        const response = await fetch('/todos', { headers });
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
  }, [authHeaders]);

  const addTodo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTodo.trim()) return;

    try {
      const headers = authHeaders ? authHeaders() : {};
      const response = await fetch('/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ title: newTodo, priority: 'normal' }),
      });

      if (response.ok) {
        const data = await response.json();
        setTodos([...todos, data.todo]);
        setNewTodo('');
      }
    } catch (err) {
      console.error('Failed to add todo:', err);
    }
  };

  const toggleTodo = async (id: string, completed: boolean) => {
    try {
      const headers = authHeaders ? authHeaders() : {};
      const response = await fetch(`/todos/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ completed: !completed }),
      });

      if (response.ok) {
        setTodos(todos.map((t) => (t.id === id ? { ...t, completed: !completed } : t)));
      }
    } catch (err) {
      console.error('Failed to toggle todo:', err);
    }
  };

  const activeTodos = todos.filter((t) => !t.completed);
  const completedCount = todos.filter((t) => t.completed).length;

  return (
    <div className={`${styles['todo-panel']} ${styles[`todo-panel-${theme}`]}`}>
      <div className={styles['todo-header']}>
        <h3 className={styles['todo-title']}>Tasks</h3>
        {todos.length > 0 && (
          <span className={styles['todo-count']}>
            {activeTodos.length}/{todos.length}
          </span>
        )}
      </div>

      <form onSubmit={addTodo} className={styles['todo-input-form']}>
        <input
          type="text"
          placeholder="Add a task..."
          value={newTodo}
          onChange={(e) => setNewTodo(e.target.value)}
          className={styles['todo-input']}
          disabled={loading}
        />
        <button
          type="submit"
          className={styles['todo-add-btn']}
          disabled={!newTodo.trim() || loading}
        >
          +
        </button>
      </form>

      <div className={styles['todo-list']}>
        {activeTodos.length === 0 && completedCount === 0 ? (
          <div className={styles['todo-empty']}>
            <span className={styles['todo-empty-icon']}>✓</span>
            <div className={styles['todo-empty-text']}>No tasks yet</div>
          </div>
        ) : (
          <>
            {activeTodos.map((todo) => (
              <div key={todo.id} className={styles['todo-item']}>
                <input
                  type="checkbox"
                  checked={false}
                  onChange={() => toggleTodo(todo.id, false)}
                  className={styles['todo-checkbox']}
                />
                <span className={styles['todo-text']}>{todo.title}</span>
              </div>
            ))}
            {completedCount > 0 && (
              <div className={styles['todo-completed-count']}>
                {completedCount} completed ✓
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default TodoPanel;
