import type { FeatureContext, FeatureHandle } from '../features.js';
import { taskRoutes } from './routes.js';
import { TaskService, TASKS_TICK_MS } from './service.js';

/** Test hooks (see FeatureDeps in ../features.ts). */
export interface TasksDeps {
  /** Scheduler tick of `tasks.tick` (default 15 s). */
  tickMs?: number;
}

export interface TasksHandle extends FeatureHandle {
  service: TaskService;
}

/** M20 "Geplante Aufgaben" (api/tasks.ts). Switches itself with the module `tasks`. */
export function setupTasks(ctx: FeatureContext, deps: TasksDeps = {}): TasksHandle {
  const service = new TaskService(ctx, { tickMs: deps.tickMs ?? TASKS_TICK_MS });
  if (ctx.modules.enabled('tasks')) service.start();
  const off = ctx.modules.onChange((id, on) => {
    if (id !== 'tasks') return;
    if (on) service.start();
    else service.disable();
  });
  return {
    service,
    routes: taskRoutes(ctx, service),
    idle: () => service.idle(),
    stop: () => {
      off();
      service.stop();
    },
  };
}
