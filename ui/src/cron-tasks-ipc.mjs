import { registerJsonFileIpc } from './app-ipc.mjs';

export function registerCronIpcHandlers() {
  registerJsonFileIpc('cron', '~/.moss/cron_tasks.json', {
    rootKey: 'tasks',
    idField: 'id',
  });
}
