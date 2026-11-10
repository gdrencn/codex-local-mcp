import type { TaskManager } from './manager.js';

/** Both the in-process manager and local IPC client implement this boundary. */
export type TaskService = Pick<TaskManager, 'status' | 'submit' | 'query' | 'cancel' | 'continue'>;
